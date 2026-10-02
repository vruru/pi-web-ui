/**
 * 权限预设相关辅助逻辑与会话回放。
 */

/**
 * 从会话 sessionManager entries 回放恢复最后设定的**计划模式**状态（同 permission/preset
 * 的落盘口径：切会话/重载不丢）。从未设定或非布尔 → false。
 */
export function readPlanModeFromSession(sm: unknown): boolean {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return false;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { customType?: string; data?: { enabled?: unknown } } | undefined;
			if (e?.customType === "plan/mode" && typeof e.data?.enabled === "boolean") return e.data.enabled;
		}
	} catch {
		// ignore
	}
	return false;
}

/**
 * 从会话 sessionManager entries 回放恢复最后设定的**审查者模式**状态（同 plan/mode
 * 口径：customType "delegate/mode"）。从未设定或非布尔 → false。
 * ⚠️ 执行对话 id **不回放**：常驻执行对话是本进程内的活对象，重启后
 * 首条请求会重新建一个（宁可多一个执行对话，也别指向一个不存在的 id）。
 */
export function readDelegateModeFromSession(sm: unknown): boolean {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return false;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { customType?: string; data?: { enabled?: unknown } } | undefined;
			if (e?.customType === "delegate/mode" && typeof e.data?.enabled === "boolean") return e.data.enabled;
		}
	} catch {
		// ignore
	}
	return false;
}

/**
 * 从会话 sessionManager entries 回放恢复最后设定的权限预设（若从未设定则返回 undefined）。
 * customType 为 "permission/preset"，载荷结构为 { preset: string }。
 */
export function readPermissionFromSession(sm: unknown): string | undefined {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return undefined;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: { preset?: string } } | undefined;
			if (e?.type === "custom" && e.customType === "permission/preset" && typeof e.data?.preset === "string") {
				return e.data.preset;
			}
		}
	} catch {
		// ignore
	}
	return undefined;
}
