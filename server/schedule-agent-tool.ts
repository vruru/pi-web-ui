// ---------------------------------------------------------------------------
// schedule-agent-tool.ts — 把内置调度器暴露给 Agent（issue #193）
// ---------------------------------------------------------------------------
// 背景：pi-web-ui 早有完整调度基建（SchedulerStore：cron/间隔触发＋持久化＋
// 无头执行，见 scheduler-tasks.ts），但只停留在插件 API 与图形面板层面 ——
// AI 被用户要求“每小时检查一次”“半小时后提醒我”时手里没有工具，只能用
// sleep 死循环假装答应（休眠的会话根本推不回消息）。
//
// 本文件注册三个标准 pi 引擎 customTool（DSH 引擎无 customTool 注册面，不接）：
//   schedule_task   → 建任务（默认绑定发起对话＋单次，用熟即删）；
//   schedule_list   → 看全部任务（含下次触发/上次结果）；
//   schedule_cancel → 按 id 删任务。
// 到期执行走 index.ts 的 executor：目标对话还在 → steer 语义唤醒它（不切用户
// 当前对话）；不在了（关闭/重启）→ 回落原有无头执行；单次任务触发后自动删除。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
// 返回文本按 lang 取 pick(lang, zh, en, key, vars)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SCHEDULE_CANCEL_TOOL_NAME, SCHEDULE_LIST_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME } from "./tool-manager.js";
import {
	computeNextFire,
	describeIntervalMs,
	SCHEDULER_MIN_INTERVAL_MS,
	type SchedulerStore,
	type SchedulerTaskView,
} from "./scheduler-tasks.js";
import { parseCronSpec } from "./plugin-schedule.js";

/** 由 ClientSession 实现的数据宿主（store 全局单例在 index.ts，cwd/对话取 live 值）。 */
export interface ScheduleToolHost {
	/** 调度存储（未接入的引擎回 undefined，工具直接报错）。 */
	store: () => SchedulerStore | undefined;
	/** 任务执行目标项目（创建时刻的当前 cwd，之后切项目不影响已建任务）。 */
	cwd: () => string;
	/** 当前活动对话 id（owner 缺席时的回落；可能为空串 = 无头）。 */
	activeConversationId: () => string;
	/** 指定对话的稳定绑定（cwd + 落盘会话文件，供触发时重绑定认领）。
	 *  可选 —— 老宿主没实现时回落 cwd()/空 sessionFile（行为与原来一致）。
	 *  不传 id = 取当前活动对话的信息。 */
	conversationInfo?: (id?: string) => { cwd: string; sessionFile: string } | undefined;
}

/** schedule 参数归一化结果（cron 原样单空格；interval 为毫秒整数字符串）。 */
export interface ParsedSchedule {
	kind: "cron" | "interval";
	spec: string;
}

/** 用户写法 → 调度规格。纯函数，可单测。
 *  收：5 字段 cron（"0 * * * *"）、相对时间（"in 30m" / "in 1h" / "in 2d"）、
 *  裸时长（"30m" / "1h"，裸数字按分钟）。单位 s/m/h/d/w（大小写不敏感）。 */
export function parseScheduleSpec(raw: unknown): ParsedSchedule {
	const s = String(raw ?? "").trim();
	if (!s) throw new Error("empty");
	const single = s.replace(/\s+/g, " ");
	// 5 字段即按 cron 试（"in 30m"是 2 段，不会误判）。
	if (single.split(" ").length === 5 && parseCronSpec(single)) {
		return { kind: "cron", spec: single };
	}
	const m =
		/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days|w|week|weeks)?$/i.exec(
			single,
		);
	if (!m) {
		throw new Error(
			`无法解析的时间写法：${s}（要 5 字段 cron 如 "0 * * * *"，或相对时间如 "in 30m" / "in 1h" / "30m"）`,
		);
	}
	const n = Number(m[1]);
	const unit = (m[2] ?? "m").toLowerCase();
	const mult = unit.startsWith("s")
		? 1000
		: unit.startsWith("m")
			? 60_000
			: unit.startsWith("h")
				? 3_600_000
				: unit.startsWith("d")
					? 86_400_000
					: 7 * 86_400_000; // w
	const ms = Math.floor(n * mult);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`时长非法：${s}`);
	return { kind: "interval", spec: String(ms) };
}

