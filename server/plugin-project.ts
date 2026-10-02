/**
 * plugin-project — 插件「组装项目」的纯执行层（issue #146）。
 *
 * 插件（`plugins/<id>/`）希望能让宿主把**几个仓库 + 若干配置文件**拼成一个工作区：
 * 建目录、clone、写文件，可选在根目录 `git init`。本模块只做这一件事，并且假定
 * 「能不能在这个目录里动手」已经由上层判过 —— 授权由 `PluginGrantsStore` + 用户
 * 授权弹窗负责，**这里不做授权判断**，只兜住两件必须自己保证的事：
 *
 * 1. **执行**：spawn git（不走 shell）、写盘、逐行回报进度；失败即停，返回
 *    `ok:false` + 第一个失败点的原因 + 已经走过的 log —— 绝不吞错、绝不假装成功
 *    （插件会把日志原样展示给用户，一个半成品项目配上「成功」比直接报错更坏）。
 * 2. **路径越界防护**：任何相对路径（repo 的 subdir、files 的 key）resolve 之后
 *    都必须仍落在授权根目录 `dir` 之内。授权说的是「这个目录」，不等于它的父目录、
 *    也不等于它内部某个符号链接指向的对面，所以每个目标过三道：
 *      ① 直接拒绝绝对路径（含 win32 盘符 / UNC）；
 *      ② `relative(root, abs)` 不得以 `..` 开头（win32 比较前统一小写 —— 该平台
 *         文件系统大小写不敏感，`E:\A` 与 `e:\a` 是同一个目录）；
 *      ③ 目标（或它最近一个已存在的祖先）的 **realpath** 仍必须在 root 的 realpath
 *         之内 —— 防 junction / 符号链接把写入引到目录之外。
 *    对用户给的路径不做任何「顺手规整」（trim / 归一）：看不懂就直接拒绝。
 *
 * 校验全部在**动磁盘之前**做完（纯函数阶段）：一个永远不可能成功的规格不应该先
 * 建出一半目录、clone 半个仓库再报错。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { readdir as fspReaddir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killPidTree } from "./process-utils.js";

/** 单条 git 命令的默认墙钟上限：大仓库 clone 可能很慢，给足 5 分钟。 */
const DEFAULT_GIT_TIMEOUT_MS = 5 * 60_000;
/** 单个文件内容上限（1MB）。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** files 条目数上限。 */
const MAX_FILES = 32;
/** 单行日志上限：进度条 / 超长 URL 截断后再回给 UI。 */
const MAX_LINE_CHARS = 400;
/** 日志总行数上限：clone 输出可能很多，超出后不再追加（结果里标注已截断）。 */
const MAX_LOG_LINES = 500;
/** 失败时回传的 stderr 尾部长度。 */
const MAX_STDERR_TAIL = 1200;
/** realpath 向上找「已存在祖先」的层数上限（防病态路径原地打转）。 */
const MAX_ANCESTOR_HOPS = 64;

export interface ProjectRepoSpec {
	/** git 远端 URL（https:// / git@ / file:// 均可）。 */
	url: string;
	/** 目标子目录（相对 root；缺省 = 根）。 */
	subdir?: string;
	/** 分支/tag。 */
	ref?: string;
	/** 目标已存在时：true = 删除后重来（默认 false，直接报错）。 */
	replace?: boolean;
}

export interface ProjectCreateSpec {
	/** 项目根目录（绝对路径；**必须已存在**，本模块不擅自创建用户没指定的新根 —— 由调用方/授权流程决定）。 */
	dir: string;
	/** 要 clone 的仓库。 */
	repos?: ProjectRepoSpec[];
	/** 要写入的文件：相对路径 → 文本内容（禁止越界、禁止绝对路径、禁止 ..、单个 ≤ 1MB，总数 ≤ 32）。 */
	files?: Record<string, string>;
	/** 在 dir 里 git init（缺省 false）。 */
	gitInit?: boolean;
}

