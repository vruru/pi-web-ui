import { describe, it, expect, vi } from "vitest";
import { sanitizeEvalEnv } from "../../server/eval-tool.js";
import { makePersistentTerminalTools } from "../../server/terminals.js";

describe("Terminal & Eval Sandbox Security Enhancements (#339)", () => {
	it("sanitizes environment variables to prevent API key and credential leakage", () => {
		const mockEnv = {
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: "sk-proj-1234567890",
			ANTHROPIC_AUTH_TOKEN: "anthropic-secret-token",
			AWS_SECRET_ACCESS_KEY: "aws-secret-123",
			DB_PASSWORD: "super-secret-password",
			CUSTOM_CREDENTIAL: "my-credentials",
			NODE_ENV: "production",
		};

		const cleaned = sanitizeEvalEnv(mockEnv as any);

		expect(cleaned.PATH).toBe("/usr/bin:/bin");
		expect(cleaned.HOME).toBe("/home/user");
		expect(cleaned.NODE_ENV).toBe("production");

		// 验证敏感密钥已被彻底过滤
		expect((cleaned as any).OPENAI_API_KEY).toBeUndefined();
		expect((cleaned as any).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect((cleaned as any).AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect((cleaned as any).DB_PASSWORD).toBeUndefined();
		expect((cleaned as any).CUSTOM_CREDENTIAL).toBeUndefined();
	});

	it("blocks high-risk command input via terminal_input tool", async () => {
		const mockTerminals = {
			inputChecked: vi.fn().mockReturnValue(null),
			noteAgentActivity: vi.fn(),
		};

		const tools = makePersistentTerminalTools(mockTerminals as any, "/workspace", () => "en", {
			checkSafety: (cmd) => {
				if (cmd.includes("rm -rf /")) {
					return { blocked: true, reason: "Dangerous rm -rf / blocked" };
				}
				return {};
			},
		});

		const inputTool = tools.find((t) => t.name === "terminal_input");
		expect(inputTool).toBeDefined();

		// 输入普通文本（无换行）不触发拦截
		await expect(
			inputTool!.execute("call-safe", { terminalId: "term-1", data: "ls -la" }, undefined, undefined, {} as any),
		).resolves.toBeDefined();

		// 输入危险破坏性命令（带换行提交）直接抛错阻断
		await expect(
			inputTool!.execute("call-danger", { terminalId: "term-1", data: "rm -rf /\n" }, undefined, undefined, {} as any),
		).rejects.toThrow("Dangerous rm -rf / blocked");

		expect(mockTerminals.inputChecked).toHaveBeenCalledWith("term-1", "ls -la");
		// 验证危险命令根本没有被传递给底层终端
		expect(mockTerminals.inputChecked).not.toHaveBeenCalledWith("term-1", "rm -rf /\n");
	});
});
