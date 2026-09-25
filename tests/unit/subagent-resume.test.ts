import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession, type Conversation } from "../../server/agent-service.js";
import type { SubagentToolHost } from "../../server/subagents.js";

type Internal = {
	convs: Map<string, Conversation>;
	scheduleSubagentResume(parent: Conversation): void;
	onEvent(conv: Conversation, event: unknown): void;
	ownedSubagentHost(anchor: { session: Conversation["session"] }, ownerId: string): SubagentToolHost;
	findConversationHome?: () => { session: Internal; convId: string };
};
function conversation(id: string, parentId?: string) {
	return {
		id,
		parentId,
		title: id,
		isSubagent: !!parentId,
		subagentGeneration: 1,
		subagentCompletedGeneration: parentId ? 1 : undefined,
		session: { isIdle: true, isStreaming: false, isCompacting: false, sendCustomMessage: vi.fn(async () => {}) },
	} as unknown as Conversation;
}
function client(...convs: Conversation[]): Internal {
	return Object.assign(Object.create(ClientSession.prototype), {
		convs: new Map(convs.map((c) => [c.id, c])),
		activeId: convs[0].id,
		isQuiesced: () => false,
		getSubagentSnapshot: (id: string) => ({ state: "done", output: `result ${id}` }),
		emit: vi.fn(),
		emitRun: vi.fn(),
		emitConversations: vi.fn(),
		scheduleSessionsRefresh: vi.fn(),
		refreshConversationTitle: vi.fn(),
		flushSnapshot: vi.fn(),
		scheduleSnapshot: vi.fn(),
		goalSvc: { onAgentEnd: vi.fn() },
		settingsSvc: { hasPendingReload: () => false },
		subagentRunOutcome: () => ({}),
	});
}
function streaming(conv: Conversation, value: boolean) {
	Object.assign(conv.session, { isStreaming: value, isIdle: !value });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("subagent completion resumes", () => {
	it("waits for slow parent settlement after agent_end rather than losing the wake", async () => {
		const parent = conversation("parent"),
			child = conversation("child", parent.id);
		const owner = client(parent, child);
		streaming(parent, true);
		owner.onEvent(parent, { type: "agent_end", messages: [], willRetry: false });
		await vi.advanceTimersByTimeAsync(500);
		expect(parent.session.sendCustomMessage).not.toHaveBeenCalled();
		streaming(parent, false);
		owner.onEvent(parent, { type: "agent_settled" });
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("batches siblings and delivers each later generation exactly once", async () => {
		const parent = conversation("parent"),
			one = conversation("one", parent.id),
			two = conversation("two", parent.id);
		const owner = client(parent, one, two);
		owner.scheduleSubagentResume(parent);
		owner.scheduleSubagentResume(parent);
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ details: { runIds: ["one", "two"] } }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		owner.scheduleSubagentResume(parent);
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		one.subagentGeneration = one.subagentCompletedGeneration = 2;
		owner.scheduleSubagentResume(parent);
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		expect(parent.session.sendCustomMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ details: { runIds: ["one"] } }),
			expect.anything(),
		);
	});

	it("resolves transferred ownership when a queued wake fires", async () => {
		const parent = conversation("parent"),
			child = conversation("child", parent.id);
		const oldOwner = client(parent, child),
			newOwner = client(conversation("other"));
		oldOwner.scheduleSubagentResume(parent);
		oldOwner.convs.clear();
		parent.id = "moved-parent";
		child.parentId = parent.id;
		newOwner.convs.set(parent.id, parent);
		newOwner.convs.set(child.id, child);
		oldOwner.findConversationHome = () => ({ session: newOwner, convId: parent.id });
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(newOwner.convs.get("other")!.session.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("does not publish retrying child results or restart an explicitly stopped parent", async () => {
		const parent = conversation("parent"),
			child = conversation("child", parent.id);
		const owner = client(parent, child);
		child.retryState = { attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "transient" };
		owner.scheduleSubagentResume(parent);
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).not.toHaveBeenCalled();
		child.retryState = null;
		owner.scheduleSubagentResume(parent);
		parent.subagentResumeStopped = true;
		await vi.advanceTimersByTimeAsync(100);
		owner.onEvent(child, { type: "agent_settled" });
		await vi.advanceTimersByTimeAsync(100);
		expect(parent.session.sendCustomMessage).not.toHaveBeenCalled();
		expect(child.subagentAcknowledgedGeneration).toBeUndefined();
	});

	it("a root reading a grandchild cannot consume the wake owed to its direct parent", async () => {
		const root = conversation("root"),
			middle = conversation("middle", root.id),
			child = conversation("child", middle.id);
		const owner = client(root, middle, child);
		owner.ownedSubagentHost({ session: root.session }, root.id).acknowledgeSubagentResults!([middle.id, child.id]);
		expect(middle.subagentAcknowledgedGeneration).toBe(1);
		expect(child.subagentAcknowledgedGeneration).toBeUndefined();
		owner.scheduleSubagentResume(middle);
		await vi.advanceTimersByTimeAsync(100);
		expect(middle.session.sendCustomMessage).toHaveBeenCalledTimes(1);
	});
});
