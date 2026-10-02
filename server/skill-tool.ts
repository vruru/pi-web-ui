// ---------------------------------------------------------------------------
// skill-tool.ts — 让 AI 按名取技能全文（名录 + skill 工具）
// ---------------------------------------------------------------------------
// 背景：{{skills}} 默认只渲染名录（name/description/location），引导语原来让
// 模型“用 read 工具加载技能文件”——模型要自己拼 location 路径调 read，权限大
// 且容易猜错路径。本工具提供专用通道：skill({name}) 精确命中，读文件包成与
// SDK 一致的 `<skill name location>` 块（前端 parseSkillBlock 直接认，渲染折叠
// 卡片）；不给 name 则返回名录 + 用法，找错名则给纠错列表。
//
// 约束（第 1 条定稿，不破坏现有体系）：
//   - 名录渲染不动；skillsFullText 名单注入不动；/skill:name 手势不动；
//   - 正文每次重读（不缓存），单文件 8KB 封顶（与 fillSkillContents 同口径）；
//   - 禁用集由 host 在调用时过滤（与 skillsOverride 主会话语义一致），工具侧
//     查不到被禁用的技能；
//   - 与 SDK 同名工具撞名时 customTools 按 name 覆盖（bash 本体是先例）。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
// 返回文本按 lang 取 pick(lang, zh, en, key)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { statSync, readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SKILL_TOOL_NAME } from "./tool-manager.js";
import { decodeText } from "./text-sniff.js";

/** 技能名录行（agent-service 的 skillToolHost 从会话 loader 实时取）。 */
export interface SkillCatalogEntry {
	name: string;
	description: string;
	filePath: string;
}

/** 由 ClientSession 实现的数据宿主（已按 disabledSkills 过滤）。 */
export interface SkillToolHost {
	listSkills(): SkillCatalogEntry[];
}

/** 单文件正文上限（与 agent-service fillSkillContents 同口径：8KB）。 */
export const SKILL_TOOL_FILE_CAP = 8192;

/** 精确名匹配（大小写敏感，与 skillsFullText 名单语义一致）。 */
export function findSkill(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry | undefined {
	const n = name.trim();
	if (!n) return undefined;
	return skills.find((s) => s.name === n);
}

/** 大小写不敏感子串纠错（空 query 全匹配，调用方截行数）。 */
export function suggestSkills(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry[] {
	const q = name.trim().toLowerCase();
	if (!q) return skills;
	return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

/** 名录文本（一行一名 + 一句话描述，无技能时给空目录句）。 */
export function formatSkillCatalog(skills: SkillCatalogEntry[], lang: ServerLang): string {
	if (skills.length === 0) {
		return pick(lang, "当前没有可用技能。", "No skills are currently available.", "skill.catalog.empty");
	}
	const head = pick(
		lang,
		`可用技能（${skills.length}）：`,
		`Available skills (${skills.length}):`,
		"skill.catalog.title",
		{ count: skills.length },
	);
	const lines = skills.map((s) => `- ${s.name}${s.description.trim() ? ` — ${s.description.trim()}` : ""}`);
	return `${head}\n${lines.join("\n")}`;
}

/** 技能全文块（与 SDK 的 /skill:name 展开格式一致，前端按 skill 卡片渲染）。 */
export function renderSkillContent(name: string, location: string, body: string): string {
	return `<skill name="${name}" location="${location}">\n${body.trim()}\n</skill>`;
}

export function makeSkillTool(host: SkillToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: SKILL_TOOL_NAME,
		label: "Load a skill",
		description:
			"Load a skill's full text by its exact name (see the <available_skills> catalog in the system prompt). " +
			"Prefer this over reading the skill file with the read tool — no path guessing needed. " +
			"Call without a name to list the current catalog.",
		promptSnippet: "load a skill's full text by name (skill tool, preferred over read)",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description: "Exact skill name from the catalog. Omit to list the current catalog.",
				}),
			),
		}),
		execute: async (_id, p) => {
			let skills: SkillCatalogEntry[] = [];
			try {
				skills = host.listSkills();
			} catch {
				skills = [];
			}
			const L = getLang();
			const name = typeof p.name === "string" ? p.name.trim() : "";
			// 无名 → 名录 + 用法。
			if (!name) {
				const hint = pick(
					L,
					"用 skill({name}) 按名取全文。",
					"Use skill({name}) to load the full text by name.",
					"skill.catalog.hint",
				);
				return text(`${formatSkillCatalog(skills, L)}\n${hint}`, { count: skills.length });
			}
			const found = findSkill(skills, name);
			// 找错名 → 纠错列表（不抛错，报名录）。
			if (!found) {
				const sug = suggestSkills(skills, name).slice(0, 10);
				const head = pick(L, `没有名为 ${name} 的技能。`, `No skill named ${name}.`, "skill.not.found", { name });
				const sugText = sug.length > 0 ? `\n${formatSkillCatalog(sug, L)}` : `\n${formatSkillCatalog(skills, L)}`;
				return text(`${head}${sugText}`, { name, count: skills.length });
			}
			// 命中 → 最好努力读正文（每次重读，不缓存；失败/超限给可读错）。
			if (!found.filePath) {
				return text(
					pick(
						L,
						`技能 ${name} 没有关联文件路径，取不到全文。`,
						`Skill ${name} has no file path; full text unavailable.`,
						"skill.no.filepath",
						{ name },
					),
				);
			}
			try {
				const st = statSync(found.filePath);
				if (!st.isFile() || st.size <= 0 || st.size > SKILL_TOOL_FILE_CAP) {
					return text(
						pick(
							L,
							`技能 ${name} 的文件不可读（不存在/超 ${SKILL_TOOL_FILE_CAP / 1024}KB 上限）。`,
							`Skill ${name} file unreadable (missing or over the ${SKILL_TOOL_FILE_CAP / 1024}KB cap).`,
							"skill.file.unreadable",
							{ name },
						),
					);
				}
				const body = decodeText(readFileSync(found.filePath).subarray(0, st.size)).trim();
				if (!body) {
					return text(
						pick(L, `技能 ${name} 的文件是空的。`, `Skill ${name} file is empty.`, "skill.file.empty", { name }),
					);
				}
				return text(renderSkillContent(found.name, found.filePath, body), {
					name: found.name,
					location: found.filePath,
				});
			} catch {
				return text(
					pick(
						L,
						`技能 ${name} 的文件读取失败（可能已被删除或移走）。`,
						`Failed to read skill ${name} file (may have been deleted or moved).`,
						"skill.file.failed",
						{ name },
					),
				);
			}
		},
	});
}
