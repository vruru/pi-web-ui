/**
 * use-composer-session.ts — 待发附件的「会话闸门」接线（纯判定在 composer-draft.ts）。
 *
 * 为什么需要它：输入框里的待发附件 chips 只活在 App 的内存 state 里（不进服务端、
 * 不持久化），而正文草稿是按 sessionId 存、切会话会清空再恢复的。两边不同步就会出现
 * 「新建对话把正文（含 @ 引用）清干净了、输入框上方那排 chips 还挂着上一个对话的文件」
 * —— 那排 chips 会随下一条消息一起发出去，等于把上个对话的引用带进新对话。
 *
 * 判定用 `UiState.sessionId`（pi/DSH 双引擎都有；`conversationId` 重启即变，不能当
 * 会话身份）。瞬时态（未连接 / 会话未就绪时 sessionId 为空串）既不清也不刷新水位，
 * 否则断线重连回来会被误判成「切了会话」。
 */
import { useEffect, useRef } from "react";
import { advanceComposerSession } from "./composer-draft.js";

/**
 * @param sessionId       快照里的当前会话身份（空串 = 未就绪的瞬时态）
 * @param onSessionChange 会话身份真的变了时调用（App 传清空待发附件的回调，需稳定引用）
 */
export function useComposerSessionReset(sessionId: string, onSessionChange: () => void): void {
	const prevRef = useRef("");
	useEffect(() => {
		const step = advanceComposerSession(prevRef.current, sessionId);
		prevRef.current = step.key;
		if (step.clear) onSessionChange();
	}, [sessionId, onSessionChange]);
}