function fmtTime(ms: number | null, lang: ServerLang): string {
	if (ms === null || !Number.isFinite(ms)) return lang === "zh" ? "（未知）" : "(unknown)";
	try {
		return new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false });
	} catch {
		return new Date(ms).toISOString();
	}
}

/** 任务一行摘要（列表用；cron 显示原样，interval 中文用“每 X”，英文用秒数）。 */
function taskLine(t: SchedulerTaskView, lang: ServerLang): string {
	const when =
		t.kind === "cron"
			? `cron ${t.spec}`
			: lang === "zh"
				? describeIntervalMs(Number(t.spec))
				: `every ${Math.round(Number(t.spec) / 1000)}s`;
	const state = !t.enabled
		? lang === "zh"
			? "已暂停"
			: "paused"
		: t.running
			? lang === "zh"
				? "执行中"
				: "running"
			: lang === "zh"
				? "启用"
				: "on";
	const once = t.oneShot ? (lang === "zh" ? " · 单次" : " · one-shot") : "";
	const target = t.conversationId
		? lang === "zh"
			? ` · 汇报→对话${t.conversationId}`
			: ` · reports→${t.conversationId}`
		: lang === "zh"
			? " · 无头执行"
			: " · headless";
	const last = t.lastRun
		? lang === "zh"
			? ` · 上次${t.lastRun.ok ? "成功" : `失败（${t.lastRun.error ?? "未知错误"}）`}`
			: ` · last ${t.lastRun.ok ? "ok" : `failed (${t.lastRun.error ?? "unknown"})`}`
		: "";
	return `• ${t.id} · ${t.name} · ${when} · ${state}${once}${target} · ${lang === "zh" ? "下次" : "next"} ${fmtTime(t.nextFire, lang)}${last}`;
}

