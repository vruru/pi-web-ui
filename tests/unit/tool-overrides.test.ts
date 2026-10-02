/**
 * 覆盖注入单测：pi-web-ui 对 read / write / edit 的覆盖必须叠在「扩展注册的同名工具」之上，
 * 而不是把它顶掉 —— SDK 的合并链是 `[...扩展工具, ...customTools]` 逐个 `Map.set`（后写赢），
 * 所以覆盖层只能在会话建好后按名字把扩展那份取出来当基底（见 server/tool-overrides.ts）。
 * 夹具会话对象与 plugin-tools.test.ts 同款：零 token、零网络、不起服务。
 */
import { describe, expect, it, vi } from "vitest";
import {
	extensionToolDefinition,
	installToolOverrides,
	type AnyToolDefinition,
	type OverrideSessionLike,
} from "../../server/tool-overrides.js";

/** 最小可用工具定义：只在 name 与 marker 上有差别，便于断言「用的是哪一份」。 */
function tool(name: string, marker = ""): AnyToolDefinition {
	return {
		name,
		label: name,
		description: `desc:${name}${marker}`,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: `ran:${name}${marker}` }] };
		},
	} as unknown as AnyToolDefinition;
}

function makeSession(
	extensionTools: Array<{ definition: AnyToolDefinition }> = [],
	customTools: AnyToolDefinition[] = [],
): { session: OverrideSessionLike; refreshes: string[][] } {
	const refreshes: string[][] = [];
	const session: OverrideSessionLike = {
		extensionRunner: { getAllRegisteredTools: () => extensionTools },
		_customTools: [...customTools],
		_refreshToolRegistry() {
			refreshes.push((session._customTools ?? []).map((t) => t.name));
		},
	};
	return { session, refreshes };
}

describe("extensionToolDefinition", () => {
	it("取扩展注册表里的同名实现（扩展注册表不受 customTools 顶替影响）", () => {
		const ext = tool("read", ":ext");
		const { session } = makeSession([{ definition: ext }]);
		expect(extensionToolDefinition(session, "read")).toBe(ext);
		expect(extensionToolDefinition(session, "edit")).toBeUndefined();
	});

	it("扩展注册表缺失（SDK 改结构）→ undefined，不抛异常", () => {
		expect(extensionToolDefinition({} as OverrideSessionLike, "read")).toBeUndefined();
		expect(extensionToolDefinition({ extensionRunner: {} } as OverrideSessionLike, "read")).toBeUndefined();
	});
});

describe("installToolOverrides", () => {
	it("有扩展同名工具 → composeWith 以它为基底（扩展的实现不被顶掉）", () => {
		const ext = tool("read", ":ext");
		const composed = tool("read", ":composed");
		const { session, refreshes } = makeSession([{ definition: ext }]);
		const composeWith = vi.fn(() => composed);
		const names = installToolOverrides(session, [
			{ name: "read", fallback: () => tool("read", ":builtin"), composeWith },
		]);
		expect(names).toEqual(["read"]);
		expect(composeWith).toHaveBeenCalledWith(ext);
		expect(session._customTools).toEqual([composed]);
		expect(refreshes).toHaveLength(1);
	});

	it("没有扩展同名工具 → 用 fallback（pi-web-ui 自己的完整实现）", () => {
		const builtin = tool("read", ":builtin");
		const { session } = makeSession();
		const composeWith = vi.fn();
		installToolOverrides(session, [{ name: "read", fallback: () => builtin, composeWith }]);
		expect(composeWith).not.toHaveBeenCalled();
		expect(session._customTools).toEqual([builtin]);
	});

	it("扩展同名工具 + 没给 composeWith → 整个让给扩展（不用 fallback 顶掉它）", () => {
		const ext = tool("read", ":ext");
		const { session } = makeSession([{ definition: ext }], [tool("bash")]);
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read", ":builtin") }]);
		expect((session._customTools ?? []).map((t) => t.name)).toEqual(["bash"]);
	});

	it("注入项排在既有 customTools 之前（插件工具仍然后写赢，相对顺序与改动前一致）", () => {
		const { session } = makeSession([], [tool("bash"), tool("plugin_x")]);
		installToolOverrides(session, [
			{ name: "read", fallback: () => tool("read") },
			{ name: "write", fallback: () => tool("write") },
		]);
		expect((session._customTools ?? []).map((t) => t.name)).toEqual(["read", "write", "bash", "plugin_x"]);
	});

	it("重复注入幂等：同名只留一份，且每次都刷新注册表", () => {
		const { session, refreshes } = makeSession();
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read") }]);
		installToolOverrides(session, [{ name: "read", fallback: () => tool("read") }]);
		expect((session._customTools ?? []).filter((t) => t.name === "read")).toHaveLength(1);
		expect(refreshes).toHaveLength(2);
	});

	it("对象不兼容时返回 null 静默降级（与 syncPluginToolsIntoSession 同款）", () => {
		expect(installToolOverrides({} as OverrideSessionLike, [])).toBeNull();
		expect(installToolOverrides({ _customTools: [] } as OverrideSessionLike, [])).toBeNull();
	});
});