export interface ProjectCreateResult {
	ok: boolean;
	/** 人类可读的失败原因（第一个失败点）。 */
	error?: string;
	/** 逐条执行日志（"clone <url> → <dest>" / "write a/b.json"），UI 就地显示。 */
	log: string[];
	/** 实际创建的目录（绝对路径）。 */
	dir: string;
}

export interface ProjectCreateDeps {
	/** 进度回调（每步一行）。 */
	onProgress?: (line: string) => void;
	/** 单条 git 命令超时（默认 5 分钟）。 */
	gitTimeoutMs?: number;
	/** 注入 git 可执行文件路径（测试用；缺省 "git"）。 */
	gitBin?: string;
}

/**
 * win32 比较前统一小写：该平台文件系统大小写不敏感，`E:\A` 与 `e:\a` 指同一个目录，
 * 只按字符串比较会把「同一个目录」误判成「在目录之外」或反之。
 */
function foldCase(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 两个绝对路径是否指向同一位置（win32 大小写不敏感）。 */
export function samePath(a: string, b: string): boolean {
	return foldCase(resolve(a)) === foldCase(resolve(b));
}

/**
 * abs 是否落在 root 之内（含 root 自身）。用 `relative()` 判定：
 * `""` = root 本身；以 `..` 开头 = 越界；`relative()` 回一个绝对路径 = 跨盘符。
 */
export function isInsideRoot(root: string, abs: string): boolean {
	const rel = relative(foldCase(root), foldCase(abs));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * 把调用方给的**相对路径**解析到 root 内：返回绝对路径，越界/非法返回 null。
 * 拒绝：非字符串、空串、含 NUL、绝对路径、解析后逃出 root。
 */
export function resolveInsideRoot(root: string, raw: string): string | null {
	if (typeof raw !== "string") return null;
	if (raw === "" || raw.includes("\0")) return null;
	if (isAbsolute(raw)) return null;
	const abs = resolve(root, raw);
	return isInsideRoot(root, abs) ? abs : null;
}

/** realpath，两条实现都试（`.native` 在少数环境缺失）。 */
function realpathOf(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return realpathSync(p);
	}
}

/**
 * 目标自身（存在时）或它最近一个**已存在的祖先**的真实路径；一路到盘根都解析不出来 → null。
 * 用途是复核符号链接：`<root>/link/file.txt` 里 link 若是指向别处的 junction，
 * 单看字符串它「在 root 里」，realpath 之后就露馅了。
 * 导出给 plugin-facilities / plugins.ts 的写类操作复用（同一套越界复核语义）。
 */
export function realPathOfNearest(abs: string): string | null {
	let probe = abs;
	for (let i = 0; i < MAX_ANCESTOR_HOPS; i++) {
		try {
			return realpathOf(probe);
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return null; // 到盘根了还不存在
			probe = parent;
		}
	}
	return null;
}

/** 相对路径统一成 `/` 分隔（wire / 日志 / 前端都用正斜杠，Windows 的 path 会回 `\`）。 */
function toSlash(p: string): string {
	return p.split(sep).join("/");
}

/**
 * 递归列目录，返回树内全部符号链接 / junction 的绝对路径。
 * win32 上 Dirent.isSymbolicLink() 同样覆盖 junction（lstat 语义）；只读不跟随。
 * 目录读不了（权限/竞态删除）返回空数组 —— 兜底交给写入前的逐目标 realpath 复核。
 */
async function findSymlinks(dir: string): Promise<string[]> {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = await fspReaddir(dir, { recursive: true, withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isSymbolicLink()) continue;
		const parent = e.parentPath ?? dir;
		out.push(join(parent, e.name));
	}
	return out;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * git 运行环境：服务端没有 TTY，**任何交互式认证都会永久挂死**（工具看门狗只能杀
 * 进程，用户体验是「卡 20 分钟然后失败」）。所以一律关掉提问通道：
 * GIT_TERMINAL_PROMPT 管 git 自己的用户名/密码提示，GCM_INTERACTIVE 管 Windows
 * 凭据管理器（它不看前者），GIT_SSH_COMMAND 的 BatchMode 管 ssh 的密码/指纹确认。
 * 用户自己设的 GIT_SSH_COMMAND 优先（保留自定义 key / 代理配置）。
 */
function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		GIT_PAGER: "cat",
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
	};
}

