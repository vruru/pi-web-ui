/**
 * All-source update check: pi-web-ui itself, the installed pi core
 * (@earendil-works/pi-coding-agent — probed via `pi --version`, with a
 * vendored-copy fallback), the DIRECT pi extensions declared in
 * <agentDir>/npm/package.json (fallback: raw node_modules walk), plus the
 * git-source extensions declared in global/project settings.json (issue #178).
 * Pure logic lives here so it can be unit-tested with an injected fetcher
 * (and an injected pi-core probe); ClientSession only wires it to the wire
 * protocol.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { pick, type ServerLang } from "./i18n.js";

const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";

/** npm 官方源；用户在 <agentDir>/npm/.npmrc 里配了镜像/私有源时会被覆盖（issue #151）。 */
export const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 8_000;
/** Parallel registry lookups per batch. */
const CONCURRENCY = 5;

/** Simple numeric semver compare: >0 means a newer than b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/**
 * Cache a zero-arg function's value for ttlMs. Plain value memoization: the
 * pi probe returns null on failure instead of throwing, so errors thread
 * through as ordinary values and there is nothing to rethrow.
 */
export function memoizeWithTtl<T>(fn: () => T, ttlMs: number): () => T {
	let entry: { at: number; value: T } | null = null;
	return () => {
		const now = Date.now();
		if (!entry || now - entry.at >= ttlMs) {
			entry = { at: now, value: fn() };
		}
		return entry.value;
	};
}

/**
 * Parse `pi --version` stdout into a version string, or null. Two-stage:
 * prefer a line that is exactly the version (optional leading "v", optional
 * prerelease/build suffix) so a stdout preamble like "Update available:
 * 0.85.0" cannot forge it; otherwise fall back to the first loose
 * semver-looking token. The exact-line match keeps the FULL version incl.
 * prerelease (0.85.0-beta.1 stays 0.85.0-beta.1).
 */
export function parsePiVersionOutput(stdout: string): string | null {
	const exact = stdout.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)*)\s*$/m)?.[1];
	if (exact) return exact;
	return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export type UpdateItemKind = "webui" | "pi-core" | "package" | "git-extension";

export interface UpdateItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
	source?: string;
}

export interface LocalPackage {
	name: string;
	version: string;
	kind: UpdateItemKind;
	/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
	source?: string;
	/** git-extension only: clone dir (<agentDir>/git/… or <projectCwd>/.pi/git/…). */
	installDir?: string;
	/** git-extension only: configured ref (`@…` suffix), if any. */
	ref?: string | null;
}

/**
 * Enumerate installed pi packages for the "check all updates" list, matching
 * what the TUI shows: the DIRECT dependencies declared in
 * <agentDir>/npm/package.json, with each installed version resolved from
 * node_modules/<name>/package.json (not the manifest range). Transitive deps
 * are not listed.
 *
 * Fallback: when the manifest is missing/unreadable or declares no
 * dependencies, fall back to the historical raw node_modules walk.
 */
export function listInstalledPackages(agentDir: string): LocalPackage[] {
	const direct = readManifestDeps(agentDir);
	if (direct) return direct;
	return walkNodeModules(agentDir);
}

/** Direct deps from the npm manifest with installed versions, or null. */
function readManifestDeps(agentDir: string): LocalPackage[] | null {
	let manifest: { dependencies?: Record<string, string> } | null;
	try {
		manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		} | null;
		// Literal `null` parses fine but explodes on property access — treat as
		// unreadable (fallback to the raw walk), per the documented contract.
		if (!manifest || typeof manifest !== "object") return null;
	} catch {
		return null;
	}
	const deps = manifest.dependencies;
	if (!deps || typeof deps !== "object" || Object.keys(deps).length === 0) {
		return null;
	}
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	for (const name of Object.keys(deps)) {
		const item = readLocalPackage(join(root, ...name.split("/")));
		// Broken/uninstalled entries are skipped (the registry never sees them).
		if (item) out.push(item);
	}
	// Deterministic order (manifest key order is arbitrary).
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Legacy fallback: raw walk of <agentDir>/npm/node_modules — top-level plain
 * names plus one level inside @scope dirs. Skips .bin, dotfiles and anything
 * without a readable package.json.
 */
