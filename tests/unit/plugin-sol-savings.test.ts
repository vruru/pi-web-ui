import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	analyzeSolSavings,
	formatPlanSummary,
	getSavingsFromLedger,
	resolveSessionId,
} from "../../plugins/sol-savings/index.mjs";
import solSavingsPlugin from "../../plugins/sol-savings/index.mjs";

describe("SoL-Pi Savings 插件与底栏统计", () => {
	it("正确分析 Observation Pack 大工具输出打包并计算节省 Token", () => {
		const mockMessages = [
			{
				role: "user",
				content: [{ type: "text", text: "请帮我分析日志" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "正在读取..." }],
			},
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							"id: obs_test_123",
							"tool: bash",
							"original_bytes: 51200",
							"original_lines: 400",
							"estimated_tokens: 12000",
							"retrieve: call obs_recall with ...",
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "已收到截断结果，继续处理" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "任务完成" }],
			},
		];

		const stats = analyzeSolSavings(mockMessages);
		expect(stats.packedCount).toBe(1);
		expect(stats.totalOriginalBytes).toBe(51200);
		expect((stats.toolBreakdown as Record<string, number>).bash).toBe(1);
		// 每次请求节省 (12000 - 80) = 11920，后续有 2 轮 assistant，共节省 11920 * 2 = 23840
		expect(stats.totalSavedTokens).toBe(23840);
	});

	it("正确解析并格式化 SoL-Pi Plan 进度", () => {
		const plan = [
			{ id: "1", goal: "分析现有架构", status: "completed" },
			{ id: "2", goal: "实现底栏状态插件", status: "in_progress" },
			{ id: "3", goal: "测试与验证", status: "pending" },
		];

		const summary = formatPlanSummary(plan);
		expect(summary).not.toBeNull();
		expect(summary?.progress).toBe("1/3");
		expect(summary?.marker).toBe("◐");
		expect(summary?.goal).toBe("实现底栏状态插件");
		expect(summary?.badge).toBe("1/3 ◐");
	});

	it("插件生命周期与 host.ui.update 协同正常", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				messages: [
					{
						role: "tool_result",
						content: [
							{
								type: "text",
								text: [
									"[large tool result replaced after its first 2 provider requests]",
									"id: obs_456",
									"tool: read",
									"original_bytes: 10000",
									"original_lines: 100",
									"estimated_tokens: 2500",
								].join("\n"),
							},
						],
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "好的" }],
					},
				],
			}),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onRunEvent: vi.fn(),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);

		expect(updates.length).toBeGreaterThan(0);
		const lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.id).toBe("sol-savings-badge");
		expect(lastUpdate.patch.badge).toBe("省 2.4k");
		expect(lastUpdate.patch.hint).toContain("SoL-Pi");
	});

	it("防范并清洗序列化占位符中的引号与逗号脏字符", () => {
		const mockMessages = [
			{
				role: "user",
				content: [{ type: "text", text: "测试" }],
			},
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							'id: "obs_test_escaped",',
							'tool: "bash",',
							'original_bytes: "2048",',
							'estimated_tokens: "500",',
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "完成" }],
			},
		];

		const stats = analyzeSolSavings(mockMessages);
		expect((stats.toolBreakdown as Record<string, number>).bash).toBe(1);
		expect(stats.totalOriginalBytes).toBe(2048);
	});

	it("无节省或未触发打包时，底栏常驻显示极简 '省 0' 且文案明确当前会话", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				messages: [
					{ role: "user", content: [{ type: "text", text: "你好" }] },
					{ role: "assistant", content: [{ type: "text", text: "你好！有什么我可以帮你的？" }] },
				],
			}),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onRunEvent: vi.fn(),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);

		expect(updates.length).toBeGreaterThan(0);
		const lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.id).toBe("sol-savings-badge");
		expect(lastUpdate.patch.badge).toBe("省 0");
		expect(lastUpdate.patch.hint).toContain("当前会话");
		expect(lastUpdate.patch.hint).toContain("已节省 0 tokens");
	});

	it("多会话切换严格按当前会话隔离，不跨会话累加或污染", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		let activeConv = {
			id: "conv-1",
			title: "大任务分析",
			messages: [
				{
					role: "tool_result",
					content: [
						{
							type: "text",
							text: [
								"[large tool result replaced after its first 2 provider requests]",
								"id: obs_conv1",
								"tool: bash",
								"original_bytes: 51200",
								"original_lines: 400",
								"estimated_tokens: 12000",
							].join("\n"),
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "处理完毕" }] },
				{ role: "assistant", content: [{ type: "text", text: "再次确认" }] },
			],
		};

		let onConvChangedCb: (() => void) | undefined;
		const mockHost = {
			getActiveConversation: vi.fn(() => activeConv),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onConversationChanged: vi.fn((cb) => {
				onConvChangedCb = cb;
			}),
			onRunEvent: vi.fn(),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);

		// 会话 1：有大输出截断，产生节省
		let lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");

		// 切换至新开启的会话 2（干净会话，尚未触发截断）
		activeConv = {
			id: "conv-2",
			title: "日常问答",
			messages: [
				{ role: "user", content: [{ type: "text", text: "帮我看一下天气" }] },
				{ role: "assistant", content: [{ type: "text", text: "今天天气晴朗" }] },
			],
		};
		onConvChangedCb?.();

		// 会话 2：必须独立显示 "省 0"，绝对不能继承会话 1 的 23.8k
		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 0");
		expect(lastUpdate.patch.hint).toContain("已节省 0 tokens");

		// 再切回会话 1
		activeConv = {
			id: "conv-1",
			title: "大任务分析",
			messages: [
				{
					role: "tool_result",
					content: [
						{
							type: "text",
							text: [
								"[large tool result replaced after its first 2 provider requests]",
								"id: obs_conv1",
								"tool: bash",
								"original_bytes: 51200",
								"original_lines: 400",
								"estimated_tokens: 12000",
							].join("\n"),
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "处理完毕" }] },
				{ role: "assistant", content: [{ type: "text", text: "再次确认" }] },
			],
		};
		onConvChangedCb?.();

		// 恢复会话 1 的数据
		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");
	});

	it("正确从 SoL-Pi 物理账本 ledger.jsonl 读取权威截断数据", () => {
		const tempDir = join(tmpdir(), `sol-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const convId = "conv-sol-ledger-123";
		const ledgerDir = join(tempDir, "sessions", "test-project", "sol-pi", convId, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const ledgerContent = [
			JSON.stringify({
				timestamp: "2026-09-28T07:00:13.221Z",
				event: "placeholder",
				id: "obs_001",
				request: 5,
				sendNumber: 3,
				tool: "read",
				originalBytes: 16000,
				originalLines: 100,
				originalTokens: 2500,
				removedTokens: 2300,
			}),
			JSON.stringify({
				timestamp: "2026-09-28T07:01:13.221Z",
				event: "placeholder",
				id: "obs_002",
				request: 6,
				sendNumber: 2,
				tool: "grep",
				originalBytes: 8000,
				originalLines: 50,
				originalTokens: 1200,
				removedTokens: 1100,
			}),
			// 模拟混入损坏行或非 placeholder 事件，验证容错
			"{ bad json",
			JSON.stringify({ event: "archive", id: "obs_003" }),
		].join("\n");

		writeFileSync(join(ledgerDir, "ledger.jsonl"), ledgerContent, "utf8");

		try {
			const ledgerStats = getSavingsFromLedger(convId, tempDir);
			expect(ledgerStats).not.toBeNull();
			expect(ledgerStats?.totalSavedTokens).toBe(3400); // 2300 + 1100
			expect(ledgerStats?.totalOriginalBytes).toBe(24000); // 16000 + 8000
			expect(ledgerStats?.packedCount).toBe(2);
			expect((ledgerStats?.toolBreakdown as Record<string, number>).read).toBe(1);
			expect((ledgerStats?.toolBreakdown as Record<string, number>).grep).toBe(1);

			// 测试 analyzeSolSavings 优先读取 ledger.jsonl 并合并 messages 中的 Plan
			const mockMessagesWithPlan = [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								state: "sol-pi-online-context-state-v1",
								plan: [
									{ id: "1", goal: "提取物理账本", status: "completed" },
									{ id: "2", goal: "计算节省总数", status: "in_progress" },
								],
							}),
						},
					],
				},
			];

			const combinedStats = analyzeSolSavings(mockMessagesWithPlan, convId, tempDir);
			expect(combinedStats.totalSavedTokens).toBe(3400);
			expect(combinedStats.plan).toHaveLength(2);
			expect(combinedStats.plan?.[0].goal).toBe("提取物理账本");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("在未找到物理账本或非法会话 ID 时优雅回退至消息正则分析", () => {
		const mockMessages = [
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							"id: obs_fallback",
							"tool: eval",
							"original_bytes: 4000",
							"original_lines: 30",
							"estimated_tokens: 800",
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "回退成功" }],
			},
		];

		// 不存在的 conversationId
		const fallbackStats = analyzeSolSavings(mockMessages, "non-existent-conv-id");
		expect(fallbackStats.packedCount).toBe(1);
		expect(fallbackStats.totalOriginalBytes).toBe(4000);
		expect(fallbackStats.totalSavedTokens).toBe(720); // (800 - 80) * 1
		expect((fallbackStats.toolBreakdown as Record<string, number>).eval).toBe(1);
	});

	it("当 conversationId 为内部序号（如 c1/c2）时，通过 resolveSessionId 从消息时间戳逆向命中物理会话账本", () => {
		const tempDir = join(tmpdir(), `sol-reverse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projDir = join(tempDir, "sessions", "test-project");
		const targetSid = "01a0-reverse-uuid-test";
		const ledgerDir = join(projDir, "sol-pi", targetSid, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const msgTsMs = Date.now() - 60 * 60 * 1000; // 相对时间，避免与 mtime 预筛产生时钟耦合
		const msgTsIso = new Date(msgTsMs).toISOString();

		// 写入包含该时间戳的 session.jsonl 文件
		const sessionFileName = `${msgTsIso.replace(/[:.]/g, "-")}_${targetSid}.jsonl`;
		const sessionFileContent = [
			JSON.stringify({ type: "session", id: targetSid }),
			JSON.stringify({
				type: "message",
				id: "msg_1",
				timestamp: msgTsIso,
				message: { role: "user", content: "测试会话" },
			}),
		].join("\n");
		writeFileSync(join(projDir, sessionFileName), sessionFileContent, "utf8");

		// 写入该会话的 ledger.jsonl
		const ledgerContent = JSON.stringify({
			timestamp: "2026-09-28T12:05:00.000Z",
			event: "placeholder",
			id: "obs_rev_1",
			tool: "read",
			originalBytes: 12000,
			originalTokens: 3000,
			removedTokens: 2900,
		});
		writeFileSync(join(ledgerDir, "ledger.jsonl"), ledgerContent, "utf8");

		try {
			// 前端传来的 conv 只有 c12（内部序号）和携带时间戳的消息
			const mockConvMessages = [
				{
					id: `u-${msgTsMs}-1`,
					role: "user",
					content: [{ type: "text", text: "测试会话" }],
				},
			];

			const stats = analyzeSolSavings(mockConvMessages, "c12", tempDir);
			expect(stats.totalSavedTokens).toBe(2900);
			expect(stats.packedCount).toBe(1);
			expect((stats.toolBreakdown as Record<string, number>).read).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolveSessionId 扫描记忆化：负结果不重扫，证据翻倍后才重扫", () => {
		const tempDir = join(tmpdir(), `sol-memo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projDir = join(tempDir, "sessions", "test-project");
		const targetSid = "01a0-memo-uuid-test";
		const ledgerDir = join(projDir, "sol-pi", targetSid, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const msgTsMs = Date.now() - 60 * 60 * 1000; // 1 小时前，确保 mtime 预筛不误伤
		const msgTsIso = new Date(msgTsMs).toISOString();
		const msgs1 = [{ id: `u-${msgTsMs}-1`, role: "user", content: [{ type: "text", text: "探测" }] }];

		try {
			// 第一次扫描：尚无物理 session 文件 → 负结果
			expect(resolveSessionId("c-memo", msgs1, tempDir)).toBeNull();

			// 扫描之后才出现该会话的物理文件（含证据时间戳）与账本
			writeFileSync(
				join(projDir, `${msgTsIso.replace(/[:.]/g, "-")}_${targetSid}.jsonl`),
				JSON.stringify({ type: "message", timestamp: msgTsIso, message: { role: "user", content: "探测" } }),
				"utf8",
			);
			writeFileSync(join(ledgerDir, "ledger.jsonl"), JSON.stringify({ event: "archive" }), "utf8");

			// 同一会话重复调用：命中负缓存不得重扫（重扫就会扫到刚写入的文件）
			expect(resolveSessionId("c-memo", msgs1, tempDir)).toBeNull();

			// 证据翻倍（消息量 ×2）后允许重扫 → 命中真实 sessionId
			const msgs2 = [...msgs1, { id: `u-${msgTsMs + 1000}-2`, role: "assistant", content: [] }];
			expect(resolveSessionId("c-memo", msgs2, tempDir)).toBe(targetSid);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("运行事件拖尾合并刷新：500ms 窗口至多一次，轮次/运行边界立即刷新", async () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		let onRunCb: ((ev: { type: string }) => void) | undefined;
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				id: "conv-debounce",
				messages: [
					{ role: "user", content: [{ type: "text", text: "hi" }] },
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			}),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onConversationChanged: vi.fn(),
			onRunEvent: vi.fn((cb) => {
				onRunCb = cb;
			}),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);
		const baseline = updates.length;

		// 连发 5 个高频事件：同步阶段不得触发任何刷新
		for (let i = 0; i < 5; i++) onRunCb?.({ type: "tool_end" });
		expect(updates.length).toBe(baseline);

		// 拖尾窗口结束后恰好补一次
		await new Promise((r) => setTimeout(r, 600));
		expect(updates.length).toBe(baseline + 1);

		// 轮次/运行边界立即刷新，不受拖尾窗口影响
		onRunCb?.({ type: "run_end" });
		expect(updates.length).toBe(baseline + 2);
	});
});
