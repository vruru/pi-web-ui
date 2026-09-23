/**
 * 插件更新辅助（备份/回滚 + 远端 sha 对比）——纯逻辑，供 CLI（bin/pi-web-ui.mjs）
 * 与单测共用。远端提交通过 git ls-remote 获取；GitHub 子目录通过 tree SHA
 * 排除同仓无关改动。exec / tree resolver 可注入，单测完全离线。
 *
 * 布局：
 *   <dataDir>/plugins/<id>/           安装本体（含 .pi-source.json + .pi-git-sha）
 *   <dataDir>/plugin-backups/<id>-<ts>/  覆盖安装前的旧版本快照（保留最近 N 份）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { pick, type ServerLang } from "./i18n.js";

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** 保留的备份份数（超出删除最旧的）。 */
export const BACKUP_KEEP = 3;

export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** 默认执行器：execFile 直跑 git（不经 shell），15s 超时。 */
export const execGit: Exec = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/**
 * 覆盖安装前备份旧插件目录 → <dataDir>/plugin-backups/<id>-<ts>/。
 * 目标不存在/备份失败返回 null（调用方可继续——备份是尽力而为的保护）。
 */
export function ensureBackup(dataDir: string, id: string, opts?: { source?: string }): string | null {
	if (!PLUGIN_ID_RE.test(id)) return null;
	const target = join(dataDir, "plugins", id);
	if (!existsSync(target)) return null;
	const ts = stamp();
	const dest = join(dataDir, "plugin-backups", `${id}-${ts}`);
	try {
		mkdirSync(dirnameOf(dest)!, { recursive: true });
		cpSync(target, dest, {
			recursive: true,
			// 与安装一致：不备份 .git/node_modules（纯运行目录），config.json 等保留。
			filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
		});
		writeFileSync(join(dest, ".pi-backup.json"), JSON.stringify({ id, ts, source: opts?.source }, null, 2) + "\n");
		pruneBackups(dataDir, id);
		return ts;
	} catch (err) {
		try {
			rmSync(dest, { recursive: true, force: true });
		} catch {
			/* 清理失败忽略 */
		}
		console.warn(`[plugin-updater] 备份 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 该插件的备份目录列表（按时间从新到旧）。 */
export function listBackups(dataDir: string, id: string): string[] {
	if (!PLUGIN_ID_RE.test(id)) return [];
	const dir = join(dataDir, "plugin-backups");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${id.replace(/[^A-Za-z0-9_-]/g, "")}-(\\d{8}-\\d{9})$`);
	return names
		.filter((n) => re.test(n) && existsSync(join(dir, n, ".pi-backup.json")))
		.sort()
		.reverse();
}

/**
 * 回滚到最近一份备份：删当前 plugins/<id> → 拷贝备份回 → 删备份。
 * 返回最近备份 ts；无备份返回 null。
 */
export function restoreBackup(dataDir: string, id: string): string | null {
	const backups = listBackups(dataDir, id);
	if (backups.length === 0) return null;
	const src = join(dataDir, "plugin-backups", backups[0]);
	const target = join(dataDir, "plugins", id);
	try {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		mkdirSync(join(dataDir, "plugins"), { recursive: true });
		cpSync(src, target, { recursive: true });
		rmSync(src, { recursive: true, force: true });
		return backups[0];
	} catch (err) {
		console.warn(`[plugin-updater] 回滚 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 保留最近 BACKUP_KEEP 份，删除更旧的。 */
export function pruneBackups(dataDir: string, id: string, keep = BACKUP_KEEP): void {
	const backups = listBackups(dataDir, id);
	for (const b of backups.slice(keep)) {
		try {
			rmSync(join(dataDir, "plugin-backups", b), { recursive: true, force: true });
		} catch {
			/* 忽略 */
		}
	}
}

/** Match the installer's GitHub source syntax, including pinned refs and subdirectories. */
export function parseUpdateSource(spec: string): { repo: string; ref: string; subpath: string } | null {
	let clean = spec.trim();
	const hash = clean.indexOf("#");
	let ref = hash >= 0 ? clean.slice(hash + 1).trim() : "";
	if (hash >= 0) clean = clean.slice(0, hash);
	clean = clean.replace(/^git@github\.com:/i, "").replace(/^https?:\/\/(?:www\.)?github\.com\//i, "");
	const parts = clean.split("/").filter(Boolean);
	if (parts.length < 2 || !parts.every((p) => /^[\w.~-]+$/.test(p) && p !== "." && p !== "..")) return null;
	const repo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
	let subpath: string;
	if (parts[2] === "tree" || parts[2] === "blob") {
		ref ||= parts[3] ?? "";
		subpath = parts.slice(4).join("/");
	} else subpath = parts.slice(2).join("/");
	return { repo, ref: ref || "HEAD", subpath };
}

/** Resolve the installed source's branch/tag, never silently substitute default HEAD. */
export async function resolveRemoteSha(spec: string, exec: Exec = execGit): Promise<string | null> {
	const clean = spec.trim();
	const source = parseUpdateSource(clean);
	const local = existsSync(clean) ? clean : clean.startsWith("file://") ? clean.slice(7) : null;
	if (!local && !source) return null;
	const ref = local ? "HEAD" : source!.ref;
	if (/^[0-9a-f]{40,64}$/i.test(ref)) return ref.toLowerCase().slice(0, 12);
	const targets = ref === "HEAD" ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
	const res = await exec("git", ["ls-remote", local ?? `https://github.com/${source!.repo}.git`, ...targets]);
	if (!res.ok) return null;
	const rows = res.stdout
		.trim()
		.split("\n")
		.map((line) => line.split(/\s+/));
	const row = rows.find((r) => r[1] === `refs/tags/${ref}^{}`) ?? rows.find((r) => targets.includes(r[1]));
	const sha = row?.[0];
	return sha && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase().slice(0, 12) : null;
}

export type ResolvePluginTree = (repo: string, revision: string, subpath: string) => Promise<string | null>;

/** The directory tree excludes unrelated commits elsewhere in a monorepo. */
export function createTreeResolver(fetcher: typeof fetch = fetch): ResolvePluginTree {
	const requests = new Map<string, Promise<{ path: string; type: string; sha: string }[] | null>>();
	return async (repo, revision, subpath) => {
		const key = `${repo}@${revision}`;
		let request = requests.get(key);
		if (!request) {
			request = (async () => {
				try {
					const response = await fetcher(
						`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
						{
							headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-web-ui-plugin-update" },
							signal: AbortSignal.timeout(10_000),
						},
					);
					if (!response.ok) return null;
					const body = (await response.json()) as {
						truncated?: boolean;
						tree?: { path: string; type: string; sha: string }[];
					};
					return body.truncated || !Array.isArray(body.tree) ? null : body.tree;
				} catch {
					return null;
				}
			})();
			requests.set(key, request);
		}
		const tree = await request;
		const entry = tree?.find((item) => item.path === subpath && item.type === "tree");
		return entry && /^[0-9a-f]{40,64}$/i.test(entry.sha) ? entry.sha : null;
	};
}

export interface PluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	source: string;
	/** 本地安装时记录的 sha（.pi-git-sha）。 */
	localSha: string | null;
	/** 安装源指定分支/tag 的远端 sha（null = 无法检查）。 */
	remoteSha: string | null;
	/** 已确认安装源有改动；子目录插件须同时确认目录 tree 不同。 */
	updatable: boolean;
	error?: string;
}

/** 扫描全部已装插件，对比本地 sha 与远端 sha，报告更新状态。 */
export async function checkPluginUpdates(
	dataDir: string,
	exec: Exec = execGit,
	/** error 字段文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
	lang?: () => ServerLang,
	resolveTree: ResolvePluginTree = createTreeResolver(),
): Promise<PluginUpdateInfo[]> {
	const l = lang?.() ?? "en";
	const pluginsDir = join(dataDir, "plugins");
	let names: string[] = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		return [];
	}
	const out: PluginUpdateInfo[] = [];
	const remoteChecks = new Map<string, ReturnType<Exec>>();
	const sharedExec: Exec = (cmd, args) => {
		const key = JSON.stringify([cmd, args]);
		let pending = remoteChecks.get(key);
		if (!pending) {
			pending = exec(cmd, args);
			remoteChecks.set(key, pending);
		}
		return pending;
	};
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		const dir = join(pluginsDir, n);
		try {
			const sourceJson = readFileSync(join(dir, ".pi-source.json"), "utf8");
			const { source } = JSON.parse(sourceJson) as { source?: string };
			if (!source) continue; // 无来源记录（手工拷入）→ skip
			let localSha: string | null = null;
			try {
				localSha = readFileSync(join(dir, ".pi-git-sha"), "utf8").trim() || null;
			} catch {
				localSha = null; // Unknown installation revision cannot establish an update.
			}
			let remoteSha: string | null = null;
			let error: string | undefined;
			try {
				if (localSha && /^[0-9a-f]{12,64}$/i.test(localSha)) remoteSha = await resolveRemoteSha(source, sharedExec);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				remoteSha = null;
			}
			if (!remoteSha && !error)
				error = pick(
					l,
					"无法检查（非 git 源或 git 不可用）",
					"Cannot check (non-git source or git unavailable)",
					"pluginupdate.cannot.check",
				);
			let name: string | undefined;
			let version: string | undefined;
			try {
				const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				name = m.name;
				version = m.version;
			} catch {
				/* 坏 manifest：仍报告 */
			}
			let updatable = !!localSha && !!remoteSha && !localSha.startsWith(remoteSha) && !remoteSha.startsWith(localSha);
			const parsed = parseUpdateSource(source);
			if (updatable && parsed?.subpath) {
				try {
					const [localTree, remoteTree] = await Promise.all([
						resolveTree(parsed.repo, localSha!, parsed.subpath),
						resolveTree(parsed.repo, remoteSha!, parsed.subpath),
					]);
					updatable = !!localTree && !!remoteTree && localTree !== remoteTree;
					if (!localTree || !remoteTree) error = "Cannot verify plugin directory revision";
				} catch {
					updatable = false;
					error = "Cannot verify plugin directory revision";
				}
			}
			out.push({
				id: n,
				name,
				version,
				source,
				localSha,
				remoteSha,
				updatable,
				error,
			});
		} catch {
			continue; // 坏目录跳过
		}
	}
	return out;
}

/** Share concurrent checks and expire after five minutes. Installation/rollback changes
 * the fingerprint immediately, so an old result cannot survive a plugin update. */
export function createPluginUpdateChecker(
	dataDir: string,
	check: () => Promise<PluginUpdateInfo[]> = () => checkPluginUpdates(dataDir),
	ttlMs = 5 * 60_000,
	now: () => number = Date.now,
): () => Promise<PluginUpdateInfo[]> {
	let cached: { key: string; expires: number; result: Promise<PluginUpdateInfo[]> } | undefined;
	return () => {
		let key = "";
		try {
			key = readdirSync(join(dataDir, "plugins"))
				.sort()
				.filter((id) => PLUGIN_ID_RE.test(id))
				.map((id) => [
					id,
					...[".pi-source.json", ".pi-git-sha", "manifest.json"].map((file) => {
						try {
							return readFileSync(join(dataDir, "plugins", id, file), "utf8");
						} catch {
							return "";
						}
					}),
				])
				.map((entry) => JSON.stringify(entry))
				.join("\n");
		} catch {
			/* no plugins */
		}
		if (cached?.key === key && cached.expires > now()) return cached.result;
		const entry = { key, expires: Infinity, result: Promise.resolve().then(check) };
		cached = entry;
		entry.result.then(
			() => {
				entry.expires = now() + ttlMs;
			},
			() => {
				if (cached === entry) cached = undefined;
			},
		);
		return entry.result;
	};
}

function stamp(): string {
	const d = new Date();
	const p = (x: number, n = 2) => String(x).padStart(n, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function dirnameOf(p: string): string | null {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(0, i) : null;
}
