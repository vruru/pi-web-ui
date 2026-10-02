// ---------------------------------------------------------------------------
// subagents.ts — 第一方轻量子代理：工具定义与运行态模型
// ---------------------------------------------------------------------------
// 架构（相对参考项目的大幅简化）：
//
// 参考项目（tintinweb / nicobailon 的 pi-subagents）把子代理做成「完整子会话」
// —— 独立 SessionManager / SettingsManager / 模型 / 工具隔离 / resume /
// steer / 并发池 / 工作区隔离，复杂度来自「要独立支撑一个完整会话」。
//
// pi-web-ui 的 ClientSession 天生就是多会话并发的：一个 conversation 就有
// 一个独立 AgentSessionRuntime + TerminalManager，所有 conversation 共享
// 同一个 modelRuntime，创建走 createAgentSessionServices + FromServices（已
// 封装好）。因此本模块把子代理定义为：
//
//   子代理 = 一个标记了 isSubagent 的普通 Conversation（inMemory session，
//   不落盘、不进历史/resume 列表）
//   - 出现在左栏「运行的对话」列表，带「子代理」徽标
//   - 用户可以像普通对话一样：点开查看实时消息流、输入补充（= steer）、
//     中止（= abort）、完成后移出（= dismiss）
//   - 运行态经现有快照/消息管线推送，不需要单独的可视化桥
//
// 本文件只定义：运行态快照类型、host 接口（由 ClientSession 实现，操作的是
// 它的 conversation 体系）、以及注册给每个会话的 subagent_* 工具。真正创建
// conversation / 跑 prompt 全部在 agent-service.ts 的 spawnSubagent 里完成。
//
// 返回文本按 lang 取 pick(lang, zh, en)。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SUBAGENT_COEXIST_TOOL_NAME, isSubagentToolName } from "./tool-manager.js";

export { SUBAGENT_COEXIST_TOOL_NAME, isSubagentToolName };

/** 子代理的状态（由 conversation 派生的轻量视图）。 */
export type SubagentState = "running" | "queued" | "done" | "canceled";

/**
 * subagent_wait_all 的最长阻塞时间：必须短暂低于工具看门狗（默认 20 分钟，
 * PI_WEB_TOOL_TIMEOUT_MS 可调），否则看门狗会先中止整个会话而不是让 wait
 * 干净地超时返回。取 0.8×看门狗并以 60s 封顶、5s 兜底：看门狗调小（如 <75s）
 * 时 60s 下限会反超看门狗造成本末倒置，此时随看门狗缩短，但不低于 5s。
 */
const WAIT_CAP_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	const watchdog = Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
	return Math.max(Math.min(60_000, Math.floor(watchdog * 0.8)), 5_000);
})();

/** 子代理是否已到终态（运行结束、被中止或出错）。wait 工具据此判断
 * 是否可以取结果；streaming=false 即可（error/canceled 都在快照里带标记）。 */
export function isSubagentTerminal(r: SubagentSnapshot | undefined): boolean {
	return !!r && !r.streaming;
}

/** 单个子代理的运行态快照（供 subagent_list / subagent_get_result 与左栏徽标）。 */
export interface SubagentSnapshot {
	/** conversation id（= 工具的 runId；左栏点击即 switch 到它）。 */
	convId: string;
	/** 展示类型 / 角色（explore / implement / review …，默认 general）。 */
	type: string;
	/** 标题：prompt 首行（截断）。 */
	title: string;
	/** 原始 prompt。 */
	prompt: string;
	state: SubagentState;
	/** 是否正在流式输出。 */
	streaming: boolean;
	/** 最近一次运行是否报错（provider 400/超时等）；有则这里带可读错误文本。 */
	error?: string;
	/** 是否被用户/AI 中止（最后一条 assistant 消息 stopReason=aborted，或中断后
	 *  有输出但未正常结束）。区别于 error：中止不是故障，但不应当作成功结果。 */
	canceled?: boolean;
	/** 会话消息数（近似活动量）。 */
	messageCount: number;
	/** 会话模型 id（可空）。 */
	model?: string;
	/** 已收集的 assistant 最后文本（运行中为最新输出）。 */
	output: string;
	/** 父对话 id（派发者会话；主对话派发时为普通对话 id，子代理嵌套派发时为父子代理 id）。
	 *  wait_all 据此算后代/祖先，避免子代理无参等待把父级圈进来导致父子互等到超时。 */
	parentId?: string;
	/** 是否为持久化会话（落盘到 session 文件，非仅内存会话）。 */
	persisted?: boolean;
	/** 同行协作交接给的目标子代理 convId 列表（该子代理交接给谁）。 */
	handoffTo?: string[];
	/** 同行协作接收自的来源子代理 convId 列表（谁交接给该子代理）。 */
	handoffFrom?: string[];
}