function walkNodeModules(agentDir: string): LocalPackage[] {
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.startsWith(".") || entry === ".bin") continue;
		if (entry.startsWith("@")) {
			let scoped: string[];
			try {
				scoped = readdirSync(join(root, entry));
			} catch {
				continue;
			}
			for (const name of scoped) {
				if (name.startsWith(".")) continue;
				const item = readLocalPackage(join(root, entry, name));
				if (item) out.push(item);
			}
		} else {
			const item = readLocalPackage(join(root, entry));
			if (item) out.push(item);
		}
	}
	// Deterministic order (readdir order is FS-dependent).
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readLocalPackage(dir: string): LocalPackage | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (!pkg.name || !pkg.version) return null;
		return { name: pkg.name, version: pkg.version, kind: "package" };
	} catch {
		return null;
	}
}

// -- git-source extensions (issue #178) --------------------------------------
// The panel historically enumerated only npm direct deps, so `git:` entries in
// settings.json never appeared. pi core updates both (`updateConfiguredSources`
// buckets npmCandidates/gitCandidates), keyed by normalized `git:host/path`.

const execFileAsync = promisify(execFile);
/** Matches pi core NETWORK_TIMEOUT_MS so slow forges degrade the same way. */
const GIT_TIMEOUT_MS = 10_000;

export interface GitExtensionSource {
	host: string;
	/** Normalized owner/repo (no .git suffix, no ref). */
	path: string;
	/** Configured ref (`@…` suffix), if any. Pinned refs are still checked:
	 * core treats them as checkout targets to reconcile (package-manager
	 * `updateConfiguredSources` comment), so a moved ref shows as an update. */
	ref: string | null;
	/** `host/path` — prepend `git:` for the `pi update` argument (issue #178 step 6). */
	shorthand: string;
	/** `git:host/path` — global/project dedupe key (mirrors core identity). */
	identity: string;
}

function hasUnsafeGitPart(value: string, allowSlash: boolean): boolean {
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return true;
	if (!allowSlash && value.includes("/")) return true;
	if (value.split("/").includes("..")) return true;
	return false;
}

function normalizeGitRepo(host: string, path: string, ref: string | null): GitExtensionSource | null {
	const cleanPath = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
	if (!host || !cleanPath || cleanPath.split("/").length < 2) return null;
	if (hasUnsafeGitPart(host, false) || hasUnsafeGitPart(cleanPath, true)) return null;
	if (ref !== null && (ref === "" || ref.includes("\0"))) return null;
	return {
		host,
		path: cleanPath,
		ref,
		shorthand: `${host}/${cleanPath}`,
		identity: `git:${host}/${cleanPath}`,
	};
}

/** Split `rest` (the part after the host) on the first `@` into path + ref. */
function splitGitRef(rest: string): { path: string; ref: string | null } {
	const at = rest.indexOf("@");
	if (at < 0) return { path: rest, ref: null };
	return { path: rest.slice(0, at), ref: rest.slice(at + 1) || null };
}

/**
 * Parse a settings `packages` entry into a git source, or null when it is not
 * one. Accepts the same shapes pi core does (`parseGitUrl`): `git:`-prefixed
 * shorthand/URLs plus bare explicit protocol URLs. `npm:`/local entries yield
 * null — they are handled by the npm enumeration, not here.
 */
