// ---------------------------------------------------------------------------
// compact-context-tool.ts — 主动压缩上下文工具（compact_context）
// ---------------------------------------------------------------------------
// 让 AI 可以根据当前问题主动触发上下文压缩，自主决定保留和当前问题相关的内容，
// 去除或深度压缩与当前问题无关、弱相关的历史探索与冗余输出。
//
// 执行时机：当 AI 在当前回合调用本工具后，本工具记录 pending 压缩请求并返回成功；
// 在当前回合结束后（agent_settled 时会话处于完全 idle 状态），系统自动应用 AI
// 指定的保留范围（keepRecentTokens）与关注点（focus / summary），执行 SDK 的
// context compaction，使精炼后的上下文在后续交互中持续生效。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { COMPACT_CONTEXT_TOOL_NAME } from "./tool-manager.js";

/** 工具名（唯一登记在 tool-manager.ts，在此 re-export 供外部模块引用）。 */
export { COMPACT_CONTEXT_TOOL_NAME };

/** 待执行的主动压缩请求记录。 */
export interface PendingCompaction {
	/** 针对当前问题的压缩重点指示（保留什么、去除什么）。 */
	focus: string;
	/** 自主指定的近期保留 token 数（不压缩的近期上下文范围）。 */
	keepRecentTokens?: number;
	/** AI 自主编写的压缩摘要内容（若提供则作为总结核心）。 */
	summary?: string;
	/** 请求时间戳。 */
	requestedAt: number;
}

/** 供 compact_context 工具调用的宿主接口（由 ClientSession / Conversation 桥接）。 */
export interface CompactContextHost {
	/** 获取当前会话 ID。 */
	conversationId(): string;
	/** 获取当前会话的上下文统计信息（消息条数、估算 tokens）。 */
	getContextStats(): { messageCount: number; estimatedTokens: number };
	/** 记录待在回合结算后执行的压缩请求。 */
	scheduleCompaction(compaction: PendingCompaction): void;
}

/** 最小允许保留近期 tokens 下限。 */
export const MIN_KEEP_RECENT_TOKENS = 1000;
/** 最大允许保留近期 tokens 上限。 */
export const MAX_KEEP_RECENT_TOKENS = 100000;
/** SDK 默认的常规保留 tokens。 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * 智能计算生效的 keepRecentTokens：
 * - 若 AI 显式指定，钳制到合法区间 [MIN_KEEP_RECENT_TOKENS, MAX_KEEP_RECENT_TOKENS]；
 * - 若未显式指定，根据当前会话估算 tokens 动态计算：
 *   会话较大时（>= 30000）保留默认 20000 tokens；
 *   会话中等或较小时（< 30000），保留最近约 35%（且不低于 1500 tokens），
 *   确保即便会话只有数千 tokens 时，也能成功切出前半段历史进行压缩，避免报 session too small。
 * 纯函数。
 */
export function calculateEffectiveKeepRecentTokens(requestedTokens?: number, currentEstimatedTokens?: number): number {
	if (typeof requestedTokens === "number" && Number.isFinite(requestedTokens)) {
		return Math.min(MAX_KEEP_RECENT_TOKENS, Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(requestedTokens)));
	}
	const current = Math.max(0, currentEstimatedTokens ?? 0);
	if (current >= 30000) {
		return DEFAULT_KEEP_RECENT_TOKENS;
	}
	if (current > 0) {
		// 动态保留约 35%，至少保留 1500 tokens，上限不超过 DEFAULT_KEEP_RECENT_TOKENS
		const dynamicTokens = Math.max(1500, Math.floor(current * 0.35));
		return Math.min(DEFAULT_KEEP_RECENT_TOKENS, dynamicTokens);
	}
	return DEFAULT_KEEP_RECENT_TOKENS;
}

/**
 * 组装给 SDK compaction 的完整指示文本：
 * 融入 focus 指示与 AI 自主提炼的 customSummary。纯函数。
 */
export function buildCompactionInstructions(focus: string, customSummary?: string): string {
	const trimmedFocus = focus.trim();
	const trimmedSummary = customSummary?.trim();
	if (!trimmedSummary) return trimmedFocus;
	return `${trimmedFocus}\n\n[Key Points / Summary to Retain]\n${trimmedSummary}`;
}

