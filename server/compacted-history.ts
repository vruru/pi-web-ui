/**
 * compacted-history.ts — 提取被上下文压缩折叠的历史消息（issue #398）。
 *
 * 核心原则：严格解耦「UI 展示流」与「LLM 推理视窗」。
 * 当用户在聊天界面点击压缩卡片（CompactionCard）上的「展开查看被折叠的历史」时，
 * 本模块根据 compactionMessageId 纯只读地从会话 DAG 祖先链中还原被该节点折叠的
 * 历史消息，转换为 UiMessage[] 供前端展示，绝不重新送入后续大模型推理。
 */

import type { UiMessage } from "./protocol.js";
import { findEntryByUiId, serializeMessage, type AgentMessage, type UiIdEntryLike } from "./serialize.js";

export interface SessionEntryLike extends UiIdEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	message?: AgentMessage;
	content?: unknown;
	display?: boolean;
}

export interface SessionManagerLike {
	getEntries?: () => SessionEntryLike[];
	getBranch?: (id?: string) => SessionEntryLike[];
	getEntry?: (id: string) => SessionEntryLike | undefined;
	buildContextEntries?: () => SessionEntryLike[];
}

/**
 * 在任意 entries 集合中按 parentId 回溯构造从根到 targetId 的祖先链。
 * 纯函数，防循环引用，用于 getBranch 不可用或单测环境下的兜底。
 */
export function walkAncestors(targetId: string, allEntries: SessionEntryLike[]): SessionEntryLike[] {
	const byId = new Map<string, SessionEntryLike>();
	for (const e of allEntries) byId.set(e.id, e);
	const path: SessionEntryLike[] = [];
	let curId: string | null = targetId;
	const visited = new Set<string>();
	while (curId && byId.has(curId) && !visited.has(curId)) {
		visited.add(curId);
		const entry: SessionEntryLike = byId.get(curId)!;
		path.push(entry);
		curId = entry.parentId;
	}
	return path.reverse();
}

/**
 * 根据 Compaction 节点切分出被该节点折叠的历史 entries。
 * 纯函数。
 *
 * 切分规则（遵循 Pi 内核 CompactionEntry 规范）：
 * - 结束边界（keptIndex）：当前 compaction 的 firstKeptEntryId 所在位置。
 *   若为 retain-none（firstKeptEntryId === id），则结束边界为压缩节点自身。
 * - 起始边界（startIndex）：若前序存在更早的 compaction 节点，则从其 firstKeptEntryId
 *   （或前序节点之后）开始，避免与前一张压缩卡片折叠的内容重叠；若无前序，则从 0 开始。
 */
export function sliceCompactedEntries(
	targetCompaction: SessionEntryLike,
	branch: SessionEntryLike[],
): SessionEntryLike[] {
	const targetIdx = branch.findIndex((e) => e.id === targetCompaction.id);
	if (targetIdx === -1) return [];

	// 1. 确定保留起点边界 keptIdx
	let keptIdx = targetIdx;
	const firstKeptId = targetCompaction.firstKeptEntryId;
	if (firstKeptId && firstKeptId !== targetCompaction.id) {
		const found = branch.findIndex((e) => e.id === firstKeptId);
		if (found >= 0 && found <= targetIdx) {
			keptIdx = found;
		}
	}

	// 2. 确定前序压缩起始点 startIndex
	let startIdx = 0;
	for (let i = targetIdx - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			const prevComp = branch[i];
			const prevFirstKeptId = prevComp.firstKeptEntryId;
			if (prevFirstKeptId && prevFirstKeptId !== prevComp.id) {
				const prevKeptIdx = branch.findIndex((e) => e.id === prevFirstKeptId);
				if (prevKeptIdx >= 0 && prevKeptIdx < targetIdx) {
					startIdx = prevKeptIdx;
					break;
				}
			}
			startIdx = i + 1;
			break;
		}
	}

	if (startIdx >= keptIdx) return [];
	return branch.slice(startIdx, keptIdx);
}

/**
 * 将被折叠的原始 entries 转换为只读 UiMessage[] 列表。
 * 纯函数。
 */
export function serializeCompactedEntries(entries: SessionEntryLike[]): UiMessage[] {
	const result: UiMessage[] = [];
	let seq = 1;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			if (entry.message.role === "system") continue;
			const ui = serializeMessage(entry.message, seq++);
			if (ui) result.push(ui);
		} else if (entry.type === "custom_message" && entry.display !== false) {
			const m = {
				role: "custom",
				content: entry.content,
				timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
			} as AgentMessage;
			const ui = serializeMessage(m, seq++);
			if (ui) result.push(ui);
		}
	}

	return result;
}

/**
 * 根据前端 compactionMessageId 提取被折叠的历史消息（综合入口）。
 */
export function getCompactedMessages(
	sessionManager: SessionManagerLike,
	compactionMessageId: string,
	seqOf?: (m: AgentMessage) => number,
): { messages: UiMessage[]; error?: string } {
	try {
		const contextEntries = sessionManager.buildContextEntries?.() ?? [];
		const allEntries = sessionManager.getEntries?.() ?? contextEntries;

		// 1. 定位目标 compaction 条目
		const defaultSeqOf = () => 1;
		let targetCompaction = findEntryByUiId(
			contextEntries,
			compactionMessageId,
			seqOf ?? defaultSeqOf,
		) as SessionEntryLike | null;

		if (!targetCompaction) {
			targetCompaction = findEntryByUiId(
				allEntries,
				compactionMessageId,
				seqOf ?? defaultSeqOf,
			) as SessionEntryLike | null;
		}

		if (!targetCompaction || targetCompaction.type !== "compaction") {
			// 直接以 raw id 查
			targetCompaction =
				(sessionManager.getEntry?.(compactionMessageId) as SessionEntryLike | undefined) ??
				allEntries.find((e) => e.id === compactionMessageId && e.type === "compaction") ??
				null;
		}

		if (!targetCompaction || targetCompaction.type !== "compaction") {
			return { messages: [], error: "Compaction entry not found" };
		}

		// 2. 获取该节点的分支祖先链
		let branch: SessionEntryLike[] = [];
		if (typeof sessionManager.getBranch === "function") {
			try {
				branch = sessionManager.getBranch(targetCompaction.id) ?? [];
			} catch {
				branch = [];
			}
		}
		if (branch.length === 0) {
			branch = walkAncestors(targetCompaction.id, allEntries);
		}

		// 3. 提取折叠区间并序列化
		const foldedEntries = sliceCompactedEntries(targetCompaction, branch);
		const messages = serializeCompactedEntries(foldedEntries);

		return { messages };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { messages: [], error: msg };
	}
}
