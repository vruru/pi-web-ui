// ---------------------------------------------------------------------------
// conversation-read-tool.ts — 让 AI（含子代理）读取别的对话
// ---------------------------------------------------------------------------
// 背景：用户在左栏有「运行的对话」（含子代理）与「历史对话」，也常想让 AI
// 「结合另一个对话的内容回答」。此前 AI 既不知道别的对话的 id，也没有干净的
// 读取通道（只能用 read/bash 翻转录 jsonl，既难找路径又难解析）。
//
// 本工具提供只读双通道：
//   action=list  → 运行中对话（本标签页的全部 conversation，含子代理）+
//                  历史会话转录（scope=current 仅当前项目，all 跨全部项目）；
//   action=read  → 按 id 读运行中对话的实时消息（含未落盘的），或按 path 读
//                  历史转录（只接受会话列表里的路径，任意文件不给读）。
//
// 转录文本走 transcriptText/formatTranscript 纯函数（有单测）；文件解析走
// parseTranscriptLines（jsonl 逐行，坏行跳过）。输出按条数 + 字符数双封顶，
// 长对话分多次 offset 翻页。跨标签页的实时运行读不到——以落盘历史为准，
// description 里会告诉模型这一点。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
// 返回文本按 lang 取 pick(lang, zh, en, key, vars)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { CONVERSATION_READ_TOOL_NAME } from "./tool-manager.js";
import type { AgentMessage } from "./serialize.js";
import {
	extractTouches,
	formatTouchEntry,
	formatTouchesCompact,
	toolCallRefsOfContent,
	type TouchedFile,
	unionTouchLists,
} from "./conversation-touches.js";
import type { ClaimView } from "./claim-store.js";

/** 运行中对话的列表行（ClientSession.convs 的轻量视图）。 */
export interface ConversationListEntry {
	id: string;
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	isSubagent: boolean;
	parentId?: string;
}

/** 历史会话的列表行（SessionInfo 的轻量视图）。 */
export interface HistorySessionEntry {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	cwd: string;
}

/** 转录消息的最小结构（实时 AgentMessage 与转录文件解析结果的公共面）。 */
export interface TranscriptInputMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	summary?: string;
	details?: unknown;
	timestamp?: number;
	/** 该消息里的工具调用参数（additive：一条消息可并列多个 toolCall，故为数组；
	 *  格式化输出仍只看 content，本字段只给触碰集解析/status 摘要等内部消费用。
	 *  content 里的 {type:"toolCall", name, arguments} 块一直都在，
	 *  本字段只是它的便捷访问点，取不到时留空 —— 绝不伪造。） */
	toolCalls?: { name: string; args?: unknown }[];
}

/** 由 ClientSession 实现的数据宿主（读它自己的 conversation 体系 + 会话目录）。 */
export interface ConversationReadHost {
	/** 触碰 sidecar（可选：压缩后旧消息被摘要替代，files 回落现算会丢历史；
	 *  加方法的理由 —— sidecar 按会话文件存，解析路径与转录属同一宿主职责，
	 *  另起通道反而分裂；缺省/读不到时调用方回落现算，不破坏既有实现）。 */
	readTouchSidecar?(id?: string, path?: string): TouchedFile[] | undefined;
	listRunningConversations(): ConversationListEntry[];
	readRunningConversation(
		id: string,
	): { title: string; cwd: string; isSubagent: boolean; messages: TranscriptInputMessage[] } | undefined;
	listHistorySessions(scope: "current" | "all", cwd: string): Promise<HistorySessionEntry[]>;
	/** path 不在会话列表里（越界/手写脏路径）→ undefined，工具转报错。 */
	readHistorySession(path: string): Promise<
		| {
				title: string;
				cwd: string;
				sessionPath: string;
				messages: TranscriptInputMessage[];
		  }
		| undefined
	>;
}

/** 由 content 块提 toolCalls 字段（additive；格式化输出不受影响，见接口注释）。 */
function fillToolCalls(target: TranscriptInputMessage, content: unknown): void {
	const refs = toolCallRefsOfContent(content);
	if (refs.length > 0) target.toolCalls = refs;
}

/** AgentMessage → 转录最小结构（角色原样保留，内容不动，格式化延后）。 */
export function toTranscriptInput(m: AgentMessage): TranscriptInputMessage {
	const role = (m as { role?: unknown }).role;
	const r = typeof role === "string" ? role : "unknown";
	const base: TranscriptInputMessage = { role: r };
	const anyM = m as unknown as Record<string, unknown>;
	if (typeof anyM.content !== "undefined") {
		base.content = anyM.content;
		fillToolCalls(base, anyM.content);
	}
	if (typeof anyM.toolName === "string") base.toolName = anyM.toolName;
	if (typeof anyM.isError === "boolean") base.isError = anyM.isError;
	if (typeof anyM.command === "string") base.command = anyM.command;
	if (typeof anyM.output === "string") base.output = anyM.output;
	if (typeof anyM.summary === "string") base.summary = anyM.summary;
	if (typeof anyM.details !== "undefined") base.details = anyM.details;
	if (typeof anyM.timestamp === "number") base.timestamp = anyM.timestamp;
	return base;
}

