/**
 * lsp-tool.ts — 导出给 AI Agent 的原生 LSP 语言服务器工具（Native Opt-in LSP Tool）。
 *
 * 核心设计：
 * - 零重型外部依赖：基于 Node.js 标准流与原生 JSON-RPC 2.0 实现轻量级 LSP 客户端。
 * - 多会话共享池（Project-level Pool）：同项目多会话与并发子代理复用同一个后台语言服务器实例，
 *   避免多子代理重复拉起语言服务器导致内存爆炸（参考 omp 的 lspmux 理念）。
 * - 支持 4 大核心语义动作：
 *   1. definition：跳转到符号定义位置（支持展示定义代码片段）；
 *   2. references：列出工作区内所有引用/调用处；
 *   3. hover：获取类型签名与文档说明（Docstring/Markdown）；
 *   4. diagnostics：获取文件或项目的实时编译与类型检查错误。
 * - 闲置自动回收：15 分钟无请求自动休眠退出，释放系统内存。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LSP_TOOL_NAME = "lsp";

export type LspAction =
	| "definition"
	| "references"
	| "hover"
	| "diagnostics"
	| "documentSymbol"
	| "read_symbol"
	| "workspaceSymbol"
	| "cascade";

export const LSP_SYMBOL_KINDS: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

interface LspDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number; // 1 = Error, 2 = Warning, 3 = Info, 4 = Hint
	message: string;
	source?: string;
	code?: string | number;
}

interface LspLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface LanguageServerConfig {
	languageId: string;
	commands: Array<{ bin: string; args: string[]; installHint: string; npmPackage?: string }>;
}

const LANGUAGE_SERVER_CATALOG: Record<string, LanguageServerConfig> = {
	ts: {
		languageId: "typescript",
		commands: [
			{
				bin: "vtsls",
				args: ["--stdio"],
				installHint: "npm install -g @vtsls/language-server",
				npmPackage: "@vtsls/language-server typescript",
			},
			{
				bin: "typescript-language-server",
				args: ["--stdio"],
				installHint: "npm install -g typescript-language-server typescript",
				npmPackage: "typescript-language-server typescript",
			},
		],
	},
	js: {
		languageId: "javascript",
		commands: [
			{
				bin: "vtsls",
				args: ["--stdio"],
				installHint: "npm install -g @vtsls/language-server",
				npmPackage: "@vtsls/language-server typescript",
			},
			{
				bin: "typescript-language-server",
				args: ["--stdio"],
				installHint: "npm install -g typescript-language-server typescript",
				npmPackage: "typescript-language-server typescript",
			},
		],
	},
	py: {
		languageId: "python",
		commands: [
			{
				bin: "pyright-langserver",
				args: ["--stdio"],
				installHint: "npm install -g pyright",
				npmPackage: "pyright",
			},
			{ bin: "pyright", args: ["--stdio"], installHint: "pip install pyright" },
			{ bin: "pylsp", args: [], installHint: "pip install python-lsp-server" },
		],
	},
	rs: {
		languageId: "rust",
		commands: [{ bin: "rust-analyzer", args: [], installHint: "rustup component add rust-analyzer" }],
	},
	go: {
		languageId: "go",
		commands: [{ bin: "gopls", args: ["serve"], installHint: "go install golang.org/x/tools/gopls@latest" }],
	},
	c: {
		languageId: "c",
		commands: [{ bin: "clangd", args: [], installHint: "Install LLVM/clangd from package manager" }],
	},
	cpp: {
		languageId: "cpp",
		commands: [{ bin: "clangd", args: [], installHint: "Install LLVM/clangd from package manager" }],
	},
};

function getLanguageForPath(filePath: string): { langKey: string; config: LanguageServerConfig } | null {
	const ext = extname(filePath).toLowerCase().replace(/^\./, "");
	if (["ts", "tsx", "mts", "cts"].includes(ext)) return { langKey: "ts", config: LANGUAGE_SERVER_CATALOG.ts };
	if (["js", "jsx", "mjs", "cjs"].includes(ext)) return { langKey: "js", config: LANGUAGE_SERVER_CATALOG.js };
	if (["py", "pyi"].includes(ext)) return { langKey: "py", config: LANGUAGE_SERVER_CATALOG.py };
	if (ext === "rs") return { langKey: "rs", config: LANGUAGE_SERVER_CATALOG.rs };
	if (ext === "go") return { langKey: "go", config: LANGUAGE_SERVER_CATALOG.go };
	if (["c", "h"].includes(ext)) return { langKey: "c", config: LANGUAGE_SERVER_CATALOG.c };
	if (["cpp", "cc", "cxx", "hpp", "hxx"].includes(ext)) return { langKey: "cpp", config: LANGUAGE_SERVER_CATALOG.cpp };
	return null;
}

/** 二进制探测结果的内存缓存（cwd + cmd 为 key；用户态安装成功后按包失效） */
const resolveBinaryCache = new Map<string, string | null>();

export function clearResolveBinaryCache(): void {
	resolveBinaryCache.clear();
}

/** 探测二进制是否可在当前系统执行（优先项目本地、Pi 生态共享目录、用户态托管目录、系统 PATH） */
export function resolveBinary(cmd: string, cwd: string): string | null {
	const cacheKey = `${cwd}::${cmd}`;
	const cached = resolveBinaryCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const found = resolveBinaryUncached(cmd, cwd);
	resolveBinaryCache.set(cacheKey, found);
	return found;
}

function resolveBinaryUncached(cmd: string, cwd: string): string | null {
	const isWin = process.platform === "win32";
	const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];

	if (isAbsolute(cmd)) {
		if (existsSync(cmd)) return cmd;
		if (isWin) {
			for (const ext of exts) {
				if (ext && existsSync(cmd + ext)) return cmd + ext;
			}
		}
		return null;
	}

	// 1. 本地 workspace node_modules/.bin 优先
	const localBinDir = resolve(cwd, "node_modules", ".bin");
	for (const ext of exts) {
		const target = join(localBinDir, cmd + ext);
		if (existsSync(target)) return target;
	}

	// 2. Pi 生态工具与用户态目录（pi-lens / pi-web 用户态托管，零权限直接复用）
	const home = homedir();
	const sharedDirs = [
		join(home, ".pi-lens", "tools", "node_modules", ".bin"),
		join(home, ".pi-web", "lsp-servers", "node_modules", ".bin"),
		join(home, ".pi", "agent", "tools", "node_modules", ".bin"),
	];
	for (const sharedDir of sharedDirs) {
		for (const ext of exts) {
			const target = join(sharedDir, cmd + ext);
			if (existsSync(target)) return target;
		}
	}

	// 3. 遍历系统 PATH 目录（纯文件系统检查，零子进程开销、杜绝 Windows cmd.exe 引号卡死）
	const pathDirs = (process.env.PATH || "").split(delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const target = join(dir, cmd + ext);
			if (existsSync(target)) return target;
		}
	}

	return null;
}

