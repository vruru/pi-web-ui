/// <reference lib="dom" />
/**
 * compacted-history-state.ts — 被折叠历史消息的按需加载状态 store（issue #398）。
 *
 * 采用模块级 store + useSyncExternalStore 驱动：
 * - 每个 compactionMessageId 独立维护一份请求状态与缓存（支持多次压缩卡片各自查看）；
 * - 首次展开时按需通过 WS 发送 get_compacted_messages；
 * - 收到 compacted_messages_result 应答后缓存在内存中，避免重复请求；
 * - getSnapshot 保证引用稳定，防止 React 渲染颠簸。
 */

import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiMessage } from "./types";

export type CompactedMessagesPayload = Extract<ServerMessage, { type: "compacted_messages_result" }>;

export type CompactedHistoryStatus = "idle" | "loading" | "ready" | "error";

export interface CompactedHistoryState {
	status: CompactedHistoryStatus;
	messages: UiMessage[];
	error?: string;
}

const IDLE_STATE: CompactedHistoryState = Object.freeze({
	status: "idle",
	messages: [],
});

/** key: compactionMessageId -> state */
const cache = new Map<string, CompactedHistoryState>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** 触发拉取某个压缩卡片所折叠的历史消息。 */
export function fetchCompactedHistory(compactionMessageId: string, conversationId?: string): void {
	const id = (compactionMessageId ?? "").trim();
	if (!id) return;

	const existing = cache.get(id);
	if (existing && (existing.status === "loading" || existing.status === "ready")) {
		return;
	}

	cache.set(id, {
		status: "loading",
		messages: existing?.messages ?? [],
	});
	notify();

	appSend({
		type: "get_compacted_messages",
		compactionMessageId: id,
		conversationId,
	});
}

/** 收到服务端的历史消息应答。由 use-chat 分发。 */
export function receiveCompactedMessages(payload: CompactedMessagesPayload): void {
	const id = payload.compactionMessageId;
	if (!id) return;

	if (payload.error) {
		cache.set(id, {
			status: "error",
			messages: [],
			error: payload.error,
		});
	} else {
		cache.set(id, {
			status: "ready",
			messages: payload.messages ?? [],
		});
	}
	notify();
}

/** 获取某个压缩卡片当前的折叠历史状态（未请求时返回固定的 IDLE_STATE 引用）。 */
export function getCompactedHistoryState(compactionMessageId: string): CompactedHistoryState {
	return cache.get(compactionMessageId) ?? IDLE_STATE;
}

/** 订阅变更。返回取消订阅函数。 */
export function subscribeCompactedHistory(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** React hook：订阅某个压缩卡片的历史折叠消息。 */
export function useCompactedHistory(compactionMessageId: string): CompactedHistoryState {
	return useSyncExternalStore(
		subscribeCompactedHistory,
		() => getCompactedHistoryState(compactionMessageId),
		() => IDLE_STATE,
	);
}

/** 仅供单测：清空缓存。 */
export function resetCompactedHistory(): void {
	cache.clear();
}
