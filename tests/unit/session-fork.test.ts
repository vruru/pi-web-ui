import { describe, it, expect } from "vitest";
import {
	findEntryByUiId,
	serializeMessage,
	uiMessageId,
	type AgentMessage,
	type UiIdEntryLike,
} from "../../server/serialize.js";

// issue #381：渲染 id（serializeMessage / serializeCachedFor）与解析 id
// （resolveMessageEntry → findEntryByUiId）必须出自同一套编号。这里按服务端
// 真实流程做往返验证：先像 serializeCachedFor 那样给整条对话渲染出 id，
// 再用 findEntryByUiId 找回 entry。旧实现（解析侧自算 assistant 同时间戳
// 序号 / entry 全局序号）在助手气泡上 100% 解析失败——保留反例锁住。

interface MockEntry extends UiIdEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	message?: AgentMessage;
}

/** 模拟 agent-service 的 uiMessageKey：n 是跨角色的对话级计数器，按首次
 *  遇见顺序分配（真实 key 含内容指纹，这里用 JSON(content) 代替）。 */
function makeCounter() {
	let nextN = 1;
	const seqMap = new Map<string, number>();
	const seqOf = (m: AgentMessage) => {
		const content = (m as { content?: unknown }).content;
		const key = `${m.role}:${m.timestamp}:${JSON.stringify(content)}`;
		if (!seqMap.has(key)) seqMap.set(key, nextN++);
		return seqMap.get(key)!;
	};
	return { seqOf };
}

/** 模拟 serializeCachedFor：所有消息都先过 uiMessageKey 分配 n，user 的
 *  id 序号特判成同时间戳内第几条，其余直接用 n。返回 id 列表（按入参顺序）。 */
function renderAll(entries: MockEntry[], seqOf: (m: AgentMessage) => number): string[] {
	const userSeqByTs = new Map<number, number>();
	return entries.map((e) => {
		const m = e.message!;
		const n = seqOf(m);
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			const seq = (userSeqByTs.get(ts) ?? 0) + 1;
			userSeqByTs.set(ts, seq);
			return uiMessageId(m, seq);
		}
		return uiMessageId(m, n);
	});
}

function msgEntry(id: string, parentId: string | null, message: AgentMessage): MockEntry {
	return { id, parentId, type: "message", message };
}

function user(timestamp: number, text = "q"): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistant(timestamp: number, text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
		stopReason: "stop",
	} as AgentMessage;
}

describe("findEntryByUiId：渲染 id ↔ 解析 id 往返一致（issue #381）", () => {
	it("assistant 气泡：全局第 2/4 条消息（a-<ts>-2 / a-<ts>-4）能解析回 entry", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
			msgEntry("e3", "e2", user(2000)),
			msgEntry("e4", "e3", assistant(2005, "second reply")),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-1000-1", "a-1005-2", "u-2000-1", "a-2005-4"]);

		ids.forEach((id, i) => {
			expect(findEntryByUiId(entries, id, seqOf)?.id).toBe(entries[i].id);
		});
	});

	it("fork/rollback 的 before/at 切分：assistant 与 user 均正确", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
			msgEntry("e3", "e2", user(2000)),
			msgEntry("e4", "e3", assistant(2005, "second reply")),
		];
		const ids = renderAll(entries, seqOf);

		const entryA2 = findEntryByUiId(entries, ids[1], seqOf)!;
		expect(entryA2.parentId).toBe("e1"); // before → e1
		expect(entryA2.id).toBe("e2"); // at → e2

		const entryU2 = findEntryByUiId(entries, ids[2], seqOf)!;
		expect(entryU2.parentId).toBe("e2");
		expect(entryU2.id).toBe("e3");
	});

	it("toolResult / bashExecution 往返一致", () => {
		const { seqOf } = makeCounter();
		const toolResult = {
			role: "toolResult",
			toolCallId: "call_abc123",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			timestamp: 1010,
		} as AgentMessage;
		const bash = {
			role: "bashExecution",
			command: "ls",
			output: "a",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1020,
		} as AgentMessage;
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", toolResult),
			msgEntry("e3", "e2", bash),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-1000-1", "t-call_abc123", "b-1020-3"]);

		expect(findEntryByUiId(entries, ids[1], seqOf)?.id).toBe("e2");
		expect(findEntryByUiId(entries, ids[2], seqOf)?.id).toBe("e3");
	});

	it("custom_message（含 display:false 跳过）往返一致", () => {
		const { seqOf } = makeCounter();
		const entries = [
			{
				id: "e0",
				parentId: null,
				type: "custom_message",
				timestamp: new Date(900).toISOString(),
				customType: "note",
				content: [{ type: "text", text: "hi" }],
				display: false,
			},
			{
				id: "e1",
				parentId: "e0",
				type: "custom_message",
				timestamp: new Date(1000).toISOString(),
				customType: "note",
				content: [{ type: "text", text: "hi" }],
				display: true,
			},
			msgEntry("e2", "e1", user(2000)),
		] as unknown as MockEntry[];

		// 渲染侧：display:false 不产出气泡；display:true 的 custom 首次出现 → n=1
		const hidden = serializeMessage(
			{ role: "custom", content: [{ type: "text", text: "hi" }], timestamp: 900 } as AgentMessage,
			1,
		);
		expect(hidden?.id).toBe("c-900-1");
		const ids = [
			uiMessageId({ role: "custom", content: [{ type: "text", text: "hi" }], timestamp: 1000 } as AgentMessage, 1),
		];
		expect(ids[0]).toBe("c-1000-1");

		expect(findEntryByUiId(entries, ids[0], seqOf)?.id).toBe("e1");
		// display:false 的条目本就不渲染、无按钮，解析不到也算正确
		expect(findEntryByUiId(entries, "c-900-1", seqOf)).toBeNull();
	});

	it("同时间戳的双 user 消息：同毫秒序号两侧口径一致", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(2000, "first question")),
			msgEntry("e2", "e1", assistant(2005, "reply")),
			msgEntry("e3", "e2", user(2000, "edited question")),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-2000-1", "a-2005-2", "u-2000-2"]);

		ids.forEach((id, i) => {
			expect(findEntryByUiId(entries, id, seqOf)?.id).toBe(entries[i].id);
		});
	});

	it("原始 entry id 直接命中（快路径）", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [msgEntry("raw-entry-id", null, user(1000))];
		expect(findEntryByUiId(entries, "raw-entry-id", seqOf)?.id).toBe("raw-entry-id");
	});

	it("查不到返回 null（不是抛错）", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [msgEntry("e1", null, user(1000))];
		expect(findEntryByUiId(entries, "a-9999-9", seqOf)).toBeNull();
	});

	it("旧解析口径的 assistant id（同时间戳序号）不再撞上错误的 entry", () => {
		// 旧 resolver 把第二条 assistant 重算成 a-1005-1（同时间戳内第 1 条），
		// 而下发的是 a-1005-2——两个 id 各说各话。修好后真实渲染链路里
		// 不存在 a-1005-1 这个 id，不应被解析到任何 entry。
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
		];
		renderAll(entries, seqOf);
		expect(findEntryByUiId(entries, "a-1005-1", seqOf)).toBeNull();
		expect(findEntryByUiId(entries, "a-1005-2", seqOf)?.id).toBe("e2");
	});

	it("serializeMessage 与 uiMessageId 出同一 id（防再分叉）", () => {
		const m = assistant(2005, "second reply");
		const ui = serializeMessage(m, 4);
		expect(ui?.id).toBe(uiMessageId(m, 4));
		expect(ui?.id).toBe("a-2005-4");
	});
});
