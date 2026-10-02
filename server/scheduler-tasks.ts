/**
 * 内置定时任务调度（issue #184）。
 *
 * 面向普通用户的图形化调度器：任务 CRUD + cron/间隔触发 + 无头执行 +
 * 执行历史 + 通知。底层 cron 解析复用 plugin-schedule.ts（parseCronSpec /
 * nextCronFire），持久化走 <dataDir>/scheduler-tasks.json（全局共享，
 * 与 client-state.json 同级），执行经调用方注入的 executor（index.ts 接
 * AgentService.chatFromScheduler，无头伪客户端）。
 *
 * 定时策略：单个 10s ticker 检查到期任务（cron 下次触发 / 间隔毫秒），
 * running 集合防重叠；catchUp "once" 在启动时补跑一次漏掉的触发。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextCronFire, parseCronSpec } from "./plugin-schedule.js";

export type SchedulerKind = "cron" | "interval";
export type SchedulerCatchUp = "skip" | "once";

export interface SchedulerTaskInput {
	id?: string;
	name?: string;
	description?: string;
	cwd?: string;
	kind?: SchedulerKind;
	/** cron: 5 字段表达式；interval: 毫秒整数（字符串或数字）。 */
	spec?: string | number;
	prompt?: string;
	enabled?: boolean;
	/** 可选 "provider/id"，空 = 跟随默认。 */
	model?: string;
	thinkingLevel?: string;
	catchUp?: SchedulerCatchUp;
	/** 发起对话 id（Agent 工具创建时填）：触发时优先唤醒它，找不到再无头执行。空 = 无头。
	 *  注意：它是各客户端内存计数器（c1/c2…），重启/切走释放后即失效 ——
	 *  持久化只靠它认对话必然在压缩/重启后误判 closed/gone（issue #231），
	 *  必须配合下面的 sessionFile（落盘会话路径，压缩/重启后稳定）做二次确认。 */
	conversationId?: string;
	/** 发起对话的落盘会话文件（Agent 工具创建时快照，压缩/重启后依然稳定）。 */
	sessionFile?: string;
	/** 单次任务：触发执行一次后自动删除（Agent 工具 recurring=false 时置 true）。 */
	oneShot?: boolean;
}