/** 内容块 → 纯文本：text 拼接；图片占位；具名块（toolCall 等）留名；其余占位。 */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown; name?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") {
			parts.push(blk.text);
		} else if (blk.type === "image") {
			parts.push("[image]");
		} else if (typeof blk.name === "string" && blk.name) {
			parts.push(`[tool call: ${blk.name}]`);
		} else {
			parts.push("[…]");
		}
	}
	return parts.join("\n");
}

/** 附件 aside 的短名（details.name/path），非附件返回空。 */
function attachmentName(details: unknown): string {
	if (!details || typeof details !== "object") return "";
	const d = details as { name?: unknown; path?: unknown };
	if (typeof d.name === "string" && d.name) return d.name;
	if (typeof d.path === "string" && d.path) return d.path.split(/[\\/]/).pop() ?? d.path;
	return "";
}

/** 单条转录消息 → 可读文本行（角色标签 + 内容，不截断，截断由 format 统一做）。 */
export function transcriptText(m: TranscriptInputMessage): string {
	switch (m.role) {
		case "bashExecution":
			return `[bash $ ${m.command ?? ""}]\n${m.output ?? ""}`;
		case "branchSummary":
			return `[branch summary]\n${m.summary ?? ""}`;
		case "compactionSummary":
			return `[compaction summary]\n${m.summary ?? ""}`;
		case "toolResult": {
			const head = `[tool result${m.toolName ? ` (${m.toolName})` : ""}${m.isError ? " ERROR" : ""}]`;
			const body = textOfContent(m.content);
			return body ? `${head}\n${body}` : head;
		}
		case "custom": {
			const name = attachmentName(m.details);
			const body = textOfContent(m.content);
			const head = name ? `[attachment: ${name}]` : "[note]";
			return body ? `${head}\n${body}` : head;
		}
		case "user":
		case "assistant":
			return textOfContent(m.content);
		default: {
			const body = textOfContent(m.content);
			return body ? `[${m.role}]\n${body}` : `[${m.role}]`;
		}
	}
}

/** 角色标签（列表行里的序号前缀用）。 */
function roleLabel(m: TranscriptInputMessage): string {
	if (m.role === "toolResult") return `tool result${m.toolName ? ` (${m.toolName})` : ""}`;
	return m.role;
}

/** 单条消息截断：超出部分标注剩余字符数（调用方一眼知道丢了多少）。 */
export function truncateCounted(s: string, cap: number): string {
	if (s.length <= cap) return s;
	return `${s.slice(0, cap)}\n… +${s.length - cap} chars`;
}

function trunc(s: string, cap: number): string {
	return truncateCounted(s, cap);
}

export interface FormatTranscriptOpts {
	/** 起始下标（0-based， chronological）。缺省 0。 */
	offset?: number;
	/** 最多取多少条。缺省 50，上限 200。 */
	limit?: number;
	/** 单条消息字符封顶。缺省 2000。 */
	perMsgCap?: number;
	/** 全文字符封顶。缺省 20000。 */
	maxChars?: number;
}

export interface FormattedTranscript {
	text: string;
	total: number;
	from: number;
	to: number;
	/** 还有后文没给（to < total 或撞了 maxChars）。 */
	truncated: boolean;
}

/** 转录分页格式化：序号形如 [12/135 user]，尾部带翻页提示位（调用方拼 header）。 */
export function formatTranscript(messages: TranscriptInputMessage[], opts?: FormatTranscriptOpts): FormattedTranscript {
	const total = messages.length;
	const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
	const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit ?? 50)));
	const perMsgCap = Math.max(100, Math.floor(opts?.perMsgCap ?? 2000));
	const maxChars = Math.min(60000, Math.max(1000, Math.floor(opts?.maxChars ?? 20000)));
	const from = Math.min(offset, total);
	const to = Math.min(from + limit, total);
	const lines: string[] = [];
	for (let i = from; i < to; i++) {
		const m = messages[i];
		lines.push(`[${i + 1}/${total} ${roleLabel(m)}]\n${trunc(transcriptText(m).trim(), perMsgCap)}`);
	}
	let text = lines.join("\n\n");
	let truncated = to < total;
	if (text.length > maxChars) {
		text = `${text.slice(0, maxChars)}\n… [truncated]`;
		truncated = true;
	}
	if (total === 0) text = "";
	return { text, total, from, to, truncated };
}

/**
 * 转录 jsonl → 转录消息（message 条目取 message；compaction/branch_summary
 * 取 summary；坏行跳过）。纯函数：文件读取由宿主做，单测直接喂文本。
 */
export function parseTranscriptLines(text: string): TranscriptInputMessage[] {
	const out: TranscriptInputMessage[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let e: {
			type?: unknown;
			message?: {
				role?: unknown;
				content?: unknown;
				toolName?: unknown;
				isError?: unknown;
				details?: unknown;
				timestamp?: unknown;
			};
			summary?: unknown;
		};
		try {
			e = JSON.parse(t);
		} catch {
			continue;
		}
		if (e?.type === "message" && e.message && typeof e.message.role === "string") {
			const msg = e.message;
			const m: TranscriptInputMessage = { role: msg.role as string };
			if (typeof msg.content !== "undefined") {
				m.content = msg.content;
				fillToolCalls(m, msg.content);
			}
			if (typeof msg.toolName === "string") m.toolName = msg.toolName;
			if (typeof msg.isError === "boolean") m.isError = msg.isError;
			if (typeof msg.details !== "undefined") m.details = msg.details;
			if (typeof msg.timestamp === "number") m.timestamp = msg.timestamp;
			out.push(m);
			continue;
		}
		if ((e?.type === "compaction" || e?.type === "branch_summary") && typeof e.summary === "string") {
			out.push({
				role: e.type === "compaction" ? "compactionSummary" : "branchSummary",
				summary: e.summary,
			});
		}
	}
	return out;
}

