/**
 * server/plan-mode.ts
 *
 * 计划模式（Plan Mode）：**只规划不实施** 的纯函数闸门与判定。
 *
 * 形态：会话级开关（`set_plan_mode`）→ 打开后本对话只允许「只读调研」，
 * 产出走 `plan_update` 步骤看板 + 计划正文，实施由用户确认后另起一轮。
 *
 * 为什么要硬闸门而不只靠提示词：模型不遵守软约束是常态（尤其长任务里
 * 「顺手改一下」）。所以计划模式在**工具执行前**再挡一道：写类工具直接拒、
 * bash 只放行只读命令，拒了就把原因当工具结果回给模型，让它换只读路径。
 *
 * 判定全部是纯函数（无 IO），单测见 tests/unit/plan-mode.test.ts。
 */

import { SUBAGENT_COEXIST_TOOL_NAME, isSubagentToolName } from "./tool-manager.js";

/** 计划模式下确定禁止的工具：写文件 / 改文件 / 建删 / 版本控制写。 */
const BLOCKED_TOOLS = new Set([
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
	// 版本控制写（git add/commit/checkout/reset…；git 的只读子命令走 bash 白名单）
	"git",
	// 形态变换（会重写整个文件树）
	"format",
	"prettier",
	"lint_fix",
	"autofix",
]);

/**
 * 计划模式下也禁掉的「旁路工具」：它们能在**别的会话**里干活，而闸门是
 * 会话级的 —— 子代理/排程对话的 planMode 是 false，等于绕过只读约束。
 * 调研靠本对话的 read/grep/只读 bash 足够，需要并行调研时先退出计划模式。
 */
const BYPASS_TOOLS = new Set([
	"spawn",
	"spawn_agent",
	"subagent_spawn",
	"delegate_task",
	"schedule_agent",
	"host_schedule",
	"create_goal",
	"set_goal",
	"start_goal_wizard",
	"create_conversation",
	"fork_conversation",
]);

/** 计划模式下从模型视野中彻底隐藏的写类工具与旁路工具全集。 */
export const PLAN_MODE_BLOCKED_TOOL_NAMES = new Set<string>([
	...BLOCKED_TOOLS,
	...BYPASS_TOOLS,
	"subagent",
	SUBAGENT_COEXIST_TOOL_NAME,
]);

/** bash 类工具名（terminalBash 开关分流后可能是这几个）。 */
const BASH_TOOLS = new Set(["bash", "bash_execute", "run_command", "shell", "terminal", "terminal_exec"]);

/** 计划模式放行的只读命令（basename，无参数）。刻意保守：宁可拒一次让模型换命令。 */
const READ_ONLY_COMMANDS = new Set([
	// 目录 / 文件查看
	"ls",
	"ll",
	"pwd",
	"cat",
	"bat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"find",
	"fd",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"which",
	"type",
	// 检索与文本处理（只读变体；sed 的 -i 在段内另行拒绝）
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"sed",
	"awk",
	"cut",
	"tr",
	"sort",
	"uniq",
	"jq",
	"yq",
	"diff",
	"cmp",
	// 环境 / 版本
	"env",
	"printenv",
	"date",
	"uname",
	"whoami",
	"node",
	"npm",
	"python",
	"python3",
	// 校验和（只读）
	"md5sum",
	"sha256sum",
]);

/** git 的只读子命令（写子命令一律禁）。 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"describe",
	"shortlog",
	"grep",
	"cat-file",
	"whatchanged",
]);

/** 解释器的「只读例外」：只有这些参数组合放行，其余（-e/--eval/run script/子命令）拒。 */
const INTERPRETER_SAFE_ARGS = new Set(["--version", "-v", "-V", "--help", "-h", "--revision"]);

