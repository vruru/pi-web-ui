import { describe, expect, it, vi } from "vitest";
import wechatPlugin, {
	stripInternalMarkers,
	peerAccountId,
	assistantTextOf,
	encodeClientVersion,
	inboundTextOf,
} from "../../plugins/wechat-ilink/index.mjs";

describe("wechat-ilink: stripInternalMarkers", () => {
	it("剥离各类 pi-web-ui 内部控制 marker", () => {
		const input = [
			"好的，这就为您安排任务：",
			"[[plan:new:1=调研,2=实现,active=1]]",
			"[[todo:new:开始调研]]",
			"[[conv:rename:微信重命名测试]]",
			"[[notify:info:后台任务已开始]]",
			"我们开始第一步调研。",
		].join("\n");

		const output = stripInternalMarkers(input);
		expect(output).not.toContain("[[plan:");
		expect(output).not.toContain("[[todo:");
		expect(output).not.toContain("[[conv:");
		expect(output).not.toContain("[[notify:");
		expect(output).toBe("好的，这就为您安排任务：\n\n我们开始第一步调研。");
	});

	it("保留普通 wikilink 与数组", () => {
		const input = "请参考 [[Obsidian Note]] 以及矩阵 [[1, 2], [3, 4]]。";
		expect(stripInternalMarkers(input)).toBe(input);
	});

	it("处理 Windows \\r\\n 换行符与多余空行", () => {
		const input = "前言\r\n\r\n[[notify:这是一条通知]]\r\n\r\n\r\n\r\n结语";
		const output = stripInternalMarkers(input);
		expect(output).toBe("前言\n\n结语");
	});

	it("纯 marker 文本清理后为空字符串", () => {
		const input = "[[todo:new:买菜]][[notify:info:done]]";
		expect(stripInternalMarkers(input)).toBe("");
	});
});

describe("wechat-ilink: peerAccountId", () => {
	it("相同 peer 映射出的 accountId 恒定一致", () => {
		const a1 = peerAccountId("user_12345");
		const a2 = peerAccountId("user_12345");
		expect(a1).toBe(a2);
	});

	it("不同 peer 映射出的 accountId 互不相同", () => {
		const a1 = peerAccountId("wx_user_alpha");
		const a2 = peerAccountId("wx_user_beta");
		expect(a1).not.toBe(a2);
	});

	it("输出格式符合合规键名，长度 <= 64 且仅含安全字符", () => {
		const id = peerAccountId("wx_user_test_@123#xyz");
		expect(id).toMatch(/^wx_[a-f0-9]{16}$/);
		expect(id.length).toBeLessThanOrEqual(64);
		expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
	});

	it("空值安全回退", () => {
		expect(peerAccountId("")).toBe("wx_default");
		expect(peerAccountId("   ")).toBe("wx_default");
		expect(peerAccountId(null)).toBe("wx_default");
		expect(peerAccountId(undefined)).toBe("wx_default");
	});
});

describe("wechat-ilink: assistantTextOf", () => {
	it("提取 assistant 文本并过滤 marker", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "任务开始：\n[[todo:new:第一步]]" },
				{ type: "text", text: "已完成调研。\n[[notify:success:ok]]" },
			],
		};
		const text = assistantTextOf(msg as never);
		expect(text).toBe("任务开始：\n\n已完成调研。");
	});

	it("非 assistant 角色或非 text 块返回空", () => {
		expect(assistantTextOf({ role: "user", content: [{ type: "text", text: "hi" }] } as never)).toBe("");
		expect(assistantTextOf({ role: "assistant", content: [{ type: "image", dataUrl: "..." }] } as never)).toBe("");
		expect(assistantTextOf(null as never)).toBe("");
	});
});

describe("wechat-ilink: 完整入站、隔离与无竞态回包（issue #345）", () => {
	it("隔离 accountId、剥离 marker，并在 early run_end 下可靠发包", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_alice"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		interface SendMessagePayload {
			msg?: {
				to_user_id?: string;
				item_list?: Array<{ text_item?: { text: string } }>;
			};
		}
		let sentPayload: SendMessagePayload | null = null;
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					// 第一轮长轮询模拟推一条来自 peer_alice 的入站消息
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_alice",
									context_token: "ctx_token_123",
									item_list: [{ type: 1, text_item: { text: "请制定计划" } }],
								},
							],
						}),
					} as Response;
				}
				// 模拟长轮询挂起，防止单测无限自旋
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				sentPayload = JSON.parse(String(init?.body ?? "{}"));
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			if (urlStr.includes("getconfig")) {
				return { ok: true, json: async () => ({ typing_ticket: "ticket_1" }) } as Response;
			}
			if (urlStr.includes("sendtyping") || urlStr.includes("msg/")) {
				return { ok: true, json: async () => ({}) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			let chatResolve: (val: { conversationId: string; clientId: string }) => void = () => {};
			const chatPromise = new Promise<{ conversationId: string; clientId: string }>((resolve) => {
				chatResolve = resolve;
			});

			const hostChatSpy = vi.fn((_req: unknown) => chatPromise);

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			// 等待 pollOnce 执行并调用 host.chat
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});

			// 验证 accountId 隔离性：必须是基于 peer_alice 的 wx_${hash}，而不是硬编码的 "wx"
			const firstCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const req = (firstCall?.[0] ?? {}) as { accountId?: string; text?: string };
			expect(req.accountId).toBe(peerAccountId("peer_alice"));
			expect(req.accountId).not.toBe("wx");
			expect(req.text).toContain("[微信:peer_alice]");

			// 模拟微任务时序竞态：在 host.chat() 的 Promise resolve 之前，
			// 底层 agent 已经极快触发了 message 与 run_end 事件！
			const targetConvId = "conv_quick_test";
			expect(runHandler).toBeDefined();

			runHandler!({
				type: "message",
				conversationId: targetConvId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "计划已就绪：\n[[plan:new:1=方案,active=1]]\n[[todo:new:第一项]]\n请查阅方案详情。",
						},
					],
				},
			});

			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				at: Date.now(),
			});

			// 此时尚未回包（因为 host.chat 的 Promise 还没返回 conversationId）
			expect(sentPayload).toBeNull();

			// 随后 host.chat 完成，返回该 conversationId
			chatResolve({
				conversationId: targetConvId,
				clientId: `plugin:wechat-ilink:${req.accountId}`,
			});

			// 等待 trackRun 消费 earlyRuns 并发送回包
			await vi.waitFor(() => {
				expect(sentPayload).not.toBeNull();
			});

			// 验证回包内容与收件人
			const payload = sentPayload as unknown as SendMessagePayload;
			expect(payload?.msg?.to_user_id).toBe("peer_alice");
			const outText = payload?.msg?.item_list?.[0]?.text_item?.text ?? "";

			// 验证内部 marker 已被彻底剥离
			expect(outText).not.toContain("[[plan:");
			expect(outText).not.toContain("[[todo:");
			expect(outText).toBe("计划已就绪：\n\n请查阅方案详情。");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("encodeClientVersion 与 inboundTextOf 正常运行", () => {
		expect(encodeClientVersion("0.1.0")).toBe(String(0x00000100));
		expect(inboundTextOf([{ text_item: { text: "你好" } }])).toBe("你好");
		expect(inboundTextOf([{ image_item: {} }])).toBe("[图片]");
	});
});
