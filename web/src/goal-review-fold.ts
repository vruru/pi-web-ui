import type { UiMessage } from "./types";
import { asText } from "./components/Message";

/**
 * 审查回合消息的折叠识别（与服务端契约同源，见 server/goal-service.ts）。
 *
 * 目标审查回合由三样东西组成：审查指令（user 消息，契約）、verdict JSON
 * （assistant 消息，机器输出）、起止卡片（custom goal-review 消息）。
 * 指令和纯 JSON 默认折叠成摘要行（结论卡已有人话，裸 JSON 只留审计入口）；
 * 起止卡片保持展开。
 */

export const GOAL_REVIEW_MARK = "[goal-review]";

function firstText(m: UiMessage): string {
	for (const b of m.content ?? []) {
		const t = asText(b);
		if (t && t.text.trim()) return t.text;
	}
	return "";
}

/** 纯 verdict JSON 的 assistant 回复 → 返回结论。前后带闲话的不算（保持展开）。 */
export function reviewVerdictOf(m: UiMessage): "pass" | "fail" | undefined {
	if (m.role !== "assistant") return undefined;
	const text = firstText(m).trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
	try {
		const v = JSON.parse(text) as { verdict?: unknown };
		if (v && typeof v === "object" && (v.verdict === "pass" || v.verdict === "fail")) return v.verdict;
	} catch {
		// 不是纯 JSON（围栏/单引号/尾逗号）→ 落正则
	}
	const mm = text.match(/^\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}$/);
	return mm ? (mm[1] as "pass" | "fail") : undefined;
}

export type ReviewFoldKind = { kind: "prompt" } | { kind: "verdict"; verdict: "pass" | "fail" };

/** 审查回合消息识别：指令（含标记的 user 消息）与纯 verdict 结论默认折叠。 */
export function reviewFoldKind(m: UiMessage): ReviewFoldKind | undefined {
	if (m.role === "user" && firstText(m).includes(GOAL_REVIEW_MARK)) return { kind: "prompt" };
	const v = reviewVerdictOf(m);
	if (v) return { kind: "verdict", verdict: v };
	return undefined;
}