/** 段内出现即判写：重定向、命令替换、后台、heredoc。 */
const WRITE_SHELL_TOKENS = /[><`]|&\s*$/;

/** 引号感知的命令切分：把一条命令按 ; && || | 换行 拆成独立段。 */
function splitShellSegments(cmd: string): string[] {
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
		// 命令替换 $( … ) 一律视为写（能跑任意代码），整条拒。
		if (ch === "$" && cmd[i + 1] === "(") return [""];
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

/** 取一段里的命令 token：跳过 `FOO=bar` 前缀、`/usr/bin/env`、路径前缀。 */
function commandToken(segment: string): string {
	const tokens = segment.split(/\s+/);
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
			i++;
			continue;
		}
		if (tok === "env" || tok === "command" || tok === "nohup" || tok === "time") {
			i++;
			continue;
		}
		return tok;
	}
	return "";
}

function basenameOf(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

/** 单段是否只读（不含管道/重定向/命令替换，命令在白名单内）。 */
function segmentIsReadOnly(segment: string): boolean {
	if (WRITE_SHELL_TOKENS.test(segment)) return false;
	// `>` 重定向在别处已覆盖；这里补 `2>&1` 之外的 fd 复制与 `<<<`/`2>`。
	if (/<<|&\s*\d|\d\s*>/.test(segment)) return false;
	const cmd = commandToken(segment);
	if (!cmd) return false;
	const name = basenameOf(cmd);
	const rest = segment.slice(segment.indexOf(cmd) + cmd.length).trim();
	const args = rest.split(/\s+/).filter(Boolean);
	if (name === "git") {
		const sub = args.find((a) => !a.startsWith("-"));
		return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
	}
	if (!READ_ONLY_COMMANDS.has(name)) return false;
	// sed -i / awk 的 system() 之类写路径。
	if (name === "sed" && args.some((a) => /^-[a-z]*i/.test(a) || a === "--in-place")) return false;
	if (name === "awk" && /system\s*\(/.test(rest)) return false;
	// 解释器：只放行 --version/--help 这类无副作用调用。
	if (name === "node" || name === "python" || name === "python3" || name === "npm") {
		return args.length > 0 && args.every((a) => INTERPRETER_SAFE_ARGS.has(a));
	}
	return true;
}

/**
 * bash 命令是否只读（纯函数）。规则：按 `;` `&&` `||` `|` 切段，**每段**都要
 * 只读；段内禁重定向 / 命令替换 / 后台 / heredoc；命令在白名单内，
 * git 只放只读子命令，解释器只放行 --version/--help。
 */
export function bashCommandIsReadOnly(cmd: string): boolean {
	const text = (cmd ?? "").trim();
	if (!text) return false;
	const segments = splitShellSegments(text);
	if (segments.length === 0) return false;
	return segments.every(segmentIsReadOnly);
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

/** 计划模式对一次工具调用的裁决：undefined = 放行。 */
export interface PlanModeDenial {
	reason: string;
	reasonEn: string;
	/** 归类，写进 details 供前端与回归判读。 */
	kind: "write-tool" | "bash" | "bypass-tool";
}

/**
 * 计划模式闸门（纯函数）：命中即拒绝，并把可操作的替代路径告诉模型。
 * - 写类工具 → 拒（提示：把要做的事写进计划，用户确认后另起一轮实施）
 * - bash 非常规命令 → 拒（提示：用 read/grep/只读 git，或给出计划）
 * - 旁路工具（spawn/delegate/目标模式/排程）→ 拒（会绕过本会话只读约束）
 */
export function planModeDenial(toolName: string, params: unknown): PlanModeDenial | undefined {
	const name = (toolName ?? "").trim();
	if (!name) return undefined;
	if (isSubagentToolName(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		if (!act || act === "spawn") {
			return {
				kind: "bypass-tool",
				reason: `计划模式：不能调用 subagent(action="spawn")（它会在别的会话里执行，绕过本会话的只读约束）。请在本对话内用只读工具完成调研。`,
				reasonEn: `Plan mode: subagent(action="spawn") is unavailable (it runs outside this conversation and would bypass the read-only constraint). Research with read-only tools here.`,
			};
		}
	}
	if (BYPASS_TOOLS.has(name)) {
		return {
			kind: "bypass-tool",
			reason: `计划模式：不能调用 ${name}（它会在别的会话里执行，绕过本会话的只读约束）。请在本对话内用只读工具完成调研。`,
			reasonEn: `Plan mode: ${name} is unavailable (it runs outside this conversation and would bypass the read-only constraint). Research with read-only tools here.`,
		};
	}
	if (BASH_TOOLS.has(name)) {
		const cmd = commandOf(params);
		if (cmd.trim() === "") {
			return {
				kind: "bash",
				reason: "计划模式：终端命令不可用。请用 read/grep/只读 git 完成调研。",
				reasonEn: "Plan mode: shell commands are unavailable. Use read/grep and read-only git instead.",
			};
		}
		if (bashCommandIsReadOnly(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `计划模式：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。请改用 read/grep/git status|diff|log 等只读手段；需要做的改动写进计划，等用户确认后实施。`,
			reasonEn: `Plan mode: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. Use read/grep or read-only git (status/diff/log). Put proposed changes in the plan and wait for the user's go-ahead.`,
		};
	}
	if (BLOCKED_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `计划模式：只规划不实施，${name} 被拒。请把这一步写进计划（plan_update 步骤 + 计划正文），等用户确认后在新一轮里实施。`,
			reasonEn: `Plan mode: planning only, no implementation — ${name} was rejected. Record it as a plan step (plan_update) and wait for the user to approve before implementing.`,
		};
	}
	return undefined;
}

