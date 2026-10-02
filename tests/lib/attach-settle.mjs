/**
 * attach-settle.mjs — 冒烟测试共用的 attach 余波排空 helper。
 *
 * 背景：ready 只代表传输通（issue #295），不代表会话就绪。hello 之后服务端
 * 还要走 attach → 插件链（ensureLoaded/命令目录/首快照/rev2 空 delta/面板推送），
 * 测试在第一条消息到达后立刻开断言，会跟余波交错（snapshot-delta 曾稳定复现
 * delta baseRev 3 vs 前一条 rev 1；plugin-grants 曾撞未知插件命令）。
 *
 * 用法：
 *   import { waitAttachSettled } from "./lib/attach-settle.mjs";
 *   // 在自建的 ws message 监听里把每条原始消息喂进来：
 *   ws.on("message", (raw) => record(JSON.parse(raw.toString())));
 *   await waitAttachSettled({ sawReady: () => ready, sawMarker: () => schedulerTasks });
 *
 * 约定：插件链末尾固定以 scheduler_tasks 收尾（见 server/index.ts attach 流程），
 * 以它为排空标记，再静置 quietMs 即认为基线干净。调用方之后再清空自己的
 * stream 开始断言。
 */
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @param {object} opts
 * @param {() => boolean} opts.sawReady - 是否已收到 ready
 * @param {() => boolean} opts.sawMarker - 是否已收到 scheduler_tasks（排空标记）
 * @param {number} [opts.timeoutMs=10000] - 等标记的最长时限（超时也继续，不抛错）
 * @param {number} [opts.quietMs=500] - 标记到达后再静置时长
 * @returns {Promise<boolean>} 标记是否如期到达（false = 靠超时兜底继续）
 */
export async function waitAttachSettled({ sawReady, sawMarker, timeoutMs = 10_000, quietMs = 500 }) {
	const t0 = Date.now();
	while (!sawReady()) {
		if (Date.now() - t0 > timeoutMs) break;
		await sleep(50);
	}
	const t1 = Date.now();
	let marked = false;
	while (!sawMarker()) {
		if (Date.now() - t1 > timeoutMs) break;
		await sleep(50);
	}
	marked = sawMarker();
	await sleep(quietMs);
	return marked;
}
