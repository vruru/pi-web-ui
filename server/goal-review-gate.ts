/**
 * server/goal-review-gate.ts
 *
 * 目标审查回合的硬闸门（纯函数）：主对话在 `awaitingVerdict` 置位期间是审查者，
 * 只许只读核实 —— 写类工具 / 非常规 bash / 派发类工具 / 向用户提问一律拒。
 *
 * 为什么要硬闸门而不只靠契约：审查回合的提示词只写了「只读核实」，但主对话是
 * 用户自己的全功能会话，模型在长任务里「顺手改一下」是常态；且 D6 要求轮次由
 * 服务端控制，派生/等待/指挥别的对话必须拦。闸门是**无状态**的（每次执行只读
 * `awaitingVerdict` 是否置位），verdict 落定即自动恢复，不存在「钉死只读」。
 *
 * 判定全部是纯函数（无 IO），单测见 tests/unit/goal-review-gate.test.ts。
 * 包裹形态与 withPlanModeGate / withDelegationGate 同构，见 agent-service.ts。
 *
 * 已知局限（与计划/审查者闸门同口径）：创建时注册进 customTools 的插件工具
 * 同样被包裹；但之后经 refreshPluginTools 动态补入已有会话的不在覆盖面。
 * 自研插件若绕过 wrapper 直接写文件同样拦不住 —— 只读是硬闸门，不是安全边界。
 */
import { bashCommandIsReadOnly } from "./plan-mode.js";
import { isSubagentToolName } from "./tool-manager.js";

/** 审查回合禁写的工具：与计划/审查者模式同名单（写 / 改 / 增删 / git 写 / 形态变换）。 */
const WRITE_TOOLS = new Set([
	// 文件写入与编辑（第一方 + SDK 内置 + 编辑器类扩展的常见名）
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
	// 文件系统增删改
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
	// 版本控制写（git add/commit/checkout/reset…；只读子命令走 bash 白名单）
	"git",
	// 形态变换（会重写整个文件树）
	"format",
	"prettier",
	"lint_fix",
	"autofix",
]);

/**
 * 审查回合禁掉的「派发类」工具：轮次由服务端控制（D6）—— 派生 / 等待 / 指挥
 * 别的对话、排程、改模式 / 开新目标都会绕开「一轮 = 派活 + 判定」的口径。
 * 只读的 `conversation_read` / `subagent_get_result` / `subagent_list` 不在名单里：
 * 审查者可以按需看执行者的转录（契约要求看实际状态，而不是信描述）。
 */
const DISPATCH_TOOLS = new Set([
	"spawn",
	"spawn_agent",
	"subagent_spawn",
	"spawn_subagent",
	"subagent_steer",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_handoff",
	"delegate_task",
	"schedule",
	"schedule_agent",
	"host_schedule",
	"create_goal",
	"set_goal",
	"start_goal_wizard",
	"set_plan_mode",
]);

/** bash 家族（要逐条判命令是否只读；与审查者模式同名单）。 */
const BASH_TOOLS = new Set(["bash", "shell", "sh", "zsh", "terminal", "terminal_bash", "run_command", "exec"]);

/** 引号感知的命令切分（按 | ; && || 换行拆段；含 $( / 反引号时整条视为一段交白名单判
 *  —— 白名单必拒，方向是 fail-closed，这里的拆分只会让判定更严不会放宽）。 */
function splitReviewSegments(cmd: string): string[] {
	if (/[`$]\(/.test(cmd)) return [cmd];
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote) {
			cur += ch;
			if (ch === quote && cmd[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === ";" || ch === "\n") {
			out.push(cur);
			cur = "";
			continue;
		}
		if ((ch === "&" || ch === "|") && cmd[i + 1] === (ch === "&" ? "&" : "|")) {
			out.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === "|") {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * 审查回合额外放行的测试命令：契约承诺审查者可以「跑测试」验结论，而计划模式的
 * 保守白名单连 `npm test` 都没有（解释器只放 --version/--help）。只认「跑测试」
 * 的形状（test 脚本 / 各语言测试运行器），`npm run deploy` 这类一律不放；
 * 重定向 / 反引号沿白名单方向必拒。
 */
function isTestRunnerChunk(chunk: string): boolean {
	if (/[><`]/.test(chunk)) return false;
	const tokens = chunk.split(/\s+/).filter(Boolean);
	const first = tokens[0] ?? "";
	const name = first.slice(first.lastIndexOf("/") + 1);
	const args = tokens.slice(1);
	switch (name) {
		case "npm":
		case "yarn":
		case "pnpm":
		case "bun":
			return args[0] === "test" || (args[0] === "run" && (args[1] ?? "").startsWith("test"));
		case "npx":
			return args[0] === "vitest" || args[0] === "jest" || args[0] === "mocha";
		case "pytest":
			return true;
		case "python":
		case "python3":
			return args[0] === "-m" && (args[1] === "pytest" || args[1] === "unittest");
		case "node":
			return args[0] === "--test";
		case "go":
		case "cargo":
			return args[0] === "test";
		case "make":
			return (args[0] ?? "").startsWith("test") || args[0] === "check";
		default:
			return false;
	}
}