/** 把数据流按行喂给 onLine（跨 chunk 的半行缓存在闭包里，UTF-8 用 StringDecoder 拼接）。 */
function makeLineReader(onLine: (line: string) => void) {
	const decoder = new StringDecoder("utf8");
	let rest = "";
	const emit = (raw: string) => {
		// git 的 `\r` 进度条（"Receiving objects: 45%"）压成一行，避免刷屏。
		const line = raw.replace(/\r/g, " ").trimEnd();
		if (line !== "") onLine(line);
	};
	return {
		push(chunk: Buffer) {
			rest += decoder.write(chunk);
			const parts = rest.split("\n");
			rest = parts.pop() ?? "";
			for (const p of parts) emit(p);
		},
		flush() {
			rest += decoder.end();
			if (rest !== "") emit(rest);
			rest = "";
		},
	};
}

interface GitRunResult {
	/** 退出码；spawn 层直接失败（ENOENT 等）时为 -1。 */
	code: number;
	/** 超时 / 启动失败等「不是 git 自己报的错」。 */
	spawnError?: string;
	timedOut: boolean;
	/** stderr 尾部，做失败原因用。 */
	stderrTail: string;
}

/** 跑一条 git 命令：stdout/stderr 逐行进日志，超时连坐整棵进程树。 */
async function runGit(
	bin: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; onLine: (line: string) => void },
): Promise<GitRunResult> {
	return await new Promise<GitRunResult>((settle) => {
		let child;
		try {
			child = spawn(bin, args, {
				cwd: opts.cwd,
				env: opts.env,
				// spawn 用 argv 数组，不过 shell（URL/ref 里的 `; rm -rf` 无效）。
				// POSIX 下让它自成进程组：超时要杀的是整棵树（git 会拉起 ssh /
				// credential helper 子进程），killPidTree 用 -pid 干活需要这一点。
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			settle({
				code: -1,
				spawnError: `无法启动 git（${bin}）：${errMessage(err)}`,
				timedOut: false,
				stderrTail: "",
			});
			return;
		}

		const stderrLines: string[] = [];
		const stdout = makeLineReader((line) => opts.onLine(`git: ${line}`));
		// stderr 同时进日志（git 的进展、远端提示全在 stderr）和失败原因尾部。
		const stderr = makeLineReader((line) => {
			stderrLines.push(line);
			opts.onLine(`git: ${line}`);
		});
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

		let timedOut = false;
		let settled = false;
		let graceTimer: NodeJS.Timeout | undefined;
		let spawnError: string | undefined;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			stdout.flush();
			stderr.flush();
			let tail = stderrLines.join("\n");
			if (tail.length > MAX_STDERR_TAIL) tail = `…${tail.slice(-MAX_STDERR_TAIL)}`;
			settle({ code: code ?? -1, timedOut, stderrTail: tail, ...(spawnError ? { spawnError } : {}) });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (typeof child.pid === "number" && child.pid > 0) {
				void killPidTree(child.pid);
				// On Windows taskkill is asynchronous and a child may not emit close
				// promptly. Directly kill the git process too, then force settlement
				// after a short grace period so callers never hang on close.
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			} else {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}
			graceTimer = setTimeout(() => {
				try {
					child.stdout?.destroy();
					child.stderr?.destroy();
				} catch {
					/* already closed */
				}
				finish(-1);
			}, 500);
		}, opts.timeoutMs);

		child.on("error", (err) => {
			spawnError = `无法启动 git（${bin}）：${errMessage(err)}`;
			if (timedOut) finish(-1);
		});
		child.on("close", (code) => finish(code));
	});
}

/** 规格校验后的执行计划（绝对路径 + 原始 URL/ref）。 */
interface PlannedRepo {
	url: string;
	ref?: string;
	/** 绝对目标目录。 */
	dest: string;
	/** 相对 root 的展示用路径（`/` 分隔；根目录 = "."）。 */
	destRel: string;
	replace: boolean;
}

