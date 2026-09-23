/**
 * plugin-catalog-sync — 受支持的「插件市场目录同步」（issue #148）。
 *
 * 第三方插件想把自己的插件清单同步进宿主，本来只能：派发私有的浏览器事件
 * `pi-web-ui:plugin-run-command` + 让用户在可见终端里看它跑命令。私有事件随时会变，
 * 宿主的目录更新也没有回执。这里把它做成**受支持的一条路径**：
 *
 *   host.reloadCatalog(source, { install, replace })       （插件侧，浏览器）
 *     → plugin_catalog_sync                                （协议）
 *       → 本文件：读文档 → 校验 → 原子写盘 → 可选安装 → 重载 + 重推 → 回执
 *
 * 三条纪律（对齐 issue 的验收标准）：
 *   1. 校验与市场「添加到列表」同源（plugin-catalog.ts 的 toEntry）——不合法条目丢弃，
 *      形状不对 / 读不到 / 解析失败时**一个字节都不写盘**（旧目录保持有效）；
 *   2. 安装走正常安装器（PluginInstaller，同 CLI + 同一把锁），失败逐条回报，
 *      不因为一条坏条目就停掉整批；
 *   3. 回执是结构化的（ok/error/entries/installed），不靠 DOM 事件或控制台文字。
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";
import { normalizeSyncPayload, writeCustomCatalog } from "./plugin-catalog.js";
import type { PluginInstaller } from "./plugin-installer.js";
import type { UiPluginCatalogEntry } from "./protocol.js";

export interface CatalogSyncOptions {
	/** 顺手把每个条目安装/更新一遍（已装 = update，未装 = install）。 */
	install?: boolean;
	/** 整体替换用户自定义列表（默认 false = 按 id upsert，保留未提到的旧条目）。 */
	replace?: boolean;
}

export interface CatalogSyncDeps {
	/** <dataDir>/plugin-catalog.json。 */
	customCatalogPath: string;
	/** <dataDir>/plugins —— 判断条目是否已装（决定 install 还是 update）。 */
	pluginsDir: string;
	installer: PluginInstaller;
	/** 写盘后只重推目录（false）；安装后才重载插件并重推列表（true）。 */
	afterWrite: (pluginsChanged: boolean) => Promise<void>;
	lang?: () => ServerLang;
	/** 抓取超时（默认 30s）。 */
	fetchTimeoutMs?: number;
	/** 文档大小上限（默认 1MB）——避免一个巨型 JSON 顶爆内存。 */
	maxBytes?: number;
}

export interface CatalogSyncResult {
	ok: boolean;
	error?: string;
	/** 同步后的完整市场列表（builtin + custom；由调用方取）。 */
	entries?: UiPluginCatalogEntry[];
	/** install:true 时逐条安装结果。 */
	installed?: { id: string; ok: boolean; error?: string }[];
}

/**
 * 读同步文档：`http(s)://` 走网络，其余当本地文件路径（须为绝对路径）。
 * 只读文本，JSON 解析交给调用方（解析失败也走同一条「不写盘」的路径）。
 */
