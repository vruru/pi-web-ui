import { describe, expect, it } from "vitest";
import { buildTerminalBashLine, detectTrailingLimiter, sentinelUnsafeReason } from "../../server/terminals.js";

/** 终端接管 bash 的哨兵注入（audit fix #2/#6）：
 *  - 旧实现把 `; printf '\n[pi-exit:%s]\n' "$__pi_rc"` 与命令拼在同一物理行，
 *    尾注释/尾管道/续行符/未闭合引号都会吞掉哨兵或造成语法错误；
 *  - 新实现单行命令的哨兵独占一行，多行命令保持 $'...' 转义单行 + 行内拼接。 */

describe("buildTerminalBashLine：哨兵独占一行（audit fix #2）", () => {
	it("单行命令：哨兵独占一行追加（命令 + 换行 + 退出码捕获行）", () => {
		const line = buildTerminalBashLine("ls -la");
		const lines = line.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("ls -la");
		expect(lines[1]).toContain("[pi-exit:%s]");
		expect(lines[1]).toContain("PIPESTATUS");
		// 命令行本身不再拼哨兵序列
		expect(lines[0]).not.toContain("printf");
	});

	it("尾注释不再吞哨兵：哨兵行独立于注释所在行", () => {
		const line = buildTerminalBashLine("echo done # note");
		const lines = line.split("\n");
		expect(lines[0]).toBe("echo done # note");
		expect(lines[1]).toMatch(/^__pi_rc=/);
		expect(lines[1]).toContain("[pi-exit:%s]");
	});

	it("尾管道不再吞哨兵：哨兵行仍是独立的一行", () => {
		const line = buildTerminalBashLine("echo hi |");
		const lines = line.split("\n");
		expect(lines[0]).toBe("echo hi |");
		expect(lines[1]).toContain("[pi-exit:%s]");
	});

	it("尾随续行符：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine("echo hi \\");
		expect(line).toBe("echo hi \\");
		expect(line).not.toContain("pi-exit");
	});

	it("未闭合引号：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine('echo "hi');
		expect(line).toBe('echo "hi');
		expect(line).not.toContain("pi-exit");
	});

	it("多行命令保持 $'...' 转义单行 + 行内拼接（行为不变）", () => {
		const line = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
		expect(line.startsWith("eval $'")).toBe(true);
		expect(line.includes("\n")).toBe(false);
		expect(line).toContain("; __pi_rc=");
		expect(line).toContain("[pi-exit:%s]");
	});

	it("tailFile：tail 补看段落在哨兵行内，退出码仍是底层命令的", () => {
		const line = buildTerminalBashLine("make", { file: "build.log", lines: 20 });
		const lines = line.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("tail -n 20 -- 'build.log'");
		expect(lines[1]).toContain("[pi-exit:%s]");
	});
});

describe("sentinelUnsafeReason：续行/引号扫描（audit fix #2）", () => {
	it("普通单行命令 → null（可注入）", () => {
		expect(sentinelUnsafeReason("echo 'a b' | grep a")).toBeNull();
		expect(sentinelUnsafeReason('echo "x=$(date)"')).toBeNull();
	});

	it("尾随续行符 → trailing_backslash（含尾随空白）", () => {
		expect(sentinelUnsafeReason("echo hi \\")).toBe("trailing_backslash");
		expect(sentinelUnsafeReason("echo hi \\   ")).toBe("trailing_backslash");
	});

	it("未闭合引号 → unclosed_quote（三种引号）", () => {
		expect(sentinelUnsafeReason('echo "hi')).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo 'hi")).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo `hi")).toBe("unclosed_quote");
	});

	it("ANSI-C 引号内的转义单引号不误判", () => {
		expect(sentinelUnsafeReason("echo $'it\\'s fine'")).toBeNull();
	});

	it("多行命令恒判安全（走 eval 转义路径，必然可注入）", () => {
		expect(sentinelUnsafeReason("echo 'x\ndo\ny'")).toBeNull();
	});
});

describe("detectTrailingLimiter：命令替换保守跳过拆管（audit fix #6）", () => {
	it("含 $( 的命令直接跳过：替换内的嵌套管道不被误拆", () => {
		expect(detectTrailingLimiter("echo $(ls | tail -5)")).toBeNull();
		expect(detectTrailingLimiter("diff $(sort a.txt | tail -1) b.txt | tail -3")).toBeNull();
	});

	it("含反引号的命令直接跳过", () => {
		expect(detectTrailingLimiter("echo `ls | tail -5`")).toBeNull();
	});

	it("不含命令替换的尾部限输出管道照常识别", () => {
		const hit = detectTrailingLimiter("seq 1 30 | tail -3");
		expect(hit).not.toBeNull();
		expect(hit?.base).toBe("seq 1 30");
		expect(hit?.lines).toBe(3);
	});
});
