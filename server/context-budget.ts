/**
 * context-budget.ts — 多级分层上下文预算裁剪（Hierarchical Context Budgeting）
 *
 * 借鉴 DeepSeek Harness (DSH) 的梯度裁剪策略：在触发昂贵的 LLM 全文摘要之前，
 * 增加确定性梯度瘦身，大幅推迟全量压缩时间点，保留近期关键代码的完整细节记忆：
 *
 *   1. 第一级（远期工具输出裁剪）：当上下文达到预警水位（例如 70%）时，自动将历史中
 *      较早的工具巨量输出（如几千行的命令输出、超长文件读取）替换为轻量占位摘要
 *      （`[Tool output trimmed: N lines / M bytes]`），保留工具调用的元数据与首尾关键信息；
 *   2. 第二级（已完成步骤折叠）：折叠已通过的目标轮次中间调试日志；
 *   3. 第三级（语义全量压缩）：仅在前两级裁剪后依然超标时，才调用 LLM 执行深度语义压缩。
 *
 * 纯模块：纯函数与纯逻辑，无外部 I/O 副作用，易于单测与多端复用。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type AgentMessage = AgentSession["messages"][number];

/** 默认第一级触发预警水位（70%）。 */
export const DEFAULT_PRUNE_WATERMARK = 0.7;

/** 默认第二级触发预警水位（85%）。 */
export const DEFAULT_STAGE2_WATERMARK = 0.85;

/** 触发远期工具裁剪的最小行数（超过此行数视作巨量输出）。 */
export const DEFAULT_MIN_TRIM_LINES = 20;

/** 触发远期工具裁剪的最小字节数（超过此体积视作巨量输出）。 */
export const DEFAULT_MIN_TRIM_BYTES = 1000;

/** 裁剪时保留的头部行数。 */
export const DEFAULT_HEAD_LINES = 3;

/** 裁剪时保留的尾部行数。 */
export const DEFAULT_TAIL_LINES = 3;

/** 保留最近若干轮不裁剪（近期关键工作记忆保护）。1 轮通常包含 user + assistant + toolResult。 */
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/**
 * 粗略估算字符串的 token 数（chars / 4 保守估算）。
 */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * 估算一条 AgentMessage 的 token 数。
 */
export function estimateMessageTokens(message: AgentMessage): number {
	let total = 0;
	const msg = message as unknown as Record<string, unknown>;
	if (typeof msg.content === "string") {
		total += estimateTextTokens(msg.content);
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") {
				total += estimateTextTokens(b.text);
			} else if (b.type === "thinking" && typeof b.thinking === "string") {
				total += estimateTextTokens(b.thinking);
			} else if (b.type === "toolCall" && b.arguments) {
				total += estimateTextTokens(JSON.stringify(b.arguments));
			} else if (b.type === "image") {
				total += 800; // 图片估算基准
			}
		}
	}
	if (msg.role === "bashExecution" && typeof msg.output === "string") {
		total += estimateTextTokens(msg.output);
	}
	return Math.max(1, total);
}

/**
 * 估算消息数组的总 token 数。
 */
export function estimateMessagesTotalTokens(messages: AgentMessage[]): number {
	let sum = 0;
	for (const m of messages) {
		sum += estimateMessageTokens(m);
	}
	return sum;
}

export interface TrimToolOutputOptions {
	/** 最小裁剪行数，默认 20。 */
	minLines?: number;
	/** 最小裁剪字节数，默认 1000。 */
	minBytes?: number;
	/** 头部保留行数，默认 3。 */
	headLines?: number;
	/** 尾部保留行数，默认 3。 */
	tailLines?: number;
	/** 保留最近多少轮次不裁剪，默认 2。 */
	keepRecentTurns?: number;
}

export interface TrimToolOutputResult {
	messages: AgentMessage[];
	trimmedCount: number;
	savedBytes: number;
	savedTokens: number;
}

/**
 * 查找属于“近期工作记忆”的消息起始索引。
 * 从后往前数 keepRecentTurns 个 user 消息；在此之后的皆为近期交互，不参与第一级工具裁剪。
 */
