import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ClientSession, type Conversation } from "../../server/agent-service.js";

/**
 * Goal role conversations (the executor of a goal) are spawned through the subagent
 * channel but are driven by GoalService: it waits for the executor's turn and then
 * prompts the reviewer (the main conversation) itself. The fork's subagent policy must
 * therefore not treat them like ordinary subagents:
 *
 * - no "subagent-completion" wake-up of the parent (it would add a second turn next to
 *   the review prompt);
 * - no execution slot (they are persisted regular conversations, reused across rounds);
 * - the model still follows the fork rule: explicit choice or the spawning conversation.
 */
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	createAgentSessionRuntime: vi.fn(),
	SessionManager: { create: () => ({}), inMemory: () => ({}) },
}));

type Internal = {
	convs: Map<string, Conversation>;
	pendingSubagentStarts: number;
	scheduleSubagentResume: ReturnType<typeof vi.fn>;
	subagentOccupiesSlot(conv: Conversation): boolean;
	onEvent(conv: Conversation, event: unknown): void;
	spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply: undefined,
		model: string | null,
		parentId: string,
		persist: boolean,
		title?: string,
		goalRole?: "executor" | "reviewer",
	): Promise<string>;
};

function fixture(): Internal {
	const main = {
		id: "main",
		cwd: "/tmp",
		isSubagent: false,
		session: { isIdle: true, isStreaming: false, model: { provider: "current", id: "main" } },
	} as unknown as Conversation;
	return Object.assign(Object.create(ClientSession.prototype), {
		convs: new Map([[main.id, main]]),
		pendingSubagentStarts: 0,
		activeId: main.id,
		cwd: "/tmp",
		agentDir: "/tmp/pi-web-goal-role-test",
		settingsSvc: { current: {}, hasPendingReload: () => false },
		sharedModelRuntime: {
			getModel: (provider: string, id: string) => (provider === "missing" ? undefined : { provider, id }),
		},
		getLang: () => "en",
		makeTerminalManager: () => ({ killAll: () => {} }),
		clearAllToolWatchdogs: () => {},
		restoreKeyForModel: async () => {},
		makeRuntimeFactory: () => ({}),
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		extensionUiFor: () => ({}),
		pushProjects: async () => {},
		emitConversations: () => {},
		emit: () => {},
		scheduleSubagentResume: vi.fn(),
		makeConversation: (runtime: { session: unknown }, id: string, terminals: unknown) => ({
			terminals,
			id,
			cwd: "/tmp",
			session: runtime.session,
			runtime,
		}),
	}) as Internal;
}

function runtime() {
	const setModel = vi.fn(async () => {});
	return {
		setModel,
		value: {
			dispose: async () => {},
			session: {
				isIdle: true,
				isStreaming: false,
				subscribe: () => () => {},
				bindExtensions: async () => {},
				sendUserMessage: async () => {},
				setModel,
			},
		},
	};
}
const settle = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => vi.mocked(createAgentSessionRuntime).mockReset());
afterEach(() => vi.restoreAllMocks());

describe("goal role conversations and the fork subagent policy", () => {
	it("an executor is a persisted conversation: no execution slot, no parent wake-up after its first turn", async () => {
		const c = fixture();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime().value as never);
		const id = await c.spawnSubagentConversation(
			"do it",
			"goal-executor",
			"/tmp",
			undefined,
			null,
			"main",
			true,
			"Goal",
			"executor",
		);
		const conv = c.convs.get(id)!;
		expect(id).toMatch(/^conv-/);
		expect(conv.goalRole).toBe("executor");
		expect(conv.isSubagent).toBe(false);
		expect(c.pendingSubagentStarts).toBe(0);
		expect(c.subagentOccupiesSlot(conv)).toBe(false);
		// GoalService waits on this promise before it samples the executor.
		await conv.kickoff;
		await settle();
		expect(c.scheduleSubagentResume).not.toHaveBeenCalled();
	});

	it("an ordinary subagent still wakes its parent when its first turn is delivered", async () => {
		const c = fixture();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime().value as never);
		const id = await c.spawnSubagentConversation("do it", "general", "/tmp", undefined, null, "main", false);
		await c.convs.get(id)!.kickoff;
		await settle();
		expect(c.scheduleSubagentResume).toHaveBeenCalledWith(c.convs.get("main"));
	});

	it("turn ends of a role conversation never mark a completion for the parent", () => {
		const c = fixture();
		const base = { cwd: "/tmp", parentId: "main", subagentGeneration: 2, retryState: null };
		const session = { isIdle: true, isStreaming: false };
		const role = {
			...base,
			id: "conv-exec",
			isSubagent: false,
			goalRole: "executor",
			session,
		} as unknown as Conversation;
		const plain = { ...base, id: "sa-1", isSubagent: true, session } as unknown as Conversation;
		c.convs.set(role.id, role).set(plain.id, plain);
		Object.assign(c, {
			currentBaseTokens: () => null,
			disposed: false,
		});
		c.onEvent(role, { type: "agent_settled" });
		expect(role.subagentCompletedGeneration).toBeUndefined();
		expect(c.scheduleSubagentResume).not.toHaveBeenCalledWith(c.convs.get("main"));
		c.onEvent(plain, { type: "agent_settled" });
		expect(plain.subagentCompletedGeneration).toBe(2);
		expect(c.scheduleSubagentResume).toHaveBeenCalledWith(c.convs.get("main"));
	});

	it("executor model: follows the reviewer conversation unless the user picked one; a missing pick fails the spawn", async () => {
		const c = fixture();
		const follow = runtime();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(follow.value as never);
		await c.spawnSubagentConversation("p", "goal-executor", "/tmp", undefined, null, "main", true, "t", "executor");
		expect(follow.setModel).toHaveBeenCalledWith({ provider: "current", id: "main" });

		const picked = runtime();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(picked.value as never);
		await c.spawnSubagentConversation(
			"p",
			"goal-executor",
			"/tmp",
			undefined,
			"exec/model",
			"main",
			true,
			"t",
			"executor",
		);
		expect(picked.setModel).toHaveBeenCalledWith({ provider: "exec", id: "model" });

		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime().value as never);
		Object.assign(c, { removeConversation: (id: string) => c.convs.delete(id) });
		const before = c.convs.size;
		await expect(
			c.spawnSubagentConversation(
				"p",
				"goal-executor",
				"/tmp",
				undefined,
				"missing/model",
				"main",
				true,
				"t",
				"executor",
			),
		).rejects.toThrow("Subagent model not found");
		expect(c.convs.size).toBe(before);
	});

	it("an inherited model without a registry entry (unconfigured install) does not block the spawn", async () => {
		const c = fixture();
		Object.assign(c.convs.get("main")!.session, { model: { provider: "missing", id: "unknown" } });
		const rt = runtime();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(rt.value as never);
		await expect(
			c.spawnSubagentConversation("p", "goal-executor", "/tmp", undefined, null, "main", true, "t", "executor"),
		).resolves.toMatch(/^conv-/);
		expect(rt.setModel).not.toHaveBeenCalled();
	});

	it("execution slots follow live state: a finished subagent that is steered again occupies a slot again", () => {
		const c = fixture();
		const session = { isIdle: true, isStreaming: false };
		const sub = { id: "sa-1", isSubagent: true, session } as unknown as Conversation;
		expect(c.subagentOccupiesSlot(sub)).toBe(false);
		Object.assign(session, { isIdle: false, isStreaming: true });
		expect(c.subagentOccupiesSlot(sub)).toBe(true);
	});
});
