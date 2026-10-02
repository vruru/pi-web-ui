/**
 * Background-server tracking — 从 agent-service.ts 抽出。
 *
 * bash 工具执行前后各拍一次监听端口快照，diff 出 AI 启动的后台服务记入列表；
 * 列表按客户端持久（对话切换/断线重连不消失），只有任务被停或进程自行退出才移除。
 * 本模块自包含：只依赖 process-utils 与协议类型，经回调与 ClientSession 解耦
 * （emit 推消息 / flushSnapshot 立即刷快照 / isDisposed 停止后台刷新）。
 */
import type { ServerMessage, BgServer } from "./protocol.js";
import {
	killPidTree,
	lookupProcessName,
	lookupProcessCommandLine,
	snapshotListeningPorts,
	snapshotProcessParents,
} from "./process-utils.js";

const BG_REFRESH_INTERVAL_MS = 30_000;
/** bash 结束后等这么久再拍「后」快照——给后台服务绑定端口的时间。 */
const BG_BIND_WAIT_MS = 1500;

/**
 * 基本不可能由 AI 启动的常驻桌面软件进程名（小写）。命中即跳过，避免面板被
 * 微信/QQ 等本地软件的动态监听端口污染。注意 Chrome 不进黑名单：AI 会用
 * Playwright 拉浏览器做模拟，它靠下方父链回溯判定（Playwright 起的 chrome
 * 能回溯到服务器进程，自己开的 chrome 父链是 explorer，分得开）。
 */
export const NON_AGENT_PROCESS_NAMES = new Set([
	"wechat.exe",
	"weixin.exe",
	"wechatappex.exe",
	"qq.exe",
	"tim.exe",
	"telegram.exe",
	"dingtalk.exe",
	"explorer.exe",
	"searchhost.exe",
	"searchapp.exe",
	"svchost.exe",
	"winlogon.exe",
	"dwm.exe",
	"csrss.exe",
	"conhost.exe",
]);

/**
 * 判定 bash 后新出现的监听端口进程是否该记入后台任务列表（即「AI 启动的」）。
 * 判定规则（查不到就保守记录，宁多勿漏）：
 * 1. 进程名命中黑名单（如 WeChat.exe，AI 不会去启动微信）→ 跳过；
 * 2. 进程树可查时沿父链向上回溯：
 *    - 撞上服务器进程（serverPid，AI 的任何 bash/execFile 都从它 spawn）→ 记录；
 *    - 撞上本次 diff 出的其他新 pid（bash 留下的中间层，如 concurrently/npm
 *      一类进程，它自己不监听端口所以没进 diff，但子进程监听）→ 记录；
 *    - 完整回溯到系统根（pid 0/1）都未命中 → 桌面软件自启（如自己开的 Chrome，
 *      父链 explorer→…→0），跳过；
 * 3. 父链断链（父进程已退出/reparent，快照里查不到级联）→ 保守记录。
 * @param parents 全量 pid→ppid 映射，undefined = 查询失败（跳过父链判定，只留黑名单）。
 * @param newPids 本次 bash 前后 diff 出的全部新监听 pid。
 */
export function shouldTrackBackgroundServer(
	pid: number,
	parents: Map<number, number> | undefined,
	newPids: ReadonlySet<number>,
	serverPid: number,
	name?: string,
): boolean {
	if (name && NON_AGENT_PROCESS_NAMES.has(name.toLowerCase())) return false;
	if (!parents) return true; // 进程树查不到 → 保守记录
	const seen = new Set<number>();
	let cur: number | undefined = pid;
	while (cur !== undefined && !seen.has(cur)) {
		seen.add(cur);
		if (cur === serverPid) return true;
		if (cur !== pid && newPids.has(cur)) return true;
		const next = parents.get(cur);
		if (next === undefined) {
			// 到达系统根（0/1）→ 完整链，桌面软件；否则是断链 → 保守记录
			return cur <= 1 ? false : true;
		}
		if (next === cur) return false; // 自引用根，同样视为完整链终点
		cur = next;
	}
	return false;
}

