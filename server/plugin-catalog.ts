/**
 * 插件市场 / 插件列表 —— 可一键安装的插件清单。
 *
 * 两层来源（合并后经协议 plugin_catalog 推给前端）：
 *   - builtin : <pkgRoot>/plugins/catalog.json（随包发布，官方维护列表；
 *               插件作者把新插件加进来 = 往这个文件加一条 + PR）
 *   - custom  : <dataDir>/plugin-catalog.json（用户在设置面板「添加到列表」，
 *               任何第三方插件都能随时填进列表；仅 custom 条目可经 UI 移除）
 *
 * 条目结构见 protocol.UiPluginCatalogEntry。`id` 是安装落盘目录名
 * （<dataDir>/plugins/<id>）；安装固定用 `pi-web-ui install <source>
 * --name <id>` 保证目录名 == 列表 id，前端据此判断已装/未装。
 *
 * 设计上服务端不做网络探测（不拉 manifest）：名称/简介/图标由条目本身携带
 * （作者填），id 由来源推导或作者显式指定 —— 保持离线可用、可单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UiPluginCatalogEntry } from "./protocol.js";
import { normalizeIconSvg } from "./icon-svg.js";
import { pick, type ServerLang } from "./i18n.js";

/** 合法插件 id（与 server/plugins.ts 的 ID_RE 一致，防路径穿越）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** source 校验：owner/repo 或 owner/repo/子路径[#ref]。宽松校验，实际解析
 *  交给 CLI（pi-web-ui install）。只接受远程 GitHub 源，拒绝本地路径。 */
function isValidSource(source: string): boolean {
	if (!source || source.length > 300) return false;
	if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) return false;
	if (/^https?:\/\//.test(source)) return true; // 完整 URL（install 也支持）
	const spec = source.split("#")[0]!.replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2) return false;
	for (const s of segs) if (s === "." || s === "..") return false;
	return true;
}

/** 导出给服务端其它模块（后台作业的安装源校验、目录同步），单一事实源。 */
export { isValidSource };

/** 推导默认 id：与 CLI（bin/pi-web-ui.mjs）的规则对齐 —— 子路径末段 > 仓库名
 *  > 来源末段；非法字符替换为 -，两端去 -；空则 "plugin"。显式 raw（含合法
 *  id 校验）优先。返回的 id 不保证通过 ID_RE（Cyrillic 等），调用方再校验。 */
export function deriveCatalogId(raw: string | undefined, source: string): string {
	if (raw && ID_RE.test(raw)) return raw;
	const spec = source.split("#")[0]!.replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	const last = segs.length >= 2 ? segs[segs.length - 1]! : (segs[0] ?? "plugin");
	const cleaned = last.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "plugin";
}

function readJsonSafe<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function atomicWrite(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
	renameSync(tmp, path);
}

/** 把任意对象规范化为合法条目；非法则返回 null。 */
function toEntry(raw: Record<string, unknown>, builtin: boolean): UiPluginCatalogEntry | null {
	const source = typeof raw.source === "string" ? raw.source.trim() : "";
	if (!isValidSource(source)) return null;
	const id = deriveCatalogId(typeof raw.id === "string" ? raw.id.trim() : undefined, source);
	if (!ID_RE.test(id)) return null;
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
	const description =
		typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
	const descriptionEn =
		typeof raw.descriptionEn === "string" && raw.descriptionEn.trim() ? raw.descriptionEn.trim() : undefined;
	const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
	const iconSvg = normalizeIconSvg(raw.iconSvg);
	const homepage = typeof raw.homepage === "string" && raw.homepage.trim() ? raw.homepage.trim() : undefined;
	return {
		id,
		name,
		source,
		builtin,
		...(description ? { description } : {}),
		...(descriptionEn ? { descriptionEn } : {}),
		...(icon ? { icon } : {}),
		...(iconSvg ? { iconSvg } : {}),
		...(homepage ? { homepage } : {}),
	};
}

/** 读合并后的目录：builtin 在前，custom 在后（同 id 时 custom 覆盖 builtin）。
 *  custom 覆盖 builtin 时强制打 `overridesBuiltin: true` 标记（builtin 同时为
 *  false）：显示字段（name/icon/description）来自用户可写来源，可能仿冒官方条目，
 *  前端据此把它标识为「自定义覆盖」。source 始终保留真实（custom）安装来源，
 *  不允许伪装成官方来源。 */
export function readCatalog(builtinPath: string, customPath: string): UiPluginCatalogEntry[] {
	const out: UiPluginCatalogEntry[] = [];
	const seen = new Set<string>();
	if (existsSync(builtinPath)) {
		const raw = readJsonSafe<unknown>(builtinPath, []);
		if (Array.isArray(raw)) {
			for (const it of raw) {
				const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, true) : null;
				if (e && !seen.has(e.id)) {
					seen.add(e.id);
					out.push(e);
				}
			}
		}
	}
	const rawCustom = readJsonSafe<{ entries?: unknown }>(customPath, {});
	const list =
		rawCustom && typeof rawCustom === "object" && Array.isArray((rawCustom as { entries?: unknown[] }).entries)
			? (rawCustom as { entries: unknown[] }).entries
			: [];
	for (const it of list) {
		const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, false) : null;
		if (!e) continue;
		const idx = out.findIndex((x) => x.id === e.id);
		if (idx >= 0) {
			// 覆盖了同名 builtin 条目：强制带标识（不信任 custom 文件里的任何自标字段）。
			out[idx] = { ...e, builtin: false, overridesBuiltin: true };
		} else {
			out.push(e);
		}
		seen.add(e.id);
	}
	return out;
}

