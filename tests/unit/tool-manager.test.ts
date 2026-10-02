/**
 * tool-manager 单测：统一工具门控纯函数（目录/归一化/遗留同步/ActiveSet 门控）。
 * 零 token、零端口。
 */
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	CLAIM_FILES_TOOL_NAME,
	COMPACT_CONTEXT_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	LSP_TOOL_NAME,
	PATCH_TOOL_NAME,
	PLAN_UPDATE_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	SKILL_TOOL_NAME,
	applyAgentToolsGating,
	defaultDisabledAgentTools,
	deriveLegacy,
	effectiveDisabledAgentTools,
	EVAL_TOOL_NAME,
	foldLegacyIntoDisabled,
	isAgentToolEnabled,
	isKnownAgentTool,
	isTerminalGuidanceOn,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	filterToolsByPreset,
	presetAllowsPluginTools,
	presetHasQuestionnaire,
	presetShowsSkillCatalog,
	setAgentToolEnabled,
	setAgentToolsEnabled,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../server/tool-manager.js";

/** 假 ActiveSet（只记录名字集合，不碰 SDK；getAllTools 与活跃集同源 = 初始全集）。 */
function fakeSet(initial: string[] = []) {
	let names = [...initial];
	return {
		getActiveToolNames: () => [...names],
		getAllTools: () => [...initial].map((name) => ({ name })),
		setActiveToolsByName: (next: string[]) => {
			names = [...next];
		},
		peek: () => names,
	};
}

describe("catalog", () => {
	it("共 25 个可开关工具（终端 7＋子代理 1＋其他 17）", () => {
		expect(AGENT_TOOL_CATALOG).toHaveLength(25);
		expect(TERMINAL_TOOL_NAMES).toHaveLength(7);
		expect(SUBAGENT_TOOL_NAMES).toHaveLength(1);
	});

	it("默认：终端组/edit_soft/eval 关，其余开（与改动前行为一致）", () => {
		const off = new Set(defaultDisabledAgentTools());
		for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
		expect(off.has("edit_soft")).toBe(true);
		expect(off.has(EVAL_TOOL_NAME)).toBe(true);
		expect(off.has(LSP_TOOL_NAME)).toBe(true);
		expect(off.has(PATCH_TOOL_NAME)).toBe(false);
		for (const n of SUBAGENT_TOOL_NAMES) expect(off.has(n)).toBe(false);
		expect(off.has("delegate_task")).toBe(false);
		expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
		expect(off.has("todo_list")).toBe(false);
		// 对话引用读取只读，默认开。
		expect(off.has(CONVERSATION_READ_TOOL_NAME)).toBe(false);
		// 技能全文按名加载只读，默认开。
		expect(off.has(SKILL_TOOL_NAME)).toBe(false);
		// 展示文件给用户（只读探测 + 卡片）默认开：不打开模型不知道能“给用户看”。
		expect(off.has(PRESENT_FILES_TOOL_NAME)).toBe(false);
		// 文件认领（事前打招呼，纯 advisory）默认开：不打开 AI 不知道能认领。
		expect(off.has(CLAIM_FILES_TOOL_NAME)).toBe(false);
		// 结构化任务计划更新默认开。
		expect(off.has(PLAN_UPDATE_TOOL_NAME)).toBe(false);
		// 主动上下文压缩默认开：让 AI 可根据当前任务主动压缩精简上下文。
		expect(off.has(COMPACT_CONTEXT_TOOL_NAME)).toBe(false);
	});
});

describe("normalize", () => {
	it("非数组回落默认；脏数据只保留已知工具名（去重）", () => {
		expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
		expect(normalizeDisabledAgentTools(["edit_soft", "nope", "edit_soft", 42])).toEqual(["edit_soft"]);
	});

	it("旧名 markers_list 迁移到 todo_list（已关闭保持关闭）", () => {
		expect(normalizeDisabledAgentTools(["markers_list"])).toEqual(["todo_list"]);
		expect(normalizeDisabledAgentTools(["markers_list", "todo_list"])).toEqual(["todo_list"]);
	});

	it("isKnownAgentTool / isAgentToolEnabled", () => {
		expect(isKnownAgentTool("subagent")).toBe(true);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isAgentToolEnabled("edit_soft", ["edit_soft"])).toBe(false);
		expect(isAgentToolEnabled("edit_soft", [])).toBe(true);
	});
});

describe("legacy sync", () => {
	it("旧存档（仅遗留三开关）折算语义与改动前一致", () => {
		// 全 undefined：终端关、edit_soft 关、问卷开。
		const d = legacyToDisabled({});
		for (const n of TERMINAL_TOOL_NAMES) expect(d).toContain(n);
		expect(d).toContain("edit_soft");
		expect(d).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
		// 新字段优先，遗留值忽略。
		expect(legacyToDisabled({ disabledAgentTools: [], terminalToolsEnabled: false })).toEqual([]);
	});

	it("deriveLegacy 回填（终端组全开才算开）", () => {
		expect(deriveLegacy([])).toEqual({
			terminalToolsEnabled: true,
			editSoftEnabled: true,
			questionnaireEnabled: true,
		});
		const partial = deriveLegacy([TERMINAL_TOOL_NAMES[0]]);
		expect(partial.terminalToolsEnabled).toBe(false);
		expect(partial.editSoftEnabled).toBe(true);
	});

	it("foldLegacyIntoDisabled 只动覆盖的组", () => {
		const cur = ["edit_soft", "subagent"];
		expect(foldLegacyIntoDisabled(cur, { terminalToolsEnabled: false })).toEqual([
			"edit_soft",
			"subagent",
			...TERMINAL_TOOL_NAMES,
		]);
		// true = 移出该组；未传的组不动。
		expect(foldLegacyIntoDisabled(["edit_soft"], { editSoftEnabled: true })).toEqual([]);
		expect(foldLegacyIntoDisabled(["edit_soft"], {})).toEqual(["edit_soft"]);
	});

	it("effectiveDisabled 合并问卷别名（双保险）", () => {
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [], questionnaireEnabled: false })).toContain(
			ASK_USER_QUESTION_TOOL_NAME,
		);
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [] })).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
	});

	it("终端引导只在组内有启用工具时注入", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES])).toBe(false);
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(true);
	});
});

