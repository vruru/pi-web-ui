/**
 * server/delegate-mode.ts 纯函数单测：审查者模式（自动委派）的工具闸门。
 * 与 tests/unit/plan-mode.test.ts 同口径：锁判定，不碰 IO。
 */
import { describe, expect, it } from "vitest";
import { delegationDenial, DELEGATION_SYSTEM_PROMPT, delegateNoticeText } from "../../server/delegate-mode.js";

describe("delegationDenial", () => {
	it("写类工具一律拒（主对话只审阅不施工）", () => {
		for (const name of ["write", "edit", "edit_soft", "patch", "rm", "mkdir", "git", "notebook_edit"]) {
			const d = delegationDenial(name, {});
			expect(d, name).toBeDefined();
			expect(d!.kind).toBe("write-tool");
			expect(d!.reason).toContain("审查者模式");
		}
	});

	it("派发类工具拒：派活是服务端的活", () => {
		for (const name of ["spawn", "subagent_spawn", "delegate_task", "set_goal", "set_plan_mode"]) {
			const d = delegationDenial(name, {});
			expect(d, name).toBeDefined();
			expect(d!.kind).toBe("dispatch-tool");
		}
	});

	it("bash：只读放行、非常规拒", () => {
		expect(delegationDenial("bash", { command: "git status" })).toBeUndefined();
		expect(delegationDenial("bash", { command: "ls -la" })).toBeUndefined();
		expect(delegationDenial("bash", { command: "npm test" })?.kind).toBe("bash");
		expect(delegationDenial("bash", { command: "rm -rf dist" })?.kind).toBe("bash");
		expect(delegationDenial("terminal", { command: "npm run build" })?.kind).toBe("bash");
		// 空命令 → 直接拒（不给「空跑」留口子）
		expect(delegationDenial("bash", { command: "  " })?.kind).toBe("bash");
		expect(delegationDenial("bash", {})?.kind).toBe("bash");
	});

	it("只读/查询类工具放行", () => {
		for (const name of ["read", "grep", "glob", "ls", "conversation_read", "present_files", "todo_list"]) {
			expect(delegationDenial(name, {}), name).toBeUndefined();
		}
	});

	it("空工具名放行（不误伤）", () => {
		expect(delegationDenial("", {})).toBeUndefined();
		expect(delegationDenial("   ", {})).toBeUndefined();
	});

	it("中英双语理由成对", () => {
		const d = delegationDenial("write", {})!;
		expect(d.reason.length).toBeGreaterThan(10);
		expect(d.reasonEn.length).toBeGreaterThan(10);
		expect(d.reasonEn).not.toBe(d.reason);
	});
});

describe("提示词与 notice 文案", () => {
	it("提示词段是纯英文（工具提示词卫生口径）且含关键硬规则", () => {
		expect(DELEGATION_SYSTEM_PROMPT).toMatch(/^# Reviewer mode/);
		expect(DELEGATION_SYSTEM_PROMPT).toMatch(/blocked by the server/);
		expect(DELEGATION_SYSTEM_PROMPT).toMatch(/plan mode wins/i);
		// 不含中文字符
		expect(/[一-鿿]/.test(DELEGATION_SYSTEM_PROMPT)).toBe(false);
	});

	it("notice 中英成对", () => {
		for (const on of [true, false]) {
			const n = delegateNoticeText(on);
			expect(n.text.length).toBeGreaterThan(4);
			expect(n.textEn.length).toBeGreaterThan(4);
		}
		expect(delegateNoticeText(true).text).toContain("执行对话");
		expect(delegateNoticeText(false).text).toContain("关闭");
	});
});