export interface CatalogAddInput {
	source: string;
	id?: string;
	name?: string;
	description?: string;
	icon?: string;
	iconSvg?: string;
}

/** 把用户填的条目追加进 custom 文件（同 id 覆盖旧条目）；返回规范化后的条目。
 *  非法来源/条目抛 Error。 */
export function addCustomEntry(
	customPath: string,
	input: CatalogAddInput,
	/** 面向用户的抛错文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
	lang?: () => ServerLang,
): UiPluginCatalogEntry {
	const l = lang?.() ?? "en";
	const source = String(input?.source ?? "").trim();
	if (!isValidSource(source)) {
		throw new Error(
			pick(
				l,
				"来源需为 owner/repo 或 owner/repo/子目录（不支持本地路径）",
				"Source must be owner/repo or owner/repo/subdir (local paths are not supported)",
				"plugincatalog.source.invalid",
			),
		);
	}
	const id = deriveCatalogId(typeof input?.id === "string" ? input.id.trim() : undefined, source);
	if (!ID_RE.test(id))
		throw new Error(
			pick(
				l,
				`非法 id "${id}"（仅限字母数字-_）`,
				`Invalid id "${id}" (letters/digits/-/_ only)`,
				"plugincatalog.id.invalid",
				{ id },
			),
		);
	const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
	const entries = Array.isArray(raw.entries) ? (raw.entries as unknown[]) : [];
	const next = entries.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).id === id));
	next.push({
		id,
		source,
		...(typeof input?.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
		...(typeof input?.description === "string" && input.description.trim()
			? { description: input.description.trim() }
			: {}),
		...(typeof input?.icon === "string" && input.icon.trim() ? { icon: input.icon.trim() } : {}),
		...(normalizeIconSvg(input?.iconSvg) ? { iconSvg: normalizeIconSvg(input?.iconSvg) } : {}),
	});
	atomicWrite(customPath, { entries: next });
	return toEntry(next[next.length - 1] as Record<string, unknown>, false)!;
}

/** 移除用户添加的条目（builtin 由文件自身控制，不可经此删除）；返回是否删掉。 */
export function removeCustomEntry(customPath: string, id: string): boolean {
	if (!ID_RE.test(id)) return false;
	const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
	if (!Array.isArray(raw.entries)) return false;
	const next = raw.entries.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).id === id));
	if (next.length === raw.entries.length) return false;
	atomicWrite(customPath, { entries: next });
	return true;
}

/* -------------------------------------------------------------------------- */
/* 目录同步（issue #148：host.reloadCatalog —— 第三方插件同步远端目录）        */
/* -------------------------------------------------------------------------- */

/** 同步文档的规范化结果：合法条目 + 被丢掉的条目数。 */
export interface CatalogSyncPayload {
	entries: UiPluginCatalogEntry[];
	/** 因缺 source / id 非法 / 形状不对而被丢弃的条目数（>0 时前端提示）。 */
	skipped: number;
}

/**
 * 把同步文档规范化为自定义条目列表（纯函数，不碰磁盘）。
 *
 * 文档形状：JSON 数组，或 `{ entries: [...] }`（与本文件自身的磁盘格式同形）。
 * 每个条目走 `toEntry` —— 与市场“添加到列表”**同一套校验**（id 字符集、source 必须
 * 是远程 owner/repo[/subdir][#ref]、字段 trimmed + 长度上限），非法条目丢弃并计数；
 * 整份文档形状不对则直接报错，由调用方原样回给调用者（绝不写盘）。
 */
export function normalizeSyncPayload(raw: unknown, lang?: () => ServerLang): CatalogSyncPayload | { error: string } {
	const l = lang?.() ?? "en";
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
			? (raw as { entries: unknown[] }).entries
			: null;
	if (!list)
		return {
			error: pick(
				l,
				'目录 JSON 需为数组，或 {"entries": [...]} 形状',
				'Catalog JSON must be an array or the {"entries": [...]} shape',
				"plugincatalog.sync.shape",
			),
		};
	const entries: UiPluginCatalogEntry[] = [];
	let skipped = 0;
	for (const it of list) {
		const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, false) : null;
		if (e) entries.push(e);
		else skipped += 1;
	}
	return { entries, skipped };
}

/**
 * 原子写入用户自定义列表。
 *
 * `replace=true` 整体替换（文档即真相）；`false`（默认）按 id upsert：文档里出现的
 * id 覆盖同名旧条目，文档没提的旧条目**保留** —— 这样插件只推送增量也能用。
 * 写入内容只包含本文件认识的白名单字段（id/source/name/description/descriptionEn/
 * icon/homepage），远端文档里塞的其他键不会落到磁盘上。
 *
 * 返回写盘后的自定义条目数（合并列表由 PluginManager.catalog() 重读得出）。
 */
export function writeCustomCatalog(customPath: string, incoming: UiPluginCatalogEntry[], replace: boolean): number {
	const byId = new Map<string, UiPluginCatalogEntry>();
	if (!replace) {
		const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
		const existing = Array.isArray(raw.entries) ? raw.entries : [];
		for (const it of existing) {
			const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, false) : null;
			if (e) byId.set(e.id, e);
		}
	}
	for (const e of incoming) byId.set(e.id, e);
	const entries = [...byId.values()].map((e) => ({
		id: e.id,
		source: e.source,
		name: e.name,
		...(e.description ? { description: e.description } : {}),
		...(e.descriptionEn ? { descriptionEn: e.descriptionEn } : {}),
		...(e.icon ? { icon: e.icon } : {}),
		...(e.iconSvg ? { iconSvg: e.iconSvg } : {}),
		...(e.homepage ? { homepage: e.homepage } : {}),
	}));
	atomicWrite(customPath, { entries });
	return entries.length;
}
