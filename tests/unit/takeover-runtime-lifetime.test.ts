import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService, ClientSession, type Conversation } from "../../server/agent-service.js";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("takeover preserves the outgoing idle runtime", () => {
	it.each([false, true])(
		"repairing the source active view does not dispose the transferred runtime (remaining=%s)",
		async (remaining) => {
			const dispose = vi.fn(async () => {});
			const conversation = {
				id: "moving",
				title: "Viewed history",
				isSubagent: false,
				listed: false,
				promptedSinceActive: false,
				goal: { reviewing: false },
				wizardRunning: false,
				session: { isStreaming: false, isCompacting: false, sessionFile: undefined },
				terminals: { countBlockingLive: () => 0 },
				runtime: { dispose },
			} as unknown as Conversation;
			const replacement = { id: "replacement", isSubagent: false } as Conversation;
			const client = Object.create(ClientSession.prototype) as ClientSession;
			const internal = client as unknown as {
				activeId: string;
				convs: Map<string, Conversation>;
				takeoverDepartures: Set<Conversation>;
				displaceActive(): Conversation | null;
			};
			Object.assign(client, {
				activeId: conversation.id,
				convs: new Map([[conversation.id, conversation]]),
				takeoverDepartures: new Set(),
				pendingQuestions: new Map(),
				pendingPageCalls: new Map(),
				clearAllToolWatchdogs: vi.fn(),
				emitConversations: vi.fn(),
				flushSnapshot: vi.fn(),
			});
			if (remaining) internal.convs.set(replacement.id, replacement);
			const repairActive = async () => {
				const displaced = internal.displaceActive();
				internal.convs.set(replacement.id, replacement);
				internal.activeId = replacement.id;
				if (displaced) {
					internal.convs.delete(displaced.id);
					await displaced.runtime.dispose();
				}
				return true;
			};
			Object.assign(client, { newChat: repairActive, switchConversation: repairActive });
			// This idle viewed runtime would normally be discarded on navigation.
			expect(internal.displaceActive()).toBe(conversation);
			const result = await client.detachTakeoverConversations([conversation.id]);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.payload.convs[0]).toBe(conversation);
			expect(dispose).not.toHaveBeenCalled();
			expect(internal.activeId).toBe(replacement.id);
			expect(internal.convs.has(conversation.id)).toBe(false);
			expect(internal.takeoverDepartures.size).toBe(0);
		},
	);
	it("only the connected selected conversation or selected descendant requires manual takeover", () => {
		const client = Object.create(ClientSession.prototype) as ClientSession;
		Object.assign(client, {
			activeId: "one",
			sinks: new Set([() => {}]),
			convs: new Map([
				["one", { id: "one" }],
				["two", { id: "two" }],
				["child", { id: "child", parentId: "two", isSubagent: true }],
			]),
		});
		expect(client.requiresManualTakeover("one")).toBe(true);
		expect(client.requiresManualTakeover("two")).toBe(false);
		Object.assign(client, { activeId: "child" });
		expect(client.requiresManualTakeover("two")).toBe(true);
		Object.assign(client, { sinks: new Set() });
		expect(client.requiresManualTakeover("two")).toBe(false);
	});
});

describe("transcript ownership during asynchronous transfer", () => {
	it("reserves the transcript through detach/insert so a concurrent opener never sees it unowned", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let detached = false;
		let inserted = false;
		const path = "/tmp/takeover-reserved-session.jsonl";
		const brief = { id: "moving", title: "History", cwd: "/tmp", isSubagent: false, sessionFile: path };
		const source = {
			takeoverBriefs: () => [brief],
			requiresManualTakeover: () => false,
			detachTakeoverConversations: async () => {
				detached = true;
				await gate;
				return { ok: true, payload: { convs: [brief], questions: [], pageCalls: [] } };
			},
			findConversationBySessionFile: () => (detached ? undefined : brief),
			conversationStreaming: () => false,
			sinkCount: () => 1,
			sendNotice: vi.fn(),
		};
		const target = {
			takeoverBriefs: () => [],
			sendNotice: vi.fn(),
			refreshExternalRunning: vi.fn(),
			insertTakeoverConvs: vi.fn(() => {
				inserted = true;
				return "adopted";
			}),
			switchConversation: vi.fn(async () => {}),
			findConversationBySessionFile: () => (inserted ? brief : undefined),
			conversationStreaming: () => false,
			sinkCount: () => 1,
			requiresManualTakeover: () => true,
		};
		const service = Object.create(AgentService.prototype) as AgentService;
		Object.assign(service, {
			clients: new Map<string, unknown>([
				["source", source],
				["target", target],
			]),
			transferringSessions: new Map(),
		});
		const operation = service.takeOverConversation("target", "source", "moving", true);
		expect(detached).toBe(true);
		expect(inserted).toBe(false);
		for (const opener of ["source", "target", "third-browser"]) {
			expect(service.findSessionOwner(path, opener)).toMatchObject({ transferring: true, requiresTakeover: true });
		}
		release();
		await operation;
		expect(target.insertTakeoverConvs).toHaveBeenCalledOnce();
		expect(service.findSessionOwner(path, "third-browser")).toMatchObject({
			clientId: "target",
			requiresTakeover: true,
		});
		expect(service.findSessionOwner(path, "third-browser")?.transferring).toBeUndefined();
	});
});

