/**
 * builtins/todo.ts — 内置任务标记（复刻 pi-marker-tools）。
 */

import type { ApplyResult, MarkerTool, MarkerOverlay, ParsedToken, MarkerContext } from "../marker.js";
import { getServerBlock, pick, type ServerLang } from "../../i18n.js";

export const TODO_NAMESPACE = "todo";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Todo {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
	blockedBy: number[];
	createdAt: number;
}

export interface TodoState {
	tasks: Todo[];
	nextId: number;
}

export function initTodoState(): TodoState {
	return { tasks: [], nextId: 1 };
}

function findTask(state: TodoState, id: number): Todo | undefined {
	return state.tasks.find((t) => t.id === id && t.status !== "deleted");
}

function parseId(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function formatStatus(s: TodoStatus): string {
	switch (s) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in_progress";
		case "completed":
			return "completed";
		default:
			return s;
	}
}

export function describeTodos(state: TodoState, includeDeleted = false, lang: ServerLang = "en"): string {
	const visible = state.tasks.filter((t) => includeDeleted || t.status !== "deleted");
	if (visible.length === 0) return pick(lang, "[todo] （空）", "[todo] (empty)", "markers.todo.list.empty");
	return visible
		.map((t) => {
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			const deps = t.blockedBy.length ? ` ⛓ ${t.blockedBy.join(",")}` : "";
			return `[${formatStatus(t.status)}] #${t.id} ${t.subject}${form}${deps}`;
		})
		.join("\n");
}

const TODO_GUIDANCE_ZH: string[] = [
	"- 标记语法：[[todo:new:<主题>]] 新建；[[todo:set:<id>,completed|in_progress|pending]] 状态；[[todo:remove:<id>]] 删除；[[todo:dep:<id>,blocks=<依赖id,逗号分隔>]] 设依赖。",
	"- 状态变化全部用上面的 [[todo:...]] 内联标记表达，不会中断回答，无需等待返回。",
	"- 想查看/list 当前任务列表时，才用 `todo_list` 工具（读操作走工具）。",
	"- 不要编造不存在的任务 id；id 由 [[todo:new:...]] 分配，首次分配是自增整数。",
];

const TODO_GUIDANCE_EN: string[] = [
	"- Marker syntax: [[todo:new:<subject>]] to create; [[todo:set:<id>,completed|in_progress|pending]] for status; [[todo:remove:<id>]] to delete; [[todo:dep:<id>,blocks=<dep ids, comma-separated>]] to set dependencies.",
	"- Express all status changes with the [[todo:...]] inline markers above; they never interrupt your reply and need no waiting for a result.",
	"- Only use the `todo_list` tool (the read path goes through the tool) when you want to list the current tasks.",
	"- Never invent task ids; ids are assigned by [[todo:new:...]], starting from incrementing integers.",
];

/** 语言感知的 todo guidance（issue #91）：en 用英译、zh 用中文，默认英文。 */
export function getTodoGuidance(lang: ServerLang = "en"): string[] {
	return getServerBlock(lang, "markers.todo.guidance", TODO_GUIDANCE_ZH, TODO_GUIDANCE_EN);
}

