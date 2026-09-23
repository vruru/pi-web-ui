/**
 * 插件定时任务的 cron 解析与持久化（host.schedule 的底层，server/plugins.ts 调用）。
 *
 * 两部分：
 * 1. 全 5 字段 cron（分 时 日 月 周）：`"*"` / `"*\/n"` / `"a-b"` / `"a-b/n"` /
 *    `"a,b,c"` / 单数字；月/周支持英文名（jan/dec 不分大小写，sun..sat，7 视作 0）。
 *    日-周按标准 cron OR 语义（都受限取并集，一侧 `*` 时另一侧说了算）。
 *    时间一律按**服务器本地时区**算（文档写死，不做 TZ 配置）。
 * 2. 持久记录 `<pluginDir>/schedules.json`：只存声明（spec/catchUp/label）+
 *    上次触发 lastRun；fn 回调永远由插件代码在 activate 里重给（重启后重建）。
 *    坏文件当空表（不回写，避免一次磁盘抖动清空全部定时）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CronParts {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	dow: number[];
}

const MONTH_NAMES: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};
const DOW_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

/** 单字段解析 → 升序去重数组；非法回 null。纯函数，单测覆盖。 */
export function parseCronField(raw: string, min: number, max: number, names?: Record<string, number>): number[] | null {
	const src = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!src) return null;
	const out = new Set<number>();
	const num = (tok: string): number | null => {
		const t = tok.trim();
		if (!t) return null;
		if (names && t in names) return names[t]!;
		if (!/^\d+$/.test(t)) return null;
		let n = Number(t);
		if (n === 7 && min === 0 && max === 6) n = 0; // 周日的 7 写法
		if (!Number.isInteger(n) || n < min || n > max) return null;
		return n;
	};
	for (const part of src.split(",")) {
		const p = part.trim();
		if (!p) return null;
		// 步长：*/n 或 a-b/n（a 缺省 min，b 缺省 max）。
		const step = p.split("/");
		if (step.length === 2) {
			const every = num(step[1]!);
			if (every === null || every <= 0) return null;
			let lo = min;
			let hi = max;
			if (step[0] !== "" && step[0] !== "*") {
				const range = step[0]!.split("-");
				if (range.length > 2) return null;
				const a = num(range[0]!);
				if (a === null) return null;
				lo = a;
				if (range.length === 2) {
					const b = num(range[1]!);
					if (b === null || b < a) return null;
					hi = b;
				}
			}
			for (let v = lo; v <= hi; v += every) out.add(v);
			continue;
		}
		if (step.length > 2) return null;
		if (p === "*") {
			for (let v = min; v <= max; v++) out.add(v);
			continue;
		}
		if (p.includes("-")) {
			const range = p.split("-");
			if (range.length !== 2) return null;
			const a = num(range[0]!);
			const b = num(range[1]!);
			if (a === null || b === null || b < a) return null;
			for (let v = a; v <= b; v++) out.add(v);
			continue;
		}
		const n = num(p);
		if (n === null) return null;
		out.add(n);
	}
	if (out.size === 0) return null;
	return [...out].sort((a, b) => a - b);
}

/** 5 字段 cron 解析；非法回 null。纯函数，单测覆盖。 */
export function parseCronSpec(spec: string): CronParts | null {
	const fields = String(spec ?? "")
		.trim()
		.split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0]!, 0, 59);
	const hour = parseCronField(fields[1]!, 0, 23);
	const dom = parseCronField(fields[2]!, 1, 31);
	const month = parseCronField(fields[3]!, 1, 12, MONTH_NAMES);
	const dow = parseCronField(fields[4]!, 0, 6, DOW_NAMES);
	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

function isFull(values: number[], min: number, max: number): boolean {
	return values.length === max - min + 1;
}

/**
 * 下一次触发毫秒时间戳（从 fromMs 的下一分钟开始扫，上限约一年）；**一年内没有下一次回 null**
 * （例如 `0 0 31 2 *` 这种永远不存在的日子）。
 *
 * 为什么不是回一个「一年后的哨兵值」：调用方 `armCron` 拿它做 `setTimeout(next - now)`，
 * 而 Node 的 setTimeout 延迟超过 2^31-1ms（≈24.8 天）会**溢出成 1ms** —— 哨兵值配上溢出
 * 就是「1ms 后触发 → 再排下一次」的死循环（每次触发还伴随插件回调与写盘）。回 null 之后，
 * 调用方能明确区分「还有很久」与「永远不会发生」。纯函数，单测覆盖。
 */