export function makeScheduleTools(
	host: ScheduleToolHost,
	ownerConversationId?: string,
	lang?: () => ServerLang,
): ToolDefinition[] {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	const noStore = () =>
		text(
			pick(
				getLang(),
				"当前引擎不支持定时任务（调度存储未接入）。",
				"Scheduled tasks are not wired for the current engine.",
				"sched.not.wired",
			),
		);

	const taskTool = defineTool({
		name: SCHEDULE_TASK_TOOL_NAME,
		label: "Schedule a wake-up in this conversation",
		description:
			"Create a scheduled wake-up in the CURRENT conversation: at the cron time or after the delay, your prompt is delivered back into this conversation so you continue and report. " +
			"Use for periodic checks, delayed reminders, scheduled summaries — never sleep loops (they cannot push messages back). " +
			'schedule: 5-field cron ("0 * * * *" hourly) or delay ("in 30m"); minimum 60s. One-shot by default; recurring=true repeats. ' +
			"Re-binds to the same session after compaction/restart; if the conversation is gone it falls back to the project's active conversation (visibly reported), headless only when none exists. " +
			"Manage with schedule_list / schedule_cancel.",
		promptSnippet: "schedule a wake-up in this conversation (cron or delay), auto-report on fire",
		parameters: Type.Object({
			schedule: Type.String({
				description:
					'When to fire: 5-field cron ("0 * * * *" hourly) or relative delay ("in 30m", "in 1h", "30m"). Minimum 60s.',
			}),
			prompt: Type.String({
				description:
					"Instruction delivered into this conversation on fire (e.g. what to check and report). Max 8000 chars.",
			}),
			label: Type.Optional(
				Type.String({ description: "Short name shown in the background-tasks panel. Defaults to the prompt head." }),
			),
			recurring: Type.Optional(
				Type.Boolean({ description: "Repeat on schedule (default false = one-shot, auto-deleted after firing)." }),
			),
		}),
		execute: async (_id, p) => {
			const store = host.store();
			if (!store) return noStore();
			let parsed: ParsedSchedule;
			try {
				parsed = parseScheduleSpec(p.schedule);
			} catch (err) {
				return text(
					pick(
						getLang(),
						`时间写法非法：${String(p.schedule ?? "")}（要 5 字段 cron 如 "0 * * * *" 或相对时间如 "in 30m"）：${(err as Error).message}`,
						`Invalid schedule: ${String(p.schedule ?? "")} (want 5-field cron like "0 * * * *" or a delay like "in 30m"): ${(err as Error).message}`,
						"sched.task.bad.schedule",
						{ schedule: String(p.schedule ?? "") },
					),
				);
			}
			if (parsed.kind === "interval" && Number(parsed.spec) < SCHEDULER_MIN_INTERVAL_MS) {
				return text(
					pick(
						getLang(),
						`间隔太短（最短 60s，防 token 烧穿）。`,
						`Interval too short (minimum 60s, prevents token burn).`,
						"sched.task.interval.too.short",
					),
				);
			}
			const prompt = String(p.prompt ?? "").trim();
			if (!prompt) {
				return text(
					pick(
						getLang(),
						"触发指令（prompt）不能为空：写清楚触发时要检查什么、汇报什么。",
						"Prompt must not be empty: say what to check and report on fire.",
						"sched.task.empty.prompt",
					),
				);
			}
			const cwd = String(host.cwd() ?? "").trim();
			if (!cwd) {
				return text(
					pick(
						getLang(),
						"当前没有工作目录，无法创建定时任务。",
						"No working directory, cannot create the scheduled task.",
						"sched.task.no.cwd",
					),
				);
			}
			const labelRaw = typeof p.label === "string" ? p.label.trim().slice(0, 80) : "";
			const name = labelRaw || prompt.split("\n")[0]!.slice(0, 40) || "定时任务";
			const convId = (ownerConversationId ?? "").trim() || String(host.activeConversationId() ?? "").trim();
			// 稳定绑定（issue #231）：owner 对话的落盘会话文件 —— 压缩/重启后靠它重认同一会话，
			// 内存对话 id（c1/c2…）只做首选唤醒键。宿主没实现 conversationInfo 时按原来只绑 id。
			let bindCwd = cwd;
			let bindSessionFile = "";
			try {
				const info = host.conversationInfo?.((ownerConversationId ?? "").trim() || convId || undefined);
				if (info) {
					if (String(info.cwd ?? "").trim()) bindCwd = String(info.cwd).trim();
					bindSessionFile = String(info.sessionFile ?? "")
						.trim()
						.slice(0, 1024);
				}
			} catch {
				/* 绑定快照尽力而为：拿不到稳定键就按原来的 id 绑定触发 */
			}
			const recurring = p.recurring === true;
			let task;
			try {
				task = store.upsert({
					name,
					cwd: bindCwd,
					kind: parsed.kind,
					spec: parsed.spec,
					prompt,
					conversationId: convId,
					sessionFile: bindSessionFile,
					oneShot: !recurring,
				});
			} catch (err) {
				return text(String((err as Error)?.message ?? err));
			}
			const L = getLang();
			const next = computeNextFire(task, Date.now());
			const head =
				L === "zh" ? `定时任务已创建：${task.id}（${task.name}）` : `Scheduled task created: ${task.id} (${task.name})`;
			const whenLine =
				L === "zh"
					? `触发：${parsed.kind === "cron" ? `cron ${parsed.spec}` : describeIntervalMs(Number(parsed.spec))}，下次 ${fmtTime(next, L)}${recurring ? "（周期）" : "（单次，触发后自动删除）"}`
					: `Fires: ${parsed.kind === "cron" ? `cron ${parsed.spec}` : `every ${Math.round(Number(parsed.spec) / 1000)}s`}, next ${fmtTime(next, L)}${recurring ? " (recurring)" : " (one-shot, auto-deleted after firing)"}`;
			const targetLine = convId
				? L === "zh"
					? `汇报：触发时自动唤醒本对话（${convId}）；压缩/重启后按会话文件自动重绑，原对话不在时先回落同项目活跃对话（明确提示），无存活对话才无头执行。`
					: `Reports: wakes this conversation (${convId}) on fire; re-binds by session file after compaction/restart, falls back to the project's active conversation (with a visible note), headless only with no live conversation.`
				: L === "zh"
					? "汇报：无头执行，报告进调度面板历史（创建时没拿到对话 id）。"
					: "Reports: headless run, report in panel history (no conversation id captured at creation).";
			const tail =
				L === "zh"
					? `取消：schedule_cancel(id="${task.id}")，或后台任务面板手动取消；查看：schedule_list。`
					: `Cancel: schedule_cancel(id="${task.id}"), or from the background-tasks panel; inspect: schedule_list.`;
			return text(`${head}\n${whenLine}\n${targetLine}\n${tail}`, { task });
		},
	});

	const listTool = defineTool({
		name: SCHEDULE_LIST_TOOL_NAME,
		label: "List scheduled tasks",
		description:
			"List all built-in scheduled tasks (all projects): " +
			"id, name, cron/interval, on/paused, one-shot, target conversation, next fire, last run. " +
			"Use it to inspect before cancelling, or to answer the user about what is scheduled.",
		promptSnippet: "list scheduled wake-up tasks",
		parameters: Type.Object({}),
		execute: async () => {
			const store = host.store();
			if (!store) return noStore();
			const L = getLang();
			const tasks = store.list();
			if (tasks.length === 0) {
				return text(
					pick(
						getLang(),
						"当前没有定时任务。用 schedule_task 创建（cron 或 in 30m 这类延迟，最短 60s）。",
						"No scheduled tasks. Create one with schedule_task (cron or a delay like in 30m, minimum 60s).",
						"sched.list.empty",
					),
					{ tasks: [] },
				);
			}
			const lines = tasks.slice(0, 50).map((t) => taskLine(t, L));
			const more =
				tasks.length > 50
					? L === "zh"
						? `\n…还有 ${tasks.length - 50} 条没列（去后台任务面板看全量）。`
						: `\n…${tasks.length - 50} more not shown (see the background-tasks panel).`
					: "";
			const head = L === "zh" ? `定时任务（${tasks.length}）：` : `Scheduled tasks (${tasks.length}):`;
			return text(`${head}\n${lines.join("\n")}${more}`, { tasks });
		},
	});

	const cancelTool = defineTool({
		name: SCHEDULE_CANCEL_TOOL_NAME,
		label: "Cancel a scheduled task",
		description:
			"Delete a scheduled task by id (see schedule_list). " +
			"Deleting stops all future fires; use it when the user says the schedule is no longer needed.",
		promptSnippet: "cancel a scheduled task by id",
		parameters: Type.Object({
			id: Type.String({ description: "Task id from schedule_list." }),
		}),
		execute: async (_id, p) => {
			const store = host.store();
			if (!store) return noStore();
			const id = String(p.id ?? "").trim();
			if (!id) {
				return text(
					pick(
						getLang(),
						"要删哪个任务？给 id（先 schedule_list 查）。",
						"Which task? Give its id (see schedule_list first).",
						"sched.cancel.empty.id",
					),
				);
			}
			if (!store.remove(id)) {
				return text(
					pick(
						getLang(),
						`没有 id=${id} 的任务（可能已触发自删或被删过，用 schedule_list 看现有的）。`,
						`No task id=${id} (may have fired-and-deleted or been removed; see schedule_list).`,
						"sched.cancel.not.found",
						{ id },
					),
				);
			}
			return text(
				pick(
					getLang(),
					`定时任务 ${id} 已删除，不再触发。`,
					`Scheduled task ${id} deleted, will not fire again.`,
					"sched.cancel.ok",
					{ id },
				),
				{ id },
			);
		},
	});

	return [taskTool, listTool, cancelTool];
}