/** 大小写不敏感子串（空 query 全匹配）。 */
function matchesHay(hay: string, q: string): boolean {
	return q === "" || hay.toLowerCase().includes(q);
}

/** action=read 的视图：chat 只给 user/assistant 文本（默认，省 token），
 *  full 才含工具调用与结果（含 bash 输出、附件 aside、压缩摘要）。 */
export type ReadView = "chat" | "full";

export interface ReadSelectionOpts {
	view?: ReadView;
	/** 取最新 N 条（取代猜 offset；与 offset 同给时 last 先生效）。 */
	last?: number;
	/** 对话内搜索（大小写不敏感）：只回命中消息 ±1 条上下文。 */
	query?: string;
}

export interface ReadSelection {
	/** view/last/query 层层筛选后的消息（offset/limit 分页之前）。 */
	selected: TranscriptInputMessage[];
	/** view 过滤后的总数（last/query 之前；header 里报数用）。 */
	totalInView: number;
	/** query 模式：命中消息在 view 内选区的序号（0-based 排序，不含上下文；
	 *  header 里报位置用 —— 与 offset 分页同一坐标系，都是选区相对位置。
	 *  selected 是命中 ±1 上下文展开）。 */
	hitIndices: number[];
}

/** read 选择器（纯函数）：view → query → last 的顺序固定，见注释。 */
export function selectReadMessages(messages: TranscriptInputMessage[], opts?: ReadSelectionOpts): ReadSelection {
	const list = Array.isArray(messages) ? messages : [];
	const view: ReadView = opts?.view === "full" ? "full" : "chat";
	const inView = view === "full" ? list : list.filter((m) => m.role === "user" || m.role === "assistant");
	const q = (opts?.query ?? "").trim().toLowerCase();
	let selected = inView;
	let hitIndices: number[] = [];
	if (q) {
		// 在 view 内按转录文本搜：hitIndices 只记命中（报数/定位用），
		// selected 是命中 ±1 条上下文展开（去重保序）。
		const hits: number[] = [];
		const keep = new Set<number>();
		for (let i = 0; i < inView.length; i++) {
			if (transcriptText(inView[i]).toLowerCase().includes(q)) {
				hits.push(i);
				for (let j = Math.max(0, i - 1); j <= Math.min(inView.length - 1, i + 1); j++) keep.add(j);
			}
		}
		hitIndices = hits;
		selected = [...keep].sort((a, b) => a - b).map((i) => inView[i]);
	}
	const last = opts?.last;
	if (typeof last === "number" && Number.isFinite(last)) {
		const n = Math.min(200, Math.max(1, Math.floor(last)));
		if (selected.length > n) {
			selected = selected.slice(selected.length - n);
			// last 裁掉上下文外层时命中序号跟走（只留仍在选区内的）。
			if (hitIndices.length > 0) {
				const keep = new Set(selected);
				hitIndices = hitIndices.filter((i) => keep.has(inView[i]));
			}
		}
	}
	return { selected, totalInView: inView.length, hitIndices };
}

/** 工具参数里的一句话提示（path/command，单行 ≤80 字符；拿不到就空串）。 */
function toolHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as { path?: unknown; file_path?: unknown; filePath?: unknown; command?: unknown };
	for (const k of ["path", "file_path", "filePath", "command"] as const) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) {
			const oneLine = v.trim().replace(/\s+/g, " ");
			return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
		}
	}
	return "";
}

export interface ConversationSummary {
	/** 从尾往前第一条工具调用（含 bashExecution），没有则 undefined。 */
	lastTool?: { name: string; hint: string };
	/** 最后一条 assistant 消息的纯文本（文本块拼接），没有则 undefined。 */
	lastAssistant?: string;
	/** 是否在等用户回答问卷：最后一次 ask_user_question 调用之后没有同名
	 *  toolResult（pi 引擎问卷走工具调用，可从转录推断；DSH 问卷不走工具，
	 *  推断不出 —— 见 status 文案里的诚实说明，只报能确定的）。 */
	waitingQuestion: boolean;
}

/** action=status 的摘要器（纯函数）：只读转录，不碰 host。 */
export function summarizeConversation(messages: TranscriptInputMessage[]): ConversationSummary {
	const list = Array.isArray(messages) ? messages : [];
	let lastTool: ConversationSummary["lastTool"];
	let lastAssistant: ConversationSummary["lastAssistant"];
	let lastAskIdx = -1;
	let lastAskResultIdx = -1;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (!m || typeof m !== "object") continue;
		if (m.role === "assistant") {
			const textParts: string[] = [];
			const calls = toolCallRefsOfContent(m.content);
			if (m.toolCalls && m.toolCalls.length > 0) {
				for (const c of m.toolCalls) {
					if (c && typeof c.name === "string") {
						lastTool = { name: c.name, hint: toolHint(c.args) };
						if (c.name === "ask_user_question") lastAskIdx = i;
					}
				}
			} else {
				for (const c of calls) {
					lastTool = { name: c.name, hint: toolHint(c.args) };
					if (c.name === "ask_user_question") lastAskIdx = i;
				}
			}
			if (Array.isArray(m.content)) {
				for (const b of m.content) {
					if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
						const t = (b as { text?: unknown }).text;
						if (typeof t === "string" && t) textParts.push(t);
					}
				}
			}
			const joined = textParts.join("\n").trim();
			if (joined) lastAssistant = joined;
		} else if (m.role === "bashExecution" && typeof m.command === "string") {
			lastTool = { name: "bash", hint: toolHint({ command: m.command }) };
		} else if (m.role === "toolResult" && m.toolName === "ask_user_question") {
			lastAskResultIdx = i;
		}
	}
	return { lastTool, lastAssistant, waitingQuestion: lastAskIdx >= 0 && lastAskResultIdx < lastAskIdx };
}

