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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";
import { normalizeSyncPayload, writeCustomCatalog } from "./plugin-catalog.js";
import { workspacePath } from "./files-service.js";
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
	/** 工作区根（本地文件来源只允许工作区内的路径；缺省 = 一律拒绝本地路径）。
	 *  任意绝对路径可读 = 一个「文件存在/可读性」探测 oracle，必须收口。 */
	workspaceRoot?: string;
	/** 安装确认门（P0）：install:true 在真正动安装器之前必须拿到用户确认
	 *  （列出将安装的插件 id/source）。拒绝 / 超时 / 未接入（无头 DSH）一律
	 *  fail-closed —— 只写目录不安装。 */
	confirmInstall?: (items: Array<{ id: string; source: string }>) => Promise<boolean>;
}

export interface CatalogSyncResult {
	ok: boolean;
	error?: string;
	/** 同步后的完整市场列表（builtin + custom；由调用方取）。 */
	entries?: UiPluginCatalogEntry[];
	/** install:true 时逐条安装结果。 */
	installed?: { id: string; ok: boolean; error?: string }[];
	/** install:true 但用户拒绝 / 超时 / 无确认设施：目录已写，未安装任何插件
	 *  （调用方据此发 notice 告知）。 */
	installRefused?: boolean;
}

/**
 * 读同步文档：`http(s)://` 走网络，其余当本地文件路径 —— **只允许工作区内的路径**
 * （复用 files-service 的 workspacePath 校验；任意绝对路径可读会成为「文件存在 /
 * 可读性」探测 oracle）。只读文本；本地来源的读失败与过大统一进 `localDocFailed`
 * 这一条错误（调用方把解析失败也并进来），不区分「读不到 / 解析失败」两种失败。
 */
function localDocFailed(l: ServerLang): { error: string } {
	return {
		error: pick(
			l,
			"目录文档无效或不可读（仅支持 http(s) URL 或工作区内的 JSON 文件）",
			"Invalid or unreadable catalog document (http(s) URL or an in-workspace JSON file only)",
			"plugincatalog.sync.doc.invalid",
		),
	};
}

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
	// 本地来源：必须在工作区内（workspacePath 对相对/绝对路径统一做越界判定）。
	// 越界 / 读不到 / 过大统一返回同一条错误，不给调用方区分的余地。
	const wp = deps.workspaceRoot ? workspacePath(deps.workspaceRoot, source.trim()) : null;
	if (!wp) return localDocFailed(l);
	let text: string;
	try {
		text = readFileSync(wp.abs, "utf8");
	} catch {
		return localDocFailed(l);
	}
	if (text.length > maxBytes) return localDocFailed(l);
	return { text };
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
	const isLocalSource = !/^https?:\/\//i.test(src);
	let raw: unknown;
	try {
		raw = JSON.parse(doc.text);
	} catch (err) {
		// 本地来源不区分「读得到但解析失败 / 读不到 / 越界」——组合起来就是文件探测
		// oracle；http(s) 来源与本地文件无关，保留解析细节方便排障。
		if (isLocalSource) return { ok: false, error: localDocFailed(lang()).error };
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
		// 安装确认门（P0）：安装/更新插件是高风险动作，必须先经用户确认。第三方页面
		// 脚本可以直发 plugin_catalog_sync，没有这道门就能静默装任意插件。拒绝 /
		// 超时 / 无确认设施（无头 DSH）一律只保留目录更新，不安装。
		const items = payload.entries.map((e) => ({ id: e.id, source: e.source }));
		const confirmed = deps.confirmInstall ? await deps.confirmInstall(items) : false;
		if (!confirmed) return { ok: true, installRefused: true, installed: [] };
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