/**
 * 由 ClientSession 实现的子代理操作接口。所有操作都作用于它的
 * conversation 体系（convs.map 里的 isSubagent 对话）。
 */
export interface SubagentToolHost {
	/** 创建子代理 conversation 并触发 prompt。`templateName` 可选：设置面板配置
	 *  的子代理模板（角色 prompt + 技能/扩展白名单 + 可选思考强度）；
	 *  不传 = 按主会话默认配置。`model` 可选："provider/id"，显式指定本次子代理模型
	 *  （仅限用户明确要求）；不传 = 跟随派发者当前模型，无当前模型才用全局默认。思考强度同理：模板自带优先（不传没有单独的
	 *  thinking 参数）→ 不指定则跟随主对话当前强度。
	 *  `parentId` 可选：真正的派发者对话 id（左栏嵌套用）。按会话归属的 host
	 *  包装会自动填入；不传时回退到派发时刻的 active 对话（兼容旧行为）。
	 *  `persist` 可选：是否创建为持久化落盘的普通对话（存入历史，可继续聊）；
	 *  默认 false（轻量内存子代理）。
	 *  模板不存在/已停用时应抛错（工具把错误转给 AI 而不是启动。）。 */
	spawnSubagent(
		prompt: string,
		type: string,
		cwd: string,
		templateName?: string,
		model?: string,
		parentId?: string,
		persist?: boolean,
	): Promise<string>;
	/** 取单个子代理快照（按 convId）。 */
	getSubagent(convId: string): SubagentSnapshot | undefined;
	/** 列出现有的子代理与派生的受控对话（按创建顺序）。scope: all（默认）/ subagent / persistent。 */
	listSubagents(scope?: "all" | "subagent" | "persistent"): SubagentSnapshot[];
	/** 向运行中的子代理注入消息（未在运行的内容直接排队为下一次回合）。 */
	steerSubagent(convId: string, message: string): Promise<void>;
	/** 中止运行中的子代理。 */
	stopSubagent(convId: string): Promise<void>;
	/** 列出可供 AI 选择的子代理模板（名 + 简介 + 模型 + 思考强度）。只含 enabled 的（停用的对 AI 不可见）。 */
	listTemplates(): {
		name: string;
		description: string;
		descriptionEn?: string;
		model?: string;
		thinkingLevel?: string;
	}[];
	/** Confirm terminal results delivered to this caller, suppressing redundant completion wake-ups. */
	acknowledgeSubagentResults?(runIds: string[]): void;
	/** 获取当前生效的工具看门狗超时（毫秒），用于计算 wait_all 的最大等待上限。 */
	getWatchdogTimeoutMs?(): number;
	/** 检查某个模板名是否可用于派生子代理（存在且 enabled）。 */
	isTemplateUsable(name: string): boolean;
	/** 将任务产物或指令从一个子代理直接交接给另一个同行子代理（对等协作路由）。 */
	handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void>;
	/** 可选语言（主会话按客户端 locale 提供 getLang；缺省英文）。 */
	lang?: () => ServerLang;
}