export function findRecentCutoffIndex(messages: AgentMessage[], keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS): number {
	if (messages.length === 0 || keepRecentTurns <= 0) return 0;
	let userTurnsSeen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown };
		if (m.role === "user") {
			userTurnsSeen++;
			if (userTurnsSeen >= keepRecentTurns) {
				return i;
			}
		}
	}
	return 0;
}

/**
 * 第一级裁剪：远期工具输出裁剪（Distant Tool Output Trimming）
 *
 * 将历史中较早的工具巨量输出（几千行命令输出、超长文件读取）替换为轻量占位摘要，
 * 保留工具调用的元数据与首尾关键信息。
 */
export function trimDistantToolOutputs(
	messages: AgentMessage[],
	options: TrimToolOutputOptions = {},
): TrimToolOutputResult {
	const minLines = options.minLines ?? DEFAULT_MIN_TRIM_LINES;
	const minBytes = options.minBytes ?? DEFAULT_MIN_TRIM_BYTES;
	const headLines = options.headLines ?? DEFAULT_HEAD_LINES;
	const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
	const keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;

	const cutoffIndex = findRecentCutoffIndex(messages, keepRecentTurns);
	let trimmedCount = 0;
	let savedBytes = 0;
	let savedTokens = 0;

	const newMessages: AgentMessage[] = messages.map((m, index) => {
		// 近期消息不裁剪，保护最近的关键工作上下文
		if (index >= cutoffIndex) {
			return m;
		}

		const msg = m as unknown as Record<string, unknown>;

		// 1. 处理 toolResult 消息
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			let modified = false;
			const newContent = msg.content.map((block) => {
				if (!block || typeof block !== "object") return block;
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					const text = b.text;
					// 如果已经裁剪过，避免重复处理
					if (text.includes("[Tool output trimmed:")) {
						return block;
					}
					const byteLen = Buffer.byteLength(text, "utf8");
					const lines = text.split("\n");
					if (lines.length >= minLines || byteLen >= minBytes) {
						if (lines.length > headLines + tailLines) {
							const head = lines.slice(0, headLines).join("\n");
							const tail = lines.slice(lines.length - tailLines).join("\n");
							const trimmedLines = lines.length - headLines - tailLines;
							const middleText = lines.slice(headLines, lines.length - tailLines).join("\n");
							const trimmedBytes = Buffer.byteLength(middleText, "utf8");

							const placeholder = `[Tool output trimmed: ${trimmedLines} lines / ${trimmedBytes} bytes]`;
							const trimmedText = `${head}\n... ${placeholder} ...\n${tail}`;

							const diffBytes = byteLen - Buffer.byteLength(trimmedText, "utf8");
							if (diffBytes > 0) {
								savedBytes += diffBytes;
								savedTokens += estimateTextTokens(text) - estimateTextTokens(trimmedText);
								trimmedCount++;
								modified = true;
								return { ...b, text: trimmedText };
							}
						}
					}
				}
				return block;
			});

			if (modified) {
				return { ...msg, content: newContent } as unknown as AgentMessage;
			}
		}

		// 2. 处理 bashExecution 消息
		if (msg.role === "bashExecution" && typeof msg.output === "string") {
			const text = msg.output;
			if (!text.includes("[Tool output trimmed:")) {
				const byteLen = Buffer.byteLength(text, "utf8");
				const lines = text.split("\n");
				if (lines.length >= minLines || byteLen >= minBytes) {
					if (lines.length > headLines + tailLines) {
						const head = lines.slice(0, headLines).join("\n");
						const tail = lines.slice(lines.length - tailLines).join("\n");
						const trimmedLines = lines.length - headLines - tailLines;
						const middleText = lines.slice(headLines, lines.length - tailLines).join("\n");
						const trimmedBytes = Buffer.byteLength(middleText, "utf8");

						const placeholder = `[Tool output trimmed: ${trimmedLines} lines / ${trimmedBytes} bytes]`;
						const trimmedText = `${head}\n... ${placeholder} ...\n${tail}`;

						const diffBytes = byteLen - Buffer.byteLength(trimmedText, "utf8");
						if (diffBytes > 0) {
							savedBytes += diffBytes;
							savedTokens += estimateTextTokens(text) - estimateTextTokens(trimmedText);
							trimmedCount++;
							return { ...msg, output: trimmedText } as unknown as AgentMessage;
						}
					}
				}
			}
		}

		return m;
	});

	return {
		messages: newMessages,
		trimmedCount,
		savedBytes,
		savedTokens: Math.max(0, savedTokens),
	};
}

