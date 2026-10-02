import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TEMPLATES,
	SubagentTemplatesStore,
	TEMPLATE_LIMITS,
	type SubagentTemplate,
} from "../../server/subagent-templates.js";

/** 每个用例一个临时目录，用后即焚。 */
const dirs: string[] = [];
function tmpStore(): SubagentTemplatesStore {
	const dir = mkdtempSync(join(tmpdir(), "satpl-"));
	dirs.push(dir);
	return new SubagentTemplatesStore(join(dir, "subagent-templates.json"));
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: SubagentTemplate = {
	name: "reviewer",
	description: "只读审查子代理",
	promptMode: "replace",
	systemPrompt: "你是一名严格的代码审查者。",
	enabledSkills: ["code-review"],
	enabledExtensions: ["npm:pi-scm"],
	model: "",
	thinkingLevel: "",
	enabled: true,
};

describe("SubagentTemplatesStore", () => {
	it("首次加载以内置默认模板为种子（不落盘）", () => {
		const store = tmpStore();
		const names = store.list().map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["review", "implement", "research", "scout", "audit", "delegate"]));
		for (const t of store.list()) {
			expect(t.enabled).toBe(true);
			expect(t.promptMode).toMatch(/^(replace|append)$/);
		}
	});

	it("老用户旧文件：缺失的内置模板一次性补齐；此后删除不再复活", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		// 模拟发版前的旧文件：只有 review（无 sidecar 档）
		writeFileSync(file, JSON.stringify([{ name: "review", systemPrompt: "old" }]));
		const a = new SubagentTemplatesStore(file);
		// 新内置模板（oracle 等）被补齐
		expect(a.get("oracle")).toBeDefined();
		expect(a.get("review")!.systemPrompt).toBe("old");
		// 旧文件没有 thinkingLevel：归一为空 = 跟随主对话（升级不改变已有模板行为）
		expect(a.get("review")!.thinkingLevel).toBe("");
		// 用户删掉 review 后重载：不再复活（已在 seeded 名单）
		a.remove("review");
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")).toBeUndefined();
		expect(b.get("oracle")).toBeDefined();
	});

	it("upsert / get / list / remove 基础流程（默认之上增删）", () => {
		const store = tmpStore();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		expect(store.upsert(base)).toBeNull();
		expect(store.get("reviewer")).toEqual(base);
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		// 同名覆盖
		expect(store.upsert({ ...base, description: "v2" })).toBeNull();
		expect(store.get("reviewer")!.description).toBe("v2");
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		store.remove("reviewer");
		expect(store.get("reviewer")).toBeUndefined();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		// 删除不存在的名字静默
		store.remove("nope");
	});

	it("用户改动后落盘，此后以文件为准（默认模板可被删除且不再复活）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		// 删除内置 review + 新增自定义 —— 触发落盘
		a.remove("review");
		a.upsert({ ...base, enabled: false });
		// 新实例重读磁盘：review 不再出现（用户已删）、reviewer 保留
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")).toBeUndefined();
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.list()).toHaveLength(DEFAULT_TEMPLATES.length - 1 + 1);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw.find((t) => t.name === "review")).toBeUndefined();
	});

	it("非法名称拒绝保存", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, name: "   " })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "x".repeat(61) })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "  合法 名称 " })).toBeNull();
		// 名字做空白折叠
		expect(store.get("合法 名称")).toBeDefined();
	});

	it("replace + 空提示词拒绝保存（静默失效不如保存期拦下）", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, promptMode: "replace", systemPrompt: "   ", systemPromptEn: "" })).toMatch(
			/replace/,
		);
		// 拒绝后不落盘、不污染列表
		expect(store.get("reviewer")).toBeUndefined();
		// 英文提示词非空则放行（双语任填一个即可）
		expect(store.upsert({ ...base, promptMode: "replace", systemPrompt: "", systemPromptEn: "Be strict." })).toBeNull();
		// append 允许空提示词（只用白名单限定身份）
		expect(store.upsert({ ...base, name: "append-only", promptMode: "append", systemPrompt: "" })).toBeNull();
	});

	it("体积超限拒绝保存（明确报错，不静默截断）", () => {
		const store = tmpStore();
		// systemPrompt / systemPromptEn 各自计上限
		expect(store.upsert({ ...base, systemPrompt: "x".repeat(TEMPLATE_LIMITS.systemPrompt + 1) })).toMatch(/超长/);
		expect(
			store.upsert({ ...base, name: "long-en", systemPromptEn: "x".repeat(TEMPLATE_LIMITS.systemPrompt + 1) }),
		).toMatch(/英文系统提示词超长/);
		// description / descriptionEn
		expect(
			store.upsert({ ...base, name: "long-desc", description: "x".repeat(TEMPLATE_LIMITS.description + 1) }),
		).toMatch(/简介超长/);
		expect(
			store.upsert({ ...base, name: "long-desc-en", descriptionEn: "x".repeat(TEMPLATE_LIMITS.description + 1) }),
		).toMatch(/英文简介超长/);
		// 白名单条数与单条长度
		expect(
			store.upsert({
				...base,
				name: "too-many-skills",
				enabledSkills: Array.from({ length: TEMPLATE_LIMITS.whitelistEntries + 1 }, (_, i) => `s${i}`),
			}),
		).toMatch(/条目过多/);
		expect(
			store.upsert({
				...base,
				name: "long-extension",
				enabledExtensions: ["npm:" + "x".repeat(TEMPLATE_LIMITS.whitelistEntryLength)],
			}),
		).toMatch(/超长条目/);
		// 拒绝后不落盘
		for (const name of ["reviewer", "long-en", "long-desc", "long-desc-en", "too-many-skills", "long-extension"]) {
			expect(store.get(name)).toBeUndefined();
		}
		// 恰好卡线的值放行（不误伤）
		expect(store.upsert({ ...base, systemPrompt: "x".repeat(TEMPLATE_LIMITS.systemPrompt) })).toBeNull();
		expect(
			store.upsert({
				...base,
				name: "edge-ok",
				enabledSkills: Array.from({ length: TEMPLATE_LIMITS.whitelistEntries }, (_, i) => `s${i}`),
			}),
		).toBeNull();
	});

	it("持久化到磁盘并可重载（全局共享语义）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		a.upsert({ ...base, enabled: false });
		// 新实例重读磁盘
		const b = new SubagentTemplatesStore(file);
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.get("reviewer")!.enabled).toBe(false);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw).toHaveLength(DEFAULT_TEMPLATES.length + 1);
	});

	it("容忍脏数据：非法条目丢弃、字段缺失补默认", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "ok", systemPrompt: "x" }, { name: "", systemPrompt: "bad-name" }, "garbage", 42]),
		);
		const store = new SubagentTemplatesStore(file);
		const list = store.list();
		// 脏条目丢弃 + 缺失的内置模板一次性补齐（sidecar 无档）
		expect(list).toHaveLength(1 + DEFAULT_TEMPLATES.length);
		expect(list[0]).toEqual({
			name: "ok",
			description: "",
			promptMode: "append",
			systemPrompt: "x",
			enabledSkills: [],
			enabledExtensions: [],
			model: "",
			thinkingLevel: "",
			enabled: true,
		});
	});

	it("model 字段归一：空白 → 空串（跟随主对话）；脏类型 → 空串", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "a", model: "anthropic/claude-opus-4-5" }, { name: "b", model: 42 }, { name: "c" }]),
		);
		const store = new SubagentTemplatesStore(file);
		expect(store.get("a")!.model).toBe("anthropic/claude-opus-4-5");
		expect(store.get("b")!.model).toBe("");
		expect(store.get("c")!.model).toBe("");
		// upsert 时同样归一
		store.upsert({ ...base, name: "withModel", model: "  dashscope/qwen-max " });
		expect(store.get("withModel")!.model).toBe("dashscope/qwen-max");
	});

	it("thinkingLevel 字段归一：只认 SDK 档位；空/脏值 → 空串（跟随主对话）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([
				{ name: "a", thinkingLevel: "high" },
				{ name: "b", thinkingLevel: "  xhigh " },
				{ name: "c", thinkingLevel: "off" },
				{ name: "d", thinkingLevel: "ultra" },
				{ name: "e", thinkingLevel: 42 },
				{ name: "f" },
			]),
		);
		const store = new SubagentTemplatesStore(file);
		expect(store.get("a")!.thinkingLevel).toBe("high");
		expect(store.get("b")!.thinkingLevel).toBe("xhigh");
		expect(store.get("c")!.thinkingLevel).toBe("off");
		// 写错的值当未配置（不报错、不猜），回落「跟随主对话」
		expect(store.get("d")!.thinkingLevel).toBe("");
		expect(store.get("e")!.thinkingLevel).toBe("");
		expect(store.get("f")!.thinkingLevel).toBe("");
		// upsert 同样校验
		store.upsert({ ...base, name: "ok", thinkingLevel: "medium" });
		expect(store.get("ok")!.thinkingLevel).toBe("medium");
		store.upsert({ ...base, name: "bad", thinkingLevel: "MAX" });
		expect(store.get("bad")!.thinkingLevel).toBe("");
	});

	it("list 返回副本（外部修改不影响库内）", () => {
		const store = tmpStore();
		store.upsert(base);
		const copy = store.list().find((t) => t.name === "reviewer")!;
		copy.enabledSkills.push("hack");
		expect(store.get("reviewer")!.enabledSkills).toEqual(["code-review"]);
	});
});