interface PlannedFile {
	rel: string;
	abs: string;
	content: string;
}

/**
 * 组装项目：mkdir 子目录 → clone 仓库 → 写文件 → 可选 git init。
 * 失败即停（返回 ok:false + 原因 + 已完成的 log），不吞错、不假装成功。
 */
export async function createProject(
	spec: ProjectCreateSpec,
	deps: ProjectCreateDeps = {},
): Promise<ProjectCreateResult> {
	const log: string[] = [];
	let truncated = false;
	/** 每步一行：先进 log（结果里原样带回），再回调上层（转发到浏览器 / 终端）。 */
	const emit = (line: string) => {
		const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
		if (log.length >= MAX_LOG_LINES) {
			truncated = true;
			return;
		}
		log.push(text);
		try {
			deps.onProgress?.(text);
		} catch {
			// 进度回调是 UI 层的事：它抛错不能中断组装（更不能把项目搞成半成品）。
		}
	};
	let root = typeof spec?.dir === "string" ? spec.dir : "";
	const finish = (ok: boolean, error?: string): ProjectCreateResult => {
		if (truncated) {
			truncated = false;
			log.push(`…（输出超过 ${MAX_LOG_LINES} 行，已截断）`);
		}
		return error === undefined ? { ok, log, dir: root } : { ok, error, log, dir: root };
	};
	const fail = (error: string): ProjectCreateResult => {
		emit(`失败：${error}`);
		return finish(false, error);
	};

	// ——— ① 校验根目录：必须是「已存在的绝对路径」。先判 isAbsolute 再 resolve：
	//     resolve 会拿进程 cwd 把相对路径补成绝对，那会掩盖调用方的错误。
	const rawDir = spec?.dir;
	if (typeof rawDir !== "string" || rawDir === "") return fail("缺少项目根目录 dir（必须是非空绝对路径）");
	if (!isAbsolute(rawDir)) return fail(`项目根目录必须是绝对路径：${rawDir}`);
	root = resolve(rawDir);
	try {
		if (!statSync(root).isDirectory()) return fail(`项目根目录不是文件夹：${root}`);
	} catch {
		return fail(`项目根目录不存在：${root}（本模块不创建新的根目录）`);
	}
	// 真实路径：后面每个写盘目标都要拿它复核（防符号链接/junction 逃逸）。
	const rootReal = realPathOfNearest(root) ?? root;

	// ——— ② 校验 repos（纯计算，不碰磁盘）———
	const rawRepos = spec?.repos;
	if (rawRepos !== undefined && !Array.isArray(rawRepos)) return fail("repos 必须是数组");
	const plannedRepos: PlannedRepo[] = [];
	const repoItems = rawRepos ?? [];
	for (let i = 0; i < repoItems.length; i++) {
		const item = repoItems[i] as ProjectRepoSpec | undefined;
		const url = typeof item?.url === "string" ? item.url.trim() : "";
		if (url === "") return fail(`repos[${i}].url 必须是非空字符串`);
		// spawn 不过 shell，但 git 自己会把以 "-" 开头的实参当**选项**解析：
		// `--upload-pack=<cmd>` / `-c core.sshCommand=…` 这类能让远端/本地执行任意
		// 命令，必须挡在解析之前（argv 数组只挡得住注入 shell，挡不住选项注入）。
		if (url.startsWith("-")) return fail(`repos[${i}].url 不能以 "-" 开头（防 git 选项注入）：${url}`);
		const rawRef = item?.ref;
		let ref: string | undefined;
		if (rawRef !== undefined && rawRef !== null && rawRef !== "") {
			if (typeof rawRef !== "string") return fail(`repos[${i}].ref 必须是字符串`);
			ref = rawRef.trim();
			if (ref === "" || ref.startsWith("-")) return fail(`repos[${i}].ref 非法：${String(rawRef)}`);
		}
		const rawSubdir = item?.subdir;
		let dest = root;
		let destRel = ".";
		if (rawSubdir !== undefined && rawSubdir !== null && rawSubdir !== "") {
			if (typeof rawSubdir !== "string") return fail(`repos[${i}].subdir 必须是字符串`);
			const abs = resolveInsideRoot(root, rawSubdir);
			if (abs === null) return fail(`repos[${i}].subdir 路径越界（必须落在 dir 之内）：${rawSubdir}`);
			dest = abs;
			destRel = toSlash(relative(root, abs));
		}
		plannedRepos.push({ url, dest, destRel, replace: item?.replace === true, ...(ref ? { ref } : {}) });
	}

	// ③ 真实路径复核 + replace 的边界：任何一个目标解析后跑出 root 就整单拒绝。
	for (let i = 0; i < plannedRepos.length; i++) {
		const r = plannedRepos[i];
		// 缺省 subdir = 直接 clone 进根目录本身：根是调用方授权的那一层，
		// replace 删它等于删用户自己的项目目录（不是「清空一个子目录」），拒绝。
		if (r.replace && samePath(r.dest, root)) {
			return fail(`repos[${i}]: replace 不能用于项目根目录（拒绝删除 dir 本身）`);
		}
		const real = realPathOfNearest(r.dest);
		if (real === null) return fail(`repos[${i}].subdir 无法解析真实路径：${r.destRel}`);
		if (!isInsideRoot(rootReal, real)) {
			return fail(`repos[${i}].subdir 路径越界（符号链接指向 dir 之外）：${r.destRel}`);
		}
	}

	// ——— ④ 校验 files（纯计算）———
	const rawFiles = spec?.files;
	if (rawFiles !== undefined && (rawFiles === null || typeof rawFiles !== "object" || Array.isArray(rawFiles))) {
		return fail("files 必须是「相对路径 → 文本内容」的对象");
	}
	const fileEntries = Object.entries(rawFiles ?? {});
	if (fileEntries.length > MAX_FILES) return fail(`files 条目数超限：${fileEntries.length} > ${MAX_FILES}`);
	const plannedFiles: PlannedFile[] = [];
	for (const [rel, content] of fileEntries) {
		const abs = resolveInsideRoot(root, rel);
		if (abs === null) return fail(`files 路径越界或非法（必须是 dir 内的相对路径）：${rel}`);
		if (typeof content !== "string") return fail(`files["${rel}"] 必须是字符串内容`);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_FILE_BYTES) return fail(`files["${rel}"] 超过单文件上限 1MB（${bytes} 字节）`);
		// 目标自身（存在时）或其最近祖先的 realpath 也要在 root 里：
		// 目标可能是父目录里的 junction，也可能是「指向 /etc/passwd 的文件链接」。
		const real = realPathOfNearest(abs);
		if (real === null || !isInsideRoot(rootReal, real)) {
			return fail(`files 路径越界（符号链接指向 dir 之外）：${rel}`);
		}
		plannedFiles.push({ rel: toSlash(relative(root, abs)), abs, content });
	}

	// ——— ⑤ 执行：校验全过了才动磁盘 ———
	const gitBin = deps.gitBin && deps.gitBin.trim() !== "" ? deps.gitBin : "git";
	const timeoutMs = deps.gitTimeoutMs && deps.gitTimeoutMs > 0 ? deps.gitTimeoutMs : DEFAULT_GIT_TIMEOUT_MS;
	const env = gitEnv();
	const gitFailReason = (what: string, res: GitRunResult): string | undefined => {
		if (res.spawnError) return res.spawnError;
		if (res.timedOut) return `${what} 超时（> ${Math.round(timeoutMs / 1000)}s）`;
		if (res.code !== 0) return `${what} 失败（退出码 ${res.code}）`;
		return undefined;
	};
	try {
		// 本轮真正 clone 出的目录（根目录本身除外 —— 它是授权目录，绝不清理）与
		// 已写入的文件，供「clone 后置复核命中」时回滚，不把半个带毒仓库留在盘上。
		const clonedThisRun = plannedRepos.filter((r) => !samePath(r.dest, root)).map((r) => r.dest);
		const writtenThisRun: string[] = [];
		const cleanupThisRun = (): void => {
			for (const f of writtenThisRun) {
				try {
					rmSync(f, { force: true });
				} catch {
					/* 清理尽力而为 */
				}
			}
			for (const d of clonedThisRun) {
				try {
					rmSync(d, { recursive: true, force: true });
				} catch {
					/* 清理尽力而为 */
				}
			}
		};
		for (const r of plannedRepos) {
			const atRoot = samePath(r.dest, root);
			// 根目录已存在是常态（它就是那个已存在的授权目录），既不 rm 也不 mkdir ——
			// 交给 git 判断它是否为空目录（非空时 git 自己会报 "not an empty directory"）。
			if (!atRoot && existsSync(r.dest)) {
				// 目标已存在：只有显式 replace 才动它 —— 绝不静默覆盖用户数据。
				if (!r.replace) return fail(`目标目录已存在：${r.destRel}（要覆盖请显式 replace:true）`);
				emit(`rm -rf ${r.destRel}`);
				rmSync(r.dest, { recursive: true, force: true });
			}
			if (!atRoot) {
				emit(`mkdir ${r.destRel}`);
				mkdirSync(r.dest, { recursive: true });
			}
			emit(`clone ${r.url} → ${r.destRel}`);
			const args = ["clone", "--depth", "1"];
			if (r.ref) args.push("--branch", r.ref);
			// 目标用绝对路径 + cwd=root：相对路径交给 git 会被它按自己的规则再解释一遍。
			args.push(r.url, r.dest);
			const res = await runGit(gitBin, args, { cwd: root, timeoutMs, env, onLine: emit });
			const why = gitFailReason("git clone", res);
			if (why) return fail(`${why}${res.stderrTail === "" ? "" : `：${res.stderrTail}`}`);
		}

		// ——— ⑥ clone 后置复核（写文件前）：前置校验（③④）都在 clone 之前，而恶意
		//     仓库可以在 clone 时落地指向 root 之外的符号链接，随后的文件写入就会跟着
		//     链接跑出授权目录（「先 clone 后校验」的逃逸窗口）。两道防线：
		//     a. 扫描 clone 出的目录树，出现任何符号链接即视为恶意仓库整体拒绝
		//        （clone --depth 1 不跑包管理器，正常仓库极少提交 symlink，宁可误杀）；
		//     b. 每个写入目标写前再做一次 realPathOfNearest 复核（覆盖 a 与写盘之间的窗口）。
		//     任一命中：清理本轮 clone 的目录（rmSync 不跟随符号链接，安全）与已写文件。
		for (const dest of clonedThisRun) {
			const offenders = await findSymlinks(dest);
			if (offenders.length > 0) {
				cleanupThisRun();
				return fail(`仓库包含符号链接（视为恶意仓库拒绝），例如：${toSlash(relative(root, offenders[0]!))}`);
			}
		}

		for (const f of plannedFiles) {
			// 写前复核目标仍解析在 rootReal 内：前置校验时它还不存在（最近祖先在 root 内），
			// clone 之后可能被仓库塞进来的符号链接顶掉。
			const real = realPathOfNearest(f.abs);
			if (real === null || !isInsideRoot(rootReal, real)) {
				cleanupThisRun();
				return fail(`files 路径越界（clone 后复核：符号链接指向 dir 之外）：${f.rel}`);
			}
			emit(`write ${f.rel}`);
			mkdirSync(dirname(f.abs), { recursive: true });
			writeFileSync(f.abs, f.content, "utf8");
			writtenThisRun.push(f.abs);
		}

		if (spec?.gitInit === true) {
			emit("git init");
			const res = await runGit(gitBin, ["init"], { cwd: root, timeoutMs, env, onLine: emit });
			const why = gitFailReason("git init", res);
			if (why) return fail(`${why}${res.stderrTail === "" ? "" : `：${res.stderrTail}`}`);
		}

		return finish(true);
	} catch (err) {
		// 兜底：fs 层意外错误（权限、盘满、目录被并发删掉）也走 ok:false，
		// 不让插件看到一个抛出来的异常（它只认 ok/error/log）。
		return fail(`组装失败：${errMessage(err)}`);
	}
}
