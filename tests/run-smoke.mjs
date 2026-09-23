#!/usr/bin/env node
/**
 * run-smoke.mjs — 零 token 协议冒烟测试聚合跑器（本地与 CI 共用）。
 *
 * 顺序执行一组自起 server 的 *-test.mjs 脚本（各自独立端口 + 临时 data-dir，
 * 结束时自行清理）。任何一个失败不中断后续，最后汇总并以非零码退出。
 *
 * 不收录的脚本及原因：
 *   - 浏览器 E2E（playwright/chromium，路径写死本机）：*-browser*、scm-test、
 *     freeze、goal-pill/ui/rounds、panel/left/sound/settings-ui 等 → 本地手动跑；
 *   - 真模型 live：goal-review-loop、live-test（需已运行 server）、update-test。
 *
 * 用法：node tests/run-smoke.mjs [name1 name2 …]   # 无参 = 全量
 */
import { spawn } from "node:child_process";
import { isolatedTestEnv } from "./lib/isolated-env.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Windows 本机已知失败（非逻辑问题，ubuntu CI 正常）：
//   - terminal-smoke-test：node-pty 在 ConPTY 下 shell 退出事件/控制台列表 agent
//     （AttachConsole failed）行为差异，导致退出检测类检查超时；
//   - restart-handoff-test：所有断言通过后 libuv 在命名管道关闭时触发
//     win\\async.c 断言崩溃（退出码 127），属 libuv 关闭时序问题。
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	"ui-zoom-settings-test",
	"clear-provider-key-test",
	"conv-cross-project-test",
	"conv-cwd-test",
	"project-model-key-test",
	"plugin-jobs-test",
	// 插件目录授权的**接线**（request → 浏览器确认 → 落表 → 插件读得到 → 撤销）。
	"plugin-grants-test",
	"provider-oauth-test",
	"provider-keys-test",
	"db-client-test",
	"dsh-smoke-test",
	"dsh-stats-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	"left-panel-delete-test",
	"legado-web-engine-test",
	"legado-web-test",
	"list-files-missing-dir-test",
	// #262 regression: directory symlinks classify as dir on all platforms + "~/" expansion in the panel path bar (Android/Termux).
	"list-files-symlink-home-test",
	// 宿主 cron 引爆的溢出回归（远期 / 永不发生的表达式不能把服务打成死循环）。
	"plugin-cron-overflow-test",
	// 笔记插件（notes）：清单/HTTP 通道/长轮询推送/持久化（零 token，浏览器 E2E 另见 notes-ui-test）。
	"notes-test",
	"plugin-bgtask-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"plugin-proxy-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	// --build 自动推断 + --no-build + install --catalog（issue #165，零网络本地目录源）。
	"plugin-catalog-cli-test",
	"preview-test",
	// Express 5 *splat 多段数组回归（issue #225）：嵌套文件 HTTP 预览（__abs__/相对）。
	"preview-http-test",
	"quiesce-test",
	"question-bridge-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"restart-service-test",
	"running-list-test",
	"scm-features-test",
	"settings-test",
	"shutdown-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"subagent-template-test",
	"subagent-thinking-test",
	"subagent-ui-context-test",
	"switch-session-background-test",
	"cross-client-session-test",
	// 浏览器关闭重开后残留会话认领（无在线浏览器时新标签整体接管，有在线时不抢）。
	"orphan-adopt-test",
	// 手动过户：右键「另一处」行把对话（含等答复问卷）搬到本页，问卷可直接回答。
	"takeover-test",
	// 已结束对话的过户：run 跑完后 elsewhere 仍保留空闲行可过户；新页面不自动恢复别处持有的会话。
	"idle-takeover-test",
	// 跨页作答：点 elsewhere 行的 `?` 把问卷拉到本页回答，不搬迁对话。
	"remote-answer-test",
	"terminal-smoke-test",
	// 全局主机采样经心跳推送，不调用模型。
	"host-metrics-test",
	"token-auth-test",
	// Express 5 sendFile 隐藏目录 404 回归（issue #223）：data-dir 在点号目录下时主题 CSS 仍可达。
	"theme-dotfile-test",
	// 工具定义说明（工具卡右键 → 显示工具详细信息）：get_tool_info → tool_info 的归一化回归（零 token）。
	"tool-info-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
	// 额外工作区根（宿主侧多根，issue #146）：set_workspace_roots 落快照 + 插件受支持路径跨根。
	"workspace-roots-test",
];

// 不在默认清单里的脚本：
//   - 需外部已运行 server（attach 型，默认 8787）：ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test —— 本地先起 server 再单独跑；
//   - 需真模型（本地可跑，CI 无凭据必败）：goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
//     tool-status-test（需真模型执行 bash 工具，从仓库根或任意目录均可跑）；
//   - 平台相关：spawn-helper-test（macOS spawn-helper 二进制）；win32 下
//     terminal-smoke / restart-handoff 自动跳过（见 WIN32_KNOWN_ENV_FAIL）；
//   - title-jsonl-test：已修复（原 lsof/URL.pathname 的 Windows 兼容问题），本地可跑；
//   - 浏览器 E2E 见文件头注释（headless Chrome 路径写死本机）。

const targets = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const results = [];

for (const name of targets) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && process.argv.length <= 2) {
		results.push({ name, ok: true, skipped: true });
		console.log(`\n⏭ ${name} — Windows 环境已知噪音（node-pty/libuv），跳过；ubuntu CI 正常跑`);
		continue;
	}
	const file = join(here, `${name}.mjs`);
	process.stdout.write(`\n▶ ${name}\n`);
	const isolated = isolatedTestEnv(name);
	const ok = await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file], {
			// 测试脚本内相对路径（如 dist/server/index.js）以仓库根为基准
			cwd: dirname(here),
			stdio: "inherit",
			// 冒烟测试默认离线；专测预同步的脚本可显式覆盖为本地 fixture。
			// Fallback isolation for every subprocess; fixtures may override with their own temp dirs.
			env: isolated.env,
		});
		child.on("exit", (code) => resolveRun(code === 0));
		child.on("error", () => resolveRun(false));
	}).finally(isolated.cleanup);
	results.push({ name, ok });
}

console.log("\n===== 冒烟汇总 =====");
let failures = 0;
for (const r of results) {
	console.log(`${r.skipped ? "⏭" : r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? "（跳过）" : ""}`);
	if (!r.ok) failures++;
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