export function parseGitExtensionSource(entry: string): GitExtensionSource | null {
	const trimmed = entry.trim();
	if (!trimmed || trimmed.startsWith("npm:")) return null;
	const url = trimmed.startsWith("git:") ? trimmed.slice(4).trim() : trimmed;
	if (!url) return null;
	// scp-like: git@host:owner/repo[.git][@ref]
	const scp = url.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		const { path, ref } = splitGitRef(scp[2]!);
		return normalizeGitRepo(scp[1]!, path, ref);
	}
	// Explicit protocol URLs (bare or git:-prefixed).
	if (/^(https?|ssh|git):\/\//i.test(url)) {
		let host: string;
		let rest: string;
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			rest = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
		const { path, ref } = splitGitRef(rest);
		return normalizeGitRepo(host, path, ref);
	}
	// Shorthand only with an explicit git: prefix (bare `a/b` is a local path).
	if (!trimmed.startsWith("git:")) return null;
	const slash = url.indexOf("/");
	if (slash < 0) return null;
	const host = url.slice(0, slash);
	if (!host.includes(".") && host !== "localhost") return null;
	const { path, ref } = splitGitRef(url.slice(slash + 1));
	return normalizeGitRepo(host, path, ref);
}

/**
 * Total switch for the git-source check (issue #178 step 8). `0/false/no/off`
 * disables it (large-monorepo escape hatch); unset or anything else enables.
 */
export function isGitExtensionCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_GIT_EXTENSION_CHECK ?? "").trim().toLowerCase();
	return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

type SettingsPackageEntry = string | { source?: unknown };

function readSettingsPackagesFile(file: string): SettingsPackageEntry[] {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
		if (!data || typeof data !== "object" || !Array.isArray(data.packages)) return [];
		return data.packages.filter(
			(p): p is SettingsPackageEntry => typeof p === "string" || (p !== null && typeof p === "object"),
		);
	} catch {
		return [];
	}
}