/**
 * 审查回合的 bash 是否可放行：每段要么过计划模式只读白名单，要么是跑测试的形状。
 * 空命令返回 false（调用方另行处理无命令调用）。
 */
export function goalReviewBashAllowed(cmd: string): boolean {
	const text = (cmd ?? "").trim();
	if (!text) return false;
	const chunks = splitReviewSegments(text);
	if (chunks.length === 0) return false;
	return chunks.every((c) => isTestRunnerChunk(c) || bashCommandIsReadOnly(c));
}

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

/**
 * 审查回合中的用户插话是否顺延：纯文本 steer 会污染 verdict，必须排队到 verdict
 * 落定后；followUp（补充按钮）由 SDK 排在整轮结束后才送达，本来就安全；斜杠命令
 * 与带附件的不进顺延（前者直通，后者引用只在发送瞬间有效、调用方改响亮拒绝）。
 */
export function shouldDeferPromptForReview(opts: {
	queue: boolean;
	text: string;
	hasAttachments: boolean;
	awaitingVerdict: boolean;
}): boolean {
	if (opts.queue || !opts.awaitingVerdict || opts.hasAttachments) return false;
	if (opts.text.trim().startsWith("/")) return false;
	return true;
}

/** 目标审查闸门对一次工具调用的裁决：undefined = 放行。 */
export interface GoalReviewDenial {
	reason: string;
	reasonEn: string;
	/** 归类，写进 details 供前端与回归判读。 */
	kind: "write-tool" | "bash" | "dispatch-tool" | "ask-user";
}

/**
 * 目标审查闸门（纯函数）：命中即拒绝，并把「该干什么」告诉模型 ——
 * 拒绝理由是模型在审查回合里唯一的纠偏机会（长任务里最容易「顺手改一下」）。
 */
export function goalReviewDenial(toolName: string, params: unknown): GoalReviewDenial | undefined {
	const name = (toolName ?? "").trim();
	if (!name) return undefined;
	// 向用户提问：审查回合禁弹窗（问了就没人应答，verdict 会超时拖成 blocked）。
	if (name === "ask_user_question") {
		return {
			kind: "ask-user",
			reason:
				"目标审查回合：不能向用户提问（本回合由服务端自动驱动，弹窗无人应答）。请只做本轮审查、只回 verdict JSON。",
			reasonEn:
				"Goal review round: do not ask the user anything (this round is server-driven; dialogs go unanswered). Just review this round and reply with only the verdict JSON.",
		};
	}
	if (isSubagentToolName(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		// 只读 action（get_result, list, templates）放行；其余（spawn, steer, stop, wait_all, handoff）或未传 action 均拒绝
		if (act === "get_result" || act === "list" || act === "templates") {
			return undefined;
		}
		return {
			kind: "dispatch-tool",
			reason: `目标审查回合：不能调用 subagent(action="${act || "spawn"}") —— 轮次由服务端控制。请只做本轮审查、只回 verdict JSON。`,
			reasonEn: `Goal review round: subagent(action="${act || "spawn"}") is unavailable — the server owns the rounds. Just review this round and reply with only the verdict JSON.`,
		};
	}
	if (DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `目标审查回合：不能调用 ${name} —— 轮次由服务端控制。请只做本轮审查、只回 verdict JSON。`,
			reasonEn: `Goal review round: ${name} is unavailable — the server owns the rounds. Just review this round and reply with only the verdict JSON.`,
		};
	}
	if (BASH_TOOLS.has(name)) {
		const cmd = commandOf(params);
		if (cmd.trim() === "") {
			return {
				kind: "bash",
				reason: "目标审查回合：终端只用于只读核实（跑测试 / 看 diff），不接受无命令调用。请用 read / grep / 只读 git。",
				reasonEn:
					"Goal review round: the terminal is for read-only verification only (run tests / inspect the diff); calls without a command are rejected. Use read / grep / read-only git.",
			};
		}
		if (goalReviewBashAllowed(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `目标审查回合：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。要改工作区请在 verdict 里判 fail 并写具体待改项，让执行对话下一轮做。`,
			reasonEn: `Goal review round: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. To change the workspace, verdict fail with concrete items and let the executor do it next round.`,
		};
	}
	if (WRITE_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `目标审查回合：只读核实，${name} 被拒。工作区的改动由执行对话做；你的职责是看实际状态、只回 verdict JSON。`,
			reasonEn: `Goal review round: read-only verification — ${name} was rejected. The executor conversation makes the changes; your job is to inspect the actual state and reply with only the verdict JSON.`,
		};
	}
	return undefined;
}
