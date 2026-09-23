import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ClientSession, type Conversation } from "../../server/agent-service.js";
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	createAgentSessionRuntime: vi.fn(),
}));
function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
type Internal = {
	convs: Map<string, Conversation>;
	pendingSubagentStarts: number;
	spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: import("../../server/subagent-templates.js").SubagentTemplate,
		model?: string | null,
		parentId?: string,
	): Promise<string>;
};
function fixture() {
	const client = Object.create(ClientSession.prototype) as ClientSession;
	const main = {
		id: "main",
		cwd: "/tmp",
		isSubagent: false,
		session: { isIdle: true, isStreaming: false },
	} as Conversation;
	Object.assign(client, {
		convs: new Map([[main.id, main]]),
		pendingSubagentStarts: 0,
		activeId: main.id,
		agentDir: "/tmp",
		settingsSvc: { current: {} },
		getLang: () => "en",
		makeTerminalManager: () => ({ killAll: () => {} }),
		clearAllToolWatchdogs: () => {},
		restoreKeyForModel: async () => {},
		makeRuntimeFactory: () => ({}),
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		extensionUiFor: () => ({}),
		emitConversations: () => {},
		emit: () => {},
		makeConversation: (runtime: { session: unknown }, id: string, terminals: unknown) => ({
			terminals,
			id,
			cwd: "/tmp",
			session: runtime.session,
			runtime,
		}),
	});
	return client as unknown as Internal;
}
function runtime(run: ReturnType<typeof deferred>) {
	return {
		dispose: async () => {},
		session: {
			isIdle: true,
			isStreaming: false,
			subscribe: () => () => {},
			bindExtensions: async () => {},
			sendUserMessage: () => run.promise,
		},
	};
}
const spawn = (client: Internal) =>
	client.spawnSubagentConversation("task", "general", "/tmp", undefined, null, "main");
beforeEach(() => {
	vi.mocked(createAgentSessionRuntime).mockReset();
});
describe("subagent execution capacity", () => {
	it("16 completed records retain their results but do not block a new run; completion frees its slot", async () => {
		const c = fixture();
		for (let i = 0; i < 16; i++)
			c.convs.set(`done${i}`, {
				id: `done${i}`,
				isSubagent: true,
				session: { isIdle: true, isStreaming: false },
			} as Conversation);
		const run = deferred();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime(run) as never);
		const id = await spawn(c);
		expect(c.convs.size).toBe(18);
		expect(c.convs.get(id)?.subagentRunPending).toBe(true);
		expect(c.pendingSubagentStarts).toBe(0);
		run.resolve();
		await run.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(c.convs.get(id)?.subagentRunPending).toBe(false);
	});
	it("reserves all 16 initializing slots before asynchronous runtimes exist and releases rejected starts", async () => {
		const c = fixture();
		const init = deferred();
		vi.mocked(createAgentSessionRuntime).mockImplementation(async () => {
			await init.promise;
			throw new Error("init failed");
		});
		const running = Array.from({ length: 16 }, () => spawn(c));
		const results = Promise.allSettled(running);
		expect(c.pendingSubagentStarts).toBe(16);
		await expect(spawn(c)).rejects.toThrow("Subagent limit reached");
		init.resolve();
		await results;
		expect(c.pendingSubagentStarts).toBe(0);
		expect(vi.mocked(createAgentSessionRuntime)).toHaveBeenCalledTimes(16);
	});
	it("counts non-streaming queued work, then frees capacity after task failure", async () => {
		const c = fixture();
		for (let i = 0; i < 15; i++)
			c.convs.set(`busy${i}`, {
				id: `busy${i}`,
				isSubagent: true,
				session: { isIdle: false, isStreaming: false },
			} as Conversation);
		const run = deferred();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime(run) as never);
		const id = await spawn(c);
		await expect(spawn(c)).rejects.toThrow("Subagent limit reached");
		run.reject(new Error("failed"));
		await run.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(c.convs.get(id)?.subagentRunPending).toBe(false);
		const next = deferred();
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(runtime(next) as never);
		await expect(spawn(c)).resolves.toMatch(/^sa-/);
		next.resolve();
	});
});

describe("subagent model inheritance", () => {
	it.each([null, "chosen/explicit"])("inherits the spawner unless explicitly overridden (%s)", async (override) => {
		const c = fixture();
		const current = { provider: "current", id: "main" };
		Object.assign(c.convs.get("main")!.session, { model: current });
		Object.assign(c, {
			settingsSvc: { current: { subagentDefaultModel: "legacy/default" } },
			sharedModelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }) },
		});
		const run = deferred();
		const rt = runtime(run);
		const setModel = vi.fn();
		Object.assign(rt.session, { setModel });
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(rt as never);
		await c.spawnSubagentConversation(
			"task",
			"general",
			"/tmp",
			{ model: "template/other", enabledExtensions: [] } as never,
			override,
			"main",
		);
		expect(setModel).toHaveBeenCalledWith(override ? { provider: "chosen", id: "explicit" } : current);
		run.resolve();
	});
	it("does not silently run with another model when requested model is unavailable", async () => {
		const c = fixture();
		const run = deferred();
		const rt = runtime(run);
		const send = vi.spyOn(rt.session, "sendUserMessage");
		vi.mocked(createAgentSessionRuntime).mockResolvedValue(rt as never);
		await expect(
			c.spawnSubagentConversation("task", "general", "/tmp", undefined, "missing/model", "main"),
		).rejects.toThrow("Subagent model not found");
		expect(send).not.toHaveBeenCalled();
		expect(c.convs.size).toBe(1);
		expect(c.pendingSubagentStarts).toBe(0);
	});
});