async function readDocument(
	source: string,
	deps: CatalogSyncDeps,
	lang: () => ServerLang,
): Promise<{ text: string } | { error: string }> {
	const l = lang();
	const maxBytes = Math.max(1024, Number(deps.maxBytes ?? 1024 * 1024));
	if (/^https?:\/\//i.test(source)) {
		let res: Response;
		try {
			res = await fetch(source, {
				redirect: "follow",
				signal: AbortSignal.timeout(Math.max(1000, Number(deps.fetchTimeoutMs ?? 30_000))),
			});
		} catch (err) {
			return {
				error: pick(
					l,
					`拉取目录失败：${(err as Error)?.message ?? err}`,
					`Failed to fetch the catalog: ${(err as Error)?.message ?? err}`,
					"plugincatalog.sync.fetch.failed",
					{ reason: String((err as Error)?.message ?? err) },
				),
			};
		}
		if (!res.ok)
			return {
				error: pick(
					l,
					`拉取目录失败：HTTP ${res.status}`,
					`Failed to fetch the catalog: HTTP ${res.status}`,
					"plugincatalog.sync.http",
					{ status: String(res.status) },
				),
			};
		const text = await res.text();
		if (text.length > maxBytes)
			return {
				error: pick(
					l,
					`目录文档过大（> ${Math.round(maxBytes / 1024)} KB）`,
					`Catalog document too large (> ${Math.round(maxBytes / 1024)} KB)`,
					"plugincatalog.sync.too.large",
					{ kb: String(Math.round(maxBytes / 1024)) },
				),
			};
		return { text };
	}
	const p = source.trim();
	if (!isAbsolute(p))
		return {
			error: pick(
				l,
				"来源需为 http(s) URL 或本地文件的绝对路径",
				"Source must be an http(s) URL or an absolute local file path",
				"plugincatalog.sync.source.invalid",
			),
		};
	try {
		const text = readFileSync(p, "utf8");
		if (text.length > maxBytes)
			return {
				error: pick(
					l,
					`目录文档过大（> ${Math.round(maxBytes / 1024)} KB）`,
					`Catalog document too large (> ${Math.round(maxBytes / 1024)} KB)`,
					"plugincatalog.sync.too.large",
					{ kb: String(Math.round(maxBytes / 1024)) },
				),
			};
		return { text };
	} catch (err) {
		return {
			error: pick(
				l,
				`读取目录文件失败：${(err as Error)?.message ?? err}`,
				`Failed to read the catalog file: ${(err as Error)?.message ?? err}`,
				"plugincatalog.sync.read.failed",
				{ reason: String((err as Error)?.message ?? err) },
			),
		};
	}
}

/**
 * 同步一次目录：读 → 校验 → 原子写 → 可选安装 → 重载 + 重推。
 * 任何一步失败都以 `{ ok:false, error }` 返回（不抛），由协议层原样回给调用者。
 */
export async function syncPluginCatalog(
	source: string,
	opts: CatalogSyncOptions,
	deps: CatalogSyncDeps,
): Promise<CatalogSyncResult> {
	const lang = deps.lang ?? (() => "en" as ServerLang);
	const l = lang();
	const src = String(source ?? "").trim();
	if (!src)
		return {
			ok: false,
			error: pick(l, "缺少目录来源", "Missing catalog source", "plugincatalog.sync.source.missing"),
		};
	const doc = await readDocument(src, deps, lang);
	if ("error" in doc) return { ok: false, error: doc.error };
	let raw: unknown;
	try {
		raw = JSON.parse(doc.text);
	} catch (err) {
		return {
			ok: false,
			error: pick(
				l,
				`目录 JSON 解析失败：${(err as Error)?.message ?? err}`,
				`Catalog JSON is not valid JSON: ${(err as Error)?.message ?? err}`,
				"plugincatalog.sync.parse.failed",
				{ reason: String((err as Error)?.message ?? err) },
			),
		};
	}
	const payload = normalizeSyncPayload(raw, lang);
	if ("error" in payload) return { ok: false, error: payload.error };
	// 到这里才动磁盘：校验失败的文档绝不覆盖一份有效目录。
	writeCustomCatalog(deps.customCatalogPath, payload.entries, opts.replace === true);
	await deps.afterWrite(false);

	let installed: { id: string; ok: boolean; error?: string }[] | undefined;
	if (opts.install === true && payload.entries.length) {
		installed = [];
		for (const e of payload.entries) {
			const action = existsSync(join(deps.pluginsDir, e.id)) ? "update" : "install";
			const res = await deps.installer.run(
				{ jobId: `catalog-sync:${e.id}`, action, id: e.id, source: e.source },
				{ lang },
			);
			installed.push({ id: e.id, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
		}
		// 安装改变了 <dataDir>/plugins —— 再重载/重推一次，让新插件与前端清单对齐。
		await deps.afterWrite(true);
	}
	return { ok: true, installed };
}