const installTasks = new Map<string, Promise<boolean>>();
/** 安装失败的负缓存（pkg -> 失败时间戳）：失败后 5 分钟内不再重复执行 120s 的 npm install */
const installFailedAt = new Map<string, number>();
const INSTALL_FAIL_NEGATIVE_CACHE_MS = 5 * 60 * 1000;

/**
 * 在用户专属目录（~/.pi-web/lsp-servers）执行无侵入、免 sudo/root 的语言服务包按需安装。
 * 注意：必须经用户显式授权（lsp 工具的 allowInstall 参数）后才能调用，不得静默触发。
 */
export async function autoInstallLanguageServer(pkg: string): Promise<boolean> {
	const existing = installTasks.get(pkg);
	if (existing) return existing;
	const failedAt = installFailedAt.get(pkg);
	if (failedAt !== undefined && Date.now() - failedAt < INSTALL_FAIL_NEGATIVE_CACHE_MS) {
		console.warn(`[LSP] Skip auto-install for ${pkg}: failed recently, retry later with allowInstall`);
		return false;
	}

	const task = (async () => {
		try {
			const userLspDir = join(homedir(), ".pi-web", "lsp-servers");
			console.warn(`[LSP] Installing language server [${pkg}] into ${userLspDir} (user-space, no sudo)…`);
			mkdirSync(userLspDir, { recursive: true });
			const pkgJson = join(userLspDir, "package.json");
			if (!existsSync(pkgJson)) {
				writeFileSync(pkgJson, JSON.stringify({ name: "pi-web-lsp-servers", private: true }) + "\n");
			}

			const pkgs = pkg.split(/\s+/).filter(Boolean);
			const isWin = process.platform === "win32";
			const npmCmd = isWin ? "npm.cmd" : "npm";

			let stderr = "";
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(npmCmd, ["install", "--no-audit", "--no-fund", "--save-dev", ...pkgs], {
					cwd: userLspDir,
					stdio: ["ignore", "ignore", "pipe"],
					shell: isWin,
				});
				const timer = setTimeout(() => {
					if (isWin) {
						// shell:true 时 proc.pid 只是 cmd.exe 的 PID——proc.kill() 只杀得到
						// cmd.exe，npm/node 整棵子进程树会残留。taskkill /T 连树强杀。
						if (typeof proc.pid === "number") {
							const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
							killer.on("error", () => {});
						}
					} else {
						// POSIX：npm 由非 shell 直接 spawn，kill 其主进程即可让安装流程终止
						//（取 SIGKILL 而非 detached 进程组方案：不改变子进程组语义，安装
						// 超时本身是罕见路径，残余 node 子进程随 npm 主进程退出被回收）。
						try {
							proc.kill("SIGKILL");
						} catch {}
					}
					reject(new Error("npm install timed out"));
				}, 120_000);
				proc.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				proc.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
				proc.on("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(new Error(`npm install exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ""}`));
				});
			});
			console.warn(`[LSP] Language server [${pkg}] installed, resolving binaries…`);
			// 新二进制落盘，探测缓存失效
			clearResolveBinaryCache();
			installFailedAt.delete(pkg);
			return true;
		} catch (err) {
			console.warn(`[LSP] Auto-install failed for ${pkg}: ${(err as Error).message}`);
			installFailedAt.set(pkg, Date.now());
			return false;
		} finally {
			installTasks.delete(pkg);
		}
	})();

	installTasks.set(pkg, task);
	return task;
}

// ----------------------------------------------------------------------------
// JSON-RPC 2.0 传输层与单项目 LSP 客户端
// ----------------------------------------------------------------------------

export class LspClient {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pendingRequests = new Map<
		number,
		{ resolve: (res: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	private diagnosticsCache = new Map<string, LspDiagnostic[]>(); // fileUri -> diagnostics
	private openFiles = new Set<string>(); // fileUri
	private docVersions = new Map<string, number>(); // fileUri -> version
	private buffer = Buffer.alloc(0);
	private idleTimer: NodeJS.Timeout | null = null;
	private initialized = false;
	private isShuttingDown = false;

	constructor(
		public readonly projectCwd: string,
		public readonly langKey: string,
		public readonly binPath: string,
		public readonly binArgs: string[],
		public readonly languageId: string,
		/** 客户端不可用（空闲回收 / 进程退出 / spawn 失败）时从池移除的回调 */
		private readonly onEvict: () => void,
	) {}

	async start(): Promise<void> {
		this.touch();
		this.proc = spawn(this.binPath, this.binArgs, {
			cwd: this.projectCwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.binPath),
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
		this.proc.stderr?.on("data", (_d: Buffer) => {
			// 可选记录 debug 日志，不干扰输出
		});

		// spawn 失败（ENOENT/EACCES 等）只触发 'error'，进程从未启动时不会触发
		// 'exit'——不监听会让 initialize 等请求挂到超时，客户端还留在池里被误判存活。
		this.proc.on("error", (err: Error) => {
			this.proc = null;
			this.rejectAllPending(new Error(`Language server failed to start: ${err.message}`));
			this.onEvict();
		});

		// stdin 写错误（对端退出后的 EPIPE 等）在 stream 上异步 emit，不监听会以
		// uncaughtException 崩掉整个服务进程。这里统一兜底：标记死亡 + 清理挂起请求。
		this.proc.stdin?.on("error", (err: Error) => {
			this.proc = null;
			this.rejectAllPending(new Error(`Language server stdin error: ${err.message}`));
			this.onEvict();
		});

		this.proc.on("exit", (code) => {
			this.proc = null;
			this.rejectAllPending(new Error(`Language server exited with code ${code}`));
			// 进程退出即从池移除，防止后续请求命中死客户端
			this.onEvict();
		});

		try {
			// 发送 initialize 握手
			await this.request("initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(this.projectCwd).toString(),
				workspaceFolders: [
					{
						name: "workspace",
						uri: pathToFileURL(this.projectCwd).toString(),
					},
				],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
					},
				},
			});

			this.notify("initialized", {});
			this.initialized = true;
		} catch (err) {
			if (this.proc) {
				try {
					this.proc.kill();
				} catch {}
				this.proc = null;
			}
			throw err;
		}
	}