export const CompactContextParams = Type.Object({
	focus: Type.String({
		description:
			"Compression focus and requirements for the current issue/task. State: 1) the active problem/goal; 2) context to PRESERVE (key decisions, code changes, conventions, user constraints); 3) what to REMOVE or condense (failed attempts, resolved debugging, off-topic history).",
	}),
	keepRecentTokens: Type.Optional(
		Type.Number({
			description:
				"Recent tokens to keep uncompacted (1000-64000). Smaller values (e.g. 3000-8000) compact more aggressively. Omit = auto-calculated from session size.",
		}),
	),
	summary: Type.Optional(
		Type.String({
			description:
				"Custom structured summary written by you; used as the core basis for the compaction entry if provided.",
		}),
	),
});

export type CompactContextParamsType = Static<typeof CompactContextParams>;

export function makeCompactContextTool(host: CompactContextHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");

	return defineTool<typeof CompactContextParams, Record<string, unknown>>({
		name: COMPACT_CONTEXT_TOOL_NAME,
		label: "Compact conversation context based on current issue",
		description:
			"Compress/compact the conversation context around the current task: specify what to preserve (key decisions, code structure, active requirements) and what to drop or heavily summarize (unrelated exploration, verbose outputs, resolved debugging). " +
			"Optionally control how many recent tokens stay untouched. Compaction executes when the current turn settles, refreshing context for subsequent turns.",
		promptSnippet: "proactively compact conversation context focusing on the current issue",
		promptGuidelines: [
			"Use compact_context when the conversation has grown long, or after extensive debugging/exploration, to focus context strictly on the current problem.",
			"Clearly specify in 'focus' what to keep (decisions, specs, active changes) and what to drop (failed attempts, voluminous command outputs).",
			"After calling compact_context, conclude your current turn with a brief wrap-up and next steps; the system executes compaction right after this turn finishes.",
		],
		parameters: CompactContextParams,
		execute: async (_id, p) => {
			const l = getLang();
			const params = p as CompactContextParamsType;
			const focus = params.focus?.trim() || "";

			if (!focus) {
				const errMsg = pick(
					l,
					"调用 compact_context 必须提供 focus 参数，说明针对当前问题的压缩要求与保留重点。",
					"compact_context requires a 'focus' parameter explaining what to keep and what to drop for the current issue.",
				);
				return {
					content: [{ type: "text", text: errMsg }],
					details: { ok: false, error: errMsg },
					isError: true,
				};
			}

			const stats = host.getContextStats();
			// 如果整个会话消息条数太少（< 4 条）且 token 极少（< 1200），无需压缩
			if (stats.messageCount < 4 && stats.estimatedTokens < 1200) {
				const msg = pick(
					l,
					`当前会话历史较短（约 ${stats.estimatedTokens} tokens，${stats.messageCount} 条消息），无需压缩。建议在历史累积较长或切换任务焦点后再调用此工具。`,
					`Current conversation is very brief (~${stats.estimatedTokens} tokens, ${stats.messageCount} messages), no compaction needed yet. Call this tool when history grows longer or when switching task focus.`,
				);
				return {
					content: [{ type: "text", text: msg }],
					details: { ok: false, skipped: true, ...stats },
				};
			}

			const effectiveKeepTokens = calculateEffectiveKeepRecentTokens(params.keepRecentTokens, stats.estimatedTokens);

			const pending: PendingCompaction = {
				focus,
				keepRecentTokens: effectiveKeepTokens,
				summary: params.summary?.trim() || undefined,
				requestedAt: Date.now(),
			};

			host.scheduleCompaction(pending);

			const successMsg = pick(
				l,
				`已成功登记上下文压缩请求。将在本轮回复结束后立即执行上下文压缩。\n- 压缩聚焦点：${focus}\n- 保留近期范围：~${effectiveKeepTokens.toLocaleString()} tokens${pending.summary ? "\n- 包含自主提炼的摘要正文" : ""}\n请在结束本轮回复后，在精炼后的上下文中继续后续工作。`,
				`Context compaction request scheduled. It will execute immediately after the current turn ends.\n- Focus: ${focus}\n- Retain scope: ~${effectiveKeepTokens.toLocaleString()} tokens${pending.summary ? "\n- Custom summary provided" : ""}\nPlease wrap up this turn, and continue work in the compacted context.`,
			);

			return {
				content: [{ type: "text", text: successMsg }],
				details: {
					ok: true,
					scheduled: true,
					focus,
					keepRecentTokens: effectiveKeepTokens,
					hasCustomSummary: !!pending.summary,
				},
			};
		},
	});
}