export interface SchedulerTask {
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: SchedulerKind;
	/** 归一化：cron 原样（单空格），interval 为毫秒整数字符串。 */
	spec: string;
	prompt: string;
	enabled: boolean;
	model: string;
	thinkingLevel: string;
	catchUp: SchedulerCatchUp;
	/** 发起对话 id（空 = 无头执行）。
	 *  易失的内存 id（c1/c2…，各客户端从 0 计数）：只做首选唤醒键，绝不能单独
	 *  作为跨重启的身份依据（issue #231）。跨重启/防串台的稳定键是 sessionFile。 */
	conversationId: string;
	/** 发起对话的落盘会话文件（Agent 工具创建时快照，压缩/重启后依然稳定）。
	 *  触发时优先按它找持有方（同一文件的对话 id 可能已变 —— 自动重绑定到新 id）；
	 *  空 = 创建时没拿到（面板任务/老任务），按原逻辑只认 conversationId。 */
	sessionFile: string;
	/** 单次任务：触发执行一次后自动删除。 */
	oneShot: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface SchedulerRunRecord {
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
	error?: string;
	/** 手动触发（面板 Run Now）还是定时触发。 */
	manual?: boolean;
}

export interface SchedulerTaskView extends SchedulerTask {
	nextFire: number | null;
	lastRun: SchedulerRunRecord | null;
	history: SchedulerRunRecord[];
	running: boolean;
}

export interface SchedulerExecutorResult {
	ok: boolean;
	conversationId?: string;
	error?: string;
}

export type SchedulerExecutor = (task: SchedulerTask) => Promise<SchedulerExecutorResult>;

export const SCHEDULER_FILE = "scheduler-tasks.json";
/** 持久间隔底线 60s（与 host.schedule 持久任务同口径，防 token 烧穿）。 */
export const SCHEDULER_MIN_INTERVAL_MS = 60_000;
export const SCHEDULER_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
export const SCHEDULER_HISTORY_MAX = 20;
const TICK_MS = 10_000;

export const SCHEDULER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function schedulerFile(dataDir: string): string {
	return join(dataDir, SCHEDULER_FILE);
}

function randomTaskId(): string {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
	return `task-${s}`;
}

/** 归一化 + 校验用户输入；非法抛 Error（中文信息，直接面向 UI）。纯函数，可单测。 */
export function normalizeSchedulerInput(input: SchedulerTaskInput, now = Date.now()): SchedulerTask {
	const idRaw = String(input.id ?? "").trim();
	const id = idRaw || randomTaskId();
	if (!SCHEDULER_ID_RE.test(id)) throw new Error("任务 id 非法（只收字母/数字/下划线/连字符，≤64 字）");
	const name = String(input.name ?? "")
		.trim()
		.slice(0, 80);
	if (!name) throw new Error("任务名称不能为空");
	const description = String(input.description ?? "")
		.trim()
		.slice(0, 500);
	const cwd = String(input.cwd ?? "").trim();
	if (!cwd) throw new Error("执行目标项目（cwd）不能为空");
	const kind: SchedulerKind = input.kind === "interval" ? "interval" : "cron";
	let spec: string;
	if (kind === "cron") {
		spec = String(input.spec ?? "")
			.trim()
			.replace(/\s+/g, " ");
		if (!parseCronSpec(spec)) throw new Error("cron 表达式非法（要 5 字段：分 时 日 月 周，如 0 9 * * *）");
	} else {
		const ms = Math.floor(Number(input.spec));
		if (!Number.isFinite(ms) || ms <= 0) throw new Error("间隔毫秒数非法");
		if (ms < SCHEDULER_MIN_INTERVAL_MS)
			throw new Error(`间隔太短（最短 ${SCHEDULER_MIN_INTERVAL_MS / 1000}s，防 token 烧穿）`);
		if (ms > SCHEDULER_MAX_INTERVAL_MS) throw new Error("间隔太长（最长 30 天）");
		spec = String(ms);
	}
	const prompt = String(input.prompt ?? "").trim();
	if (!prompt) throw new Error("触发指令（prompt）不能为空");
	if (prompt.length > 8000) throw new Error("触发指令超长（>8000 字），请裁剪后重试");
	const model = String(input.model ?? "").trim();
	if (model && !model.includes("/")) throw new Error("模型格式非法（应为 provider/id）");
	const thinkingLevel = String(input.thinkingLevel ?? "").trim();
	const catchUp: SchedulerCatchUp = input.catchUp === "once" ? "once" : "skip";
	const conversationId = String(input.conversationId ?? "")
		.trim()
		.slice(0, 128);
	// 落盘会话文件：稳定身份键（issue #231）。只做归一化（去首尾空白、封顶），
	// 不校验存在性 —— 创建时刻文件可能还没落盘，触发时按它匹配不上即回落。
	const sessionFile = String(input.sessionFile ?? "")
		.trim()
		.slice(0, 1024);
	return {
		id,
		name,
		description,
		cwd,
		kind,
		spec,
		prompt,
		enabled: input.enabled !== false,
		model,
		thinkingLevel,
		catchUp,
		conversationId,
		sessionFile,
		oneShot: input.oneShot === true,
		createdAt: now,
		updatedAt: now,
	};
}

/** 下次触发毫秒时间戳；非法/禁用回 null。纯函数，可单测。 */
export function computeNextFire(task: Pick<SchedulerTask, "kind" | "spec">, fromMs: number): number | null {
	try {
		if (task.kind === "cron") {
			const parts = parseCronSpec(task.spec);
			if (!parts) return null;
			return nextCronFire(parts, fromMs);
		}
		const ms = Math.floor(Number(task.spec));
		if (!Number.isFinite(ms) || ms <= 0) return null;
		return Math.floor(Number(fromMs)) + ms;
	} catch {
		return null;
	}
}

/** 间隔任务的人类可读描述（面板显示用）。纯函数。 */
export function describeIntervalMs(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `每 ${s} 秒`;
	if (s < 3600) {
		const m = Math.floor(s / 60);
		return s % 60 === 0 ? `每 ${m} 分钟` : `每 ${m} 分 ${s % 60} 秒`;
	}
	if (s < 86400) {
		const h = Math.floor(s / 3600);
		return s % 3600 === 0 ? `每 ${h} 小时` : `每 ${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
	}
	const d = Math.floor(s / 86400);
	return `每 ${d} 天`;
}

interface StoredTask extends SchedulerTask {
	history?: SchedulerRunRecord[];
}

function sanitizeHistory(v: unknown): SchedulerRunRecord[] {
	if (!Array.isArray(v)) return [];
	const out: SchedulerRunRecord[] = [];
	for (const r of v) {
		if (!r || typeof r !== "object") continue;
		const rec = r as Record<string, unknown>;
		if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) continue;
		out.push({
			at: rec.at,
			ok: rec.ok === true,
			durationMs: typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) ? rec.durationMs : 0,
			...(typeof rec.conversationId === "string" && rec.conversationId ? { conversationId: rec.conversationId } : {}),
			...(typeof rec.error === "string" && rec.error ? { error: rec.error.slice(0, 500) } : {}),
			...(rec.manual === true ? { manual: true as const } : {}),
		});
	}
	return out.sort((a, b) => b.at - a.at).slice(0, SCHEDULER_HISTORY_MAX);
}

/** 落盘会话路径是否指向同一会话（纯函数，可单测）。
 *  Windows 上 `C:\a\b` 与 `C:/a/b`、尾部分隔符差异都算同一文件；
 *  空串永不相等（没拿到稳定键的任务不配对）。 */
export function sameSessionFile(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(x) === norm(y);
}

export class SchedulerStore {
	private tasks = new Map<string, StoredTask>();
	private nextFire = new Map<string, number>();
	private running = new Set<string>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	constructor(
		private readonly dataDir: string,
		private readonly opts: {
			executor?: SchedulerExecutor;
			onChange?: () => void;
			notify?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			onTaskRemoved?: (taskId: string) => void;
		} = {},
	) {}

	setExecutor(executor: SchedulerExecutor): void {
		this.opts.executor = executor;
	}

	/** 启动 ticker + catchUp 补跑（幂等）。 */
	start(): void {
		this.load();
		if (this.started) return;
		this.started = true;
		const now = Date.now();
		for (const task of this.tasks.values()) {
			if (!task.enabled) continue;
			const lastAt = task.history?.[0]?.at ?? task.updatedAt;
			const next = computeNextFire(task, Math.max(lastAt, task.updatedAt));
			if (next === null) continue;
			if (next <= now && task.catchUp === "once" && lastAt < now) {
				// 重启发现漏跑：补一次，补完按这次重排。
				this.nextFire.set(task.id, now + 5000);
				void this.fire(task.id, false);
			} else if (next <= now) {
				this.nextFire.set(task.id, computeNextFire(task, now) ?? now + TICK_MS);
			} else {
				this.nextFire.set(task.id, next);
			}
		}
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.started = false;
	}

	/** 读盘；坏文件/形状不对当空表（读路径不回写）。 */
	load(): void {
		try {
			const parsed = JSON.parse(readFileSync(schedulerFile(this.dataDir), "utf8")) as {
				v?: unknown;
				tasks?: unknown;
			};
			if (!parsed || typeof parsed !== "object" || !parsed.tasks || typeof parsed.tasks !== "object") {
				this.tasks = new Map();
				return;
			}
			const next = new Map<string, StoredTask>();
			for (const [id, raw] of Object.entries(parsed.tasks as Record<string, unknown>)) {
				if (!raw || typeof raw !== "object") continue;
				const r = raw as Record<string, unknown>;
				try {
					const task = normalizeSchedulerInput({
						id,
						name: r.name as string,
						description: r.description as string,
						cwd: r.cwd as string,
						kind: r.kind as SchedulerKind,
						spec: r.spec as string,
						prompt: r.prompt as string,
						enabled: r.enabled as boolean,
						model: r.model as string,
						thinkingLevel: r.thinkingLevel as string,
						catchUp: r.catchUp as SchedulerCatchUp,
						conversationId: r.conversationId as string,
						sessionFile: (r as { sessionFile?: unknown }).sessionFile as string,
						oneShot: r.oneShot as boolean,
					});
					task.createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
					task.updatedAt =
						typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : task.createdAt;
					next.set(id, { ...task, history: sanitizeHistory(r.history) });
				} catch {
					// 单条坏记录跳过，不影响其他任务
				}
			}
			this.tasks = next;
		} catch {
			this.tasks = new Map();
		}
	}

	private save(): void {
		try {
			mkdirSync(this.dataDir, { recursive: true });
			const file = schedulerFile(this.dataDir);
			const tmp = `${file}.tmp-${process.pid}`;
			const tasks: Record<string, StoredTask> = {};
			for (const [id, t] of this.tasks) tasks[id] = t;
			writeFileSync(tmp, JSON.stringify({ v: 1, tasks }));
			renameSync(tmp, file);
		} catch (err) {
			console.error("[scheduler] persist failed:", err);
		}
	}

	private changed(): void {
		try {
			this.opts.onChange?.();
		} catch {
			/* 推送失败不影响调度 */
		}
	}

	list(): SchedulerTaskView[] {
		const now = Date.now();
		return [...this.tasks.values()]
			.map((t) => {
				const history = sanitizeHistory(t.history);
				return {
					id: t.id,
					name: t.name,
					description: t.description,
					cwd: t.cwd,
					kind: t.kind,
					spec: t.spec,
					prompt: t.prompt,
					enabled: t.enabled,
					model: t.model,
					thinkingLevel: t.thinkingLevel,
					catchUp: t.catchUp,
					conversationId: t.conversationId,
					sessionFile: t.sessionFile ?? "",
					oneShot: t.oneShot,
					createdAt: t.createdAt,
					updatedAt: t.updatedAt,
					nextFire: !t.enabled ? null : (this.nextFire.get(t.id) ?? computeNextFire(t, Math.max(now, t.updatedAt))),
					lastRun: history[0] ?? null,
					history,
					running: this.running.has(t.id),
				} satisfies SchedulerTaskView;
			})
			.sort((a, b) => a.name.localeCompare(b.name, "zh"));
	}

	/** 新建或全量更新（同名 id 覆盖）；返回归一化后的任务。
	 *  issue #231：面板编辑不带绑定字段（conversationId/sessionFile 缺席）时保留旧绑定 ——
	 *  否则用户在面板改个名字就会把 AI 任务的会话绑定洗掉，下次触发直接变无头。
	 *  字段显式出现（含空串）仍按全量语义覆盖。 */
	upsert(input: SchedulerTaskInput): SchedulerTask {
		const prev = this.tasks.get(String(input.id ?? "").trim());
		const task = normalizeSchedulerInput(input);
		if (prev) {
			task.createdAt = prev.createdAt;
			task.updatedAt = Date.now();
			if (input.conversationId === undefined && input.sessionFile === undefined) {
				task.conversationId = prev.conversationId;
				task.sessionFile = prev.sessionFile ?? "";
			}
		}
		const history = prev?.history ? sanitizeHistory(prev.history) : [];
		this.tasks.set(task.id, { ...task, history });
		// spec/cwd/开关变了 → 按现在重排下次触发
		this.nextFire.set(task.id, computeNextFire(task, Date.now()) ?? Date.now() + TICK_MS);
		this.save();
		this.changed();
		return task;
	}

	remove(id: string): boolean {
		const ok = this.tasks.delete(id);
		this.nextFire.delete(id);
		if (ok) {
			this.save();
			this.changed();
			try {
				this.opts.onTaskRemoved?.(id);
			} catch {
				/* 回调失败不影响删除 */
			}
		}
		return ok;
	}

	setEnabled(id: string, enabled: boolean): SchedulerTask | null {
		const t = this.tasks.get(id);
		if (!t) return null;
		t.enabled = enabled;
		t.updatedAt = Date.now();
		this.nextFire.set(id, computeNextFire(t, Date.now()) ?? Date.now() + TICK_MS);
		this.save();
		this.changed();
		return t;
	}

	/** 会话重绑定（issue #231）：触发时按稳定键找到了新的对话句柄，把任务的
	 *  投递目标迁移过去（只改 conversationId/sessionFile/updatedAt，不碰下次触发
	 *  与历史）。无变化回 false（调用方免一次落盘+推送）；未知任务回 false。 */
	rebind(id: string, binding: { conversationId?: string; sessionFile?: string }): boolean {
		const t = this.tasks.get(id);
		if (!t) return false;
		let dirty = false;
		if (binding.conversationId !== undefined) {
			const v = String(binding.conversationId ?? "")
				.trim()
				.slice(0, 128);
			if (v !== t.conversationId) {
				t.conversationId = v;
				dirty = true;
			}
		}
		if (binding.sessionFile !== undefined) {
			const v = String(binding.sessionFile ?? "")
				.trim()
				.slice(0, 1024);
			if (v !== (t.sessionFile ?? "")) {
				t.sessionFile = v;
				dirty = true;
			}
		}
		if (!dirty) return false;
		t.updatedAt = Date.now();
		this.save();
		this.changed();
		return true;
	}

	private async tick(): Promise<void> {
		const now = Date.now();
		for (const task of this.tasks.values()) {
			if (!task.enabled || this.running.has(task.id)) continue;
			let next = this.nextFire.get(task.id);
			if (next === undefined) {
				next = computeNextFire(task, Math.max(now, task.updatedAt)) ?? now + TICK_MS;
				this.nextFire.set(task.id, next);
			}
			if (next <= now) await this.fire(task.id, false);
		}
	}

	/** 手动立即执行一次（面板 Run Now；调试用，不扰动下次触发）。 */
	async runNow(id: string): Promise<SchedulerExecutorResult> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: "任务不存在" };
		if (this.running.has(id)) return { ok: false, error: "任务正在执行中" };
		return this.fire(id, true);
	}

	private async fire(id: string, manual: boolean): Promise<SchedulerExecutorResult> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: "任务不存在" };
		const executor = this.opts.executor;
		if (!executor) {
			const err = "调度器执行器未接入（当前引擎不支持定时任务）";
			this.recordRun(id, { at: Date.now(), ok: false, durationMs: 0, error: err, ...(manual ? { manual } : {}) });
			return { ok: false, error: err };
		}
		this.running.add(id);
		this.changed();
		const startedAt = Date.now();
		let result: SchedulerExecutorResult;
		try {
			result = await executor({ ...task });
		} catch (err) {
			result = { ok: false, error: (err as Error).message };
		}
		const durationMs = Date.now() - startedAt;
		this.running.delete(id);
		this.recordRun(id, {
			at: Date.now(),
			ok: result.ok,
			durationMs,
			...(result.conversationId ? { conversationId: result.conversationId } : {}),
			...(result.error ? { error: result.error.slice(0, 500) } : {}),
			...(manual ? { manual } : {}),
		});
		// 按这次完成时间重排下次触发（间隔任务从完成起算，避免长任务连击）。
		const cur = this.tasks.get(id);
		if (cur && cur.enabled && !manual) {
			this.nextFire.set(id, computeNextFire(cur, Date.now()) ?? Date.now() + TICK_MS);
			this.save();
		}
		const label = `⏰ ${task.name}`;
		if (result.ok) {
			this.opts.notify?.(
				"info",
				`定时任务「${task.name}」${manual ? "手动" : "定时"}触发完成（${(durationMs / 1000).toFixed(0)}s）——${label}`,
				`Scheduled task "${task.name}" ${manual ? "manually" : "automatically"} finished (${Math.round(durationMs / 1000)}s) — ${label}`,
			);
		} else {
			this.opts.notify?.(
				"warning",
				`定时任务「${task.name}」${manual ? "手动" : "定时"}触发失败：${result.error ?? "未知错误"}`,
				`Scheduled task "${task.name}" ${manual ? "manual" : "automatic"} run failed: ${result.error ?? "unknown error"}`,
			);
		}
		this.changed();
		return result;
	}

	private recordRun(id: string, run: SchedulerRunRecord): void {
		const t = this.tasks.get(id);
		if (!t) return;
		t.history = [run, ...sanitizeHistory(t.history)].slice(0, SCHEDULER_HISTORY_MAX);
		this.save();
	}
}