/** 从 prompt 取首行作为标题（截断 40 字符）。 */
export function subagentTitle(prompt: string): string {
	const line = prompt.split("\n")[0]?.trim() ?? "";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * 返回注入 ownerId 的 host 包装：每次 spawn 时自动把 ownerId（真正的派发会话）
 * 作为子代理的 parentId 传给底层 host。
 *
 * 背景（issue #95）：子代理左栏嵌套靠 parentId，而派发方是某个会话的 runtime ——
 * 必须按 runtime 归属记父对话，而不是派发瞬间的 active。后台对话继续产出时用户
 * 可能已切到别的项目，直接读 activeId 会把孩子记到无关会话名下（错组/沉底）。
 * 每个会话创建 runtime 时用本函数包一层，让它的 spawn 天然带自己的会话 id。
 */
export function withSubagentOwner(host: SubagentToolHost, ownerId: string): SubagentToolHost {
	return {
		...host,
		spawnSubagent: (prompt, type, cwd, templateName, model, _parentId, persist) =>
			host.spawnSubagent(prompt, type, cwd, templateName, model, ownerId, persist),
		handoffSubagent: (fromRunId, toRunId, payload) => host.handoffSubagent(fromRunId || ownerId, toRunId, payload),
	};
}

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_ACTIONS = [
	"spawn",
	"get_result",
	"steer",
	"list",
	"stop",
	"wait_all",
	"templates",
	"handoff",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

/**
 * 单 action 子代理总工具（注册进每个会话的 customTools，供主 agent 驱动子代理）。
 * 合并原 subagent_* 8 个工具为一个统一入口，节省会话上下文 token。
 *
 * `selfConvId`（可选）：这套工具所注册进的会话 convId。`wait_all`
 * 永远排除调用者自身——子代理会话上同样注册了该工具，不传 runIds 时
 * 「全部」会含它自己，而它正在执行本工具（streaming=true），不排除就是
 * 自己等自己、永远到超时（self-wait deadlock）。主会话调用时传它自己的
 * 普通对话 id 即可（不在子代理列表里，delete 是 no-op）。
 */
export function makeSubagentTool(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
	/** Registered name; SUBAGENT_COEXIST_TOOL_NAME when an extension owns `subagent`. */
	toolName: string = SUBAGENT_TOOL_NAME,
): ToolDefinition {
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	// Resolved per call: a session's tools outlive conversation switches.
	const callerConvId = (): string | undefined => (typeof selfConvId === "function" ? selfConvId() : selfConvId);
	// Hints in results name the tool; under the coexist name they must point at this tool,
	// not at the extension's `subagent`.
	const named = (t: string): string =>
		toolName === SUBAGENT_TOOL_NAME ? t : t.replaceAll(`${SUBAGENT_TOOL_NAME}(action=`, `${toolName}(action=`);
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: named(t) }],
		details,
	});

	const currentWaitCapMs =
		typeof host.getWatchdogTimeoutMs === "function"
			? Math.max(Math.min(60_000, Math.floor(host.getWatchdogTimeoutMs() * 0.8)), 5_000)
			: WAIT_CAP_MS;
	const capSeconds = Math.floor(currentWaitCapMs / 1000);

	return defineTool({
		name: toolName,
		label: "Subagent manager",
		description:
			"Manage background subagents (parallel delegation, research, execution). Actions:\n" +
			"- `spawn`: start with `prompt` (optional `template`, `type`, `model`, `cwd`, `persist`).\n" +
			"- `get_result`: status/output of `runId`.\n" +
			"- `steer`: send `message` to `runId`.\n" +
			"- `list`: list subagents (optional `kind`).\n" +
			"- `stop`: abort `runId`.\n" +
			"- `wait_all`: wait for completion (optional `runIds`, `timeoutSeconds`).\n" +
			"- `templates`: list templates.\n" +
			"- `handoff`: pass `payload` to `toRunId` (optional `fromRunId`).\n" +
			"Rules: a subagent inherits the caller's model; pass `model` only on explicit user request. " +
			"Max 16 running at once (finished ones do not count). Finished runs wake the caller.",
		promptSnippet: "manage background subagents: spawn, get_result, steer, list, stop, wait_all, templates, handoff",
		parameters: Type.Object({
			action: Type.Unsafe<SubagentAction>({
				type: "string",
				enum: [...SUBAGENT_ACTIONS],
				description: "The subagent action to perform.",
			}),
			prompt: Type.Optional(
				Type.String({
					description: "spawn: instructions for the subagent (goal, constraints, expected output).",
				}),
			),
			runId: Type.Optional(
				Type.String({
					description: "get_result/steer/stop: target subagent conversation ID.",
				}),
			),
			runIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "wait_all: subagent conversation IDs to wait for (omit for all active).",
				}),
			),
			message: Type.Optional(
				Type.String({
					description: "steer: follow-up instruction to inject into the subagent.",
				}),
			),
			payload: Type.Optional(
				Type.String({
					description: "handoff: artifact, data, or instructions to transfer to peer subagent.",
				}),
			),
			toRunId: Type.Optional(
				Type.String({
					description: "handoff: target peer subagent conversation ID.",
				}),
			),
			fromRunId: Type.Optional(
				Type.String({
					description: "handoff: source subagent ID (defaults to current subagent).",
				}),
			),
			type: Type.Optional(
				Type.String({
					description: "spawn: role/type name (e.g. explore/implement/review, default: general).",
				}),
			),
			template: Type.Optional(
				Type.String({
					description: "spawn: subagent template name (see action=templates).",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'spawn: "provider/id", only when the user explicitly requested this model; otherwise omit to inherit ' +
						"the spawning session model (its global default if unset). Never pick a model yourself based on " +
						"availability, cost, task type, or a template.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "spawn: working directory (defaults to current cwd).",
				}),
			),
			persist: Type.Optional(
				Type.Boolean({
					description: "spawn: persist as a regular session instead of ephemeral subagent.",
				}),
			),
			kind: Type.Optional(
				Type.String({
					enum: ["all", "subagent", "persistent"],
					description: "list: filter subagents by kind (default: all).",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					description: `wait_all: max wait in seconds (1-${capSeconds}, default: ${capSeconds}s).`,
					minimum: 1,
					maximum: capSeconds,
				}),
			),
		}),
		execute: async (_id, p, signal, _onUpdate, ctx) => {
			const action = (p.action ?? "").trim().toLowerCase();
			if (!action) {
				return text(
					pick(
						getLang(),
						"subagent 工具缺少 action 参数（可选：spawn, get_result, steer, list, stop, wait_all, templates, handoff）。",
						"subagent tool requires an action parameter (one of: spawn, get_result, steer, list, stop, wait_all, templates, handoff).",
						"subagents.action.missing",
					),
				);
			}

			switch (action) {
				case "spawn": {
					if (!p.prompt || typeof p.prompt !== "string" || !p.prompt.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="spawn") 缺少 prompt 参数。',
								'subagent(action="spawn") requires prompt parameter.',
								"subagents.spawn.missing.prompt",
							),
						);
					}
					if (p.template && !host.isTemplateUsable(p.template)) {
						return text(
							pick(
								getLang(),
								`子代理模板不可用：${p.template}（不存在或已停用）。用 subagent(action="templates") 查看当前可用模板清单；不传 template 则按默认配置运行。`,
								`Subagent template unavailable: ${p.template} (missing or disabled). Use subagent(action="templates") to list available templates; omit template to run with defaults.`,
								"subagents.spawn.template.unavailable",
								{ "p.template": p.template },
							),
						);
					}
					let convId: string;
					try {
						convId = await host.spawnSubagent(
							p.prompt,
							p.type ?? "general",
							p.cwd ?? ctx.cwd,
							p.template,
							p.model,
							undefined,
							p.persist,
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `子代理启动失败：${msg}`, `Failed to start subagent: ${msg}`, "subagents.spawn.failed", {
								error: msg,
							}),
						);
					}
					const subagentType = p.type ?? "general";
					const subagentTitleText = subagentTitle(p.prompt);
					const templateLineZh = p.template ? `\n模板：${p.template}` : "";
					const templateLineEn = p.template ? `\nTemplate: ${p.template}` : "";
					const modelLineZh = p.model ? `\n模型：${p.model}` : "";
					const modelLineEn = p.model ? `\nModel: ${p.model}` : "";
					const kindLabelZh = p.persist ? "普通持久化对话" : "子代理";
					const kindLabelEn = p.persist ? "Persistent conversation" : "Subagent";
					return text(
						pick(
							getLang(),
							`${kindLabelZh}已启动（运行列表可见）：${convId}\n类型：${subagentType} · 标题：${subagentTitleText}${templateLineZh}${modelLineZh}` +
								`\n用 subagent(action="wait_all") 一次等全部完成（不用轮询），subagent(action="get_result") 取单个结果，subagent(action="list") 看运行态，subagent(action="steer") 改向，subagent(action="stop") 停止。`,
							`${kindLabelEn} started (visible in the running list): ${convId}\nType: ${subagentType} · Title: ${subagentTitleText}${templateLineEn}${modelLineEn}` +
								`\nUse subagent(action="wait_all") to wait for all at once (no polling), subagent(action="get_result") for a single result, subagent(action="list") for live status, subagent(action="steer") to redirect, subagent(action="stop") to stop.`,
							"subagents.spawn.started",
							{
								convId,
								subagentType,
								subagentTitleText,
								"p.template": p.template,
								"p.model": p.model,
								templateLineZh,
								templateLineEn,
								modelLineZh,
								modelLineEn,
							},
						),
						{ convId, template: p.template, model: p.model, persisted: !!p.persist },
					);
				}

				case "get_result": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="get_result") 缺少 runId 参数。',
								'subagent(action="get_result") requires runId parameter.',
								"subagents.get.missing.runId",
							),
						);
					}
					const r = host.getSubagent(p.runId);
					const missingId = shortId(p.runId);
					if (!r)
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingId}（可能已移出）。`,
								`Subagent ${missingId} not found (may have been dismissed).`,
								"subagents.get.not.found",
								{ missingId },
							),
							undefined,
						);
					const verdict = subagentVerdict(r, getLang());
					const doneId = shortId(r.convId);
					const doneDetail = verdictText(r, getLang());
					const doneOutput = r.output || (getLang() === "zh" ? "（无结果）" : "(no result)");
					if (r.streaming || r.state === "running") {
						const runningId = shortId(r.convId);
						const runningOutput = r.output || (getLang() === "zh" ? "（暂无输出）" : "(no output yet)");
						return text(
							pick(
								getLang(),
								`子代理 ${runningId}（${r.type}）仍在运行（状态 ${r.state}）。\n当前输出：\n${runningOutput}`,
								`Subagent ${runningId} (${r.type}) is still running (state ${r.state}).\nCurrent output:\n${runningOutput}`,
								"subagents.get.running",
								{ runningId, "r.type": r.type, "r.state": r.state, runningOutput },
							),
							r,
						);
					}
					if (!signal?.aborted && isSubagentTerminal(r)) host.acknowledgeSubagentResults?.([r.convId]);
					return text(
						pick(
							getLang(),
							`子代理 ${doneId}（${r.type}）状态：${verdict}\n${doneDetail}\n${doneOutput}`,
							`Subagent ${doneId} (${r.type}) status: ${verdict}\n${doneDetail}\n${doneOutput}`,
							"subagents.get.done",
							{ doneId, "r.type": r.type, verdict, doneDetail, doneOutput },
						),
						r,
					);
				}

				case "steer": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 runId 参数。',
								'subagent(action="steer") requires runId parameter.',
								"subagents.steer.missing.runId",
							),
						);
					}
					if (typeof p.message !== "string" || !p.message.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 message 参数。',
								'subagent(action="steer") requires message parameter.',
								"subagents.steer.missing.message",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingSteerId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingSteerId}（可能已移出），消息未注入。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingSteerId} not found (may have been dismissed); message not injected. Use subagent(action="list") to confirm running subagents.`,
								"subagents.steer.not.found",
								{ missingSteerId },
							),
						);
					}
					await host.steerSubagent(p.runId, p.message);
					const steerId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已向子代理 ${steerId} 注入消息。`,
							`Message injected into subagent ${steerId}.`,
							"subagents.steer.injected",
							{ steerId },
						),
					);
				}

				case "list": {
					const list = host.listSubagents(p.kind as "all" | "subagent" | "persistent" | undefined);
					if (list.length === 0)
						return text(
							pick(
								getLang(),
								"当前没有运行中的对话/子代理。",
								"No managed conversations or subagents running.",
								"subagents.list.empty",
							),
						);
					const tLang = getLang();
					const lines = list.map((r) => {
						const tag = r.persisted
							? tLang === "zh"
								? "持久化"
								: "persistent"
							: tLang === "zh"
								? "子代理"
								: "subagent";
						return (
							`- ${r.convId} · ${r.type} · ${subagentVerdict(r, tLang)} · ${r.title}` +
							(tLang === "zh" ? `（${tag} · msg: ${r.messageCount}）` : ` (${tag} · msg: ${r.messageCount})`)
						);
					});
					return text(lines.join("\n"));
				}

				case "stop": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="stop") 缺少 runId 参数。',
								'subagent(action="stop") requires runId parameter.',
								"subagents.stop.missing.runId",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingStopId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingStopId}（可能已移出或已结束），无需停止。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingStopId} not found (may have been dismissed or already finished); nothing to stop. Use subagent(action="list") to confirm running subagents.`,
								"subagents.stop.not.found",
								{ missingStopId },
							),
						);
					}
					await host.stopSubagent(p.runId);
					const stopId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已请求停止子代理 ${stopId}。`,
							`Stop requested for subagent ${stopId}.`,
							"subagents.stop.requested",
							{ stopId },
						),
					);
				}

				case "wait_all": {
					const selfConvId = callerConvId();
					const ancestorIdsOf = (selfId: string): Set<string> => {
						const out = new Set<string>();
						const seen = new Set<string>([selfId]);
						let cur = host.getSubagent(selfId)?.parentId;
						while (cur && !seen.has(cur)) {
							seen.add(cur);
							out.add(cur);
							cur = host.getSubagent(cur)?.parentId;
						}
						return out;
					};
					const expandDescendants = (roots: Set<string> | string[]): string[] => {
						if (roots instanceof Set ? roots.size === 0 : (roots as string[]).length === 0) return [];
						const rootSet = roots instanceof Set ? roots : new Set(roots);
						const all = host.listSubagents();
						const out: string[] = [];
						for (const s of all) {
							if (rootSet.has(s.convId)) continue;
							let curParent = s.parentId;
							const seen = new Set<string>();
							while (curParent) {
								if (rootSet.has(curParent)) {
									out.push(s.convId);
									break;
								}
								if (seen.has(curParent)) break;
								seen.add(curParent);
								curParent = host.getSubagent(curParent)?.parentId;
							}
						}
						return out;
					};

					const explicit = p.runIds && p.runIds.length > 0;
					const wanted = new Set<string>();
					const selfAncestorIds = selfConvId ? ancestorIdsOf(selfConvId) : new Set<string>();

					if (explicit) {
						const seedRoots: string[] = [];
						for (const id of p.runIds!) {
							if (selfConvId && id === selfConvId) continue;
							if (selfAncestorIds.has(id)) continue;
							wanted.add(id);
							seedRoots.push(id);
						}
						for (const descId of expandDescendants(seedRoots)) {
							if (selfConvId && descId === selfConvId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else if (selfConvId) {
						for (const descId of expandDescendants(new Set([selfConvId]))) {
							if (descId === selfConvId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else {
						for (const r of host.listSubagents()) {
							wanted.add(r.convId);
						}
					}
					if (selfConvId) wanted.delete(selfConvId);
					for (const ancId of selfAncestorIds) wanted.delete(ancId);

					if (wanted.size === 0) {
						return text(
							pick(
								getLang(),
								"没有需要等待的子代理（调用者自身与其祖先永不计入等待；子代理无参数调用时只等待属于它自己的后代）。",
								"No subagents to wait for (the calling session itself and its ancestors are never waited on; a subagent without runIds only waits for its own descendants).",
								"subagents.wait.empty",
							),
						);
					}

					const timeoutMs = Math.min(Math.max(p.timeoutSeconds ?? capSeconds, 1), capSeconds) * 1000;
					const startedAt = Date.now();
					const POLL_INTERVAL_MS = 250;

					while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
						for (const descId of expandDescendants(wanted)) {
							if (selfConvId && descId === selfConvId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
						const allDone = Array.from(wanted).every((id) => {
							const r = host.getSubagent(id);
							return isSubagentTerminal(r);
						});
						if (allDone) break;
						await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
					}

					const tLang = getLang();
					const waitedSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
					const timeoutSecs = Math.round(timeoutMs / 1000);
					const deliveredTerminalIds: string[] = [];
					const lines = Array.from(wanted)
						.map((id) => {
							const r = host.getSubagent(id);
							const sId = shortId(id);
							if (!r) {
								return pick(
									tLang,
									`- ${sId}：已移出或不存在`,
									`- ${sId}: dismissed or not found`,
									"subagents.wait.item.missing",
									{ sId },
								);
							}
							if (isSubagentTerminal(r)) deliveredTerminalIds.push(r.convId);
							const verdict = subagentVerdict(r, tLang);
							const detail = verdictText(r, tLang);
							const out = clipSubagentOutput(r.output || (tLang === "zh" ? "（无输出）" : "(no output)"), tLang);
							return `- ${sId}（${r.type} · ${verdict} · ${r.title}）${detail ? ` · ${detail}` : ""}:\n${out}`;
						})
						.join("\n\n");

					const remaining = Array.from(wanted).filter((id) => {
						const r = host.getSubagent(id);
						return !isSubagentTerminal(r);
					});

					const head =
						remaining.length === 0
							? pick(
									tLang,
									`全部 ${wanted.size} 个子代理已收口：`,
									`All ${wanted.size} subagent(s) collected:`,
									"subagents.wait.collected",
									{ "wanted.size": wanted.size },
								)
							: signal?.aborted
								? pick(
										tLang,
										`本轮被中止，${remaining.length} 个仍在运行：`,
										`This round was aborted, ${remaining.length} still running:`,
										"subagents.wait.aborted",
										{ "remaining.length": remaining.length },
									)
								: pick(
										tLang,
										`等待超过 ${timeoutSecs}s 超时（实际等待 ${waitedSecs}s），${remaining.length} 个仍在运行：`,
										`Wait timed out after ${timeoutSecs}s (actually waited ${waitedSecs}s), ${remaining.length} still running:`,
										"subagents.wait.timeout",
										{ timeoutSecs, waitedSecs, "remaining.length": remaining.length },
									);
					if (!signal?.aborted && deliveredTerminalIds.length > 0) {
						host.acknowledgeSubagentResults?.(deliveredTerminalIds);
					}
					return text(`${head}\n${lines}\n` + promptRemaining(remaining, tLang));
				}

				case "templates": {
					const list = host.listTemplates();
					const tLang = getLang();
					if (list.length === 0) {
						return text(
							pick(
								tLang,
								"当前没有可用的子代理模板（设置面板 → 子代理模板 添加后可用）。子代理默认按主会话配置运行。",
								"No subagent templates available (add some under Settings → Subagent Templates). Subagents run with the main session defaults.",
								"subagents.templates.empty",
							),
						);
					}
					const lines = list.map((t) => {
						const desc = tLang === "zh" ? t.description : t.descriptionEn || t.description;
						// Template models never override the spawning session's model (fork policy).
						const modelPart = tLang === "zh" ? "跟随派发者当前模型" : "inherits the spawning session model";
						const thinkingPart =
							tLang === "zh"
								? t.thinkingLevel
									? `思考强度：${t.thinkingLevel}`
									: "跟随主对话思考强度"
								: t.thinkingLevel
									? `thinking: ${t.thinkingLevel}`
									: "follows the main conversation thinking level";
						return (
							(tLang === "zh" ? `- ${t.name}${desc ? `：${desc}` : ""}` : `- ${t.name}${desc ? `: ${desc}` : ""}`) +
							(tLang === "zh" ? `（${modelPart}，${thinkingPart}）` : ` (${modelPart}, ${thinkingPart})`)
						);
					});
					const firstTemplateName = list[0]?.name;
					const templateLines = lines.join("\n");
					return text(
						pick(
							getLang(),
							`可用的子代理模板（subagent 的 template 参数传名字，如 subagent(action="spawn", template="${firstTemplateName}"))：\n${templateLines}`,
							`Available subagent templates (pass the name as subagent's template param, e.g. subagent(action="spawn", template="${firstTemplateName}")):\n${templateLines}`,
							"subagents.templates.list",
							{ firstTemplateName, templateLines },
						),
					);
				}

				case "handoff": {
					const fromId = p.fromRunId || callerConvId() || "unknown";
					if (!p.toRunId || typeof p.toRunId !== "string" || !p.toRunId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 toRunId 参数。',
								'subagent(action="handoff") requires toRunId parameter.',
								"subagents.handoff.missing.toRunId",
							),
						);
					}
					if (typeof p.payload !== "string" || !p.payload.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 payload 参数。',
								'subagent(action="handoff") requires payload parameter.',
								"subagents.handoff.missing.payload",
							),
						);
					}
					if (fromId === p.toRunId) {
						return text(
							pick(
								getLang(),
								`交接失败：不能交接给自身（${shortId(fromId)}）。请指定其他同行子代理。`,
								`Handoff failed: cannot hand off to oneself (${shortId(fromId)}). Please specify a different peer subagent.`,
								"subagents.handoff.self",
								{ id: shortId(fromId) },
							),
						);
					}
					const target = host.getSubagent(p.toRunId);
					if (!target) {
						const missingId = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`未找到目标子代理 ${missingId}（可能已移出或不存在）。请用 subagent(action="list") 确认可用的子代理。`,
								`Target subagent ${missingId} not found (may have been dismissed or non-existent). Use subagent(action="list") to check available subagents.`,
								"subagents.handoff.not.found",
								{ missingId },
							),
						);
					}

					try {
						await host.handoffSubagent(fromId, p.toRunId, p.payload);
						const fromShort = shortId(fromId);
						const toShort = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`已成功将产物交接给同行子代理 ${toShort}（${target.type}），协同路由已建立并开始执行。`,
								`Successfully handed off payload to peer subagent ${toShort} (${target.type}); peer routing established and executing.`,
								"subagents.handoff.success",
								{ from: fromShort, to: toShort, type: target.type },
							),
							{ fromRunId: fromId, toRunId: p.toRunId, timestamp: Date.now() },
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `交接失败：${msg}`, `Handoff failed: ${msg}`, "subagents.handoff.failed", { error: msg }),
						);
					}
				}

				default:
					return text(
						pick(
							getLang(),
							`未知 action：${action}。支持的 action：spawn, get_result, steer, list, stop, wait_all, templates, handoff。`,
							`Unknown action: ${action}. Supported actions: spawn, get_result, steer, list, stop, wait_all, templates, handoff.`,
							"subagents.action.unknown",
							{ action },
						),
					);
			}
		},
	});
}

