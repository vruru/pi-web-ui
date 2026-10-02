/**
 * 目标审查回合硬闸门的纯函数单测（server/goal-review-gate.ts）。
 *
 * 口径：审查回合只许只读核实（read / grep / scm / 只读 bash / conversation_read）。
 * 写类、非常规 bash、派发类（D6：轮次由服务端控制）、向用户提问一律拒。
 *
 * 先例：tests/unit/plan-mode.test.ts、tests/unit/delegate-mode.test.ts（同一骨架）。
 */
import { describe, expect, it } from "vitest";
import { goalReviewDenial, shouldDeferPromptForReview } from "../../server/goal-review-gate.js";

describe("目标审查闸门 goalReviewDenial", () => {
	it("写类工具一律拒（write/edit/edit_soft/git 工具/形态变换）", () => {
		for (const name of ["write", "edit", "edit_soft", "apply_patch", "rm", "mkdir", "git", "format"]) {
			const d = goalReviewDenial(name, {});
			expect(d?.kind, name).toBe("write-tool");
			expect(d!.reason).toContain("只回 verdict JSON");
			expect(d!.reasonEn).toContain("verdict JSON");
		}
	});

	it("只读工具放行（read/grep/scm/present/todo/conversation_read/subagent_get_result）", () => {
		for (const name of [
			"read",
			"grep",
			"scm",
			"present_files",
			"todo_list",
			"conversation_read",
			"subagent_get_result",
			"subagent_list",
		]) {
			expect(goalReviewDenial(name, {}), name).toBeUndefined();
		}
		expect(goalReviewDenial("subagent", { action: "get_result" })).toBeUndefined();
		expect(goalReviewDenial("subagent", { action: "list" })).toBeUndefined();
		expect(goalReviewDenial("subagent", { action: "templates" })).toBeUndefined();
	});

	it("只读 bash 放行（跑测试/看 diff），写命令拒绝", () => {
		expect(goalReviewDenial("bash", { command: "npm test | tail -20" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "git diff HEAD --stat" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "npx vitest run tests/unit" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "pytest -q && go test ./..." })).toBeUndefined();
		const d = goalReviewDenial("bash", { command: "rm -rf dist" });
		expect(d?.kind).toBe("bash");
		expect(d!.reason).toContain("只允许只读命令");
	});

	it("测试形状只认跑测试：run deploy / node -e 照拒", () => {
		expect(goalReviewDenial("bash", { command: "npm run deploy" })?.kind).toBe("bash");
		expect(goalReviewDenial("bash", { command: 'node -e "console.log(1)"' })?.kind).toBe("bash");
		expect(goalReviewDenial("bash", { command: "npm test; rm -rf /tmp/x" })?.kind).toBe("bash");
	});

	it("保守边界：带重定向的测试命令同样拒（与计划模式同一白名单，模型换写法即可）", () => {
		// `2>&1` 命中写 shell token —— 审查者改写成 `npm test | tail -20` 就能过。
		expect(goalReviewDenial("bash", { command: "npm test 2>&1 | tail -20" })?.kind).toBe("bash");
	});

	it("无命令的终端调用拒绝（交互式用法在审查回合无意义）", () => {
		const d = goalReviewDenial("terminal_bash", {});
		expect(d?.kind).toBe("bash");
	});

	it("派发类工具一律拒（D6：轮次由服务端控制）", () => {
		expect(goalReviewDenial("subagent", { action: "spawn" })?.kind).toBe("dispatch-tool");
		expect(goalReviewDenial("subagent", { action: "wait_all" })?.kind).toBe("dispatch-tool");
		for (const name of [
			"subagent_spawn",
			"subagent_steer",
			"subagent_stop",
			"subagent_wait_all",
			"subagent_handoff",
			"delegate_task",
			"schedule",
			"set_goal",
			"start_goal_wizard",
			"set_plan_mode",
		]) {
			const d = goalReviewDenial(name, {});
			expect(d?.kind, name).toBe("dispatch-tool");
		}
	});

	it("向用户提问拒绝（弹窗无人应答，会把 verdict 拖超时）", () => {
		const d = goalReviewDenial("ask_user_question", { question: "选哪个？" });
		expect(d?.kind).toBe("ask-user");
	});

	it("审查回合插话顺延判定 shouldDeferPromptForReview", () => {
		const base = { queue: false, text: "顺便问下", hasAttachments: false, awaitingVerdict: true };
		// 纯文本 steer 插话 → 顺延（会污染 verdict）
		expect(shouldDeferPromptForReview({ ...base, queue: false })).toBe(true);
		// followUp（补充按钮）由 SDK 排在整轮结束后，本来就安全 → 不拦
		expect(shouldDeferPromptForReview({ ...base, queue: true })).toBe(false);
		// 非审查回合 → 不拦
		expect(shouldDeferPromptForReview({ ...base, awaitingVerdict: false })).toBe(false);
		// 带附件 → 不进顺延（调用方改响亮拒绝）
		expect(shouldDeferPromptForReview({ ...base, queue: false, hasAttachments: true })).toBe(false);
		// 斜杠命令直通（原生配置类不进模型）
		expect(shouldDeferPromptForReview({ ...base, queue: false, text: "/compact" })).toBe(false);
		// 空文本也顺延（与普通发送同口径，不过滤内容）
		expect(shouldDeferPromptForReview({ ...base, text: "   " })).toBe(true);
	});

	it("空名/未知工具放行（白名单制：只拦名单里的）", () => {
		expect(goalReviewDenial("", {})).toBeUndefined();
		expect(goalReviewDenial("some_future_tool", {})).toBeUndefined();
	});
});
