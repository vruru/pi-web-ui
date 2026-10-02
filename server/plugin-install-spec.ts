/**
 * plugin-install-spec — 「安装前先读 spec」（DSH 对照清单 P0-3 / 引导式安装）。
 *
 * 背景：设置面板「添加到列表 / 从市场安装」原样把用户填的来源交给 CLI。打错字、
 * 已装过、根本不是插件包，全都要等 pnpm/git 跑完、用户在输出里自己找原因。
 * 这里在**动 CLI 之前**先做一次可解释的检查，把失败归到七种 problem 之一，
 * 每种都给一句人话 +（能给的）修复建议。
 *
 * 纪律：
 *   - 本模块**不联网、不写盘**（纯分类 + 本地文件系统探测）；真正的远端探测
 *     （raw.githubusercontent 读 manifest.json）在 installer 的 inspect 里做，
 *     这样本文件可以离线单测、也可以被前端复用同一套文案 key。
 *   - 分类结果只是**建议**，不是硬门禁：installer 仍会在真正安装前再校验一次，
 *     未知/疑似可用一律放行（宁可让 CLI 说话，也不要因为探测失败把能装的挡掉）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isValidSource } from "./plugin-catalog.js";

/** 安装来源的七种分类（与 DSH 的 install spec 同口径，少让作者/用户猜）。 */
export type InstallSpecKind =
	/** npm 包名（含 scope / 版本后缀），如 `@scope/pkg@1.2.3`。 */
	| "npm"
	/** GitHub 的 owner/repo[/subdir][#ref] —— pi-web-ui 插件的主路径。 */
	| "github"
	/** 完整 http(s) URL（git 仓库或目录文档）。 */
	| "url"
	/** 本机绝对路径（CLI 才放行；服务端作业不收）。 */
	| "path"
	/** 识别不了的形状。 */
	| "invalid";

export interface InstallSpecParse {
	kind: InstallSpecKind;
	/** 规范化后的来源（github 去掉协议/`.git` 后缀；path 转绝对路径）。 */
	normalized: string;
	/** kind=github 时的分段（供远端探测拼 raw URL）。 */
	owner?: string;
	repo?: string;
	/** `#ref` 部分（分支/tag/commit）。 */
	ref?: string;
	/** 子目录（owner/repo/sub/dir 或 tree/<ref>/<sub> 写法）。 */
	subpath?: string;
}

/** npm 包名形状（宽松）：可带 @scope/ 前缀与 @version 后缀；不含 `/` 之外的路径段。 */
const NPM_RE = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[^\s/]+)?$/i;

/**
 * 解析并按形状分类一个安装来源。纯函数、不碰网络与磁盘（除 `path` 分支的
 * 存在性判断——那是刻意让「本机路径 vs 形状不对」可区分）。
 */
