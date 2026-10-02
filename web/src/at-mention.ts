/**
 * `@` 提及的词元判定（纯函数，composerProviders 补全与 slash 选择器共用一个浮层）。
 *
 * 触发规则：`@` 出现在行首/空白/左括号之后（ASCII 单词字符之后不触发，
 * 于是 `a@b` 这类邮箱不会误弹），query 取 `@` 后到光标的连续非空白串
 * （`[^\s@]*`，空串 = 刚打出 `@`，列出全部）。第二个 `@` 直接截断
 * （`@a@b` 只认后一个）。
 *
 * CJK 无空格书写：边界只排除 ASCII 单词字符 + `@` 本身，所以 `请看@文件`
 * 能触发（`看` 不是 ASCII 单词字符），而 `mail@test` 不触发（`l` 是）。
 * 不依赖 React/DOM，vitest 直接单测。
 */
import { SKILL_NAMESPACE } from "./slash-filter.js";

/** 光标前的一个 `@` 词元：start = `@` 下标，query = `@` 之后到光标的串。 */
export interface AtToken {
	start: number;
	query: string;
}

/** `@` 提及项可带的路径附件（点选后宿主追加到输入框附件 chips）。 */
export interface AtAttachment {
	path: string;
	name?: string;
	mode?: "inline" | "reference" | "lines" | "page";
	isDir?: boolean;
	lines?: { start: number; end: number };
}

/** 归一化后的 `@` 命中（一行 = 一个 provider 的一条结果）。 */
export interface AtHit {
	providerId: string;
	providerLabel: string;
	title: string;
	hint?: string;
	/** 写进输入框的文本（缺省 = title）。 */
	text?: string;
	attachments?: AtAttachment[];
}

/** 打这些词即列出全部开着的页（精确命中，标题随机时的快捷入口）。 */
export const ALL_PAGES_TRIGGERS: ReadonlySet<string> = new Set(["p", "page", "pages", "web", "网页", "页面"]);

/** 已授权页面 → `@` 命中（内置页面提供方用，`page` 网页引用 chip：
 *  path 放 origin（扩展按 origin 授权、`browser_page` target 也是它）。 */
export function mapPageHits(
	providerLabel: string,
	pages: { origin: string; title?: string; open?: boolean }[],
	query: string,
	limit = 10,
): AtHit[] {
	if (!Array.isArray(pages)) return [];
	const q = String(query ?? "").toLowerCase();
	// 前缀词：精确命中即列出全部开着的页（标题随机记不住时用；前缀仍走正常过滤）。
	const listAll = q === "" || ALL_PAGES_TRIGGERS.has(q);
	const out: AtHit[] = [];
	for (const p of pages) {
		if (!p || typeof p.origin !== "string" || !p.origin) continue;
		// 只收开着的页：关掉的模型读不到，列出来也是噪音（扩展 status 恒带 open 布尔值）。
		if (p.open !== true) continue;
		const rawTitle = typeof p.title === "string" && p.title.trim() ? p.title.trim() : p.origin;
		if (!listAll && !rawTitle.toLowerCase().includes(q) && !p.origin.toLowerCase().includes(q)) continue;
		// 显示名统一 page · … 开头（标签页标题随机，首段换掉;无分隔符就整体兜底）。
		// 写进输入框的仍是原标题（回车不加前缀），附件 chip 另带 origin。
		const sep = rawTitle.indexOf(" · ");
		const title = sep === -1 ? `page · ${rawTitle}` : `page · ${rawTitle.slice(sep + 3)}`;
		out.push({
			providerId: "host:pages",
			providerLabel,
			title,
			hint: p.origin,
			text: rawTitle,
			attachments: [{ path: p.origin, name: rawTitle, mode: "page" }],
		});
		if (out.length >= Math.max(0, limit)) break;
	}
	return out;
}

/** 服务端 search_files 结果 → `@` 命中（内置文件提供方用，引用 chip）。 */
export interface FileHitLike {
	path: string;
	name: string;
	type: "file" | "dir";
}

export function mapFileHits(providerLabel: string, raw: unknown, limit = 10): AtHit[] {
	if (!Array.isArray(raw)) return [];
	const out: AtHit[] = [];
	for (const r of raw.slice(0, Math.max(0, limit))) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (typeof o.path !== "string" || !o.path || typeof o.name !== "string" || !o.name) continue;
		out.push({
			providerId: "host:files",
			providerLabel,
			title: o.name,
			hint: o.path,
			text: `@${o.name}`,
			attachments: [
				{
					path: o.path,
					name: o.name,
					mode: "reference",
					...(o.type === "dir" ? { isDir: true } : {}),
				},
			],
		});
	}
	return out;
}

/** 单个 provider 的原始返回 → 归一化命中（坏字段逐条丢弃，不抛错）。 */
export function normalizeAtHits(providerId: string, providerLabel: string, raw: unknown, limit = 10): AtHit[] {
	if (!Array.isArray(raw)) return [];
	const out: AtHit[] = [];
	for (const h of raw.slice(0, Math.max(0, limit))) {
		if (!h || typeof h !== "object") continue;
		const o = h as Record<string, unknown>;
		if (typeof o.title !== "string" || !o.title.trim()) continue;
		const atts = Array.isArray(o.attachments)
			? (o.attachments as unknown[])
					.filter(
						(a): a is Record<string, unknown> =>
							!!a && typeof a === "object" && typeof (a as Record<string, unknown>).path === "string",
					)
					.slice(0, 4)
					.map((a): AtAttachment => {
						const mode = a.mode as unknown;
						return {
							path: a.path as string,
							...(typeof a.name === "string" ? { name: a.name } : {}),
							...(mode === "inline" || mode === "reference" || mode === "lines" || mode === "page" ? { mode } : {}),
							...(typeof a.isDir === "boolean" ? { isDir: a.isDir } : {}),
						};
					})
			: undefined;
		out.push({
			providerId,
			providerLabel,
			title: o.title.trim(),
			...(typeof o.hint === "string" && o.hint ? { hint: o.hint } : {}),
			...(typeof o.text === "string" && o.text ? { text: o.text } : {}),
			...(atts?.length ? { attachments: atts } : {}),
		});
	}
	return out;
}