/**
 * 保持数组签名的子代理工具导出，兼容原有调用点与批处理包装。
 */
export function makeSubagentTools(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
	toolName: string = SUBAGENT_TOOL_NAME,
): ToolDefinition[] {
	return [makeSubagentTool(host, lang, selfConvId, toolName)];
}

/** 短 id 前缀（前端展示/日志用）。 */
function shortId(id: string): string {
	return id.slice(0, 8);
}

/**
 * wait_all 收口时的长输出截断：留头（任务复述）+ 留尾（最终结论），中间折叠。
 * 旧实现只取前 30 行，长输出的子代理结论（一般在尾部）会被丢掉，模型收回一个
 * 没结论的摘要。短输出原样返回。
 */
function clipSubagentOutput(output: string, lang: ServerLang): string {
	const HEAD = 10;
	const TAIL = 30;
	const lines = output.split("\n");
	if (lines.length <= HEAD + TAIL + 5) return output;
	const omitted = lines.length - HEAD - TAIL;
	const marker =
		lang === "zh" ? `… [中间省略 ${omitted} 行，头尾保留] …` : `… [${omitted} lines omitted, head and tail kept] …`;
	return [...lines.slice(0, HEAD), marker, ...lines.slice(-TAIL)].join("\n");
}

/**
 * 收集 root 的传递子代理后代 id（parentId 链向上能走到 root 的；含嵌套的嵌套）。
 * root 自身不含；非子代理对话不含（普通对话不参与子代理清理口径）。
 * parentId 环（理论上不应出现）按 visited 截断，不会死循环。
 * 纯函数：后端 dismiss 流程与单测共用（前端左栏按同样口径镜像实现，见
 * LeftPanel finishedSubagentCount）。
 */