	touch(): void {
		if (this.isShuttingDown) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		// 15 分钟无调用自动回收
		this.idleTimer = setTimeout(
			() => {
				this.shutdown().catch(() => {});
				this.onEvict();
			},
			15 * 60 * 1000,
		);
		this.idleTimer.unref();
	}

	private handleData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd).toString("utf8");
			const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lenMatch) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const length = parseInt(lenMatch[1], 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) break;

			const bodyBuf = this.buffer.slice(bodyStart, bodyStart + length);
			this.buffer = this.buffer.slice(bodyStart + length);

			try {
				const msg = JSON.parse(bodyBuf.toString("utf8"));
				this.handleMessage(msg);
			} catch {}
		}
	}

	private handleMessage(msg: any): void {
		if (msg.id !== undefined) {
			if (msg.method) {
				// 服务端向客户端发起的请求（如 window/workDoneProgress/create, client/registerCapability）
				// 标准 JSON-RPC 必须回复 result: null，防止上游语言服务器挂起等待
				const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
				const wire = `Content-Length: ${Buffer.byteLength(reply, "utf8")}\r\n\r\n${reply}`;
				try {
					this.proc?.stdin?.write(wire);
				} catch {}
				return;
			}

			if (this.pendingRequests.has(msg.id)) {
				const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
				clearTimeout(timer);
				this.pendingRequests.delete(msg.id);
				if (msg.error) {
					reject(new Error(msg.error.message || `LSP error ${msg.error.code}`));
				} else {
					resolve(msg.result);
				}
			}
		} else if (msg.method === "textDocument/publishDiagnostics") {
			const params = msg.params;
			if (params?.uri && Array.isArray(params?.diagnostics)) {
				this.diagnosticsCache.set(params.uri, params.diagnostics);
			}
		}
	}

	request(method: string, params: any, timeoutMs = 15000): Promise<any> {
		this.touch();
		if (!this.proc || !this.proc.stdin) {
			return Promise.reject(new Error("Language server is not running"));
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const wire = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;

		return new Promise((res, rej) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				rej(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve: res, reject: rej, timer });
			try {
				this.proc!.stdin!.write(wire);
			} catch (err) {
				// 同步写失败（stream 已销毁等）：撤销挂起请求；异步 EPIPE 由 start() 里的
				// stdin 'error' 监听兜底，这里只需保证 promise 被 reject 而非向上抛。
				clearTimeout(timer);
				this.pendingRequests.delete(id);
				rej(new Error(`Language server stdin write failed: ${(err as Error).message}`));
			}
		});
	}

	notify(method: string, params: any): void {
		this.touch();
		if (!this.proc || !this.proc.stdin) return;
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
		const wire = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
		try {
			this.proc.stdin.write(wire);
		} catch {
			// 通知写失败只影响状态同步，不值得打断调用链；异步 EPIPE 由 stdin 'error' 监听兜底
		}
	}

	async syncDocument(absPath: string): Promise<string> {
		const uri = pathToFileURL(absPath).toString();
		if (!existsSync(absPath)) return uri;
		const content = readFileSync(absPath, "utf8");

		if (!this.openFiles.has(uri)) {
			this.docVersions.set(uri, 1);
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: this.languageId,
					version: 1,
					text: content,
				},
			});
			this.openFiles.add(uri);
		} else {
			const nextVer = (this.docVersions.get(uri) ?? 1) + 1;
			this.docVersions.set(uri, nextVer);
			this.notify("textDocument/didChange", {
				textDocument: { uri, version: nextVer },
				contentChanges: [{ text: content }],
			});
		}
		return uri;
	}

	getDiagnostics(uri: string): LspDiagnostic[] {
		return this.diagnosticsCache.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, LspDiagnostic[]> {
		return new Map(this.diagnosticsCache);
	}

	isAlive(): boolean {
		return Boolean(this.proc && !this.isShuttingDown);
	}

	private rejectAllPending(err: Error): void {
		for (const { reject, timer } of this.pendingRequests.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this.pendingRequests.clear();
	}

	async shutdown(): Promise<void> {
		this.isShuttingDown = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (!this.proc) return;

		try {
			await this.request("shutdown", {}, 3000);
			this.notify("exit", {});
		} catch {}

		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
		this.rejectAllPending(new Error("LSP client shut down"));
	}
}

// ----------------------------------------------------------------------------
// 全局项目级语言服务器管理池（Project-Level LSP Pool）
// ----------------------------------------------------------------------------

class LspServerPool {
	private pool = new Map<string, LspClient>(); // key: `${cwd}::${langKey}`
	private inFlight = new Map<string, Promise<{ client: LspClient } | { error: string }>>();
	private shuttingDown = false;

	hasAliveClient(projectCwd: string, filePath: string): boolean {
		const langInfo = getLanguageForPath(filePath);
		if (!langInfo) return false;
		const poolKey = `${projectCwd}::${langInfo.langKey}`;
		const client = this.pool.get(poolKey);
		return Boolean(client && client.isAlive());
	}

	async getClient(
		projectCwd: string,
		filePath: string,
		opts?: { allowInstall?: boolean },
	): Promise<{ client: LspClient } | { error: string }> {
		if (this.shuttingDown) {
			return { error: "LSP server pool is shutting down" };
		}

		const langInfo = getLanguageForPath(filePath);
		if (!langInfo) {
			return { error: `No language server mapping for file extension: ${extname(filePath)}` };
		}

		const poolKey = `${projectCwd}::${langInfo.langKey}`;
		const client = this.pool.get(poolKey);
		if (client) {
			// 池命中必须复检存活：进程退出事件与请求之间有竞态窗口（exit 回调排队、
			// spawn error 未触发 exit），死客户端留在池里会让所有请求挂到超时。
			if (client.isAlive()) {
				client.touch();
				return { client };
			}
			this.pool.delete(poolKey);
		}

		const pending = this.inFlight.get(poolKey);
		if (pending) {
			return pending;
		}

		const task = (async () => {
			// 寻找可用命令
			let resolvedBin: string | null = null;
			let resolvedArgs: string[] = [];
			let hint = "";
			let autoPkg: string | undefined = undefined;

			for (const cmd of langInfo.config.commands) {
				const found = resolveBinary(cmd.bin, projectCwd);
				if (found) {
					resolvedBin = found;
					resolvedArgs = cmd.args;
					break;
				}
				hint = cmd.installHint;
				if (!autoPkg && cmd.npmPackage) autoPkg = cmd.npmPackage;
			}

			// 用户态按需安装必须经用户显式授权（allowInstall），避免在工具调用链里无提示联网 npm install
			if (!resolvedBin && autoPkg && opts?.allowInstall === true) {
				const ok = await autoInstallLanguageServer(autoPkg);
				if (ok) {
					for (const cmd of langInfo.config.commands) {
						const found = resolveBinary(cmd.bin, projectCwd);
						if (found) {
							resolvedBin = found;
							resolvedArgs = cmd.args;
							break;
						}
					}
				}
			}

			if (!resolvedBin) {
				const installGateHint = autoPkg
					? `\nOr retry this tool call with { "allowInstall": true } to install \`${autoPkg}\` into ~/.pi-web/lsp-servers (user-space, no sudo) automatically.`
					: "";
				return {
					error: `Language server for ${langInfo.config.languageId} not found.\nPlease install it: \`${hint}\`${installGateHint}`,
				};
			}

			const newClient = new LspClient(
				projectCwd,
				langInfo.langKey,
				resolvedBin,
				resolvedArgs,
				langInfo.config.languageId,
				() => {
					if (this.pool.get(poolKey) === newClient) {
						this.pool.delete(poolKey);
					}
				},
			);
			// 启动失败时客户端尚在 start() 内部、池里没有它，onEvict 是空操作；
			// 成功后再退出/回收才会真正从池移除。

			try {
				await newClient.start();
				if (this.shuttingDown) {
					await newClient.shutdown();
					return { error: "LSP server pool is shutting down" };
				}
				this.pool.set(poolKey, newClient);
				return { client: newClient };
			} catch (err) {
				return { error: `Failed to start ${langInfo.config.languageId} language server: ${(err as Error).message}` };
			} finally {
				this.inFlight.delete(poolKey);
			}
		})();

		this.inFlight.set(poolKey, task);
		return task;
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const inFlightTasks = [...this.inFlight.values()];
		this.inFlight.clear();
		await Promise.allSettled(inFlightTasks);
		const promises = [...this.pool.values()].map((c) => c.shutdown());
		this.pool.clear();
		await Promise.allSettled(promises);
	}
}

export const globalLspPool = new LspServerPool();

/**
 * 辅助函数：在文件改动后，若已有存活的语言服务器，获取即时编译报错（Writethrough Diagnostics）
 */
export async function getLiveLspDiagnostics(absPath: string, cwd: string): Promise<string | null> {
	if (!globalLspPool.hasAliveClient(cwd, absPath)) {
		return null;
	}
	const res = await globalLspPool.getClient(cwd, absPath);
	if ("error" in res) return null;

	const { client } = res;
	const uri = await client.syncDocument(absPath);
	// 稍等 80ms 让后台增量分析返回
	await new Promise((r) => setTimeout(r, 80));

	const diags = client.getDiagnostics(uri);
	const errors = diags.filter((d) => d.severity === 1 || !d.severity);
	if (errors.length === 0) return null;

	const rel = absPath.startsWith(cwd) ? absPath.slice(cwd.length).replace(/^[/\\]/, "") : absPath;
	const lines = errors.slice(0, 5).map((e) => {
		const line = e.range.start.line + 1;
		const col = e.range.start.character + 1;
		const code = e.code ? ` (${e.code})` : "";
		return `• ${rel}:${line}:${col} - ${e.message}${code}`;
	});

	return `⚠️ Post-edit Diagnostics (${errors.length} error${errors.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
}

/**
 * 递归格式化 DocumentSymbol 列表为缩进的符号大纲树（做条数上限保护）
 */
function formatDocumentSymbols(symbols: any[], indent = "", lines: string[] = []): string[] {
	for (const sym of symbols) {
		if (lines.length >= 300) {
			lines.push(`${indent}• ... [Truncated: outline exceeds 300 symbols]`);
			break;
		}
		const kind = LSP_SYMBOL_KINDS[sym.kind] || `Kind(${sym.kind})`;
		const range = sym.range || sym.location?.range;
		const startLine = range ? range.start.line + 1 : "?";
		const endLine = range ? range.end.line + 1 : "?";
		const lineSpan = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
		const detail = sym.detail ? ` (${sym.detail})` : "";
		lines.push(`${indent}• [${kind}] ${sym.name}${detail} (${lineSpan})`);
		if (Array.isArray(sym.children) && sym.children.length > 0) {
			formatDocumentSymbols(sym.children, indent + "  ", lines);
		}
	}
	return lines;
}

/**
 * 递归单趟查找符号（两遍扫描：先严格精确匹配，未命中再执行大小写忽略回退，避免遮蔽后续精确符号；支持 containerName 点分路径）
 */
function findSymbolPass(
	symbols: any[],
	target: string,
	mode: "exact" | "ci",
	parentName = "",
): { symbol: any; fullName: string } | null {
	const targetLower = target.toLowerCase();
	for (const sym of symbols) {
		const qualifiedName = sym.containerName
			? `${sym.containerName}.${sym.name}`
			: parentName
				? `${parentName}.${sym.name}`
				: sym.name;

		if (mode === "exact") {
			if (sym.name === target || qualifiedName === target) {
				return { symbol: sym, fullName: qualifiedName };
			}
		} else {
			if (sym.name.toLowerCase() === targetLower || qualifiedName.toLowerCase() === targetLower) {
				return { symbol: sym, fullName: qualifiedName };
			}
		}

		if (Array.isArray(sym.children) && sym.children.length > 0) {
			const found = findSymbolPass(sym.children, target, mode, qualifiedName);
			if (found) return found;
		}
	}
	return null;
}

function findSymbol(symbols: any[], target: string): { symbol: any; fullName: string } | null {
	return findSymbolPass(symbols, target, "exact") ?? findSymbolPass(symbols, target, "ci");
}

/**
 * 收集文件内可用的顶层符号全名清单（最多收集 50 条，供找不到符号时提供备选提示）
 */
function collectSymbolNames(symbols: any[], prefix = "", names: string[] = []): string[] {
	for (const sym of symbols) {
		if (names.length >= 50) break;
		const current = sym.containerName
			? `${sym.containerName}.${sym.name}`
			: prefix
				? `${prefix}.${sym.name}`
				: sym.name;
		const kind = LSP_SYMBOL_KINDS[sym.kind] || "Symbol";
		names.push(`${current} [${kind}]`);
		if (Array.isArray(sym.children) && sym.children.length > 0) {
			collectSymbolNames(sym.children, current, names);
		}
	}
	return names;
}

/**
 * 当未传 path 且执行工作区级操作（如 workspaceSymbol）时，寻找工作区默认主文件以定位语言服务
 */
function findDefaultSourceFileForLsp(cwd: string): string | null {
	const candidates = [
		"src/index.ts",
		"src/main.ts",
		"src/app.ts",
		"index.ts",
		"main.ts",
		"app.ts",
		"server.ts",
		"main.py",
		"app.py",
		"main.go",
		"src/main.rs",
	];
	for (const c of candidates) {
		if (existsSync(join(cwd, c))) return c;
	}
	return null;
}

// ----------------------------------------------------------------------------
// 导出给 AI Agent 的工具对象
// ----------------------------------------------------------------------------

export interface LspToolOptions {
	cwd: string;
	ownerId?: string;
}

export function makeLspTool(options: LspToolOptions) {
	const cwd = options.cwd;

	return defineTool({
		name: LSP_TOOL_NAME,
		promptSnippet:
			"IDE-grade semantic analysis (LSP) across the workspace: definition, references, hover, diagnostics, symbols, impact check",
		label: "LSP code intelligence",
		description: `IDE-grade semantic analysis (LSP) across the workspace. Actions:
- \`definition\`: definition of the symbol at \`line\`/\`character\` in \`path\` (file, line, snippet).
- \`references\`: all workspace usages of that symbol.
- \`hover\`: type signature and docs for that symbol.
- \`diagnostics\`: compiler/type errors and warnings for \`path\` (whole file).
- \`documentSymbol\`: hierarchical symbol outline with line spans for \`path\`.
- \`read_symbol\`: read the body of \`symbol\` in \`path\` (e.g. "parseConfig").
- \`workspaceSymbol\`: search symbols across the workspace by \`query\`.
- \`cascade\`: impact check for \`path\` — report diagnostics of files referencing it.
Lines are 1-indexed.`,
		parameters: Type.Object({
			action: Type.Unsafe<LspAction>({
				type: "string",
				enum: [
					"definition",
					"references",
					"hover",
					"diagnostics",
					"documentSymbol",
					"read_symbol",
					"workspaceSymbol",
					"cascade",
				],
				description: "The LSP operation to perform.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Workspace-relative or absolute path to the target source file (required for all actions except workspaceSymbol).",
				}),
			),
			symbol: Type.Optional(
				Type.String({
					description: "Symbol name to read for 'read_symbol' action (e.g. 'functionName' or 'ClassName.methodName').",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Search query for 'workspaceSymbol' action.",
				}),
			),
			line: Type.Optional(
				Type.Number({
					description: "1-indexed line number in the source file.",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description: "1-indexed column/character position (defaults to 1).",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (defaults to 15).",
				}),
			),
			allowInstall: Type.Optional(
				Type.Boolean({
					description:
						"Install the missing language server into ~/.pi-web/lsp-servers (user-space, no sudo). Default false: the tool returns an installHint instead.",
				}),
			),
		}),
		async execute(
			_callId,
			params: {
				action: LspAction;
				path?: string;
				symbol?: string;
				query?: string;
				line?: number;
				character?: number;
				timeout?: number;
				allowInstall?: boolean;
			},
			_signal,
			_onUpdate,
			_ctx,
		) {
			const action = params.action;
			let targetPath = params.path;
			if (!targetPath && action === "workspaceSymbol") {
				targetPath = findDefaultSourceFileForLsp(cwd) ?? undefined;
				if (!targetPath) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Could not automatically detect a primary project source file to route language server. Please provide 'path' (pointing to any source file in the project, e.g. path='src/index.ts') to select the language server.`,
							},
						],
						details: { ok: false, error: "Missing path: cannot route language server" },
					};
				}
			}

			if (!targetPath) {
				return {
					content: [{ type: "text", text: `Error: 'path' parameter is required for action '${action}'.` }],
					details: { ok: false, error: "Missing path parameter" },
				};
			}

			const absPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
			const line = typeof params.line === "number" ? Math.max(1, params.line) : 1;
			const character = typeof params.character === "number" ? Math.max(1, params.character) : 1;
			const timeoutMs = (params.timeout ?? 15) * 1000;

			const rel = relative(cwd, absPath);
			if (
				rel === ".." ||
				rel.startsWith(".." + sep) ||
				rel.startsWith("../") ||
				rel.startsWith("..\\") ||
				isAbsolute(rel)
			) {
				return {
					content: [{ type: "text", text: `Error: Path traversal denied: ${targetPath} is outside workspace.` }],
					details: { ok: false, error: "Path traversal denied" },
				};
			}

			if (!existsSync(absPath)) {
				return {
					content: [{ type: "text", text: `Error: File not found: ${targetPath}` }],
					details: { ok: false, error: "File not found" },
				};
			}

			if (action === "read_symbol" && !params.symbol?.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `Error: 'symbol' parameter is required for 'read_symbol' action (e.g. symbol="parseConfig" or "ClassName.methodName").`,
						},
					],
					details: { ok: false, error: "Missing symbol parameter" },
				};
			}

			if (action === "workspaceSymbol" && !(params.query ?? "").trim()) {
				return {
					content: [
						{
							type: "text",
							text: `Error: 'query' parameter cannot be empty for 'workspaceSymbol' action. Please provide a search term (e.g. query='User' or 'Router').`,
						},
					],
					details: { ok: false, error: "Empty query parameter" },
				};
			}

			const clientRes = await globalLspPool.getClient(cwd, absPath, { allowInstall: params.allowInstall });
			if ("error" in clientRes) {
				return {
					content: [{ type: "text", text: `LSP Error: ${clientRes.error}` }],
					details: { ok: false, error: clientRes.error },
				};
			}

			const client = clientRes.client;
			const uri = await client.syncDocument(absPath);

			// 0-indexed positions for LSP protocol
			const position = {
				line: line - 1,
				character: character - 1,
			};

			try {
				if (action === "definition") {
					const result = await client.request(
						"textDocument/definition",
						{ textDocument: { uri }, position },
						timeoutMs,
					);
					const locs: LspLocation[] = Array.isArray(result) ? result : result ? [result] : [];

					if (locs.length === 0) {
						return {
							content: [{ type: "text", text: `No definition found for symbol at ${targetPath}:${line}:${character}` }],
							details: { ok: true, locations: [] },
						};
					}

					// 与 references(:25) 同口径：每个位置都要整读一次目标文件拼 snippet，
					// 无上限的 definition 列表会放大成几十次同步 IO 拖死请求。
					const MAX_DEFS = 25;
					const formatted = locs.slice(0, MAX_DEFS).map((loc: any) => {
						const targetUri: string = loc.targetUri || loc.uri || "";
						let defPath = targetUri;
						try {
							if (targetUri.startsWith("file:")) {
								defPath = fileURLToPath(targetUri);
							}
						} catch {}

						const targetRange = loc.targetSelectionRange || loc.targetRange || loc.range;
						const defRel = defPath.startsWith(cwd) ? defPath.slice(cwd.length).replace(/^[/\\]/, "") : defPath;
						const defLine = (targetRange?.start?.line ?? 0) + 1;
						const defCol = (targetRange?.start?.character ?? 0) + 1;

						let snippet = "";
						if (existsSync(defPath)) {
							const fileLines = readFileSync(defPath, "utf8").split(/\r?\n/);
							const startL = Math.max(0, defLine - 1);
							const endL = Math.min(fileLines.length, defLine + 3);
							snippet = fileLines
								.slice(startL, endL)
								.map((l, idx) => `${startL + idx + 1}: ${l}`)
								.join("\n");
						}

						return `• ${defRel}:${defLine}:${defCol}\n\`\`\`\n${snippet}\n\`\`\``;
					});

					const defTail = locs.length > MAX_DEFS ? `\n\n... and ${locs.length - MAX_DEFS} more definitions` : "";

					return {
						content: [
							{
								type: "text",
								text: `Definitions (${locs.length}):\n\n${formatted.join("\n\n")}${defTail}`,
							},
						],
						details: { ok: true, locations: locs },
					};
				}

				if (action === "references") {
					const result = await client.request(
						"textDocument/references",
						{
							textDocument: { uri },
							position,
							context: { includeDeclaration: true },
						},
						timeoutMs,
					);
					const locs: LspLocation[] = Array.isArray(result) ? result : [];

					if (locs.length === 0) {
						return {
							content: [{ type: "text", text: `No references found for symbol at ${targetPath}:${line}:${character}` }],
							details: { ok: true, references: [] },
						};
					}

					const formatted = locs.slice(0, 25).map((loc) => {
						const refPath = fileURLToPath(loc.uri);
						const refRel = refPath.startsWith(cwd) ? refPath.slice(cwd.length).replace(/^[/\\]/, "") : refPath;
						const refLine = loc.range.start.line + 1;
						const refCol = loc.range.start.character + 1;
						return `• ${refRel}:${refLine}:${refCol}`;
					});

					const tail = locs.length > 25 ? `\n... and ${locs.length - 25} more references` : "";

					return {
						content: [
							{
								type: "text",
								text: `Found ${locs.length} reference${locs.length > 1 ? "s" : ""}:\n${formatted.join("\n")}${tail}`,
							},
						],
						details: { ok: true, count: locs.length, references: locs },
					};
				}

				if (action === "hover") {
					const result = await client.request("textDocument/hover", { textDocument: { uri }, position }, timeoutMs);
					if (!result || !result.contents) {
						return {
							content: [{ type: "text", text: `No hover information available at ${targetPath}:${line}:${character}` }],
							details: { ok: true, hover: null },
						};
					}

					let hoverText = "";
					const c = result.contents;
					if (typeof c === "string") {
						hoverText = c;
					} else if (Array.isArray(c)) {
						hoverText = c.map((item) => (typeof item === "string" ? item : item.value)).join("\n\n");
					} else if (typeof c === "object" && c.value) {
						hoverText = c.value;
					}

					return {
						content: [{ type: "text", text: hoverText ? `Hover Info:\n${hoverText}` : "Empty hover information" }],
						details: { ok: true, hover: result },
					};
				}

				if (action === "diagnostics") {
					// 给予极短缓冲以确保 publishDiagnostics 缓存已收到
					await new Promise((r) => setTimeout(r, 120));
					const diags = client.getDiagnostics(uri);

					if (diags.length === 0) {
						return {
							content: [{ type: "text", text: `No diagnostics (clean): ${targetPath}` }],
							details: { ok: true, diagnostics: [] },
						};
					}

					const formatted = diags.slice(0, 30).map((d) => {
						const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARN" : "INFO";
						const startLine = d.range.start.line + 1;
						const startCol = d.range.start.character + 1;
						const code = d.code ? ` [${d.code}]` : "";
						return `[${sev}] line ${startLine}:${startCol}${code} - ${d.message}`;
					});

					return {
						content: [
							{
								type: "text",
								text: `Diagnostics for ${targetPath} (${diags.length}):\n${formatted.join("\n")}`,
							},
						],
						details: { ok: true, diagnostics: diags },
					};
				}

				if (action === "documentSymbol") {
					const result = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, timeoutMs);
					const symbols: any[] = Array.isArray(result) ? result : [];

					if (symbols.length === 0) {
						return {
							content: [{ type: "text", text: `No symbols found in ${targetPath}` }],
							details: { ok: true, symbols: [] },
						};
					}

					const lines = formatDocumentSymbols(symbols);
					// details 随会话持久且整体 ≤64KB（超限整条丢弃）：symbols 与文本大纲同口径截断
					const detailsSymbols = symbols.length > 300 ? symbols.slice(0, 300) : symbols;
					return {
						content: [
							{
								type: "text",
								text: `Symbols in ${targetPath} (${symbols.length} top-level):\n${lines.join("\n")}`,
							},
						],
						details: { ok: true, count: symbols.length, symbols: detailsSymbols },
					};
				}

				if (action === "read_symbol") {
					const targetSymbol = params.symbol?.trim();
					if (!targetSymbol) {
						return {
							content: [
								{
									type: "text",
									text: `Error: 'symbol' parameter is required for 'read_symbol' action (e.g. symbol="parseConfig" or "ClassName.methodName").`,
								},
							],
							details: { ok: false, error: "Missing symbol parameter" },
						};
					}

					const result = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, timeoutMs);
					const symbols: any[] = Array.isArray(result) ? result : [];

					const match = findSymbol(symbols, targetSymbol);
					if (!match) {
						const available = collectSymbolNames(symbols);
						const listSnippet =
							available.length > 0
								? `\nAvailable symbols in ${targetPath}:\n${available
										.slice(0, 30)
										.map((s) => `• ${s}`)
										.join("\n")}${available.length > 30 ? `\n... and ${available.length - 30} more` : ""}`
								: "";
						return {
							content: [
								{
									type: "text",
									text: `Symbol '${targetSymbol}' not found in ${targetPath}.${listSnippet}`,
								},
							],
							details: { ok: false, error: "Symbol not found", availableSymbols: available },
						};
					}

					const range = match.symbol.range || match.symbol.location?.range;
					if (!range) {
						return {
							content: [
								{
									type: "text",
									text: `Symbol '${targetSymbol}' found, but no range information was provided by language server.`,
								},
							],
							details: { ok: false, error: "Missing range" },
						};
					}

					let startLine = range.start.line; // 0-indexed
					let endLine = range.end.line; // 0-indexed
					// 针对行尾排他边界（end.character === 0 且跨行时）避免多读末尾空行
					if (range.end.character === 0 && endLine > startLine) {
						endLine -= 1;
					}

					const fileLines = readFileSync(absPath, "utf8").split(/\r?\n/);
					const totalSymbolLines = Math.max(0, endLine - startLine + 1);
					const MAX_SYMBOL_READ_LINES = 400;
					const isTruncated = totalSymbolLines > MAX_SYMBOL_READ_LINES;
					const sliceEndLine = isTruncated ? startLine + MAX_SYMBOL_READ_LINES - 1 : endLine;
					const symbolLines = fileLines.slice(startLine, sliceEndLine + 1);

					let formattedSnippet = symbolLines.map((l, idx) => `${startLine + idx + 1}: ${l}`).join("\n");
					if (isTruncated) {
						formattedSnippet += `\n// ... [Truncated: symbol body has ${totalSymbolLines} lines, showing first ${MAX_SYMBOL_READ_LINES} lines. Use 'documentSymbol' to inspect nested methods/members and read them individually]`;
					}

					const kind = LSP_SYMBOL_KINDS[match.symbol.kind] || `Kind(${match.symbol.kind})`;

					return {
						content: [
							{
								type: "text",
								text: `// Symbol: ${match.fullName} [${kind}]\n// File:   ${rel}:${startLine + 1}-${endLine + 1}\n\`\`\`\n${formattedSnippet}\n\`\`\``,
							},
						],
						details: {
							ok: true,
							symbol: match.symbol,
							fullName: match.fullName,
							startLine: startLine + 1,
							endLine: endLine + 1,
							code: symbolLines.join("\n"),
							totalLines: totalSymbolLines,
							truncated: isTruncated,
						},
					};
				}

				if (action === "workspaceSymbol") {
					const query = (params.query ?? "").trim();
					if (!query) {
						return {
							content: [
								{
									type: "text",
									text: `Error: 'query' parameter cannot be empty for 'workspaceSymbol' action. Please provide a search term (e.g. query='User' or 'Router').`,
								},
							],
							details: { ok: false, error: "Empty query parameter" },
						};
					}

					const result = await client.request("workspace/symbol", { query }, timeoutMs);
					const locs: any[] = Array.isArray(result) ? result : [];

					if (locs.length === 0) {
						return {
							content: [{ type: "text", text: `No symbols found across workspace matching '${query}'` }],
							details: { ok: true, symbols: [] },
						};
					}

					const MAX_WORKSPACE_SYMBOLS = 100;
					const isTruncated = locs.length > MAX_WORKSPACE_SYMBOLS;
					const cappedLocs = isTruncated ? locs.slice(0, MAX_WORKSPACE_SYMBOLS) : locs;

					const formatted = locs.slice(0, 30).map((sym: any) => {
						const targetUri: string = sym.location?.uri || sym.uri || "";
						let filePath = targetUri;
						try {
							if (targetUri.startsWith("file:")) filePath = fileURLToPath(targetUri);
						} catch {}
						const fileRel = filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^[/\\]/, "") : filePath;
						const range = sym.location?.range || sym.range;
						const lineNum = range ? range.start.line + 1 : 1;
						const kind = LSP_SYMBOL_KINDS[sym.kind] || `Kind(${sym.kind})`;
						const container = sym.containerName ? ` in ${sym.containerName}` : "";
						return `• [${kind}] ${sym.name}${container} (${fileRel}:${lineNum})`;
					});

					const tail = locs.length > 30 ? `\n... and ${locs.length - 30} more symbols` : "";

					return {
						content: [
							{
								type: "text",
								text: `Found ${locs.length} symbol${locs.length > 1 ? "s" : ""} matching '${query}' (via ${rel}):\n${formatted.join("\n")}${tail}`,
							},
						],
						details: { ok: true, count: locs.length, symbols: cappedLocs, truncated: isTruncated },
					};
				}

				if (action === "cascade") {
					// 影响级联（Impact Cascade）：找出引用本文件（或本文件某个符号）的工作区文件，
					// 聚合它们的实时诊断——让"改了签名/导出，下游编译炸了"在编辑当轮就暴露，
					// 而不是等到构建或提交时才发现。
					const MAX_SEEDS = 20;
					const MAX_DEPENDENTS = 25;
					const DIAGS_BUDGET_MS = 1500;
					const normalizePath = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

					// 1. 收集种子位置：给了 line/character 就只查那个符号；否则查全部顶层符号。
					const seeds: Array<{ line: number; character: number }> = [];
					if (typeof params.line === "number") {
						seeds.push({ line: line - 1, character: character - 1 });
					} else {
						const symResult = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, timeoutMs);
						const topSymbols: any[] = Array.isArray(symResult) ? symResult : [];
						for (const sym of topSymbols.slice(0, MAX_SEEDS)) {
							const pos = sym.selectionRange?.start ?? sym.range?.start ?? sym.location?.range?.start;
							if (pos && typeof pos.line === "number") {
								seeds.push({ line: pos.line, character: pos.character ?? 0 });
							}
						}
					}

					if (seeds.length === 0) {
						return {
							content: [{ type: "text", text: `No symbols to trace in ${targetPath} — nothing to cascade.` }],
							details: { ok: true, impacted: [], clean: [], notReported: [], referencedFiles: [] },
						};
					}

					// 2. 对每个种子查 references（不含声明处），汇总工作区内的引用方文件。
					const selfNorm = normalizePath(absPath);
					const depPaths = new Set<string>();
					const seedResults = await Promise.allSettled(
						seeds.map((pos) =>
							client.request(
								"textDocument/references",
								{ textDocument: { uri }, position: pos, context: { includeDeclaration: false } },
								timeoutMs,
							),
						),
					);
					for (const r of seedResults) {
						if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
						for (const loc of r.value as LspLocation[]) {
							const refUri: string = loc?.uri ?? "";
							if (!refUri.startsWith("file:")) continue;
							let refPath: string;
							try {
								refPath = fileURLToPath(refUri);
							} catch {
								continue;
							}
							if (normalizePath(refPath) === selfNorm) continue; // 排除自身
							const relRef = relative(cwd, refPath);
							if (relRef === ".." || relRef.startsWith(".." + sep) || relRef.startsWith("../") || isAbsolute(relRef)) {
								continue; // 只看工作区内
							}
							if (relRef.split(sep).includes("node_modules")) continue;
							depPaths.add(refPath);
						}
					}

					const dependents = [...depPaths].sort().slice(0, MAX_DEPENDENTS);
					if (dependents.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `No referencing files found for ${targetPath} — no impact cascade needed.`,
								},
							],
							details: { ok: true, impacted: [], clean: [], notReported: [], referencedFiles: [] },
						};
					}

					// 3. 逐个 didOpen/didChange 触发服务器分析，轮询等待 publishDiagnostics 回流。
					const depUris: string[] = [];
					for (const dep of dependents) {
						try {
							depUris.push(await client.syncDocument(dep));
						} catch {
							depUris.push("");
						}
					}
					const pending = new Set(depUris.filter(Boolean));
					const deadline = Date.now() + DIAGS_BUDGET_MS;
					while (pending.size > 0 && Date.now() < deadline) {
						await new Promise((r) => setTimeout(r, 120));
						const known = client.getAllDiagnostics();
						for (const u of pending) {
							if (known.has(u)) pending.delete(u);
						}
					}

					// 4. 聚合输出：有错误的排前面，其次警告，clean 与未上报的折叠列出。
					const impacted: Array<{ path: string; errors: number; warnings: number; diagnostics: LspDiagnostic[] }> = [];
					const clean: string[] = [];
					const notReported: string[] = [];
					const knownFinal = client.getAllDiagnostics();
					for (let i = 0; i < dependents.length; i++) {
						const dep = dependents[i];
						const depUri = depUris[i];
						const depRel = relative(cwd, dep).replace(/\\/g, "/");
						if (!depUri) {
							notReported.push(depRel);
							continue;
						}
						const diags = client.getDiagnostics(depUri);
						const errors = diags.filter((d) => d.severity === 1).length;
						const warnings = diags.filter((d) => d.severity === 2).length;
						if (errors + warnings > 0) {
							impacted.push({ path: depRel, errors, warnings, diagnostics: diags.slice(0, 10) });
						} else if (diags.length === 0 && !knownFinal.has(depUri)) {
							notReported.push(depRel); // 预算内服务器未上报（可能仍在分析）
						} else {
							clean.push(depRel);
						}
					}

					impacted.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);

					const out: string[] = [];
					out.push(
						`Impact cascade for ${targetPath}: ${dependents.length} referencing file(s), ${impacted.length} with findings.`,
					);
					for (const item of impacted) {
						out.push(`• ${item.path} — ${item.errors} error(s), ${item.warnings} warning(s)`);
						for (const d of item.diagnostics.slice(0, 5)) {
							const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARN" : "INFO";
							const code = d.code ? ` [${d.code}]` : "";
							const msg = String(d.message).split("\n")[0];
							out.push(`    [${sev}] line ${d.range.start.line + 1}:${d.range.start.character + 1}${code} - ${msg}`);
						}
					}
					if (clean.length > 0) {
						const shown = clean
							.slice(0, 10)
							.map((p) => `• ${p}`)
							.join("\n");
						out.push(
							`Clean (${clean.length}):\n${shown}${clean.length > 10 ? `\n... and ${clean.length - 10} more` : ""}`,
						);
					}
					if (notReported.length > 0) {
						out.push(
							`Diagnostics not reported in time (${notReported.length}, server may still be analyzing): ${notReported.slice(0, 5).join(", ")}${notReported.length > 5 ? ", ..." : ""}`,
						);
					}

					return {
						content: [{ type: "text", text: out.join("\n") }],
						details: {
							ok: true,
							impacted,
							clean,
							notReported,
							referencedFiles: dependents.map((p) => relative(cwd, p).replace(/\\/g, "/")),
						},
					};
				}

				return {
					content: [{ type: "text", text: `Unsupported action: ${action}` }],
					details: { ok: false, error: "Unsupported action" },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `LSP request failed: ${(err as Error).message}` }],
					details: { ok: false, error: (err as Error).message },
				};
			}
		},
	});
}