export interface FoldStepOptions {
	/** 保留最近多少轮次不折叠，默认 1。 */
	keepRecentTurns?: number;
}

export interface FoldStepResult {
	messages: AgentMessage[];
	foldedCount: number;
	savedBytes: number;
	savedTokens: number;
}

/**
 * 第二级裁剪：已完成步骤折叠（Completed Steps Folding）
 *
 * 折叠已通过的目标轮次中间调试日志或已确认步骤的重试调试过程。
 * 将已解决步骤中冗余的反复排查、中间反思文本折叠为轻量占位，保留最终决策和产物。
 */
export function foldCompletedStepLogs(messages: AgentMessage[], options: FoldStepOptions = {}): FoldStepResult {
	const keepRecentTurns = options.keepRecentTurns ?? 1;
	const cutoffIndex = findRecentCutoffIndex(messages, keepRecentTurns);

	let foldedCount = 0;
	let savedBytes = 0;
	let savedTokens = 0;

	// 检查历史中是否存在已完成/通过的目标审查或成功修复标记
	// 例如包含目标审查通过、已完成步骤标记等
	const newMessages: AgentMessage[] = messages.map((m, index) => {
		if (index >= cutoffIndex) {
			return m;
		}

		const msg = m as unknown as Record<string, unknown>;

		// 对中间的 assistant 消息中的冗长调试日志/思考排查进行轻量折叠
		// 若 assistant 消息包含明显的中间失败重试排查日志且不是最后结论
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let modified = false;
			const newContent = msg.content.map((block) => {
				if (!block || typeof block !== "object") return block;
				const b = block as Record<string, unknown>;
				// 如果有长 thinking 块，且在已完成历史中
				if (b.type === "thinking" && typeof b.thinking === "string") {
					const t = b.thinking;
					if (t.length > 500 && !t.includes("[Completed step debug logs folded:")) {
						const originalBytes = Buffer.byteLength(t, "utf8");
						const lines = t.split("\n").length;
						const foldedPlaceholder = `[Completed step debug logs folded: 1 entry / ${lines} lines]`;
						const diffBytes = originalBytes - Buffer.byteLength(foldedPlaceholder, "utf8");
						if (diffBytes > 0) {
							savedBytes += diffBytes;
							savedTokens += estimateTextTokens(t) - estimateTextTokens(foldedPlaceholder);
							foldedCount++;
							modified = true;
							return { ...b, thinking: foldedPlaceholder };
						}
					}
				}
				return block;
			});

			if (modified) {
				return { ...msg, content: newContent } as unknown as AgentMessage;
			}
		}

		return m;
	});

	return {
		messages: newMessages,
		foldedCount,
		savedBytes,
		savedTokens: Math.max(0, savedTokens),
	};
}

export interface ContextBudgetOptions {
	/** 上下文物理窗口（tokens）。 */
	contextWindow: number;
	/** 保留空间（tokens，默认例如 16384）。 */
	reserveTokens: number;
	/** 生效的软上限（tokens；0 或未设 = 用 contextWindow - reserveTokens）。 */
	softCap?: number | null;
	/** 第一级预警水位比率（默认 0.70）。 */
	tier1Watermark?: number;
	/** 第二级预警水位比率（默认 0.85）。 */
	tier2Watermark?: number;
	/** 是否强制执行裁剪（例如在即将触发全量压缩时）。 */
	force?: boolean;
}

