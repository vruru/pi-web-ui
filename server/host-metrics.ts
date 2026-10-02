import os from "node:os";
import type { UiHostMetrics } from "./protocol.js";

export interface HostResourceSnapshot {
	cpuIdle: number;
	cpuTotal: number;
	memoryFree: number;
	memoryTotal: number;
}

function calculateMemoryPercent(snapshot: HostResourceSnapshot): number {
	const memoryUsed = Math.max(0, snapshot.memoryTotal - snapshot.memoryFree);
	return snapshot.memoryTotal > 0 ? Math.max(0, Math.min(100, (memoryUsed / snapshot.memoryTotal) * 100)) : 0;
}

export function defaultReadSnapshot(): HostResourceSnapshot {
	const cpus = os.cpus();
	let cpuIdle = 0;
	let cpuTotal = 0;
	for (const cpu of cpus) {
		const times = cpu.times;
		const total = (times.user ?? 0) + (times.nice ?? 0) + (times.sys ?? 0) + (times.idle ?? 0) + (times.irq ?? 0);
		cpuIdle += times.idle ?? 0;
		cpuTotal += total;
	}
	return {
		cpuIdle,
		cpuTotal,
		memoryFree: os.freemem(),
		memoryTotal: os.totalmem(),
	};
}

export function calculateHostMetrics(previous: HostResourceSnapshot, current: HostResourceSnapshot): UiHostMetrics {
	const totalDelta = current.cpuTotal - previous.cpuTotal;
	const idleDelta = current.cpuIdle - previous.cpuIdle;

	let cpuPercent: number | null = null;
	if (totalDelta > 0) {
		const rawPercent = (1 - idleDelta / totalDelta) * 100;
		cpuPercent = Math.max(0, Math.min(100, rawPercent));
	}

	const memoryPercent = calculateMemoryPercent(current);

	return {
		cpuPercent,
		memoryPercent,
	};
}

/** CPU 平滑窗口：上报最近 N 次有效读数的均值。心跳 2s 一次，默认 5 次 ≈ 10s 平均
 *  —— 单次 2s 采样的毛刺（编译/构建抖动）不再直接上底栏，观感与任务管理器的
 *  曲线对齐。内存变化慢，不平滑，沿用瞬时值。 */
export const CPU_SMOOTH_WINDOW = 5;

/** 有效 CPU 读数序列的均值（空序列 → null，前端显示 —）。纯函数，可单测。 */
export function meanCpuPercent(readings: number[]): number | null {
	if (readings.length === 0) return null;
	let sum = 0;
	for (const v of readings) sum += v;
	return sum / readings.length;
}

export function createHostMetricsSampler(
	readSnapshot: () => HostResourceSnapshot = defaultReadSnapshot,
	windowSize: number = CPU_SMOOTH_WINDOW,
): () => UiHostMetrics {
	const window = Math.max(1, Math.floor(windowSize));
	let previous: HostResourceSnapshot | null = null;
	try {
		previous = readSnapshot();
	} catch {
		// 初始基线读取异常时不击穿服务启动，待后续心跳重试
		previous = null;
	}
	/** 最近 window 次有效 CPU 读数（totalDelta<=0 的 null 读数不进序列，避免空洞拉低均值）。 */
	const history: number[] = [];

	return () => {
		const current = readSnapshot();
		if (!previous) {
			previous = current;
			return {
				cpuPercent: null,
				memoryPercent: calculateMemoryPercent(current),
			};
		}
		const metrics = calculateHostMetrics(previous, current);
		previous = current;
		if (metrics.cpuPercent !== null && Number.isFinite(metrics.cpuPercent)) {
			history.push(metrics.cpuPercent);
			if (history.length > window) history.splice(0, history.length - window);
		}
		return {
			cpuPercent: meanCpuPercent(history),
			memoryPercent: metrics.memoryPercent,
		};
	};
}