describe("tool_manage 出入口", () => {
	it("setAgentToolEnabled 开关单个工具，未知名/未就绪返回 false", () => {
		const s = fakeSet(["edit_soft", "bash"]);
		expect(setAgentToolEnabled(s, "edit_soft", false)).toBe(true);
		expect(s.peek()).toEqual(["bash"]);
		expect(setAgentToolEnabled(s, "edit_soft", true)).toBe(true);
		expect(s.peek()).toEqual(["bash", "edit_soft"]);
		expect(setAgentToolEnabled(s, "bash", false)).toBe(false);
		expect(setAgentToolEnabled(s, "nope", true)).toBe(false);
		const broken = {
			getActiveToolNames: () => {
				throw new Error("not ready");
			},
			getAllTools: () => {
				throw new Error("not ready");
			},
			setActiveToolsByName: () => {},
		};
		expect(setAgentToolEnabled(broken, "edit_soft", true)).toBe(false);
	});

	it("setAgentToolsEnabled 批量（组头全开/全关），返回处理数", () => {
		const s = fakeSet();
		expect(setAgentToolsEnabled(s, [...TERMINAL_TOOL_NAMES], true)).toBe(7);
		expect(s.peek()).toEqual([...TERMINAL_TOOL_NAMES]);
		expect(setAgentToolsEnabled(s, ["bash"], true)).toBe(0);
	});

	it("applyAgentToolsGating 全量重放：目录内加减、目录外不动", () => {
		// 全部启用：目录内 19 个补齐，bash 等原样保留。
		const s = fakeSet(["bash", "read"]);
		applyAgentToolsGating(s, []);
		const names = s.peek();
		expect(names).toContain("bash");
		expect(names).toContain("read");
		for (const t of AGENT_TOOL_CATALOG) expect(names).toContain(t.name);
		// 全部禁用：目录内剔除，目录外不动。
		const s2 = fakeSet(["bash", "edit_soft", "subagent"]);
		applyAgentToolsGating(
			s2,
			AGENT_TOOL_CATALOG.map((t) => t.name),
		);
		expect(s2.peek()).toEqual(["bash"]);
	});
});

describe("预设语义总表（见 tool-manager.ts 语义注释）", () => {
	it("插件工具：只有 standard 允许，其余预设一律拒绝（读写未知，保守）", () => {
		expect(presetAllowsPluginTools(undefined)).toBe(true);
		expect(presetAllowsPluginTools("standard")).toBe(true);
		for (const p of ["minimal", "code", "reader", "ask"]) expect(presetAllowsPluginTools(p)).toBe(false);
		// 未知预设 id 按不过滤处理（filterToolsByPreset 同口径，防脏配置全灭）。
		expect(presetAllowsPluginTools("nope")).toBe(true);
	});

	it("技能名录与 skill 加载器同进退（单源推导，不另维护名单）", () => {
		expect(presetShowsSkillCatalog(undefined)).toBe(true);
		expect(presetShowsSkillCatalog("standard")).toBe(true);
		expect(presetShowsSkillCatalog("reader")).toBe(true);
		for (const p of ["minimal", "code", "ask"]) expect(presetShowsSkillCatalog(p)).toBe(false);
		// 与 filterToolsByPreset 的 skill 去留一致（改白名单只改一处）。
		for (const p of [undefined, "standard", "minimal", "code", "reader", "ask"]) {
			expect(presetShowsSkillCatalog(p)).toBe(filterToolsByPreset([SKILL_TOOL_NAME], p).includes(SKILL_TOOL_NAME));
		}
	});

	it("问卷可用性：standard/reader 有，minimal/code/ask 无（单源推导）", () => {
		expect(presetHasQuestionnaire(undefined)).toBe(true);
		expect(presetHasQuestionnaire("standard")).toBe(true);
		expect(presetHasQuestionnaire("reader")).toBe(true);
		for (const p of ["minimal", "code", "ask"]) expect(presetHasQuestionnaire(p)).toBe(false);
		expect(presetHasQuestionnaire("nope")).toBe(true);
	});

	it("终端引导：开关全关不教；预设拿掉终端工具也不教（不教不存在的工具）", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([], "minimal")).toBe(false);
		expect(isTerminalGuidanceOn([], "code")).toBe(false);
		expect(isTerminalGuidanceOn([], "ask")).toBe(false);
		// reader 下 list/read/wait 仍在，引导保留（与「组内任一可用」同口径）。
		expect(isTerminalGuidanceOn([], "reader")).toBe(true);
		// 开关全关时预设也救不回来。
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "standard")).toBe(false);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], "reader")).toBe(false);
		// 缺省 preset = 只看开关（旧语义不变）。
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(true);
	});
});