function readGitCloneNameVersion(installDir: string): { name?: string; version?: string } {
	try {
		const pkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")) as {
			name?: string;
			version?: string;
		};
		// Name and version fall back independently: a clone with a version but
		// no usable name still reports its version (name falls back to the
		// source shorthand at the call site), and vice versa.
		return {
			...(typeof pkg.name === "string" && pkg.name ? { name: pkg.name } : {}),
			...(typeof pkg.version === "string" && pkg.version ? { version: pkg.version } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * Enumerate `git:` entries from global (<agentDir>/settings.json) plus project
 * (<projectCwd>/.pi/settings.json) settings — the same two scopes pi core
 * updates. Project wins on identity collision (mirrors core dedupePackages).
 * Entries whose clone is missing are still listed (version `?`): checkAll
 * reports them as per-item errors instead of silently dropping the row.
 */
export function listGitExtensions(
	agentDir: string,
	projectCwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): LocalPackage[] {
	if (!isGitExtensionCheckEnabled(env)) return [];
	const scopes: Array<{ file: string; gitRoot: string }> = [];
	if (projectCwd)
		scopes.push({ file: join(projectCwd, ".pi", "settings.json"), gitRoot: join(projectCwd, ".pi", "git") });
	scopes.push({ file: join(agentDir, "settings.json"), gitRoot: join(agentDir, "git") });
	const seen = new Set<string>();
	const out: LocalPackage[] = [];
	for (const { file, gitRoot } of scopes) {
		for (const pkg of readSettingsPackagesFile(file)) {
			const raw = typeof pkg === "string" ? pkg : typeof pkg.source === "string" ? pkg.source : null;
			if (!raw) continue;
			const parsed = parseGitExtensionSource(raw);
			if (!parsed || seen.has(parsed.identity)) continue;
			seen.add(parsed.identity);
			const installDir = join(gitRoot, parsed.host, ...parsed.path.split("/"));
			const nv = readGitCloneNameVersion(installDir);
			out.push({
				name: nv.name ?? parsed.shorthand,
				version: nv.version ?? "?",
				kind: "git-extension",
				source: parsed.shorthand,
				installDir,
				ref: parsed.ref,
			});
		}
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Display form for git rows: `<version> (<short sha>)`, sha-only when the
 * clone has no readable package.json version (issue #178 step 5). */
export function formatGitVersion(version: string, sha: string): string {
	const short = sha.slice(0, 7);
	return version && version !== "?" ? `${version} (${short})` : short;
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return stdout.trim();
}

export interface GitCheckResult {
	localSha: string;
	remoteSha: string;
}

export type GitCheckFn = (installDir: string) => Promise<GitCheckResult>;

/**
 * Compare a clone's HEAD against its remote (lightweight: `ls-remote` fetches
 * refs only, no objects). Upstream branch wins when configured, else origin
 * HEAD — the same order pi core `getRemoteGitHead` uses.
 */
export async function defaultCheckGitExtension(installDir: string): Promise<GitCheckResult> {
	const localSha = await runGit(["rev-parse", "HEAD"], installDir);
	if (!/^[0-9a-f]{40}$/i.test(localSha)) throw new Error(`Bad local HEAD: ${localSha.slice(0, 20)}`);
	let remoteSha: string | null = null;
	try {
		const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], installDir);
		const branch = upstream.match(/^origin\/(.+)$/)?.[1];
		if (branch) {
			const out = await runGit(["ls-remote", "origin", `refs/heads/${branch}`], installDir);
			remoteSha = out.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
		}
	} catch {
		/* no usable upstream — fall through to origin HEAD */
	}
	if (!remoteSha) {
		const out = await runGit(["ls-remote", "origin", "HEAD"], installDir);
		remoteSha = out.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null;
	}
	if (!remoteSha) throw new Error("Failed to determine remote HEAD");
	return { localSha, remoteSha };
}

/** How long a pi probe result stays hot (mirrors ClientSession.piCliProbe). */
const PI_PROBE_TTL_MS = 10_000;

let piCoreProbe: { at: number; version: string | null } | null = null;

/** Locate the pi CLI on PATH without spawning anything. */
function piCliOnPath(): string | null {
	const dirs = (process.env.PATH ?? "").split(delimiter);
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = join(dir, "pi");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Read the pi core version from disk: resolve the `pi` bin (typically a
 * symlink into <global>/node_modules/<pkg>/dist/bundle/cli.js) and walk up to
 * its package.json. FORK-FREE by design — see the note on defaultProbePiCore.
 */
function readPiCoreVersionFromDisk(): string | null {
	const bin = piCliOnPath();
	if (!bin) return null;
	try {
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 8; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
					if (pkg.name === PI_CORE_PACKAGE && pkg.version) return pkg.version;
				} catch {
					/* unreadable package.json — keep walking */
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Default pi core probe: run the globally installed `pi --version`, memoized
 * machine-wide for PI_PROBE_TTL_MS so repeated collectTargets calls never
 * re-probe. Reads the version from disk (pi bin → realpath → package.json)
 * instead of spawning `pi --version`. FORK-FREE by design — see the note on
 * defaultProbePiCore.
 */
export function defaultProbePiCore(): string | null {
	const now = Date.now();
	const cached = piCoreProbe;
	if (cached && now - cached.at < PI_PROBE_TTL_MS) return cached.version;
	const version = readPiCoreVersionFromDisk();
	piCoreProbe = { at: now, version };
	return version;
}

/**
 * Fallback when the CLI probe yields nothing: the version of the vendored pi
 * core copy in <agentDir>/npm/node_modules, or null if that is absent too.
 */
function readVendoredPiCore(agentDir: string): string | null {
	try {
		const pkg = JSON.parse(
			readFileSync(join(agentDir, "npm", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"), "utf8"),
		) as { name?: string; version?: string };
		if (pkg.name !== PI_CORE_PACKAGE || !pkg.version) return null;
		return pkg.version;
	} catch {
		return null;
	}
}

/**
 * Build the full local target list: webui + the pi core + installed packages
 * + git-source extensions (issue #178) from global and project settings.
 * The pi core version comes from the CLI probe (injectable for tests), falling
 * back to the vendored copy under <agentDir>/npm/node_modules. Packages
 * listing the core directly are filtered out so the pi-core row wins — never
 * two rows for the same package.
 */
export function collectTargets(
	agentDir: string,
	webuiVersion: string,
	probePiCore: () => string | null = defaultProbePiCore,
	opts?: { projectCwd?: string; includeWebui?: boolean },
): LocalPackage[] {
	const targets: LocalPackage[] =
		opts?.includeWebui === false ? [] : [{ name: "pi-web-ui", version: webuiVersion, kind: "webui" }];
	const coreVersion = probePiCore() ?? readVendoredPiCore(agentDir);
	if (coreVersion) {
		targets.push({
			name: PI_CORE_PACKAGE,
			version: coreVersion,
			kind: "pi-core",
		});
	}
	targets.push(...listInstalledPackages(agentDir).filter((pkg) => pkg.name !== PI_CORE_PACKAGE));
	targets.push(...listGitExtensions(agentDir, opts?.projectCwd));
	return targets;
}

export type Fetcher = (
	url: string,
	init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Default fetcher (real network). Tests inject a fake. */
export const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

/**
 * 解析 .npmrc 文本里的全局 registry（`registry=<url>`，后出现的覆盖先出现的）。
 * 找不到返回 null（调用方回落 NPM_DEFAULT_REGISTRY）。引号与行尾 `/` 会被清理。
 */
export function parseNpmrcRegistry(text: string): string | null {
	let registry: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const m = line.match(/^registry\s*=\s*(.+?)\s*$/i);
		if (!m) continue;
		let url = m[1]!
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (!url) continue;
		url = url.replace(/\/+$/, "");
		if (/^https?:\/\//i.test(url)) registry = url;
	}
	return registry;
}

/**
 * 从 .npmrc 文本里找出与 registry 同源的认证头（`//host/path:_authToken=` 优先，
 * 其次 `//host/path:_auth=`）。私有源检查更新时没有它会直接 401（issue #151）。
 */
export function parseNpmrcAuth(text: string, registry: string): string | null {
	let host: string;
	try {
		host = new URL(registry).host.toLowerCase();
	} catch {
		return null;
	}
	let token: string | null = null;
	let basic: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";") || !line.startsWith("//")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (!value) continue;
		// key 形如 //registry.example.com/:_authToken —— 取 // 与 : 之间的 host 比对
		const keyHost = key.slice(2).split("/")[0]!.split(":")[0]!.toLowerCase();
		if (keyHost !== host) continue;
		if (/.:_authToken$/i.test(key)) token = value;
		else if (/.:_auth$/i.test(key)) basic = value;
	}
	if (token) return `Bearer ${token}`;
	if (basic) return `Basic ${basic}`;
	return null;
}

export interface NpmRegistryConfig {
	registry: string;
	/** Authorization 头（私有源 .npmrc 里配了 token 时才有）。 */
	authHeader: string | null;
}

/**
 * 读取 <agentDir>/npm/.npmrc（`pi update --extensions` 经 npm 自动遵守的同一份），
 * 解析出检查更新该用的 registry + 认证头。文件不存在/不可读/无 registry 行时
 * 回落官方源（issue #151：镜像/私有源用户不再被卡在官方源上）。
 */
export function resolveNpmRegistry(agentDir: string): NpmRegistryConfig {
	try {
		const text = readFileSync(join(agentDir, "npm", ".npmrc"), "utf8");
		const registry = parseNpmrcRegistry(text) ?? NPM_DEFAULT_REGISTRY;
		return { registry, authHeader: parseNpmrcAuth(text, registry) };
	} catch {
		return { registry: NPM_DEFAULT_REGISTRY, authHeader: null };
	}
}

interface RegistryDoc {
	"dist-tags"?: { latest?: string };
	time?: Record<string, string>;
}

/**
 * Look up one package's latest version + publish time in the npm registry.
 * registry/authHeader 默认官方源；镜像/私有源用户经 resolveNpmRegistry 传入
 * <agentDir>/npm/.npmrc 的配置（issue #151）。
 */
export async function fetchLatest(
	fetcher: Fetcher,
	name: string,
	registry: string = NPM_DEFAULT_REGISTRY,
	authHeader: string | null = null,
): Promise<{ latest: string | null; latestPublishedAt: string | null }> {
	const res = await fetcher(`${registry}/${encodeURIComponent(name)}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		...(authHeader ? { headers: { authorization: authHeader } } : {}),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as RegistryDoc;
	const latest = data["dist-tags"]?.latest ?? null;
	return {
		latest,
		latestPublishedAt: latest && data.time ? (data.time[latest] ?? null) : null,
	};
}

/**
 * Check every target: npm kinds against the registry, git-extension kinds
 * against their clone's remote (`ls-remote`, refs only). One failed lookup
 * degrades to an error item (upToDate: false) without failing the rest.
 * Results keep the input order. Bounded concurrency (CONCURRENCY) keeps
 * registry/remote load polite. The git checker is injectable for tests.
 */
export async function checkAll(
	targets: LocalPackage[],
	fetcher: Fetcher = defaultFetcher,
	/** 单项查询失败时的 error 文案语言（默认英文）。 */
	lang?: () => ServerLang,
	/** 镜像/私有源配置（默认官方源；调用方经 resolveNpmRegistry 传入 .npmrc，issue #151）。 */
	registryConfig?: NpmRegistryConfig,
	/** git 源远端比较（默认真 git；单测注入 fake，issue #178）。 */
	gitCheck: GitCheckFn = defaultCheckGitExtension,
): Promise<UpdateItem[]> {
	const l = lang?.() ?? "en";
	const registry = registryConfig?.registry ?? NPM_DEFAULT_REGISTRY;
	const authHeader = registryConfig?.authHeader ?? null;
	const fail = (t: LocalPackage, errMessage: string): UpdateItem => ({
		name: t.name,
		kind: t.kind,
		current: t.version,
		latest: null,
		latestPublishedAt: null,
		upToDate: false,
		...(t.source ? { source: t.source } : {}),
		error: pick(
			l,
			`检查更新失败：${errMessage}`,
			`Failed to check for updates: ${errMessage}`,
			"updatecheck.check.failed",
			{
				errMessage,
			},
		),
	});
	const results: UpdateItem[] = Array.from({ length: targets.length }) as UpdateItem[];
	let cursor = 0;
	async function worker() {
		while (cursor < targets.length) {
			const i = cursor++;
			const t = targets[i]!;
			if (t.kind === "git-extension") {
				try {
					if (!t.installDir) throw new Error("missing install dir");
					const { localSha, remoteSha } = await gitCheck(t.installDir);
					const upToDate = localSha.trim() === remoteSha.trim();
					results[i] = {
						name: t.name,
						kind: t.kind,
						current: formatGitVersion(t.version, localSha),
						latest: formatGitVersion(t.version, remoteSha),
						latestPublishedAt: null,
						upToDate,
						...(t.source ? { source: t.source } : {}),
					};
				} catch (err) {
					results[i] = fail(t, (err as Error).message);
				}
				continue;
			}
			try {
				const { latest, latestPublishedAt } = await fetchLatest(fetcher, t.name, registry, authHeader);
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest,
					latestPublishedAt,
					upToDate: latest === null || compareVersions(t.version, latest) >= 0,
				};
			} catch (err) {
				results[i] = fail(t, (err as Error).message);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
	return results;
}

/** Display order for the Component Updates panel: pi-web-ui and pi-core
 *  pinned at the top regardless of state, then out-of-date packages, then
 *  up-to-date ones, errors last. Stable within each bucket (Array.sort is
 *  stable) so registry order survives ties. */
export function sortUpdateItems(items: UpdateItem[]): UpdateItem[] {
	const kindRank = (k: UpdateItemKind): number => (k === "webui" ? 0 : k === "pi-core" ? 1 : 2);
	return [...items].sort((a, b) => {
		const ka = kindRank(a.kind);
		const kb = kindRank(b.kind);
		if (ka !== kb) return ka - kb;
		const ea = a.error ? 1 : 0;
		const eb = b.error ? 1 : 0;
		if (ea !== eb) return ea - eb;
		const sa = a.upToDate ? 1 : 0;
		const sb = b.upToDate ? 1 : 0;
		if (sa !== sb) return sa - sb;
		return 0;
	});
}