export const todoMarker: MarkerTool<TodoState> = {
	name: "todo",
	guidance: TODO_GUIDANCE_ZH,
	getGuidance: getTodoGuidance,

	async apply(
		token: ParsedToken,
		_ctx: MarkerContext,
		_state: TodoState,
		lang: ServerLang = "en",
	): Promise<ApplyResult> {
		const state = _state;
		const op = token.op;
		switch (op) {
			case "new": {
				const subject = token.args[0]?.trim();
				if (!subject)
					return {
						applied: false,
						error: pick(
							lang,
							"todo:new 需要一个主题参数 [[todo:new:<主题>]]",
							"todo:new requires a subject argument [[todo:new:<subject>]]",
							"markers.todo.new.requires.subject",
						),
					};
				const id = state.nextId++;
				state.tasks.push({ id, subject, status: "pending", blockedBy: [], createdAt: Date.now() });
				return {
					applied: true,
					feedback: pick(
						lang,
						`已创建 #${id}：${subject}（pending）`,
						`Created #${id}: ${subject} (pending)`,
						"markers.todo.new.created",
						{ id: id, subject: subject },
					),
				};
			}
			case "set": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: pick(
							lang,
							`todo:set 的 id 无效: "${rawId}"`,
							`todo:set has an invalid id: "${rawId}"`,
							"markers.todo.set.invalid.id",
							{ rawId: rawId },
						),
					};
				}
				const status = token.args[1]?.trim() as TodoStatus | undefined;
				if (!status || !(status === "pending" || status === "in_progress" || status === "completed")) {
					const statusText = status ?? "";
					return {
						applied: false,
						error: pick(
							lang,
							`todo:set 状态无效: "${statusText}"，应为 pending|in_progress|completed`,
							`todo:set has an invalid status: "${statusText}", expected pending|in_progress|completed`,
							"markers.todo.set.invalid.status",
							{ statusText: statusText },
						),
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: pick(
							lang,
							`todo:set 任务 #${id} 不存在`,
							`todo:set task #${id} does not exist`,
							"markers.todo.set.task.missing",
							{ id: id },
						),
					};
				const activeForm = token.kwargs["activeForm"];
				const from = task.status;
				if (status === "pending" && from === "completed") {
					return {
						applied: false,
						error: pick(
							lang,
							`任务 #${id} 已完成，不能置回 pending`,
							`Task #${id} is completed and cannot be set back to pending`,
							"markers.todo.set.completed.no.pending",
							{ id: id },
						),
					};
				}
				if (status === "in_progress" && from === "completed") {
					return {
						applied: false,
						error: pick(
							lang,
							`任务 #${id} 已完成，不能重新进行中`,
							`Task #${id} is completed and cannot be set back to in_progress`,
							"markers.todo.set.completed.no.inprogress",
							{ id: id },
						),
					};
				}
				task.status = status;
				if (status === "in_progress" && activeForm) task.activeForm = activeForm;
				const change = from !== status ? ` (${from} → ${status})` : "";
				return {
					applied: true,
					feedback: pick(lang, `已更新 #${id}${change}`, `Updated #${id}${change}`, "markers.todo.set.updated", {
						id: id,
						change: change,
					}),
				};
			}
			case "remove": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: pick(
							lang,
							`todo:remove 的 id 无效: "${rawId}"`,
							`todo:remove has an invalid id: "${rawId}"`,
							"markers.todo.remove.invalid.id",
							{ rawId: rawId },
						),
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: pick(
							lang,
							`todo:remove 任务 #${id} 不存在`,
							`todo:remove task #${id} does not exist`,
							"markers.todo.remove.task.missing",
							{ id: id },
						),
					};
				task.status = "deleted";
				return {
					applied: true,
					feedback: pick(
						lang,
						`已删除 #${id}：${task.subject}`,
						`Deleted #${id}: ${task.subject}`,
						"markers.todo.remove.deleted",
						{ id: id, "task.subject": task.subject },
					),
				};
			}
			case "dep": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: pick(
							lang,
							`todo:dep 的 id 无效: "${rawId}"`,
							`todo:dep has an invalid id: "${rawId}"`,
							"markers.todo.dep.invalid.id",
							{ rawId: rawId },
						),
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: pick(
							lang,
							`todo:dep 任务 #${id} 不存在`,
							`todo:dep task #${id} does not exist`,
							"markers.todo.dep.task.missing",
							{ id: id },
						),
					};
				const depRaw = token.kwargs["blocks"] ?? token.args[1] ?? "";
				const deps = depRaw
					.split(",")
					.map((x) => parseId(x.trim()))
					.filter((x): x is number => x !== null);
				const bad = deps.filter((d) => d === id || !findTask(state, d));
				if (bad.length) {
					const badList = bad.join(",");
					return {
						applied: false,
						error: pick(
							lang,
							`todo:dep 检测到非法依赖 ${badList}（不存在或自环）`,
							`todo:dep detected invalid dependencies ${badList} (missing or self-referencing)`,
							"markers.todo.dep.invalid.dependencies",
							{ badList: badList },
						),
					};
				}
				task.blockedBy = deps;
				const depsText = deps.length ? deps.join(",") : lang === "zh" ? "（无）" : "(none)";
				return {
					applied: true,
					feedback: pick(
						lang,
						`#${id} 依赖：${depsText}`,
						`#${id} blocks: ${depsText}`,
						"markers.todo.dep.blocks.updated",
						{ id: id, depsText: depsText },
					),
				};
			}
			default:
				return {
					applied: false,
					error: pick(lang, `todo 未知操作: ${op}`, `todo unknown operation: ${op}`, "markers.todo.unknown.operation", {
						op: op,
					}),
				};
		}
	},

	overlay(state: TodoState): MarkerOverlay | undefined {
		if (!state || state.tasks.length === 0) return undefined;
		const visible = state.tasks.filter((t) => t.status !== "deleted");
		if (visible.length === 0) return undefined;
		const done = visible.filter((t) => t.status === "completed").length;
		const lines = visible.map((t) => {
			const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			return ` ${mark} #${t.id} ${t.subject}${form}`;
		});
		return { tool: "todo", lines: [`${done}/${visible.length} done`, ...lines] };
	},

	init: initTodoState,
};