/** 技能命令精简接口（同 SlashCommandInfo，避免循环依赖）。 */
export interface SkillCommandLike {
	name: string;
	source: "builtin" | "extension" | "prompt" | "skill" | "plugin";
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
}

/** 技能命令 → `@` 命中（支持 @skill:name 或 @name 补全）。
 *  名称匹配优先于描述匹配，防止短查询被描述泛匹配挤占。 */
export function mapSkillHits(
	providerLabel: string,
	slashCommands: readonly SkillCommandLike[],
	query: string,
	limit = 15,
	descResolver?: (cmd: SkillCommandLike) => string,
): AtHit[] {
	if (!Array.isArray(slashCommands) || limit <= 0) return [];
	const q = String(query ?? "").toLowerCase();
	const isPrefixed = q.startsWith(SKILL_NAMESPACE);
	const cleanQ = isPrefixed ? q.slice(SKILL_NAMESPACE.length) : q;

	const nameHits: AtHit[] = [];
	const descHits: AtHit[] = [];

	// 短查询仅匹配技能名；3 字符以上或显式 skill: 前缀时才扩展匹配描述，防单字泛匹配挤占文件/插件
	const searchDesc = isPrefixed || cleanQ.length >= 3;

	for (const cmd of slashCommands) {
		if (cmd.source !== "skill") continue;
		const bareName = cmd.name.startsWith(SKILL_NAMESPACE) ? cmd.name.slice(SKILL_NAMESPACE.length) : cmd.name;
		const nameLower = bareName.toLowerCase();
		const resolvedDesc = descResolver ? descResolver(cmd) : (cmd.description ?? "");
		const descLower = resolvedDesc.toLowerCase();
		const descEnLower = (cmd.descriptionEn ?? "").toLowerCase();

		const hit: AtHit = {
			providerId: "host:skills",
			providerLabel,
			title: bareName,
			hint: resolvedDesc || `Skill ${bareName}`,
			text: `@skill:${bareName}`,
		};

		if (!cleanQ) {
			nameHits.push(hit);
		} else if (nameLower.includes(cleanQ)) {
			nameHits.push(hit);
		} else if (searchDesc && (descLower.includes(cleanQ) || descEnLower.includes(cleanQ))) {
			descHits.push(hit);
		}
	}

	return [...nameHits, ...descHits].slice(0, Math.max(0, limit));
}

/** 4 桶合并与优先级排序：
 *  1. 若 query 以 skill: 开头：skills 置顶。
 *  2. 缺省或命中 ALL_PAGES_TRIGGERS：pages 置顶（页面触发词已由 pages 本身处理，默认顺序即保持页面优先）。
 *  最终按 totalCap 截断。
 */
export function mergeAtHits(
	buckets: {
		pages?: AtHit[];
		skills?: AtHit[];
		files?: AtHit[];
		plugins?: AtHit[];
	},
	query: string,
	totalCap = 30,
): AtHit[] {
	const q = String(query ?? "").toLowerCase();
	const pages = buckets.pages ?? [];
	const skills = buckets.skills ?? [];
	const files = buckets.files ?? [];
	const plugins = buckets.plugins ?? [];

	let ordered: AtHit[];
	if (q.startsWith(SKILL_NAMESPACE)) {
		ordered = [...skills, ...pages, ...files, ...plugins];
	} else {
		ordered = [...pages, ...skills, ...files, ...plugins];
	}

	return ordered.slice(0, Math.max(0, totalCap));
}

/** `@` 前允许的边界：行首，或下面这些字符之后（空白 + 中英文括号引号）。 */
function isAtBoundary(ch: string | undefined): boolean {
	if (ch === undefined) return true;
	if (ch === "@") return false;
	// ASCII 单词字符之后是邮箱/用户名语义，不触发。
	if (/[A-Za-z0-9_]/.test(ch)) return false;
	return true;
}

/**
 * 取光标前的 `@` 词元。无触发返回 null。
 * cursor 越界时钳制到 [0, text.length]，不抛错。
 */
export function matchAtToken(text: string, cursor: number): AtToken | null {
	const src = typeof text === "string" ? text : "";
	const cur = Math.max(
		0,
		Math.min(typeof cursor === "number" && Number.isFinite(cursor) ? Math.floor(cursor) : 0, src.length),
	);
	const before = src.slice(0, cur);
	const at = before.lastIndexOf("@");
	if (at === -1) return null;
	if (!isAtBoundary(at > 0 ? before[at - 1] : undefined)) return null;
	const query = before.slice(at + 1);
	// query 含空白或第二个 @ = 早就走远了（空格提交语义与 slash 选择器一致：
	// trailing space 关浮层，回车直接发送）。
	if (/[\s@]/.test(query)) return null;
	return { start: at, query };
}