describe("cold transcript and initial attach reservations", () => {
	afterEach(() => vi.restoreAllMocks());
	it("blocks a second cold-file creation while allowing a different transcript", () => {
		const service = Object.create(AgentService.prototype) as AgentService;
		Object.assign(service, { clients: new Map(), transferringSessions: new Map() });
		const reserve = (
			service as unknown as { reserveSessionFile(path: string, clientId: string, cwd: string): () => void }
		).reserveSessionFile.bind(service);
		const releaseA = reserve("/tmp/cold-a.jsonl", "A", "/tmp");
		expect(() => reserve("/tmp/cold-a.jsonl", "B", "/tmp")).toThrow(/being opened/);
		const releaseB = reserve("/tmp/cold-b.jsonl", "B", "/tmp");
		expect(service.findSessionOwner("/tmp/cold-a.jsonl", "A")?.transferring).toBe(true);
		releaseA();
		expect(service.findSessionOwner("/tmp/cold-a.jsonl", "B")).toBe(null);
		expect(service.findSessionOwner("/tmp/cold-b.jsonl", "A")?.clientId).toBe("B");
		releaseB();
	});
	it("two hellos with one client id share a single creation even when both await the initial history scan", async () => {
		let release!: (client: ClientSession) => void;
		const creating = new Promise<ClientSession>((resolve) => {
			release = resolve;
		});
		vi.spyOn(SessionManager, "list").mockResolvedValue([]);
		const create = vi.spyOn(ClientSession, "create").mockReturnValue(creating);
		const service = Object.create(AgentService.prototype) as AgentService;
		Object.assign(service, {
			cwd: "/tmp",
			clients: new Map(),
			pending: new Map(),
			transferringSessions: new Map(),
			stateStore: { get: () => ({}), remember: vi.fn(), takeInterrupted: () => undefined },
			findAdoptableOrphan: () => null,
			wireClient: vi.fn(),
		});
		const client = {
			cwd: "/tmp",
			workspaceRoots: [],
			attachSink: vi.fn(),
			resumeInterrupted: vi.fn(),
		} as unknown as ClientSession;
		const a = service.attach("same-client", () => {});
		const b = service.attach("same-client", () => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(create).toHaveBeenCalledOnce();
		release(client);
		const results = await Promise.all([a, b]);
		expect(results[0]).toBe(client);
		expect(results[1]).toBe(client);
		expect(create).toHaveBeenCalledOnce();
		expect(client.attachSink).toHaveBeenCalledTimes(2);
	});
});

describe("conversation extension UI follows the live runtime", () => {
	it("keeps widgets and pending dialogs alive across A-B-A without replaying initialization", async () => {
		const a: ServerMessage[] = [];
		const b: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => a.push(msg));
		let value = "one";
		const init = vi.fn(() => ({ render: () => [value] }));
		ui.setWidget("live", init as unknown as Parameters<WebUIContext["setWidget"]>[1]);
		ui.setStatus("alive", "yes");
		const answer = ui.select("Pick", ["yes", "no"]);
		const dialog = a.find((msg) => msg.type === "dialog");
		if (!dialog || dialog.type !== "dialog") throw new Error("missing dialog");
		ui.rebindEmit((msg) => b.push(msg));
		expect(a.at(-1)).toEqual({ type: "dialog_closed", id: dialog.id });
		expect(b.at(-1)).toEqual(dialog);
		value = "two";
		ui.refresh();
		expect(b.some((msg) => msg.type === "widgets" && msg.widgets[0]?.lines[0] === "two")).toBe(true);
		ui.rebindEmit((msg) => a.push(msg));
		expect(b.at(-1)).toEqual({ type: "dialog_closed", id: dialog.id });
		expect(a.at(-1)).toEqual(dialog);
		ui.resolveDialog(dialog.id, "yes");
		await expect(answer).resolves.toBe("yes");
		expect(init).toHaveBeenCalledOnce();
		expect(ui.statusSnapshot()).toEqual([{ key: "alive", text: "yes" }]);
	});
	it("independent runtime dialogs cannot collide and disposing a placeholder cannot dispose the moved widget", async () => {
		const messages: ServerMessage[] = [];
		const moved = new WebUIContext((m) => messages.push(m));
		const placeholder = new WebUIContext((m) => messages.push(m));
		const render = vi.fn(() => ["live"]);
		const dispose = vi.fn();
		moved.setWidget("extension", (() => ({ render, dispose })) as unknown as Parameters<WebUIContext["setWidget"]>[1]);
		const a = moved.input("moved");
		const b = placeholder.input("blank");
		const dialogs = messages.filter((m) => m.type === "dialog");
		expect(dialogs[0].id).not.toBe(dialogs[1].id);
		placeholder.dispose();
		await expect(b).resolves.toBe(null);
		expect(dispose).not.toHaveBeenCalled();
		moved.refresh();
		expect(moved.snapshot()[0].lines).toEqual(["live"]);
		moved.resolveDialog(dialogs[0].id, "ok");
		await expect(a).resolves.toBe("ok");
		moved.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