describe("oh-my-pi specialist 内置模板", () => {
	const names = ["oracle", "librarian", "explore", "metis", "momus", "multimodal-looker", "sisyphus-junior"];

	it("7 个 specialist 齐全且为 replace 模式", () => {
		for (const n of names) {
			const t = DEFAULT_TEMPLATES.find((x) => x.name === n);
			expect(t, n).toBeDefined();
			expect(t!.promptMode).toBe("replace");
			expect(t!.enabled).toBe(true);
			expect(t!.model).toBe("");
		}
	});

	it("内置模板不预设思考强度（空 = 跟随主对话，老用户升级后行为一致）", () => {
		for (const t of DEFAULT_TEMPLATES) {
			expect(t.thinkingLevel, t.name).toBe("");
		}
	});

	it("双语简介与提示词齐全", () => {
		for (const n of names) {
			const t = DEFAULT_TEMPLATES.find((x) => x.name === n)!;
			expect(t.description.trim().length, `${n}.description`).toBeGreaterThan(0);
			expect(t.descriptionEn?.trim().length, `${n}.descriptionEn`).toBeGreaterThan(0);
			expect(t.systemPrompt.trim().length, `${n}.systemPrompt`).toBeGreaterThan(100);
			expect(t.systemPromptEn?.trim().length, `${n}.systemPromptEn`).toBeGreaterThan(100);
		}
	});
});