export function nextCronFire(parts: CronParts, fromMs: number): number | null {
	const minuteSet = new Set(parts.minute);
	const hourSet = new Set(parts.hour);
	const monthSet = new Set(parts.month);
	const domRestricted = !isFull(parts.dom, 1, 31);
	const dowRestricted = !isFull(parts.dow, 0, 6);
	const domSet = new Set(parts.dom);
	const dowSet = new Set(parts.dow);
	let t = Math.floor(Number(fromMs) / 60000) * 60000 + 60000;
	const limit = t + 366 * 24 * 60 * 60000;
	for (; t <= limit; t += 60000) {
		const d = new Date(t);
		if (!monthSet.has(d.getMonth() + 1)) continue;
		const domHit = domSet.has(d.getDate());
		const dowHit = dowSet.has(d.getDay());
		// 标准 OR 语义：都受限取并集；一侧通配时另一侧说了算；都不受限天天跑。
		const dayHit =
			domRestricted && dowRestricted ? domHit || dowHit : domRestricted ? domHit : dowRestricted ? dowHit : true;
		if (!dayHit) continue;
		if (!hourSet.has(d.getHours())) continue;
		if (!minuteSet.has(d.getMinutes())) continue;
		return t;
	}
	return null;
}

/**
 * setTimeout 的安全延迟上限（毫秒）：Node 与浏览器都按 32 位有符号整数存延迟，
 * 超过 2^31-1 会被截断（Node 会**静默变成 1ms** 并打一条 TimeoutOverflowWarning）。
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 把「距离下次触发的毫秒数」切成一段安全的 setTimeout 延迟（纯函数，单测覆盖）。
 *
 * 超过上限就只等一个分片（默认 6 小时）再重新计算 —— 重新计算这一步是关键：
 * 过期声明、时钟回拨、系统休眠回来都能自然纠正，比一次性排一个超长定时器稳。
 */
export function armDelay(nextAtMs: number, nowMs: number, maxChunkMs = 6 * 60 * 60 * 1000): number {
	const raw = Math.max(0, Number(nextAtMs) - Number(nowMs));
	if (!Number.isFinite(raw)) return 0;
	return Math.min(raw, Math.max(1, Math.min(maxChunkMs, MAX_TIMEOUT_MS)));
}

// ---------------------------------------------------------------------------
// 持久记录
// ---------------------------------------------------------------------------

/** 落盘的一条持久定时声明（fn 不落盘，activate 重建时重给）。 */
export interface PersistentScheduleRecord {
	/** 原始声明：毫秒数字符串或 5 字段 cron。 */
	spec: string;
	catchUp: "skip" | "once";
	label?: string;
	lastRun?: number;
	createdAt: number;
}

export function scheduleFile(pluginDir: string): string {
	return join(pluginDir, "schedules.json");
}

/** 读持久记录；坏文件/形状不对当空表（且不在读路径回写）。 */
export function loadScheduleRecords(pluginDir: string): Record<string, PersistentScheduleRecord> {
	try {
		const parsed = JSON.parse(readFileSync(scheduleFile(pluginDir), "utf8")) as {
			v?: unknown;
			schedules?: unknown;
		};
		if (!parsed || typeof parsed !== "object" || parsed.schedules === null || typeof parsed.schedules !== "object") {
			return {};
		}
		const out: Record<string, PersistentScheduleRecord> = {};
		for (const [id, r] of Object.entries(parsed.schedules as Record<string, unknown>)) {
			if (!r || typeof r !== "object") continue;
			const rec = r as Record<string, unknown>;
			if (typeof rec.spec !== "string" || !rec.spec) continue;
			out[id] = {
				spec: rec.spec,
				catchUp: rec.catchUp === "once" ? "once" : "skip",
				...(typeof rec.label === "string" && rec.label ? { label: rec.label } : {}),
				...(typeof rec.lastRun === "number" && Number.isFinite(rec.lastRun) ? { lastRun: rec.lastRun } : {}),
				createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
			};
		}
		return out;
	} catch {
		return {};
	}
}

/** 写持久记录（tmp+rename 原子写；失败只记日志，内存态本次会话仍生效）。 */
export function saveScheduleRecords(pluginDir: string, records: Record<string, PersistentScheduleRecord>): void {
	try {
		mkdirSync(pluginDir, { recursive: true });
		const file = scheduleFile(pluginDir);
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ v: 1, schedules: records }));
		renameSync(tmp, file);
	} catch (err) {
		console.error(`[plugin-schedule] persist failed (${pluginDir}):`, err);
	}
}