/** read 的附加说明行：query 命中位置 + chat 视图裁剪说明（纯函数）。 */
export function readExtraLines(
	L: ServerLang,
	query: string,
	sel: ReadSelection,
	rawTotal: number,
	view: ReadView,
): string {
	const lines: string[] = [];
	const q = query.trim();
	if (q && sel.hitIndices.length > 0) {
		const shown = sel.hitIndices.slice(0, 20).map((i) => i + 1);
		const idx = sel.hitIndices.length > 20 ? `${shown.join("、")}… (+${sel.hitIndices.length - 20})` : shown.join("、");
		lines.push(
			pick(
				L,
				`在对话内搜「${q}」：命中 ${sel.hitIndices.length} 条（选区第 ${idx} 条），上下文共 ${sel.selected.length} 条。`,
				`Searched for "${q}": ${sel.hitIndices.length} hit(s) (#${idx} in this selection), ${sel.selected.length} with context.`,
				"convread.read.query.head",
				{ q, hits: sel.hitIndices.length, indices: idx, shown: sel.selected.length },
			),
		);
	}
	if (view === "chat" && rawTotal > sel.totalInView) {
		lines.push(
			pick(
				L,
				`（chat 视图只含 user/assistant 共 ${sel.totalInView} 条；另有 ${rawTotal - sel.totalInView} 条工具调用/结果，用 view="full" 看。）`,
				`(chat view: only user/assistant, ${sel.totalInView} messages; ${rawTotal - sel.totalInView} more tool messages with view="full".)`,
				"convread.read.chat.note",
				{ chat: sel.totalInView, tools: rawTotal - sel.totalInView },
			),
		);
	}
	return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/** 认领行格式化（files/status 共用，纯函数；head 文案各调用方自己 pick）。
 *  style: bullets = 独立成行（files 块用）；inline = 行内逗分（status 一行用）。 */
export function formatClaimLines(claims: ClaimView[], maxItems = 5, style: "bullets" | "inline" = "bullets"): string[] {
	const list = Array.isArray(claims) ? claims : [];
	const shown = list.slice(0, Math.max(1, Math.floor(maxItems)));
	const dash = style === "bullets" ? "- " : "";
	const lines = shown.map((c) => `${dash}${c.path} · 「${c.ownerTitle}」${c.note ? ` · ${c.note}` : ""}`);
	if (list.length > shown.length) lines.push(`… (+${list.length - shown.length})`);
	return lines;
}

export function filterRunning(list: ConversationListEntry[], query: string): ConversationListEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((c) => matchesHay(c.id, q) || matchesHay(c.title, q) || matchesHay(c.cwd, q));
}

export function filterHistory(list: HistorySessionEntry[], query: string): HistorySessionEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((s) => matchesHay(s.path, q) || matchesHay(s.name ?? "", q) || matchesHay(s.firstMessage, q));
}

/** 短 id/路径展示（列表行里路径太长只留尾部）。 */
export function shortPath(p: string, keep = 48): string {
	return p.length <= keep ? p : `…${p.slice(p.length - keep)}`;
}

/** action=list 的默认条数：历史默认 15（以前无上限，几百条一次吐完）；
 *  运行中默认不限但给上限（并发对话再多也不会撑爆 details 的 64KB）。 */
export const HISTORY_LIST_DEFAULT = 15;
export const RUNNING_LIST_CAP = 50;
/** action=read 单条消息默认截断（约 600 字符，超出标 “… +N chars”；
 *  以前默认 2000，一条 bash 输出就能吃掉整个 maxChars 预算）。 */
export const READ_PER_MSG_CAP = 600;

/** conversation_read 的可选外挂（认领表住在 AgentService，不属 ConversationReadHost
 *  「读自己 conversation 体系」的职责，单独传；没有就跳过展示，不报错）。 */
export interface ConversationReadExtras {
	listClaims?: (cwd: string) => ClaimView[];
}

