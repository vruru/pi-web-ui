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
// 双语约定（issue #91）：工具 definition 描述走 bilingual(en, zh) 内联双语
// （英文在前）；per-call 返回文本按 lang 取 pick(lang, zh, en)。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bilingual, pick, type ServerLang } from "./i18n.js";

/** 子代理的状态（由 conversation 派生的轻量视图）。 */
export type SubagentState = "running" | "queued" | "done" | "canceled";

/**
 * subagent_wait_all 的最长阻塞时间：必须短暂低于工具看门狗（默认 20 分钟，
 * PI_WEB_TOOL_TIMEOUT_MS 可调），否则看门狗会先中止整个会话而不是让 wait
 * 干净地超时返回。留 20% 余量。
 */
const WAIT_CAP_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	const watchdog = Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
	return Math.max(60_000, Math.floor(watchdog * 0.8));
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
	/** 获取当前生效的工具看门狗超时（毫秒），用于计算 wait_all 的最大等待上限。 */
	getWatchdogTimeoutMs?(): number;
	/** 检查某个模板名是否可用于派生子代理（存在且 enabled）。 */
	isTemplateUsable(name: string): boolean;
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
	};
}

/**
 * 子代理工具集（注册进每个会话的 customTools，供主 agent 驱动子代理）。
 * 用 `subagent_*` 前缀命名，避免与第三方 pi-subagents 的
 * `Agent`/`get_subagent_result`/`steer_subagent` 冲突。
 *
 * `selfConvId`（可选）：这套工具所注册进的会话 convId。`subagent_wait_all`
 * 永远排除调用者自身——子代理会话上同样注册了全套工具，不传 runIds 时
 * 「全部」会含它自己，而它正在执行本工具（streaming=true），不排除就是
 * 自己等自己、永远到超时（self-wait deadlock）。主会话调用时传它自己的
 * 普通对话 id 即可（不在子代理列表里，delete 是 no-op）。
 */
