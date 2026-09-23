/**
 * `mcp.json` 热加载 —— 改完文件即生效，不必再重启 pi-web-ui。
 *
 * 为什么是「盯文件」而不是加协议消息 / 设置面板按钮：`mcp.json` 是用文本编辑器手改的
 * 外部文件（README 一直写着「改完要重启」），没有任何 UI 参与保存；监视文件是唯一不需要
 * 新增协议字段与多语言文案的形态（对照 `reload_models_config`：它有设置面板按钮，所以走协议）。
 *
 * 三条不变量（都有回归用例）：
 *  1. **内容没变就不动任何子进程**：指纹按「规范化后的服务器集合」算（服务器顺序无关、
 *     只看影响行为的字段）—— 编辑器保存、重排键、改缩进都不触发重启；
 *  2. **配置写坏不停掉在跑的服务器**：JSON 解析失败只记日志 + 提示一次，绝不碰现有实例
 *     （保存过程中的半写状态很常见）；
 *  3. **删掉文件 = 清空配置**：与「坏配置」区分开 —— 用户删掉 `mcp.json` 是有意关掉全部
 *     MCP 服务器，照常应用。
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { mcpServerSnapshot, parseMcpConfig, type McpReloadSummary, type McpServerSpec } from "./mcp-bridge.js";

/** 一次「文件 → 运行时」应用的结果。 */
export type McpReloadOutcome =
	| "reloaded" // 配置变了，已换入
	| "unchanged" // 与上次应用的内容一致，什么都没做
	| "invalid"; // 解析失败，保留在跑的服务器

export interface McpHotReloadDeps {
	dataDir: string;
	/** 应用新配置（`McpBridge.reload`）：每个服务器的启动失败由它自己消化，不该向这里抛。 */
	reload: () => Promise<McpReloadSummary>;
	/** 工具集合变化后推入已有会话（`service.applyPluginAgentTools`）——「工具列表热刷新」那一半。 */
	onToolsChanged?: () => void;
	/** 面向用户的通知条：坏配置与加载完成都要让人看见，不只是打在服务端日志里。 */
	onNotice?: (level: "info" | "warning", text: string, textEn: string) => void;
	log?: (...a: unknown[]) => void;
	/** 事件防抖（编辑器保存常触发多次）。 */
	debounceMs?: number;
	/** 内容指纹定期核对间隔；补偿 fs.watch 静默漏报或目录替换。 */
	pollIntervalMs?: number;
}

export interface McpHotReload {
	/** 读文件 → 比对指纹 → 必要时热替换。可直接调用（测试 / 手动重载）。 */
	apply(): Promise<McpReloadOutcome>;
	/** 播种指纹（启动时 `McpBridge.load()` 已按同一份文件启动过）并开始监视。 */
	start(): void;
	dispose(): void;
}

/** 规范化指纹：只含影响行为的字段、服务器顺序无关 —— 「内容变了吗」的判据。 */
function fingerprint(servers: Record<string, McpServerSpec>): string {
	const names = Object.keys(servers).sort();
	return JSON.stringify(names.map((n) => [n, mcpServerSnapshot(servers[n])]));
}

export function createMcpHotReload(deps: McpHotReloadDeps): McpHotReload {
	const file = join(deps.dataDir, "mcp.json");
	const log = deps.log ?? (() => {});
	const debounceMs = deps.debounceMs ?? 300;
	const pollIntervalMs = deps.pollIntervalMs ?? 2000;
	/** 上次应用到运行时的内容指纹；null = 还没播种。 */
	let applied: string | null = null;
	let debounce: NodeJS.Timeout | null = null;
	let poller: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;
	let disposed = false;
	let pending: Promise<McpReloadOutcome> = Promise.resolve("unchanged");

	/** 读一次磁盘：指纹 + 清单（`servers` 为 null = 坏配置）。文件不在按「没有服务器」算。 */
	function readOnce(): { fp: string; servers: Record<string, McpServerSpec> | null } {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			// 读不到（文件/目录不在）→ 空配置：删掉 mcp.json 就是「关掉全部 MCP 服务器」。
			return { fp: "empty", servers: {} };
		}
		const parsed = parseMcpConfig(raw);
		if (!parsed) return { fp: `invalid:${raw}`, servers: null };
		return { fp: `ok:${fingerprint(parsed.servers)}`, servers: parsed.servers };
	}

	async function applyOnce(): Promise<McpReloadOutcome> {
		if (disposed) return "unchanged";
		const { fp, servers } = readOnce();
		if (fp === applied) return "unchanged";
		// 先记账再动手：同一个坏文件不反复刷屏，配置没再变也不重试。
		applied = fp;
		if (!servers) {
			log("[mcp] mcp.json 解析失败，保留在跑的 MCP 服务器");
			deps.onNotice?.(
				"warning",
				"mcp.json 解析失败，已保留当前 MCP 服务器（改好保存后会自动重载）",
				"Failed to parse mcp.json — keeping the running MCP servers (saving a valid file reloads automatically)",
			);
			return "invalid";
		}
		const summary = await deps.reload();
		if (disposed) return "unchanged";
		deps.onToolsChanged?.();
		log(
			`[mcp] 配置已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具` +
				`（沿用 ${summary.kept}、启动 ${summary.started}、关闭 ${summary.stopped}、失败 ${summary.failed}）`,
		);
		deps.onNotice?.(
			"info",
			`mcp.json 已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具`,
			`mcp.json reloaded: ${summary.servers} server(s) / ${summary.tools} tool(s)`,
		);
		return "reloaded";
	}

	/** watch、轮询和手动调用共用队列，避免慢启动时两轮 reload 交叉换入实例。 */
	function apply(): Promise<McpReloadOutcome> {
		const next = pending.then(applyOnce);
		pending = next.catch(() => "unchanged");
		return next;
	}

	function run(): void {
		void apply().catch((err) => log("[mcp] 热加载失败：", err instanceof Error ? err.message : err));
	}

	function schedule(): void {
		if (debounce) return;
		debounce = setTimeout(() => {
			debounce = null;
			run();
		}, debounceMs);
	}

	/** 单文件低频核对：fs.watch 成功注册也可能漏事件，不能只靠 error 才启用。 */
	function ensurePolling(): void {
		if (poller) return;
		poller = setInterval(run, pollIntervalMs);
		poller.unref();
	}

	/** fs.watch 用不了（目录还不存在、网络盘、容器）→ 保留轮询。 */
	function fallBackToPolling(): void {
		watcher?.close();
		watcher = null;
		log(`[mcp] 目录监视不可用，mcp.json 热加载回落到 ${pollIntervalMs}ms 轮询`);
		ensurePolling();
	}

	function start(): void {
		if (watcher || poller) return;
		disposed = false;
		// 播种：启动时 load() 已按同一份文件启动过服务器，别在第一个事件里白重载一次。
		applied = readOnce().fp;
		try {
			watcher = watch(deps.dataDir, { persistent: false }, (_event, filename) => {
				// 有些平台/编辑器（保存 = 临时文件 + rename）给不出文件名，拿不到就当命中。
				if (typeof filename === "string" && filename && filename !== "mcp.json") return;
				schedule();
			});
			watcher.on("error", () => fallBackToPolling());
		} catch {
			fallBackToPolling();
		}
		ensurePolling();
	}

	function dispose(): void {
		disposed = true;
		if (debounce) clearTimeout(debounce);
		debounce = null;
		if (poller) clearInterval(poller);
		poller = null;
		watcher?.close();
		watcher = null;
	}

	return { apply, start, dispose };
}
