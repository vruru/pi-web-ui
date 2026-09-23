/**
 * 悬空 toolCall 检测与修复（issue #280）。
 *
 * 背景：流式中模型卡死 → 工具看门狗 abort 无效 → forceResetConversation
 * dispose 在飞运行时并从磁盘重建。内存里未落盘的工具结果静默蒸发，
 * 会话文件尾留下一个「有调用、无结果」的悬空 toolCall；重建后继续
 * prompt 会把非法转录链喂给 provider——请求有发起迹象但零落盘、零报错，
 * 用户在往黑洞里打字。
 *
 * 本模块：
 * - findDanglingToolCalls：纯函数，消息/条目数组里找「有调用、无后继结果」的 toolCall；
 * - healDanglingToolCallFile：落盘版，文件尾追加合成 toolResult（append-only，不改历史字节）；
 * - 合成结果文案：DANGLING_TOOL_RESULT_TEXT（中英各一，toolResult content 只带一条文本）。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const DANGLING_TOOL_RESULT_TEXT =
	"（系统：上一次运行被强制终止（工具执行超时/模型流卡死），该工具调用没有返回结果。为避免对话记录损坏，已自动填入一条合成结果。请根据需要重新执行该工具或继续对话。）";
export const DANGLING_TOOL_RESULT_TEXT_EN =
	"(System: the previous run was force-terminated (tool timeout / hung model stream) and this tool call never returned. A synthetic result was inserted automatically to keep the transcript valid. Re-run the tool or continue as needed.)";

export interface DanglingToolCall {
	toolCallId: string;
	toolName: string;
}

interface ContentBlock {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
}

function toolCallsOfMessage(msg: unknown): DanglingToolCall[] {
	if (typeof msg !== "object" || msg === null) return [];
	const m = msg as { role?: unknown; content?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	const out: DanglingToolCall[] = [];
	for (const b of m.content as ContentBlock[]) {
		if (typeof b !== "object" || b === null || b.type !== "toolCall") continue;
		const id = typeof b.id === "string" ? b.id : "";
		if (!id) continue;
		const name = typeof b.name === "string" && b.name ? b.name : "unknown";
		out.push({ toolCallId: id, toolName: name });
	}
	return out;
}

function toolResultIdsOfMessage(msg: unknown): Set<string> {
	const ids = new Set<string>();
	if (typeof msg !== "object" || msg === null) return ids;
	const m = msg as { role?: unknown; toolCallId?: unknown; content?: unknown };
	if (m.role === "toolResult" && typeof m.toolCallId === "string") ids.add(m.toolCallId);
	// 兼容：个别版本把结果放在 content 块里。
	if (Array.isArray(m.content)) {
		for (const b of m.content as ContentBlock[]) {
			if (typeof b !== "object" || b === null) continue;
			if ((b.type === "toolResult" || b.type === "tool_result") && typeof b.toolCallId === "string") {
				ids.add(b.toolCallId);
			}
		}
	}
	return ids;
}

function messagesOfEntries(entries: unknown[]): unknown[] {
	return entries.map((e) => {
		if (typeof e === "object" && e !== null && "message" in e) {
			const msg = (e as { message?: unknown }).message;
			if (typeof msg === "object" && msg !== null && "role" in msg) return msg;
		}
		return e;
	});
}

/**
 * 找悬空 toolCall：出现过调用、但之后没有任何 toolResult 与之配对的。
 * 输入既可以是 Message[]（内存 agent.state.messages），也可以是
 * SessionManager entry[]（带 { message } 包装的落盘条目）——统一按顺序扫。
 */
export function findDanglingToolCalls(messagesOrEntries: unknown[]): DanglingToolCall[] {
	const messages = messagesOfEntries(messagesOrEntries);
	const calls: { call: DanglingToolCall; index: number }[] = [];
	const results = new Map<string, number[]>();
	messages.forEach((msg, index) => {
		for (const c of toolCallsOfMessage(msg)) calls.push({ call: c, index });
		for (const id of toolResultIdsOfMessage(msg)) {
			let arr = results.get(id);
			if (!arr) {
				arr = [];
				results.set(id, arr);
			}
			arr.push(index);
		}
	});
	const out: DanglingToolCall[] = [];
	const seen = new Set<string>();
	for (const { call, index } of calls) {
		const later = (results.get(call.toolCallId) ?? []).some((ri) => ri > index);
		if (!later && !seen.has(call.toolCallId)) {
			seen.add(call.toolCallId);
			out.push(call);
		}
	}
	return out;
}

/**
 * 落盘修复：向会话文件尾追加合成 toolResult（每条悬空调用一条），
 * parentId 链式接在当前尾行之后。append-only——历史字节不动，无需备份。
 * 返回追加条数（0 = 健康，无需处理；-1 = 文件不可读/不可写）。
 */
export function healDanglingToolCallFile(filePath: string): number {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return -1;
	}
	const lines = raw.split("\n");
	const entries: unknown[] = [];
	let lastId: string | null = null;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			entries.push(parsed);
			if (typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string") {
				lastId = (parsed as { id: string }).id;
			}
		} catch {
			// 脏行：SDK 加载时同样跳过，这里忽略。
		}
	}
	if (entries.length === 0) return 0;
	const dangling = findDanglingToolCalls(entries);
	if (dangling.length === 0) return 0;
	try {
		let parentId = lastId;
		for (const d of dangling) {
			const id = `synthetic-tool-result-${randomUUID().slice(0, 8)}`;
			const entry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: d.toolCallId,
					toolName: d.toolName,
					content: [{ type: "text", text: `${DANGLING_TOOL_RESULT_TEXT}\n${DANGLING_TOOL_RESULT_TEXT_EN}` }],
					isError: true,
					timestamp: Date.now(),
				},
			};
			const line = JSON.stringify(entry);
			if (!existsSync(filePath)) return -1;
			appendFileSync(filePath, `${line}\n`, "utf8");
			parentId = id;
		}
		return dangling.length;
	} catch {
		return -1;
	}
}
