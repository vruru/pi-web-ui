/**
 * 计划模式闸门单测（纯函数，无 IO）。
 */
import { describe, expect, it } from "vitest";
import {
	bashCommandIsReadOnly,
	buildPlanModePrompt,
	planModeDenial,
	PLAN_MODE_SYSTEM_PROMPT,
} from "../../server/plan-mode.js";

describe("bashCommandIsReadOnly", () => {
	it("放行只读命令", () => {
		for (const cmd of [
			"ls -la",
			"cat server/index.ts",
			"git status",
			"git diff --stat",
			"git log --oneline -5",
			"rg -n set_plan_mode server",
			"grep -rn foo . | head -20",
			"wc -l *.ts",
			"jq .name package.json",
			"find . -name '*.ts' -newer package.json",
			"node --version",
			"pwd && ls",
			"cat a.txt | grep x | wc -l",
			"LC_ALL=C sort f.txt",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(true);
		}
	});

	it("拒绝写操作与命令替换", () => {
		for (const cmd of [
			"",
			"rm -rf dist",
			"mkdir -p out",
			"git commit -m x",
			"git push",
			"npm install",
			"npm run build",
			'node -e \'require("fs").rmSync("x")\'',
			"echo hi > out.txt",
			"cat f | tee g",
			"sed -i 's/a/b/' f.ts",
			"awk '{print > \"f\"}'",
			"ls $(git rev-parse HEAD)",
			"sleep 5 &",
			"cat <<EOF",
			"python3 script.py",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
		}
	});

	it("任何一段写命令即整条拒绝", () => {
		expect(bashCommandIsReadOnly("ls && rm -rf /")).toBe(false);
		expect(bashCommandIsReadOnly("git status; git push")).toBe(false);
		expect(bashCommandIsReadOnly("cat f | tee g")).toBe(false);
	});
});

describe("planModeDenial", () => {
	it("放行只读工具", () => {
		for (const t of ["read", "grep", "ls", "plan_update", "present_files", "scm", "conversation_read", "skill"]) {
			expect(planModeDenial(t, {}), t).toBeUndefined();
		}
	});

	it("拒绝写类工具并给出计划替代路径", () => {
		const d = planModeDenial("write", { path: "a.ts", content: "x" });
		expect(d?.kind).toBe("write-tool");
		expect(d?.reason).toContain("plan_update");
		expect(d?.reasonEn).toContain("Plan mode");
		expect(planModeDenial("edit_soft", {})?.kind).toBe("write-tool");
		expect(planModeDenial("patch", {})?.kind).toBe("write-tool");
		expect(planModeDenial("git", { command: "commit" })?.kind).toBe("write-tool");
	});

	it("bash 只放行只读命令", () => {
		expect(planModeDenial("bash", { command: "git diff" })).toBeUndefined();
		const d = planModeDenial("bash", { command: "npm run build" });
		expect(d?.kind).toBe("bash");
		expect(d?.reasonEn).toContain("read-only");
		expect(planModeDenial("bash", {})?.kind).toBe("bash");
	});

	it("拒绝旁路工具（会在别的会话实施）", () => {
		expect(planModeDenial("spawn", {})?.kind).toBe("bypass-tool");
		expect(planModeDenial("delegate_task", {})?.kind).toBe("bypass-tool");
		expect(planModeDenial("set_goal", {})?.kind).toBe("bypass-tool");
	});
});

describe("PLAN_MODE_SYSTEM_PROMPT", () => {
	it("纯英文且含关键约束（工具提示词卫生口径）", () => {
		expect(/[一-鿿]/.test(PLAN_MODE_SYSTEM_PROMPT)).toBe(false);
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan_update");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("do NOT implement");
	});

	// 回归：模型在计划模式下写不出文件，于是把整份实现当正文吐出来（烧 token
	// 又没落地）。这两条是内置提示词真正的载荷，别在改写时删掉。
	it("禁止把实现代码写进回复（禁倾倒整文件/完整函数）", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("NEVER write the implementation");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("No file dumps");
	});

	it("小需求可跳过 plan_update 走短计划", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("skip plan_update entirely");
	});
});

describe("buildPlanModePrompt", () => {
	it("空自定义 = 纯内置默认（两种模式都是）", () => {
		expect(buildPlanModePrompt("append", "")).toBe(PLAN_MODE_SYSTEM_PROMPT);
		expect(buildPlanModePrompt("replace", "   ")).toBe(PLAN_MODE_SYSTEM_PROMPT);
	});

	it("追加模式：内置默认 + 空行 + 自定义", () => {
		expect(buildPlanModePrompt("append", "extra")).toBe(`${PLAN_MODE_SYSTEM_PROMPT}\n\nextra`);
	});

	it("替换模式：只发自定义（非空时）", () => {
		expect(buildPlanModePrompt("replace", "only this")).toBe("only this");
	});
});
