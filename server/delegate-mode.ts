/**
 * server/delegate-mode.ts
 *
 * 审查者模式（自动委派 / delegate mode）：主对话**只审阅不施工**，活由服务端
 * 派给一个**常驻落盘执行对话**（每会话一个，跨轮复用）。
 *
 * 形态：会话级开关（`set_delegate_mode`）→ 开启后：
 *   1. 自动路由：用户在主对话发的每条 prompt，服务端直接转给执行对话执行
 *      （`ClientSession.dispatchToDelegate`），主对话这一轮**不跑模型**；
 *   2. 纯委派闸门：主对话的写类工具 / 非常规 bash / 派发类工具一律拒
 *      —— 即便模型自己想动手也过不去（与计划模式同一套 `withXGate` 骨架）。
 *
 * 与计划模式的关系：**互斥优先级**。计划模式开着的时候不自动派活（计划模式已经
 * 把 spawn/旁路工具全拒了，再自动派活就是死锁），由计划模式那一轮说了算。
 *
 * 判定全部是纯函数（无 IO），单测见 tests/unit/delegate-mode.test.ts。
 */
import { bashCommandIsReadOnly } from "./plan-mode.js";
import { SUBAGENT_COEXIST_TOOL_NAME } from "./tool-manager.js";

/** 审查者模式下确定禁止的工具：与计划模式同名单（写 / 改 / 增删 / git 写 / 形态变换）。 */
const BLOCKED_TOOLS = new Set([
	"write",
	"create",
	"create_file",
	"write_file",
	"edit",
	"edit_file",
	"edit_soft",
	"apply_patch",
	"patch",
	"patch_tool",
	"str_replace",
	"str_replace_editor",
	"multi_edit",
	"notebook_edit",
	"mv",
	"move",
	"cp",
	"copy",
	"mkdir",
	"rm",
	"rmdir",
	"delete",
	"delete_file",
	"touch",
	"chmod",
	"chown",
	"truncate",
	"rename",
	"git",
	"format",
	"prettier",
	"lint_fix",
	"autofix",
]);

/**
 * 审查者模式下也禁掉的「派发类」工具：派活是**服务端**的活（自动路由），
 * 模型再自己 spawn 一个只会绕开「一个常驻执行对话」这条语义线（多份上下文、
 * 多份配额、左栏一堆对话），而且落盘对话占项目会话名额。
 * 与计划模式禁它的理由不同：那边是「别绕开只读约束」，这边是「别绕开统一派活」。
 */
const DISPATCH_TOOLS = new Set([
	"spawn",
	"subagent_spawn",
	"subagent",
	SUBAGENT_COEXIST_TOOL_NAME,
	"delegate_task",
	"spawn_subagent",
	"schedule",
	"set_goal",
	"start_goal_wizard",
	"set_plan_mode",
]);

/** bash 家族（要逐条判命令是否只读）。 */
const BASH_TOOLS = new Set(["bash", "shell", "sh", "zsh", "terminal", "terminal_bash", "run_command", "exec"]);

/** 从工具参数里取命令文本（各工具字段名不同）。 */
function commandOf(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "input"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return "";
}

/** 审查者模式对一次工具调用的裁决：undefined = 放行。 */
export interface DelegationDenial {
	reason: string;
	reasonEn: string;
	/** 归类，写进 details 供前端与回归判读。 */
	kind: "write-tool" | "bash" | "dispatch-tool";
}

/**
 * 审查者模式闸门（纯函数）：命中即拒绝，并把「该干什么」告诉模型 ——
 * 提示词已经说明规则，这里再把可操作的下一步重复一遍（长任务里模型最容易
 * 「顺手改一下」，拒绝理由就是它唯一的纠偏机会）。
 */
export function delegationDenial(toolName: string, params: unknown): DelegationDenial | undefined {
	const name = (toolName ?? "").trim();
	if (!name) return undefined;
	if (DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `审查者模式：不能调用 ${name} —— 派活由服务端统一做（一个常驻执行对话）。请只描述需求、审阅结果或提问。`,
			reasonEn: `Reviewer mode: ${name} is unavailable — dispatching is done by the server (one persistent executor conversation). Describe the work, review the result, or ask questions.`,
		};
	}
	if (BASH_TOOLS.has(name)) {
		const cmd = commandOf(params);
		if (cmd.trim() === "") {
			return {
				kind: "bash",
				reason: "审查者模式：终端不可用 —— 施工由执行对话做。请用 read/grep/只读 git 看结果。",
				reasonEn:
					"Reviewer mode: the terminal is unavailable — the executor conversation does the work. Inspect with read/grep/read-only git.",
			};
		}
		if (bashCommandIsReadOnly(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `审查者模式：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。施工请交给执行对话；你要做的是看结果、判断是否达标。`,
			reasonEn: `Reviewer mode: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. The executor conversation makes the changes — your job is to inspect the result and judge whether it meets the goal.`,
		};
	}
	if (BLOCKED_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `审查者模式：本对话不施工，${name} 被拒。需求已由服务端转给执行对话；请改为审阅它交回来的结果（读 diff/测试输出）并提出下一轮要求。`,
			reasonEn: `Reviewer mode: this conversation does not make changes — ${name} was rejected. The request was forwarded to the executor conversation; review its result (read the diff, test output) and state what the next round should do.`,
		};
	}
	return undefined;
}

/** 审查者模式系统提示词段（英文：进入模型上下文，按工具提示词卫生口径只写英文）。 */
export const DELEGATION_SYSTEM_PROMPT = [
	"# Reviewer mode (you review; a server-side executor does the work)",
	"Reviewer mode is on for this conversation. The server forwards every user request to ONE persistent executor conversation, and that conversation is the only one allowed to change anything.",
	"Hard rules:",
	"- Never try to change files, run write commands, or dispatch other agents: those tools are blocked by the server and the rejection comes back as a tool error. Do not retry them.",
	"- Your job per turn: state what you expect the executor to deliver (constraints, acceptance criteria, files/paths in scope), then when a result comes back, verify it — read the diff, run read-only commands, check the tests it claims to have run — and either accept it or state precise follow-up requirements for the next round.",
	"- Keep your own messages short and decision-oriented. The executor keeps the working context; you are the reviewer, not the worker.",
	"- If plan mode is also on, plan mode wins: no dispatch happens and you produce the plan yourself.",
].join("\n");

/** 拒给用户的界面文案（notice，zh + en 成对）。 */
export function delegateNoticeText(enabled: boolean): { text: string; textEn: string } {
	return enabled
		? {
				text: "🔎 审查者模式：本对话只审阅，你的每条请求已由服务端转给常驻执行对话执行",
				textEn:
					"🔎 Reviewer mode on: this conversation only reviews; the server forwards your requests to a persistent executor conversation",
			}
		: {
				text: "审查者模式已关闭：恢复正常对话（本对话可以直接施工）",
				textEn: "Reviewer mode off: back to a normal conversation (this one can make changes again)",
			};
}