export function collectSubagentDescendantIds(
	items: ReadonlyArray<{ id: string; parentId?: string; isSubagent: boolean }>,
	rootId: string,
): string[] {
	const byId = new Map(items.map((c) => [c.id, c]));
	const out: string[] = [];
	for (const c of items) {
		if (!c.isSubagent || c.id === rootId) continue;
		let cur: { id: string; parentId?: string; isSubagent: boolean } | undefined = c;
		const seen = new Set<string>();
		while (cur?.parentId) {
			if (cur.parentId === rootId) {
				out.push(c.id);
				break;
			}
			if (seen.has(cur.parentId)) break;
			seen.add(cur.parentId);
			cur = byId.get(cur.parentId);
			if (!cur) break;
		}
	}
	return out;
}

/** 人类可读的终态判定：报错 > 中止 > done > running。 */
function subagentVerdict(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error) return pick(lang, "error（报错）", "error", "subagents.verdict.error");
	if (r.canceled) return pick(lang, "canceled（已中止）", "canceled", "subagents.verdict.canceled");
	return r.state;
}

/** 终态的可读说明（错误文本 / 中止说明 / 空）。运行中返回空。 */
function verdictText(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error)
		return pick(lang, `错误：${r.error}`, `Error: ${r.error}`, "subagents.verdict.error.detail", {
			"r.error": r.error,
		});
	if (r.canceled)
		return pick(lang, "（被中止，未产出结论）", "(Aborted, no conclusion produced.)", "subagents.verdict.aborted");
	return "";
}

/** 未完成部分的引导文案。 */
function promptRemaining(remaining: string[], lang: ServerLang = "en"): string {
	if (remaining.length === 0) return "";
	const pendingIds = remaining.map(shortId).join(", ");
	return pick(
		lang,
		`\n未完成：${pendingIds}。可再次调用 subagent_wait_all（或 subagent_steer 补充指令 / subagent_stop 中止）。`,
		`\nPending: ${pendingIds}. You may call subagent_wait_all again (or subagent_steer to add instructions / subagent_stop to abort).`,
		"subagents.wait.pending",
		{ pendingIds: pendingIds },
	);
}
