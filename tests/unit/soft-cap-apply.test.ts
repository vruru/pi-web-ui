import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../../server/soft-cap.js";

/** 不起 server：伪造 settingsSvc + convs，直接调原型方法验覆盖逻辑。
 *  原型链挂 ClientSession.prototype——被测方法内部 this.xxx()（如
 *  applyCompactionOverrideForConv）要能走到真实现。 */
function serviceWith(settings: { softCapTokens: number; softCapByModel: Record<string, number> }, sessions: unknown[]) {
	const svc = Object.create(ClientSession.prototype) as {
		settingsSvc: { current: typeof settings };
		convs: Map<string, unknown>;
	};
	svc.settingsSvc = { current: settings };
	svc.convs = new Map(sessions.map((s, i) => [`c${i}`, { session: s }]));
	return svc;
}

function fakeSession(model: { provider: string; id: string } | null, window: number) {
	const applyOverrides = vi.fn();
	return {
		model,
		getSessionStats: () => ({ contextUsage: { tokens: 1000, contextWindow: window, percent: 1 } }),
		settingsManager: { applyOverrides },
		_captured: applyOverrides,
	};
}

describe("applyCompactionOverrides", () => {
	it("全局软上限 → reserve = window - cap", () => {
		const s = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const svc = serviceWith({ softCapTokens: 190000, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 310000 } });
	});
	it("按模型覆盖优先于全局", () => {
		const s = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const svc = serviceWith({ softCapTokens: 400000, softCapByModel: { "xai/grok-4": 190000 } }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 310000 } });
	});
	it("关闭时回填 SDK 默认（旧覆盖不泄漏）", () => {
		const s = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 0, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS } });
	});
	it("cap 非法（太接近上限）→ 回填默认", () => {
		const s = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 199500, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS } });
	});
	it("未就绪会话抛错不连累其他会话", () => {
		const bad = {
			model: { provider: "a", id: "b" },
			getSessionStats: () => {
				throw new Error("not ready");
			},
			settingsManager: {
				applyOverrides: () => {
					throw new Error("gone");
				},
			},
		};
		const good = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 100000, softCapByModel: {} }, [bad, good]);
		expect(() => ClientSession.prototype.applyCompactionOverrides.call(svc)).not.toThrow();
		expect(good._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 100000 } });
	});
});

describe("activeSoftCap", () => {
	it("合法返回 cap，非法/关闭返回 null", () => {
		const cap = (
			settings: { softCapTokens: number; softCapByModel: Record<string, number> },
			model: unknown,
			window: number,
		) =>
			ClientSession.prototype.activeSoftCap.call(
				{
					settingsSvc: { current: settings },
					session: { model },
				},
				window,
			);
		expect(cap({ softCapTokens: 190000, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBe(190000);
		expect(cap({ softCapTokens: 0, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBeNull();
		expect(cap({ softCapTokens: 199500, softCapByModel: {} }, { provider: "a", id: "b" }, 200000)).toBeNull();
	});
});

describe("reapplySoftCapIfModelChanged", () => {
	// private 方法：测试里绕开可见性与 Conversation 完整类型（同上文的 fake this 模式）。
	const reapply = (ClientSession.prototype as unknown as Record<string, (this: unknown, conv: unknown) => void>)
		.reapplySoftCapIfModelChanged;

	/** 可变模型的 fake conv：reapplySoftCapIfModelChanged 只依赖 settingsSvc、
	 *  conv.session（model / getSessionStats / settingsManager）和 conv.lastModelKey。 */
	function convWith(model: { provider: string; id: string } | null, window: number) {
		const applyOverrides = vi.fn();
		const conv = {
			session: {
				model,
				getSessionStats: () => ({ contextUsage: { tokens: 1000, contextWindow: window, percent: 1 } }),
				settingsManager: { applyOverrides },
			},
			lastModelKey: undefined as string | null | undefined,
			_captured: applyOverrides,
		};
		return conv;
	}

	// 与 serviceWith 同理：reapply 内部 this.applyCompactionOverrideForConv 要走真实现。
	const svc = (settings: { softCapTokens: number; softCapByModel: Record<string, number> }) => {
		const s = Object.create(ClientSession.prototype) as {
			settingsSvc: { current: typeof settings };
		};
		s.settingsSvc = { current: settings };
		return s;
	};

	it("模型在覆盖之外被换（1M 默认模型 → 500K 会话模型）→ 按新窗口重算（泄漏回归）", () => {
		const conv = convWith({ provider: "cliproxyapi", id: "gemini-3.8-flash-high" }, 1048576);
		const s = svc({ softCapTokens: 300000, softCapByModel: {} });
		// 首个事件：模型 key 从 undefined 变为 1M 模型，按 1M 窗口换算（当时的正确值）。
		reapply.call(s, conv);
		expect(conv._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 748576 } });
		// SDK 从会话历史恢复出 500K 窗口的模型（不经过 pi-web-ui setModel 路径）：
		// 旧 reserve 若不重算，触发点 = 500000 - 748576 < 0，上下文几万 token 就被反复压缩。
		conv.session.model = { provider: "cliproxyapi", id: "grok-4.6" };
		conv.session.getSessionStats = () => ({ contextUsage: { tokens: 1000, contextWindow: 500000, percent: 1 } });
		reapply.call(s, conv);
		expect(conv._captured).toHaveBeenLastCalledWith({ compaction: { reserveTokens: 200000 } });
	});

	it("key 未变化 → 不重复注入", () => {
		const conv = convWith({ provider: "a", id: "b" }, 500000);
		const s = svc({ softCapTokens: 300000, softCapByModel: {} });
		reapply.call(s, conv);
		expect(conv._captured).toHaveBeenCalledTimes(1);
		reapply.call(s, conv);
		reapply.call(s, conv);
		expect(conv._captured).toHaveBeenCalledTimes(1);
	});

	it("模型未定（key=null）→ 只记 key 不注入", () => {
		const conv = convWith(null, 0);
		const s = svc({ softCapTokens: 300000, softCapByModel: {} });
		reapply.call(s, conv);
		expect(conv._captured).not.toHaveBeenCalled();
		expect(conv.lastModelKey).toBeNull();
	});

	it("注入抛错不外泄（会话释放竞态）", () => {
		const conv = {
			session: {
				model: { provider: "a", id: "b" },
				getSessionStats: () => ({ contextUsage: { tokens: 1, contextWindow: 500000, percent: 1 } }),
				settingsManager: {
					applyOverrides: () => {
						throw new Error("gone");
					},
				},
			},
		};
		expect(() => reapply.call(svc({ softCapTokens: 300000, softCapByModel: {} }), conv)).not.toThrow();
	});
});