/**
 * 计划模式系统提示词段（英文：进入模型上下文，按工具提示词卫生口径只写英文）。
 *
 * 头两条是这份提示词真正的载荷：**禁代码倾倒**（模型在本模式下写不出文件，
 * 于是会把整份实现当正文吐出来 —— 那既烧 token 又没落地，是计划模式最大的
 * 失败模式）与 **小需求走短计划**（一句话需求不必先跑一轮 plan_update 看板）。
 */
export const PLAN_MODE_SYSTEM_PROMPT = [
	"# Plan mode (planning only — do NOT implement)",
	"The user turned on plan mode for this conversation. Your job in this mode is to produce a concrete, executable plan — never to make the changes.",
	"## Hard rules",
	"- Read-only research only: read, grep/rg, ls, and read-only bash (git status/diff/log/show, cat, wc, head, tail, jq). Anything that writes is blocked by the server and the rejection comes back as a tool error.",
	"- Do not create, edit, move or delete files, do not run installs, builds, tests that write artifacts, and do not spawn subagents or start goal mode (those run outside this conversation).",
	"## Output shape (this is the part that matters most)",
	'- NEVER write the implementation. No full file bodies, no complete functions, no "here is the finished code", no working version of anything — it cannot be applied from this conversation and it wastes the user\'s tokens.',
	"- Describe the work instead: which files to create or change, the structure (modules / functions / state), the key decisions and their reasons, the risks and unknowns, how it is verified, and the first concrete step.",
	"- Code is allowed only as short illustrative snippets (about 20 lines each, at most two per plan) for genuinely tricky parts — a non-obvious algorithm or an API signature. No file dumps.",
	"- Keep the whole plan short: a screen or two. Depth beats length; if a decision is still open, list it as a question instead of exploring it in prose.",
	"## Plan board",
	'- For work with 3+ steps or real unknowns, call plan_update early with decision-ready steps (all status "pending") and refine it as you learn more.',
	'- For a small, unambiguous, greenfield request (e.g. "write a single-page snake game", "add a settings toggle", "rename this helper"), skip plan_update entirely and answer with the short plan: files to touch, structure, acceptance checks, first step.',
	"## Finishing",
	"- End with the plan and stop. Ask the user to confirm; implementation happens in the next turn after they turn plan mode off (or press the plan board's start-implementing action).",
	"- If the request is too ambiguous to plan, ask 1-3 targeted questions instead of guessing.",
].join("\n");

/**
 * 按设置面板偏好拼出生效的计划模式提示词（契约同 buildCommitMsgPrompt）：
 * append 把自定义文字接在内置默认之后（空自定义 = 纯默认）；replace 用自定义
 * 文字整体替换，但空自定义仍回落内置默认（绝不发空提示词）。
 */
export function buildPlanModePrompt(mode: "append" | "replace", custom: string): string {
	const text = custom?.trim() ?? "";
	if (mode === "replace" && text) return text;
	if (text) return `${PLAN_MODE_SYSTEM_PROMPT}\n\n${text}`;
	return PLAN_MODE_SYSTEM_PROMPT;
}

/** 拒给用户的界面文案（notice，zh + en 成对）。 */
export function planModeNoticeText(enabled: boolean): { text: string; textEn: string } {
	return enabled
		? {
				text: "📋 计划模式：只调研与出计划，不实施（写操作会被服务端拒绝）",
				textEn: "📋 Plan mode on: research and plan only — writes are blocked by the server",
			}
		: {
				text: "计划模式已关闭：恢复正常对话",
				textEn: "Plan mode off: back to normal",
			};
}