export function makeConversationReadTool(
	host: ConversationReadHost,
	lang?: () => ServerLang,
	extras?: ConversationReadExtras,
): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: CONVERSATION_READ_TOOL_NAME,
		label: "Read another conversation",
		description:
			"Read ANOTHER conversation: a running conversation of this client (incl. subagents — id from action=list) or a persisted history session (file path). " +
			"Use when the user references another chat. list: running + history sessions (query filter, limit). " +
			"read: one transcript — view=chat (default, user/assistant text) or full (incl. tool calls); last=N latest; query searches within (±1 context); messages capped ~600 chars. " +
			"files: files it created/modified. status: last tool call, last assistant text, pending question. " +
			"Only listed sessions are readable; other tabs' live runs appear in history once persisted.",
		promptSnippet:
			"read another conversation: list/find chats, read transcript (chat view / tail / search), touched files, status summary",
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({
					description:
						'list = show running conversations + history sessions; read = fetch one transcript. Default "list".',
				}),
			),
			scope: Type.Optional(
				Type.String({
					description: 'list only: "current" = this project, "all" = every project. Default "all".',
				}),
			),
			kind: Type.Optional(
				Type.String({
					description: 'list only: "running" | "history" | "all" (which sections to show). Default "all".',
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"list: case-insensitive filter over id/title/path/first message. read/files: search within the transcript (read returns hits ±1 context).",
				}),
			),
			view: Type.Optional(
				Type.String({
					description:
						'read only: "chat" = only user/assistant text (default, cheap); "full" = incl. tool calls/results.',
				}),
			),
			last: Type.Optional(
				Type.Number({ description: "read only: take the latest N messages (1-200) instead of guessing offset." }),
			),
			id: Type.Optional(
				Type.String({ description: 'read only: running conversation id (e.g. "c3"), from action=list.' }),
			),
			path: Type.Optional(Type.String({ description: "read only: history session file path, from action=list." })),
			offset: Type.Optional(Type.Number({ description: "read only: first message index (0-based). Default 0." })),
			limit: Type.Optional(
				Type.Number({
					description:
						"list: max entries per section (history defaults to 15, running uncapped up to 50). read/files: max messages/entries (1-200, default 50).",
				}),
			),
			maxChars: Type.Optional(Type.Number({ description: "read only: max characters (1000-60000). Default 20000." })),
		}),
		execute: async (_id, p, _signal, _onUpdate, ctx) => {
			const action = (p.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				const scopeRaw = (p.scope ?? "all").trim().toLowerCase();
				if (scopeRaw !== "current" && scopeRaw !== "all") {
					return text(
						pick(
							getLang(),
							`scope 非法：${p.scope}（只能是 current 或 all）。`,
							`Invalid scope: ${p.scope} (must be "current" or "all").`,
							"convread.list.bad.scope",
							{ "p.scope": p.scope },
						),
					);
				}
				const scope = scopeRaw as "current" | "all";
				const kindRaw = (p.kind ?? "all").trim().toLowerCase();
				if (kindRaw !== "running" && kindRaw !== "history" && kindRaw !== "all") {
					return text(
						pick(
							getLang(),
							`kind 非法：${p.kind}（只能是 running、history 或 all）。`,
							`Invalid kind: ${p.kind} (must be "running", "history" or "all").`,
							"convread.list.bad.kind",
							{ "p.kind": p.kind },
						),
					);
				}
				const kind = kindRaw as "running" | "history" | "all";
				const query = typeof p.query === "string" ? p.query : "";
				const cap =
					typeof p.limit === "number" && Number.isFinite(p.limit)
						? Math.min(200, Math.max(1, Math.floor(p.limit)))
						: undefined;
				// kind 过滤掉的一整节直接不取不展（不为了它多一次 I/O）。
				const running = kind === "history" ? [] : filterRunning(host.listRunningConversations(), query);
				const history = kind === "running" ? [] : filterHistory(await host.listHistorySessions(scope, ctx.cwd), query);
				const shownRunning = running.slice(0, cap ?? RUNNING_LIST_CAP);
				const shownHistory = history.slice(0, cap ?? HISTORY_LIST_DEFAULT);
				const L = getLang();
				const runLines = shownRunning.map(
					(c) =>
						`- ${c.id} · ${c.title} · ${c.isSubagent ? (L === "zh" ? "子代理" : "subagent") : L === "zh" ? "对话" : "chat"}${
							c.isStreaming ? (L === "zh" ? "（进行中）" : " (streaming)") : ""
						} · ${c.messageCount} msgs · ${c.cwd}`,
				);
				const histLines = shownHistory.map(
					(s) =>
						`- ${shortPath(s.path)} · ${s.name || s.firstMessage || (L === "zh" ? "（空对话）" : "(empty)")}${
							s.messageCount ? ` · ${s.messageCount} msgs` : ""
						}`,
				);
				// 超出 cap 时给计数 + 收窄指引（静默丢弃是大忌：调用方会以为这就是全量）。
				if (running.length > shownRunning.length) {
					runLines.push(
						pick(
							L,
							`… 还有 ${running.length - shownRunning.length} 条运行中（用 query 或 limit 收窄）。`,
							`… ${running.length - shownRunning.length} more running (narrow with query or limit).`,
							"convread.list.running.more",
							{ n: running.length - shownRunning.length },
						),
					);
				}
				if (history.length > shownHistory.length) {
					histLines.push(
						pick(
							L,
							`… 还有 ${history.length - shownHistory.length} 条历史（用 query 或 limit 收窄；默认只给 ${HISTORY_LIST_DEFAULT} 条）。`,
							`… ${history.length - shownHistory.length} more history (narrow with query or limit; default shows ${HISTORY_LIST_DEFAULT}).`,
							"convread.list.history.more",
							{ n: history.length - shownHistory.length },
						),
					);
				}
				const head =
					kind === "running"
						? pick(
								L,
								`运行中对话（${running.length}）：`,
								`Running conversations (${running.length}):`,
								"convread.list.head.running",
								{ n: running.length },
							)
						: kind === "history"
							? pick(
									L,
									`历史会话（${history.length}，scope=${scope}）：`,
									`History sessions (${history.length}, scope=${scope}):`,
									"convread.list.head.history",
									{ n: history.length },
								)
							: pick(
									L,
									`运行中对话（${running.length}）+ 历史会话（${history.length}，scope=${scope}）：`,
									`Running conversations (${running.length}) + history sessions (${history.length}, scope=${scope}):`,
									"convread.list.head.all",
									{ running: running.length, history: history.length },
								);
				const runHead = L === "zh" ? "【运行中】" : "[running]";
				const histHead = L === "zh" ? "【历史】" : "[history]";
				const empty = L === "zh" ? "（无）" : "(none)";
				const tail =
					L === "zh"
						? `读某一份：conversation_read(action="read", id="c…") 或 conversation_read(action="read", path="…")，长转录用 offset/limit 翻页；只看文件用 action="files"，先看摘要再决定读不读用 action="status"。`
						: `To read one: conversation_read(action="read", id="c…") or conversation_read(action="read", path="…"); page long transcripts with offset/limit; action="files" lists touched files, action="status" summarizes before you decide to read.`;
				const sections =
					kind === "history"
						? `${head}\n${histHead}\n${histLines.join("\n") || empty}`
						: kind === "running"
							? `${head}\n${runHead}\n${runLines.join("\n") || empty}`
							: `${head}\n${runHead}\n${runLines.join("\n") || empty}\n${histHead}\n${histLines.join("\n") || empty}`;
				// details 同样有界：只带展示出的条目（历史的 firstMessage 再掐到 160
				// 字符），以前整量 history 进 details 会撑爆 64KB 被整段丢弃。
				return text(`${sections}\n${tail}`, {
					scope,
					kind,
					runningTotal: running.length,
					historyTotal: history.length,
					running: shownRunning,
					history: shownHistory.map((s) => ({
						...s,
						firstMessage:
							typeof s.firstMessage === "string" && s.firstMessage.length > 160
								? `${s.firstMessage.slice(0, 160)}…`
								: s.firstMessage,
					})),
					truncated: running.length > shownRunning.length || history.length > shownHistory.length,
				});
			}
			if (action === "read") {
				const viewRaw = (p.view ?? "chat").trim().toLowerCase();
				if (viewRaw !== "chat" && viewRaw !== "full") {
					return text(
						pick(
							getLang(),
							`view 非法：${p.view}（只能是 chat 或 full）。`,
							`Invalid view: ${p.view} (must be "chat" or "full").`,
							"convread.read.bad.view",
							{ "p.view": p.view },
						),
					);
				}
				const view = viewRaw as ReadView;
				const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
				const path = typeof p.path === "string" && p.path.trim() ? p.path.trim() : undefined;
				if ((id && path) || (!id && !path)) {
					return text(
						pick(
							getLang(),
							`action=read 需要且只需要 id 或 path 其中之一（id 读运行中对话，path 读历史转录）。`,
							`action=read needs exactly one of id or path (id = running conversation, path = history transcript).`,
							"convread.read.bad.args",
						),
					);
				}
				const query = typeof p.query === "string" ? p.query : "";
				const opts = { offset: p.offset, limit: p.limit, maxChars: p.maxChars, perMsgCap: READ_PER_MSG_CAP };
				if (id) {
					const found = host.readRunningConversation(id);
					if (!found) {
						return text(
							pick(
								getLang(),
								`未找到运行中对话 ${id}（可能已关闭；用 action=list 看当前列表，落盘的可按 path 读历史）。`,
								`Running conversation ${id} not found (may be closed; use action=list for the current list, or read persisted ones by path).`,
								"convread.read.id.not.found",
								{ id },
							),
						);
					}
					const rawTotal = found.messages.length;
					const sel = selectReadMessages(found.messages, { view, last: p.last, query });
					const L = getLang();
					if (query.trim() && sel.hitIndices.length === 0) {
						return text(
							pick(
								L,
								`在对话内搜「${query.trim()}」：没有命中。换个词，或用 view="full" 把工具输出也纳入搜索。`,
								`No hits for "${query.trim()}". Try another term, or use view="full" to include tool outputs.`,
								"convread.read.query.empty",
								{ q: query.trim() },
							),
							{ id, title: found.title, view, query: query.trim(), hits: 0 },
						);
					}
					const f = formatTranscript(sel.selected, opts);
					const head =
						L === "zh"
							? `对话「${found.title}」（id=${id}${found.isSubagent ? "，子代理" : ""}，${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
							: `Conversation "${found.title}" (id=${id}${found.isSubagent ? ", subagent" : ""}, ${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
					const notes = readExtraLines(L, query, sel, rawTotal, view);
					const more =
						f.truncated && f.total > 0
							? L === "zh"
								? `\n…还有后文（offset=${f.to} 再取）。`
								: `\n…more below (re-call with offset=${f.to}).`
							: "";
					const emptyNote = f.total === 0 ? (L === "zh" ? "（该对话暂无消息）" : "(no messages yet)") : "";
					return text(`${head}${notes}\n${f.text || emptyNote}${more}`, {
						id,
						title: found.title,
						view,
						...(query.trim() ? { query: query.trim(), hitIndices: sel.hitIndices.slice(0, 500) } : {}),
						total: f.total,
						rawTotal,
						from: f.from,
						to: f.to,
					});
				}
				const found = await host.readHistorySession(path!);
				if (!found) {
					return text(
						pick(
							getLang(),
							`读不到历史会话 ${path}（不在会话列表里：只能读 action=list 列出的转录路径）。`,
							`Cannot read history session ${path} (not in the session list: only transcripts from action=list can be read).`,
							"convread.read.path.not.found",
							{ path },
						),
					);
				}
				const rawTotal = found.messages.length;
				const sel = selectReadMessages(found.messages, { view, last: p.last, query });
				const L = getLang();
				if (query.trim() && sel.hitIndices.length === 0) {
					return text(
						pick(
							L,
							`在对话内搜「${query.trim()}」：没有命中。换个词，或用 view="full" 把工具输出也纳入搜索。`,
							`No hits for "${query.trim()}". Try another term, or use view="full" to include tool outputs.`,
							"convread.read.query.empty",
							{ q: query.trim() },
						),
						{ path: found.sessionPath, title: found.title, view, query: query.trim(), hits: 0 },
					);
				}
				const f = formatTranscript(sel.selected, opts);
				const head =
					L === "zh"
						? `历史会话「${found.title || found.sessionPath}」（${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
						: `History session "${found.title || found.sessionPath}" (${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
				const notes = readExtraLines(L, query, sel, rawTotal, view);
				const more =
					f.truncated && f.total > 0
						? L === "zh"
							? `\n…还有后文（offset=${f.to} 再取）。`
							: `\n…more below (re-call with offset=${f.to}).`
						: "";
				const emptyNote = f.total === 0 ? (L === "zh" ? "（该会话暂无消息）" : "(no messages yet)") : "";
				return text(`${head}${notes}\n${f.text || emptyNote}${more}`, {
					path: found.sessionPath,
					title: found.title,
					view,
					...(query.trim() ? { query: query.trim(), hitIndices: sel.hitIndices.slice(0, 500) } : {}),
					total: f.total,
					rawTotal,
					from: f.from,
					to: f.to,
				});
			}
			if (action === "files" || action === "status") {
				const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
				const path = typeof p.path === "string" && p.path.trim() ? p.path.trim() : undefined;
				if ((id && path) || (!id && !path)) {
					return text(
						pick(
							getLang(),
							`action=${action} 需要且只需要 id 或 path 其中之一（id 读运行中对话，path 读历史转录）。`,
							`action=${action} needs exactly one of id or path (id = running conversation, path = history transcript).`,
							action === "files" ? "convread.files.bad.args" : "convread.status.bad.args",
						),
					);
				}
				// 取数（错误复用 read 的 not found 文案：同一个“找不到”语义）。
				let title = "";
				let cwd = "";
				let messages: TranscriptInputMessage[] = [];
				if (id) {
					const found = host.readRunningConversation(id);
					if (!found) {
						return text(
							pick(
								getLang(),
								`未找到运行中对话 ${id}（可能已关闭；用 action=list 看当前列表，落盘的可按 path 读历史）。`,
								`Running conversation ${id} not found (may be closed; use action=list for the current list, or read persisted ones by path).`,
								"convread.read.id.not.found",
								{ id },
							),
						);
					}
					title = found.title;
					cwd = found.cwd;
					messages = found.messages;
				} else {
					const found = await host.readHistorySession(path!);
					if (!found) {
						return text(
							pick(
								getLang(),
								`读不到历史会话 ${path}（不在会话列表里：只能读 action=list 列出的转录路径）。`,
								`Cannot read history session ${path} (not in the session list: only transcripts from action=list can be read).`,
								"convread.read.path.not.found",
								{ path },
							),
						);
					}
					title = found.title || found.sessionPath;
					cwd = found.cwd;
					messages = found.messages;
				}
				const L = getLang();
				const where = id ? { id } : { path };
				if (action === "files") {
					const fq = (typeof p.query === "string" ? p.query : "").trim().toLowerCase();
					// sidecar（压缩前的触碰）∪ 实时转录：union 语义，见 unionTouchLists。
					const all = unionTouchLists(host.readTouchSidecar?.(id, path) ?? [], extractTouches(messages));
					const filtered = fq ? all.filter((t) => t.path.toLowerCase().includes(fq)) : all;
					const listedClaims = (() => {
						try {
							const rows = extras?.listClaims?.(cwd) ?? [];
							return fq ? rows.filter((c) => c.path.toLowerCase().includes(fq)) : rows;
						} catch {
							return [];
						}
					})();
					const cap =
						typeof p.limit === "number" && Number.isFinite(p.limit)
							? Math.min(200, Math.max(1, Math.floor(p.limit)))
							: 50;
					const shown = filtered.slice(0, cap);
					if (filtered.length === 0 && listedClaims.length === 0) {
						return text(
							pick(
								L,
								`对话「${title}」还没有可识别的文件写入（只读围观/刚开场/压缩丢了旧记录都有可能）。`,
								`Conversation "${title}" has no recognizable file writes yet (read-only so far, just started, or pre-compaction touches lost).`,
								"convread.files.empty",
								{ title },
							),
							{ ...where, title, total: 0, files: [] },
						);
					}
					const sections: string[] = [];
					if (filtered.length > 0) {
						const lines = shown.map((t) => `- ${formatTouchEntry(t)}`);
						if (filtered.length > shown.length) {
							lines.push(
								pick(
									L,
									`… 还有 ${filtered.length - shown.length} 个（用 query 或 limit 收窄）。`,
									`… ${filtered.length - shown.length} more (narrow with query or limit).`,
									"convread.files.more",
									{ n: filtered.length - shown.length },
								),
							);
						}
						sections.push(
							`${pick(
								L,
								`对话「${title}」创建/修改过的文件（${filtered.length} 个，只算写不算读）：`,
								`Files created/modified by "${title}" (${filtered.length}, writes only):`,
								"convread.files.head",
								{ title, total: filtered.length },
							)}\n${lines.join("\n")}`,
						);
					}
					if (listedClaims.length > 0) {
						sections.push(
							`${pick(
								L,
								`本项目认领（${listedClaims.length} 条，绕行参考，先到先得）：`,
								`Claims in this project (${listedClaims.length}, steer clear, first-wins):`,
								"convread.files.claims",
								{ total: listedClaims.length },
							)}\n${formatClaimLines(listedClaims).join("\n")}`,
						);
					}
					return text(sections.join("\n"), {
						...where,
						title,
						total: filtered.length,
						files: shown,
						claims: listedClaims.map((c) => ({ path: c.path, ownerTitle: c.ownerTitle })),
					});
				}
				// action === "status"：一两行摘要，读全文前的低成本侦察。
				const sum = summarizeConversation(messages);
				const touched = unionTouchLists(host.readTouchSidecar?.(id, path) ?? [], extractTouches(messages)).slice(0, 6);
				let statusClaims: ClaimView[] = [];
				try {
					statusClaims = extras?.listClaims?.(cwd) ?? [];
				} catch {
					statusClaims = [];
				}
				const head = pick(
					L,
					`对话「${title}」状态（共 ${messages.length} 条）：`,
					`Status of "${title}" (${messages.length} messages):`,
					"convread.status.head",
					{ title, total: messages.length },
				);
				const toolLine = sum.lastTool
					? pick(
							L,
							`最后工具：${sum.lastTool.name}${sum.lastTool.hint ? `（${sum.lastTool.hint}）` : ""}。`,
							`Last tool: ${sum.lastTool.name}${sum.lastTool.hint ? ` (${sum.lastTool.hint})` : ""}.`,
							"convread.status.last.tool",
							{ name: sum.lastTool.name, hint: sum.lastTool.hint },
						)
					: pick(L, `还没调用过工具。`, `No tool calls yet.`, "convread.status.no.tool");
				const sayLine = sum.lastAssistant
					? pick(
							L,
							`最后一句：${truncateCounted(sum.lastAssistant, 200)}`,
							`Last assistant message: ${truncateCounted(sum.lastAssistant, 200)}`,
							"convread.status.last.say",
							{ text: truncateCounted(sum.lastAssistant, 200) },
						)
					: pick(L, `assistant 还没说过话。`, `No assistant message yet.`, "convread.status.no.say");
				const touchLine =
					touched.length > 0
						? pick(
								L,
								`最近动过：${formatTouchesCompact(touched, { maxItems: 5 })}。`,
								`Recently touched: ${formatTouchesCompact(touched, { maxItems: 5 })}.`,
								"convread.status.touched",
								{ files: formatTouchesCompact(touched, { maxItems: 5 }) },
							)
						: pick(L, `最近没动过文件。`, `No files touched recently.`, "convread.status.touched.none");
				// 等问卷只能从转录推断（ask_user_question 调了没回）；DSH 问卷不走
				// 工具调用，推断不出 —— 文案写“转录显示”，不夸大。
				const waitLine = sum.waitingQuestion
					? `\n${pick(
							L,
							`⚠ 转录显示它在等用户回答问卷（先回它，再干别的）。`,
							`⚠ The transcript shows it waiting for a question answer (answer first).`,
							"convread.status.waiting",
						)}`
					: "";
				// 认领只在有的时候占一行（没有就不提，省 token）。
				const claimLine =
					statusClaims.length > 0
						? `\n- ${pick(
								L,
								`认领：${formatClaimLines(statusClaims, 3, "inline").join("、")}。`,
								`Claims: ${formatClaimLines(statusClaims, 3, "inline").join("; ")}.`,
								"convread.status.claims",
								{ total: statusClaims.length },
							)}`
						: "";
				return text(`${head}\n- ${toolLine}\n- ${sayLine}\n- ${touchLine}${claimLine}${waitLine}`, {
					...where,
					title,
					lastTool: sum.lastTool,
					lastAssistant: sum.lastAssistant ? truncateCounted(sum.lastAssistant, 200) : undefined,
					touched: touched.slice(0, 5),
					claims: statusClaims.map((c) => ({ path: c.path, ownerTitle: c.ownerTitle })),
					waitingQuestion: sum.waitingQuestion,
				});
			}
			return text(
				pick(
					getLang(),
					`action 非法：${p.action}（只能是 list、read、files 或 status）。`,
					`Invalid action: ${p.action} (must be "list", "read", "files" or "status").`,
					"convread.bad.action",
					{ "p.action": p.action },
				),
			);
		},
	});
}
