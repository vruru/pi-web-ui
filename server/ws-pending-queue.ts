/**
 * attach 完成前暂存客户端命令的队列 —— 独立成模块是为了可单测
 * （`server/index.ts` 起 WS + SDK，不适合在单测里 import）。
 *
 * 背景：hello 先回 ready（issue #295）后，attach/插件链就绪前收到的命令一律进
 * pending 队列等重放；attach 挂死（坏挂载/家目录扫描数十秒）或失败保活时队列
 * 原先无上限——失控/恶意连接可在此期间灌消息把内存顶爆。加上限后超限丢最旧并
 * 计数（做法对齐 ws-unknown-types 的「上限 + 溢出计数 + 节流 warn」先例）。
 */

import type { ClientMessage } from "./protocol.js";

/** 队列上限：正常前端在 attach 窗口内只发 get_state 等零星几条，256 绰绰有余。 */
export const MAX_PENDING_WS_MESSAGES = 256;

/** 同一进程两次超限告警的最小间隔（防刷屏，对齐 ws-unknown-types 的节流思路）。 */
export const PENDING_DROP_WARN_INTERVAL_MS = 60_000;

let lastWarnAt = 0;

/** 超限丢弃的节流告警：`PENDING_DROP_WARN_INTERVAL_MS` 内最多一条。log 注入便于单测。 */
export function warnPendingDrop(totalDropped: number, log: (line: string) => void): void {
	const now = Date.now();
	if (now - lastWarnAt < PENDING_DROP_WARN_INTERVAL_MS) return;
	lastWarnAt = now;
	log(`[ws] attach 未完成，命令队列超限丢最旧（累计 ${totalDropped} 条）`);
}

/** 单测隔离用。 */
export function resetPendingDropWarn(): void {
	lastWarnAt = 0;
}

/** attach 前的命令暂存队列：超限丢最旧（shift），丢弃只计数，不阻断新消息入队。 */
export class PendingCommandQueue {
	private items: ClientMessage[] = [];
	private droppedTotal = 0;

	constructor(readonly cap: number = MAX_PENDING_WS_MESSAGES) {}

	push(msg: ClientMessage): void {
		if (this.items.length >= this.cap) {
			this.items.shift();
			this.droppedTotal++;
			warnPendingDrop(this.droppedTotal, (line) => console.warn(line));
		}
		this.items.push(msg);
	}

	/** 取走全部并清空（attach 完成后的重放）。 */
	drain(): ClientMessage[] {
		const out = this.items;
		this.items = [];
		return out;
	}

	/** attach 失败保活 / 连接关闭时清空（用户修好后重发的 get_state 会重新入队）。 */
	clear(): void {
		this.items = [];
	}

	/** 累计丢弃条数（排障用）。 */
	get dropped(): number {
		return this.droppedTotal;
	}

	get size(): number {
		return this.items.length;
	}
}