export function makeSubagentTools(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string,
): ToolDefinition[] {
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return [
		defineTool({
			name: "subagent_spawn",
			label: "Spawn subagent",
			description: bilingual(
				"Spawn an independent background subagent conversation for a self-contained deliverable task " +
					'(research/implement/review, etc.). Subagents appear in the left "Running conversations" list with a ' +
					"subagent badge; the user can open, supplement, or stop them. The main agent may spawn several in parallel: " +
					"use subagent_wait_all to wait for all at once (no polling), subagent_list for live status, " +
					"subagent_get_result for results, subagent_steer to redirect mid-run, subagent_stop to stop. " +
					"Good for: long-running exploration, parallel research, delegating independent subtasks. Optional template " +
					"param: use a subagent template configured in the settings panel " +
					"(role system prompt + skills/extensions whitelist + optional thinking level). Always inherit the spawning " +
					"conversation's current model, or its global default if unset. Only pass model when the user explicitly " +
					"requests that model for the subagent. Never pick another model yourself based on availability, cost, " +
					"task type, or a template's model field.",
				"在后台启动一个独立的子代理对话，用一个明确的指令去完成一项可独立交付的工作（调研/实现/审查等）。" +
					"子代理会出现在左栏「运行的对话」列表（带子代理标识），用户可点开查看、补充、中止。主 agent 可并行派发多个：" +
					"用 subagent_wait_all 一次性等全部完成（不用轮询）、subagent_list 查看运行态、subagent_get_result 取结果、" +
					"subagent_steer 中途改向、subagent_stop 停止。" +
					"适合：长耗时探索、并行调研、独立子任务委派。可选 template 参数：使用设置面板配置的子代理模板" +
					"（角色系统提示词 + 技能/扩展白名单 + 可选思考强度）。子代理默认继承派发者当前模型，未设置时用全局默认。" +
					"只有用户明确要求子代理使用某个模型时才允许传 model。禁止根据可用模型、费用、任务类型或模板模型字段自行更换模型。",
			),
			promptSnippet: "spawn an independent background subagent for a deliverable task (parallel work)",
			parameters: Type.Object({
				prompt: Type.String({
					description: bilingual(
						"Full instructions for the subagent (goal + constraints + expected output).",
						"交给子代理的完整指令（要达成的目标 + 约束 + 期望产出）。",
					),
				}),
				type: Type.Optional(
					Type.String({
						description: bilingual(
							"Subagent type/role name (e.g. explore/implement/review), for display. Default general.",
							"子代理类型/角色名（如 explore/implement/review），用于展示。默认 general。",
						),
					}),
				),
				template: Type.Optional(
					Type.String({
						description: bilingual(
							"Optional: subagent template name (a preset configured under Settings → Subagent Templates, see the " +
								"subagent_templates tool). Template = role system prompt + skills/extensions whitelist + optional " +
								"thinking level; model always follows the spawning session unless explicitly requested by the user.",
							"可选：子代理模板名（设置面板「子代理模板」配置的预设，见 subagent_templates 工具）。" +
								"模板 = 角色系统提示词 + 技能/扩展白名单 + 可选思考强度；模板模型不会覆盖派发者模型。",
						),
					}),
				),
				model: Type.Optional(
					Type.String({
						description: bilingual(
							'Only when explicitly requested by the user: "provider/id" for this run. Otherwise omit; inherit the spawning session model or global default. Never choose another model autonomously.',
							'仅当用户明确指定时才填写本次模型 "provider/id"；否则必须省略，继承派发者当前模型或全局默认。禁止自主选择其他模型。',
						),
					}),
				),
				cwd: Type.Optional(
					Type.String({
						description: bilingual(
							"Subagent working directory (relative/absolute). Defaults to the main session's cwd.",
							"子代理工作目录（相对/绝对）。默认继承主会话工作目录。",
						),
					}),
				),
				persist: Type.Optional(
					Type.Boolean({
						description: bilingual(
							"Optional: persist this conversation to disk as a regular session (saved in history, resumable). " +
								"Default false (lightweight in-memory subagent). Use true for tasks that need long-term retention or human follow-up.",
							"可选：是否将该对话持久化落盘为普通对话（保存在历史会话中，可随时回顾与继续）。" +
								"默认 false（轻量内存子代理）。需要长期留存或后续人工跟进的任务建议设为 true。",
						),
					}),
				),
			}),
			execute: async (_id, p, _signal, _onUpdate, ctx) => {
				if (p.template && !host.isTemplateUsable(p.template)) {
					return text(
						pick(
							getLang(),
							`子代理模板不可用：${p.template}（不存在或已停用）。用 subagent_templates 查看当前可用模板清单；不传 template 则按默认配置运行。`,
							`Subagent template unavailable: ${p.template} (missing or disabled). Use subagent_templates to list available templates; omit template to run with defaults.`,
							"subagents.spawn.template.unavailable",
							{ "p.template": p.template },
						),
					);
				}
				// spawn 通道是唯一的失败面（数量上限 / runtime 创建失败 / 坏 cwd 都经由
				// host 抛错）：转成返回文本而不是直接抛，让 AI 能读到原因并调整重试。
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
				// Optional segments are pre-rendered per language (translators pick
				// the Zh/En variant through the vars table; inline ternaries would
				// leak source syntax into packs that copy them verbatim).
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
							`\n用 subagent_wait_all 一次等全部完成（不用轮询），subagent_get_result 取单个结果，subagent_list 看运行态，subagent_steer 改向，subagent_stop 停止。`,
						`${kindLabelEn} started (visible in the running list): ${convId}\nType: ${subagentType} · Title: ${subagentTitleText}${templateLineEn}${modelLineEn}` +
							`\nUse subagent_wait_all to wait for all at once (no polling), subagent_get_result for a single result, subagent_list for live status, subagent_steer to redirect, subagent_stop to stop.`,
						"subagents.spawn.started",
						{
							convId: convId,
							subagentType: subagentType,
							subagentTitleText: subagentTitleText,
							"p.template": p.template,
							"p.model": p.model,
							templateLineZh: templateLineZh,
							templateLineEn: templateLineEn,
							modelLineZh: modelLineZh,
							modelLineEn: modelLineEn,
						},
					),
					{ convId, template: p.template, model: p.model, persisted: !!p.persist },
				);
			},
		}),
		defineTool({
			name: "subagent_get_result",
			label: "Get subagent result",
			description: bilingual(
				"Fetch a subagent's result or current progress. If not finished yet, returns the current status and partial " +
					"output; runtime errors (e.g. provider 400) are surfaced here as explicit errors.",
				"取一个子代理的结果或当前运行态。若尚未完成，返回当前状态与已产出的文本；运行报错（如 provider 400）会在这里明确标出错误。",
			),
			promptSnippet: "fetch a subagent's result / current progress",
			parameters: Type.Object({
				runId: Type.String({
					description: bilingual(
						"ConvId returned by subagent_spawn. Clicking the same conversation in the left panel opens it directly.",
						"subagent_spawn 返回的 convId。左栏点击同名对话可直接查看。",
					),
				}),
			}),
			execute: async (_id, p) => {
				const r = host.getSubagent(p.runId);
				const missingId = shortId(p.runId);
				if (!r)
					return text(
						pick(
							getLang(),
							`未找到子代理 ${missingId}（可能已移出）。`,
							`Subagent ${missingId} not found (may have been dismissed).`,
							"subagents.get.not.found",
							{ missingId: missingId },
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
							{ runningId: runningId, "r.type": r.type, "r.state": r.state, runningOutput: runningOutput },
						),
						r,
					);
				}
				return text(
					pick(
						getLang(),
						`子代理 ${doneId}（${r.type}）状态：${verdict}\n${doneDetail}\n${doneOutput}`,
						`Subagent ${doneId} (${r.type}) status: ${verdict}\n${doneDetail}\n${doneOutput}`,
						"subagents.get.done",
						{ doneId: doneId, "r.type": r.type, verdict: verdict, doneDetail: doneDetail, doneOutput: doneOutput },
					),
					r,
				);
			},
		}),
		defineTool({
			name: "subagent_steer",
			label: "Steer subagent",
			description: bilingual(
				"Inject a message into a subagent to redirect or supplement its work (same as the user sending a message in its conversation).",
				"向一个子代理注入一条消息，重定向/补充它的工作方向（等同用户在它的对话里发消息）。",
			),
			promptSnippet: "inject a message into a running subagent to redirect its work",
			parameters: Type.Object({
				runId: Type.String({
					description: bilingual("Target subagent convId.", "目标子代理 convId。"),
				}),
				message: Type.String({
					description: bilingual("Redirect / supplementary info to inject.", "要注入的方向调整/补充信息。"),
				}),
			}),
			execute: async (_id, p) => {
				if (!host.getSubagent(p.runId)) {
					const missingSteerId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`未找到子代理 ${missingSteerId}（可能已移出），消息未注入。请用 subagent_list 确认仍在运行的子代理。`,
							`Subagent ${missingSteerId} not found (may have been dismissed); message not injected. Use subagent_list to confirm running subagents.`,
							"subagents.steer.not.found",
							{ missingSteerId: missingSteerId },
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
						{ steerId: steerId },
					),
				);
			},
		}),
		defineTool({
			name: "subagent_list",
			label: "List subagents",
			description: bilingual(
				"List all subagents and managed conversations with their live status: convId, type, state, title, message count (errors/aborts are marked in the state).",
				"列出全部子代理及受控对话的运行态：convId、类型、状态、标题、消息数（报错/中止的会在状态里标出）。",
			),
			promptSnippet: "list all subagents and their live status",
			parameters: Type.Object({
				kind: Type.Optional(
					Type.String({
						enum: ["all", "subagent", "persistent"],
						description: bilingual(
							"Filter: all (default) = all managed tasks; subagent = only ephemeral in-memory subagents; persistent = only persistent conversations.",
							"过滤类型：all（默认）= 全部受控对话；subagent = 仅临时内存子代理；persistent = 仅持久化普通对话。",
						),
					}),
				),
			}),
			execute: async (_id, p) => {
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
					const tag = r.persisted ? (tLang === "zh" ? "持久化" : "persistent") : tLang === "zh" ? "子代理" : "subagent";
					return (
						`- ${r.convId} · ${r.type} · ${subagentVerdict(r, tLang)} · ${r.title}` +
						(tLang === "zh" ? `（${tag} · msg: ${r.messageCount}）` : ` (${tag} · msg: ${r.messageCount})`)
					);
				});
				return text(lines.join("\n"));
			},
		}),
		defineTool({
			name: "subagent_stop",
			label: "Stop subagent",
			description: bilingual(
				"Stop a running subagent (same as the user aborting it in its conversation). Already-finished ones are unaffected.",
				"停止一个运行中的子代理（等同用户在它的对话里点中止）。已完成的不受影响。",
			),
			promptSnippet: "stop a running subagent",
			parameters: Type.Object({
				runId: Type.String({
					description: bilingual("Target subagent convId.", "目标子代理 convId。"),
				}),
			}),
			execute: async (_id, p) => {
				if (!host.getSubagent(p.runId)) {
					const missingStopId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`未找到子代理 ${missingStopId}（可能已移出或已结束），无需停止。请用 subagent_list 确认仍在运行的子代理。`,
							`Subagent ${missingStopId} not found (may have been dismissed or already finished); nothing to stop. Use subagent_list to confirm running subagents.`,
							"subagents.stop.not.found",
							{ missingStopId: missingStopId },
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
						{ stopId: stopId },
					),
				);
			},
		}),
		defineTool({
			name: "subagent_wait_all",
			label: "Wait for subagents",
			description: bilingual(
				"Wait for multiple subagents to finish at once (blocks this round until all reach a terminal state or time out), " +
					"then summarize each result/error — no need to poll subagent_get_result. Pass runIds for specific subagents " +
					"(convIds returned by subagent_spawn); omit = wait for own descendant subagents when called from a subagent, " +
					"else all currently running ones. The calling session itself and its ancestors are never waited on " +
					"(a subagent calling this without runIds won't deadlock on itself or its parent). " +
					"Descendants spawned during the wait are picked up automatically. " +
					"On timeout or abort of this round, returns the remaining unfinished list; call again to continue waiting. " +
					"Good for: collecting parallel subagents.",
				"一次性等待多个子代理全部完成（阻塞本回合直到它们都到达终态或超时），然后汇总返回每个的结果/错误——" +
					"不用反复调 subagent_get_result 轮询。传 runIds 指定要等的子代理（subagent_spawn 返回的 convId）；" +
					"不传 = 子代理调用时只等自己的后代，主对话调用时等当前全部运行中的子代理。调用者自身与祖先永不计入等待" +
					"（子代理不传 runIds 时不会等自己或父级，避免父子互等到超时）。等待期间新派生的后代会自动纳入。" +
					"超时或本轮被中止时返回剩余未完成名单，可再次调用继续等。" +
					"适合：并行派发多个子代理后收口。",
			),
			promptSnippet: "wait for multiple subagents to finish (no polling) and get all results",
			parameters: Type.Object({
				runIds: Type.Optional(
					Type.Array(
						Type.String({
							description: bilingual(
								"ConvId of a subagent to wait for (returned by subagent_spawn). Omit = wait for all currently running.",
								"要等待的子代理 convId（subagent_spawn 返回值）。缺省 = 等当前全部运行中的。",
							),
						}),
					),
				),
				timeoutSeconds: Type.Optional(
					Type.Integer({
						description: bilingual(
							`Max wait in seconds (default 600, cap ~${Math.floor(WAIT_CAP_MS / 1000)} — must stay below the tool watchdog; on timeout returns the unfinished list so you can call again).`,
							`最多等待秒数（默认 600，上限约 ${Math.floor(WAIT_CAP_MS / 1000)}——必须低于工具看门狗，超时返回未完成名单可再调）。`,
						),
						minimum: 1,
						maximum: Math.floor(WAIT_CAP_MS / 1000),
					}),
				),
			}),
			execute: async (_id, p, signal) => {
				// 祖先链：调用者往上经 parentId 能走到的子代理集合。父级正在执行中的
				// wait_all 卡着（streaming=true），等它 = 父子互等、必到超时才返回。
				// parentId 可能指向普通主对话（不在子代理列表里），走到空即停；环按 visited 截断。
				const ancestorIdsOf = (selfId: string): Set<string> => {
					const out = new Set<string>();
					const seen = new Set<string>([selfId]);
					let cur = host.getSubagent(selfId)?.parentId;
					while (cur && !seen.has(cur)) {
						seen.add(cur);
						// 只有子代理才可能被圈进等待集；普通主对话记下来也无妨（wanted 里没有它）。
						out.add(cur);
						cur = host.getSubagent(cur)?.parentId;
					}
					return out;
				};
				// 后代展开：roots 里任一 id 经 parentId 链能向上走到的子代理。等待集
				// 传了显式 runIds 时也要顺带等它们的后代（fire-and-forget 的孙子辈否则会漏）。
				const expandDescendants = (roots: Set<string> | string[]): string[] => {
					if (roots instanceof Set ? roots.size === 0 : (roots as string[]).length === 0) return [];
					const rootSet = roots instanceof Set ? roots : new Set(roots);
					const all = host.listSubagents();
					const byId = new Map(all.map((s) => [s.convId, s]));
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
							curParent = byId.get(curParent)?.parentId;
							// parentId 指向普通主对话（不在 byId 里）：链到此为止，
							// 但 root 本身可能就是那个主对话 id（主调 wait_all 的 selfConvId）。
							if (!curParent) break;
						}
					}
					return out;
				};
				const explicit = p.runIds && p.runIds.length > 0;
				const wanted = new Set<string>();
				const roots = new Set<string>();
				let implicitGlobal = false;
				// 调用者自身 + 祖先永不等待：子代理调本工具时它自己正在 streaming，
				// 父级同样 streaming（卡在它自己的 wait 里），等谁都是互等死锁到超时。
				// 先算好排除集，显式 runIds 里的祖先直接剔除（不再展开它的子树，
				// 否则等父会顺带把整棵子树含兄弟分支都圈进来）。
				const excluded = new Set<string>();
				if (selfConvId) {
					excluded.add(selfConvId);
					for (const a of ancestorIdsOf(selfConvId)) excluded.add(a);
				}
				if (explicit) {
					for (const id of p.runIds!) {
						if (!excluded.has(id)) roots.add(id);
					}
					for (const id of roots) wanted.add(id);
					for (const id of expandDescendants(roots)) {
						if (!excluded.has(id)) wanted.add(id);
					}
				} else if (selfConvId && host.getSubagent(selfConvId)) {
					// 子代理无参：只等自己的后代（不含自己）。全局等会把父级/无关兄弟
					// 也圈进来：父级卡在 wait 里 streaming=true，子等父 = 父子互等到超时。
					roots.add(selfConvId);
					for (const id of expandDescendants(roots)) {
						if (!excluded.has(id)) wanted.add(id);
					}
				} else {
					// 主对话无参：等当前全部（保持老语义），但同样动态追后代。
					implicitGlobal = true;
					for (const r of host.listSubagents()) {
						if (!excluded.has(r.convId)) wanted.add(r.convId);
					}
				}
				if (wanted.size === 0) {
					const emptyLang = getLang();
					return text(
						pick(
							emptyLang,
							"没有需要等待的子代理（调用者自身与祖先不计入等待；子代理无参时只等自己的后代）。",
							"No subagents to wait for (the calling session itself and its ancestors are never waited on; a subagent without runIds only waits for its own descendants).",
							"subagents.wait.empty",
						),
					);
				}
				const currentWatchdogMs = host.getWatchdogTimeoutMs?.() ?? WAIT_CAP_MS;
				const currentWaitCapMs =
					currentWatchdogMs > 0 ? Math.max(60_000, Math.floor(currentWatchdogMs * 0.8)) : 3600_000;
				const timeoutMs = Math.min(Math.max(p.timeoutSeconds ?? 600, 1), Math.floor(currentWaitCapMs / 1000)) * 1000;
				const waitStart = Date.now();
				const deadline = waitStart + timeoutMs;
				// 已到终态的、（或已被移出找不到的）直接归位；剩下的阻塞轮询到
				// 全部完成/超时/中止（移出 = 无法再等，立即按收口处理）。
				// 每轮动态追踪：等待期间新派生的后代（roots 的子孙、或主调全局新增）自动纳入，
				// fire-and-forget 的孙子辈不会漏；自身与祖先永远排除（父子互等死锁）。
				const trackNewArrivals = () => {
					if (implicitGlobal) {
						for (const r of host.listSubagents()) {
							if (excluded.has(r.convId)) continue;
							wanted.add(r.convId);
						}
					} else {
						for (const id of expandDescendants(roots)) {
							if (excluded.has(id)) continue;
							wanted.add(id);
						}
					}
				};
				const pending = () => {
					trackNewArrivals();
					return [...wanted].filter((id) => {
						const r = host.getSubagent(id);
						return r !== undefined && !isSubagentTerminal(r);
					});
				};
				while (pending().length > 0 && Date.now() < deadline && !(signal?.aborted ?? false)) {
					await new Promise((resolve) => setTimeout(resolve, 300));
				}
				const tLang = getLang();
				const remaining = pending();
				const lines = [...wanted]
					.map((id) => {
						const r = host.getSubagent(id);
						if (!r)
							return tLang === "zh"
								? `- ${shortId(id)}：未找到（可能已移出）`
								: `- ${shortId(id)}: not found (may have been dismissed)`;
						const body = verdictText(r, tLang);
						return (
							(tLang === "zh"
								? `- ${shortId(r.convId)}（${r.type}）· ${r.title} · ${subagentVerdict(r, tLang)}`
								: `- ${shortId(r.convId)} (${r.type}) · ${r.title} · ${subagentVerdict(r, tLang)}`) +
							(body ? `\n  ${body}` : "") +
							(r.output ? `\n  ${clipSubagentOutput(r.output, tLang).split("\n").join("\n  ")}` : "")
						);
					})
					.join("\n");
				const timeoutSecs = Math.round(timeoutMs / 1000);
				const waitedSecs = Math.round((Date.now() - waitStart) / 1000);
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
									{ timeoutSecs: timeoutSecs, waitedSecs: waitedSecs, "remaining.length": remaining.length },
								);
				return text(`${head}\n${lines}\n` + promptRemaining(remaining, tLang));
			},
		}),
		defineTool({
			name: "subagent_templates",
			label: "List subagent templates",
			description: bilingual(
				"List the configurable subagent templates (role system prompt + skills/extensions whitelist + optional model " +
					"and thinking level presets) for the subagent_spawn template param. Disabled templates never appear here. " +
					"Empty list = no templates configured; subagents run with defaults.",
				"列出设置面板「子代理模板」配置的可用模板（角色系统提示词 + 技能/扩展白名单 + 可选思考强度 的组合预设），" +
					"供 subagent_spawn 的 template 参数选用。已停用的模板不会出现在这里。list 为空 = 未配置模板，子代理按默认配置运行。",
			),
			promptSnippet: "list configurable subagent templates (role prompt + skills/extensions whitelist presets)",
			parameters: Type.Object({}),
			execute: async () => {
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
					// 模型与思考强度分开报：思考强度是模板固定值（空 = 跟主对话当前强度）。
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
						`可用的子代理模板（subagent_spawn 的 template 参数传名字，如 subagent_spawn(template="${firstTemplateName}"))：\n${templateLines}`,
						`Available subagent templates (pass the name as subagent_spawn's template param, e.g. subagent_spawn(template="${firstTemplateName}")):\n${templateLines}`,
						"subagents.templates.list",
						{ firstTemplateName: firstTemplateName, templateLines: templateLines },
					),
				);
			},
		}),
	];
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