export class BgServerTracker {
	private readonly servers = new Map<number, { pid: number; since: number; name?: string; command?: string }>();
	/**
	 * bash 工具开始执行前拍的监听端口快照（tool_execution_start 时设置）。
	 * 槽位存「in-flight Promise」而非已解析的 Map：并发 bash 同时开跑时不互相
	 * 覆盖（??= 保住最早的一份——更早的基线只会多算新增，落库有去重兜底），
	 * 也修掉 fire-and-forget 时序竞态（bash 先于快照返回结束 → trackAfterBash
	 * 读到 null 直接漏记，延迟解析的旧快照还会污染下一轮）。
	 */
	private listenBefore: Promise<Map<number, number>> | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly opts: {
			emit: (msg: ServerMessage) => void;
			flushSnapshot: () => void;
			isDisposed: () => boolean;
			/** 插件注册的常驻任务（host.registerBackgroundTask）→ 追加进同一列表。 */
			pluginTasks?: () => BgServer[];
		},
	) {}

	/** 启动周期性存活检查（死项静默剔除）。 */
	start(): void {
		this.refreshTimer = setInterval(() => void this.refresh(), BG_REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** tool_execution_start(bash)：先记下「前」快照（快照在途时保留最早的一份）。 */
	snapshotBefore(): void {
		this.listenBefore ??= snapshotListeningPorts();
	}

	/** After a bash tool run, wait briefly for background servers to bind,
	 *  then diff the listening-port snapshot against the pre-run one and
	 *  remember anything new — those are servers the agent left running. */
	async trackAfterBash(): Promise<void> {
		// 读后清槽：await in-flight 快照（消除 fire-and-forget 的时序竞态），
		// 并发 bash 共用这份最早的基线，各自结束都能对得上。
		const beforePromise = this.listenBefore;
		this.listenBefore = null;
		if (!beforePromise) return;
		const before = await beforePromise;
		await new Promise((r) => setTimeout(r, BG_BIND_WAIT_MS));
		const after = await snapshotListeningPorts();
		const fresh: Array<{ port: number; pid: number }> = [];
		for (const [port, pid] of after) {
			if (!before.has(port) && !this.servers.has(port)) {
				fresh.push({ port, pid });
			}
		}
		if (fresh.length === 0) return;
		// 剔除桌面软件误报（微信等）后，剩下的才是 AI 启动的后台服务。
		const keep = await this.filterAgentSpawned(fresh);
		let added = false;
		for (const { port, pid } of keep) {
			if (this.servers.has(port)) continue;
			this.servers.set(port, { pid, since: Date.now() });
			added = true;
			// Best-effort process name + full command line so the panel shows
			// something readable (name) AND what is actually running (command).
			void lookupProcessName(pid).then((name) => {
				const cur = this.servers.get(port);
				if (cur && cur.pid === pid && name) {
					cur.name = name;
					this.push();
				}
			});
			void lookupProcessCommandLine(pid).then((command) => {
				const cur = this.servers.get(port);
				if (cur && cur.pid === pid && command) {
					cur.command = command;
					this.push();
				}
			});
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `检测到 AI 启动的后台服务：端口 ${port}（pid ${pid}）——可在顶栏「后台任务」里单独停止或全部关闭`,
				textEn: `Detected an AI-started background service: port ${port} (pid ${pid}) — stop it individually or all at once under Background tasks in the top bar`,
			});
		}
		if (added) this.push();
	}

	/** 并行拉进程树与各进程名，用黑名单 + 父链回溯剔除桌面软件误报。 */
	private async filterAgentSpawned(
		fresh: Array<{ port: number; pid: number }>,
	): Promise<Array<{ port: number; pid: number }>> {
		const parents = await snapshotProcessParents();
		const names = await Promise.all(fresh.map((f) => lookupProcessName(f.pid)));
		const newPids = new Set(fresh.map((f) => f.pid));
		const out: Array<{ port: number; pid: number }> = [];
		for (let i = 0; i < fresh.length; i++) {
			const { port, pid } = fresh[i];
			if (shouldTrackBackgroundServer(pid, parents, newPids, process.pid, names[i])) {
				out.push({ port, pid });
			}
		}
		return out;
	}

	/** The current background-server list, oldest first. 合并插件任务。 */
	list(): BgServer[] {
		const out: BgServer[] = [...this.servers.entries()]
			.map(([port, v]) => ({
				port,
				pid: v.pid,
				since: v.since,
				...(v.name ? { name: v.name } : {}),
				...(v.command ? { command: v.command } : {}),
			}))
			.sort((a, b) => a.since - b.since);
		for (const t of this.opts.pluginTasks?.() ?? []) out.push(t);
		return out;
	}

	/** Push the current background-task list to every connected socket. */
	push(): void {
		this.opts.emit({ type: "bg_servers", servers: this.list() });
	}

	/** Re-snapshot listening ports and drop tracked entries that are no longer
	 *  listening — the process exited on its own, so it must leave the panel.
	 *  Port AND pid must both match: a port reused by an unrelated process is
	 *  not our server anymore. Silent (the list just updates). */
	async refresh(): Promise<void> {
		if (this.opts.isDisposed() || this.servers.size === 0) return;
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listAndPush(): Promise<void> {
		await this.refresh();
		this.push();
	}

	/** 杀前复核端口→pid 归属（与 refresh() 同一判定：端口与 pid 都对得上才算我们的）。
	 *  缓存的 pid 可能已过期——原进程退出后端口被无关进程复用时，按缓存 pid 直接
	 *  killPidTree 会误伤无辜进程树。不符的条目剔除并推送，绝不对其开杀。 */
	private async verifyBeforeKill(): Promise<void> {
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	async killOne(port: number): Promise<boolean> {
		const entry = this.servers.get(port);
		if (!entry) {
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `端口 ${port} 不在后台任务列表中`,
				textEn: `Port ${port} is not in the background task list`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		await this.verifyBeforeKill();
		const verified = this.servers.get(port);
		if (!verified || verified.pid !== entry.pid) {
			this.opts.emit({
				type: "notice",
				level: "warning",
				text: `端口 ${port} 已不在原进程（原 pid ${entry.pid}）监听，已跳过并刷新列表`,
				textEn: `Port ${port} is no longer held by the original process (pid ${entry.pid}); skipped and list refreshed`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		killPidTree(entry.pid);
		this.servers.delete(port);
		this.push();
		this.opts.emit({
			type: "notice",
			level: "info",
			text: `已停止后台任务：端口 ${port}（pid ${entry.pid}）`,
			textEn: `Stopped background task: port ${port} (pid ${entry.pid})`,
		});
		this.opts.flushSnapshot();
		return true;
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAll(): Promise<string[]> {
		if (this.servers.size === 0) return [];
		await this.verifyBeforeKill();
		if (this.servers.size === 0) return [];
		const killed: string[] = [];
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, { pid }] of [...this.servers]) {
			killPidTree(pid);
			killed.push(String(port));
		}
		this.servers.clear();
		this.push();
		return killed;
	}
}