export interface HierarchicalPruningResult {
	messages: AgentMessage[];
	/** 裁剪前的估计 token 数。 */
	tokensBefore: number;
	/** 裁剪后的估计 token 数。 */
	tokensAfter: number;
	/** 第一级裁剪结果。 */
	tier1: {
		trimmedCount: number;
		savedBytes: number;
		savedTokens: number;
	};
	/** 第二级折叠结果。 */
	tier2: {
		foldedCount: number;
		savedBytes: number;
		savedTokens: number;
	};
	/** 裁剪后是否依然超标、需要进入第三级（语义全量压缩）。 */
	needsCompaction: boolean;
	/** 当前是否达到了第一级水位。 */
	reachedTier1: boolean;
	/** 当前是否达到了第二级水位。 */
	reachedTier2: boolean;
}

/**
 * 多级分层上下文预算裁剪总调度器（Hierarchical Pruning Orchestrator）
 *
 * 按照梯度策略执行：
 * 1. 评估当前 token 占用与有效预算阈值；
 * 2. 达到 70% 水位时，执行第一级（远期工具输出裁剪）；
 * 3. 若仍超标或达到 85% 水位，执行第二级（已完成步骤折叠）；
 * 4. 仅在前两级裁剪后依然超标时，才标记 needsCompaction = true 进入第三级。
 */
export function pruneContextHierarchically(
	messages: AgentMessage[],
	options: ContextBudgetOptions,
): HierarchicalPruningResult {
	const contextWindow = options.contextWindow > 0 ? options.contextWindow : 128_000;
	const reserveTokens = options.reserveTokens > 0 ? options.reserveTokens : 16_384;
	const effectiveCap =
		options.softCap && options.softCap > 0
			? Math.min(options.softCap, contextWindow - reserveTokens)
			: Math.max(1, contextWindow - reserveTokens);

	const tier1Watermark = options.tier1Watermark ?? DEFAULT_PRUNE_WATERMARK;
	const tier2Watermark = options.tier2Watermark ?? DEFAULT_STAGE2_WATERMARK;

	const tier1Threshold = Math.floor(effectiveCap * tier1Watermark);
	const tier2Threshold = Math.floor(effectiveCap * tier2Watermark);

	const tokensBefore = estimateMessagesTotalTokens(messages);
	let currentTokens = tokensBefore;
	let currentMessages = messages;

	const tier1Result = { trimmedCount: 0, savedBytes: 0, savedTokens: 0 };
	const tier2Result = { foldedCount: 0, savedBytes: 0, savedTokens: 0 };

	const reachedTier1 = options.force || currentTokens >= tier1Threshold;
	let reachedTier2 = options.force || currentTokens >= tier2Threshold;

	// 1. 第一级：远期工具输出裁剪
	if (reachedTier1) {
		const r1 = trimDistantToolOutputs(currentMessages);
		if (r1.trimmedCount > 0) {
			currentMessages = r1.messages;
			tier1Result.trimmedCount = r1.trimmedCount;
			tier1Result.savedBytes = r1.savedBytes;
			tier1Result.savedTokens = r1.savedTokens;
			currentTokens = estimateMessagesTotalTokens(currentMessages);
		}
	}

	// 2. 第二级：已完成步骤折叠（如果仍达到第二级水位或仍超标）
	reachedTier2 = reachedTier2 || currentTokens >= tier2Threshold;
	if (reachedTier2 || (options.force && currentTokens >= effectiveCap)) {
		const r2 = foldCompletedStepLogs(currentMessages);
		if (r2.foldedCount > 0) {
			currentMessages = r2.messages;
			tier2Result.foldedCount = r2.foldedCount;
			tier2Result.savedBytes = r2.savedBytes;
			tier2Result.savedTokens = r2.savedTokens;
			currentTokens = estimateMessagesTotalTokens(currentMessages);
		}
	}

	// 3. 第三级判定：前两级瘦身后，是否依然超过有效预算上限
	const needsCompaction = currentTokens >= effectiveCap;

	return {
		messages: currentMessages,
		tokensBefore,
		tokensAfter: currentTokens,
		tier1: tier1Result,
		tier2: tier2Result,
		needsCompaction,
		reachedTier1,
		reachedTier2,
	};
}