export function parseInstallSpec(rawSpec: string): InstallSpecParse {
	const raw = String(rawSpec ?? "").trim();
	if (!raw) return { kind: "invalid", normalized: "" };
	// 1) 本机路径：绝对路径、file:// 前缀、或当前存在的相对目录（CLI 自己的判据）。
	const localCandidate = raw.replace(/^file:\/\//i, "");
	if (isAbsolute(localCandidate) || safeExists(localCandidate)) return { kind: "path", normalized: localCandidate };
	// 2) 完整 URL（git 仓库 / 目录文档）。
	if (/^https?:\/\//i.test(raw)) {
		// GitHub 的网页 URL 仍归 github（能拿 owner/repo/ref/subpath，可做远端探测）。
		const gh = parseGithubUrl(raw);
		if (gh) return gh;
		return { kind: "url", normalized: raw };
	}
	// 3) GitHub 的 owner/repo[/sub][#ref] 简写。
	const short = parseGithubShort(raw);
	if (short) return short;
	// 4) npm 包名。
	if (NPM_RE.test(raw)) return { kind: "npm", normalized: raw };
	return { kind: "invalid", normalized: raw };
}

function safeExists(p: string): boolean {
	try {
		return existsSync(p);
	} catch {
		// 非法路径字符（Windows 上的 `<` `>` 等）→ 当不存在。
		return false;
	}
}

/** 解析 https://github.com/owner/repo[/tree/<ref>[/<sub>]] 或 `owner/repo` 简写。 */
function parseGithubUrl(raw: string): InstallSpecParse | null {
	const m = raw.match(
		/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/]+)((?:\/[^#?]+)*))?/i,
	);
	if (!m) return null;
	const [, owner, repoRaw, refRaw, rest] = m;
	const repo = String(repoRaw ?? "").replace(/\.git$/i, "");
	const subpath = String(rest ?? "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	const hashRef = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1).trim() : "";
	const ref = hashRef || String(refRaw ?? "");
	return {
		kind: "github",
		normalized: [owner, repo, subpath].filter(Boolean).join("/") + (ref ? `#${ref}` : ""),
		owner,
		repo,
		...(ref ? { ref } : {}),
		...(subpath ? { subpath } : {}),
	};
}

/** 解析 owner/repo[/sub][#ref]（cli 与 marketplace 的主写法）。 */
function parseGithubShort(raw: string): InstallSpecParse | null {
	// 带 @ 前缀 = npm scope（@scope/pkg），GitHub 的 owner 不允许 @ —— 先摘出去，
	// 免得 `@scope/pkg` 被当成 owner=`@scope` 的仓库（分类错会让 UI 给错建议）。
	if (raw.startsWith("@")) return null;
	const hash = raw.indexOf("#");
	const ref = hash >= 0 ? raw.slice(hash + 1).trim() : "";
	const body = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\/+$/, "");
	if (!isValidSource(body)) return null;
	const segs = body.split("/").filter(Boolean);
	const [owner, repo, ...rest] = segs;
	if (!owner || !repo) return null;
	// URL 的 tree/blob 写法也可简写过来（owner/repo/tree/<ref>/<sub>）。
	let subpath = rest.join("/");
	let effectiveRef = ref;
	if (rest[0] === "tree" || rest[0] === "blob") {
		effectiveRef = rest[1] ?? ref;
		subpath = rest.slice(2).join("/");
	}
	return {
		kind: "github",
		normalized: body + (effectiveRef ? `#${effectiveRef}` : ""),
		owner,
		repo,
		...(effectiveRef ? { ref: effectiveRef } : {}),
		...(subpath ? { subpath } : {}),
	};
}

/** 安装问题的七种分类（DSH 的 problem 枚举，逐条给人话建议）。 */
export type InstallProblem =
	"invalid-spec" | "already-installed" | "not-found" | "not-a-package" | "not-a-bundle" | "network" | "unknown";

export interface InstallInspect {
	/** 解析结果（形状 + 规范化来源）。 */
	spec: InstallSpecParse;
	/** 阻塞性问题（非空 = 别装了，先把这条修掉）。 */
	problem?: InstallProblem;
	/** problem 的**用户可读**英文短句（中文由调用方经 pick 结合 key 生成）。 */
	detail?: string;
	/** 是否已装（<dataDir>/plugins/<id> 存在）。已装不是错误 —— UI 会把它转成「更新」。 */
	installed: boolean;
	/** 远端探测拿到的 manifest（有则展示 name/version/description 给用户确认）。 */
	manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: string[] };
	/** 建议的插件 id（manifest.id > 来源末段），供 UI 预填。 */
	suggestedId: string;
}

/** 粗略的 id 字符集（与 server/plugins.ts 的 ID_RE 一致）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 由来源推导落盘 id（与 CLI / plugin-catalog 同规则：子目录末段 > 仓库名 > 末段）。 */
export function suggestPluginId(spec: InstallSpecParse, explicit?: string): string {
	if (explicit && ID_RE.test(explicit)) return explicit;
	const seg = spec.subpath
		? spec.subpath.split("/").filter(Boolean).pop()
		: (spec.repo ?? lastSegment(spec.normalized));
	const cleaned = String(seg ?? "")
		.replace(/[^A-Za-z0-9_-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "plugin";
}

function lastSegment(s: string): string {
	const body = s.split("#")[0]!.replace(/\/+$/, "");
	const segs = body.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? "";
}

/* ------------------------------------------------------------------ */
/* 本地可判定的检查（不联网）                                           */
/* ------------------------------------------------------------------ */

export interface LocalInspectDeps {
	/** <dataDir>/plugins。 */
	pluginsDir: string;
	/** 显式 id（用户填的；缺省由来源推导）。 */
	explicitId?: string;
	/** force/update：已装不再是阻塞问题（会走覆盖）。 */
	force?: boolean;
}

/**
 * 本地检查：形状分类 + 已装判定。**不联网** —— 远端 manifest 探测由 installer
 * 的 `inspectRemote()` 补上（本函数是它的第一步，也可单独用于「添加到列表」）。
 */
export function inspectLocalInstallSpec(rawSpec: string, deps: LocalInspectDeps): InstallInspect {
	const spec = parseInstallSpec(rawSpec);
	const suggestedId = suggestPluginId(spec, deps.explicitId);
	const installed = safeExists(join(deps.pluginsDir, suggestedId));
	const base: InstallInspect = { spec, installed, suggestedId };
	if (spec.kind === "invalid")
		return {
			...base,
			problem: "invalid-spec",
			detail:
				"Unrecognized source — expected owner/repo, owner/repo/subdir[#ref], a GitHub URL, or an npm package name.",
		};
	if (spec.kind === "path" && !safeExists(spec.normalized))
		return { ...base, problem: "not-found", detail: `Local path does not exist: ${spec.normalized}` };
	if (installed && !deps.force)
		return {
			...base,
			problem: "already-installed",
			detail: `A plugin named "${suggestedId}" is already installed — use Update to replace it.`,
		};
	return base;
}

/** 读本地目录里的 manifest.json（本地路径源用；失败返回 null，不抛）。 */
export function readLocalManifest(dir: string): InstallInspect["manifest"] | null {
	try {
		const p = join(dir, "manifest.json");
		if (!statSync(p).isFile()) return null;
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		return pickManifestFields(raw);
	} catch {
		return null;
	}
}

/** 从任意 manifest 对象里摘出可展示字段（顺带校验它是插件）。 */
export function pickManifestFields(raw: unknown): InstallInspect["manifest"] | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" && typeof o.name !== "string") return null;
	const permissions = Array.isArray(o.permissions)
		? o.permissions.filter((x): x is string => typeof x === "string").slice(0, 32)
		: undefined;
	return {
		...(typeof o.id === "string" ? { id: o.id } : {}),
		...(typeof o.name === "string" ? { name: o.name } : {}),
		...(typeof o.version === "string" ? { version: o.version } : {}),
		...(typeof o.description === "string" ? { description: o.description } : {}),
		...(permissions ? { permissions } : {}),
	};
}

/**
 * 远端 manifest 的候选 raw URL（按 ref 有无/子目录有无各一条）。
 * 只用 raw.githubusercontent.com —— 与 server/locales.ts 同一取用姿势，无需 API token。
 */
export function manifestCandidateUrls(spec: InstallSpecParse): string[] {
	if (spec.kind !== "github" || !spec.owner || !spec.repo) return [];
	const ref = spec.ref || "HEAD";
	const base = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}`;
	return spec.subpath ? [`${base}/${spec.subpath}/manifest.json`] : [`${base}/manifest.json`];
}
