/**
 * vscode-editor 客户端视图 —— 类 VSCode 的轻量编辑器 + Remote-SSH。
 *
 * 技术栈：CodeMirror 6（编辑器）+ xterm.js（远程终端），经 esbuild 打包进本文件，
 * 无运行时外部依赖。布局：左侧多根文件树（本地工作区 + SSH 主机）+ 右侧多标签
 * 编辑区 + 底部可拖拽终端面板；Ctrl+P 快速打开（本地）、Ctrl+S 保存（本地/远程）。
 *
 * 范围模型：scope = "local" | connId。文件树节点、标签页都携带 scope，
 * 所有文件操作（list/read/write/create/rename/delete）经 req() 自动附加
 * connId —— 服务端据此路由到本地 fs 或该连接的 SFTP，前后端共用一套代码路径。
 *
 * 与服务端（index.mjs）的协议：{ action, reqId, ... } 上行，
 * { res:true, reqId, ok, ... } 响应（reqId 匹配并发）；事件流 shell_data /
 * shell_exit / conn_closed / sync_progress 定向推送；kind:"state" 广播主机状态、
 * kind:"workspace" 广播工作区切换（主应用 set_cwd）。
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, dropCursor, highlightSpecialChars } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

let reqSeq = 0;

const b64 = {
	enc: (s) => btoa(unescape(encodeURIComponent(s))),
	bytes: (b64s) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)),
};

/** POSIX shell 单引号转义（cd 到含空格/引号的路径用） */
const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

// ---- 亮色主题适配 ----------------------------------------------------------
// 主应用切换主题后在 window 派发 pi-web-ui:theme-change（见 web/src/theme.ts）；
// 插件监听它，把 CodeMirror 与 xterm 切到对应明暗。亮暗判定读 documentElement
// 的 color-scheme——浅色主题文件统一声明 `color-scheme: light`，默认深色无声明
// （computed 为 normal）即按暗色处理。
const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";
function isLightTheme() {
	try {
		return getComputedStyle(document.documentElement).getPropertyValue("color-scheme").trim().startsWith("light");
	} catch { return false; }
}
/** --term-* 调色板 → xterm theme（与主应用 buildTermTheme 同源，见 web/src/theme.ts） */
function buildTermTheme() {
	let cs = null;
	try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
	const v = (name, fallback) => {
		try {
			const val = cs?.getPropertyValue(name).trim();
			return val || fallback;
		} catch { return fallback; }
	};
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#8b5cf6"),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
/** 亮色 CodeMirror 壳：跟随 --bg/--text/--accent；语法色沿用自带的
 *  defaultHighlightStyle（本就是按浅色底设计的，makeExtensions 里常驻）。 */
const cmLight = EditorView.theme(
	{
		"&": { backgroundColor: "var(--bg, #ffffff)", color: "var(--text, #1f2328)" },
		".cm-content": { caretColor: "var(--accent, #0969da)" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #0969da)" },
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 8%, transparent)" },
		".cm-activeLineGutter": { backgroundColor: "transparent" },
		".cm-gutters": {
			backgroundColor: "var(--bg, #ffffff)",
			color: "var(--text-faint, #818b98)",
			borderRight: "1px solid var(--border, #d0d7de)",
		},
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 18%, transparent)" },
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
			backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 22%, transparent)",
		},
	},
	{ dark: false },
);

// ---- 语言检测 -----------------------------------------------------------

const LANGS = [
	[/\.(jsx?|mjs|cjs)$/, () => javascript()],
	[/\.tsx?$/, () => javascript({ typescript: true })],
	[/\.json5?$/, () => json()],
	[/\.css$/, () => css()],
	[/\.(html?|vue|svelte)$/, () => html()],
	[/\.(md|markdown)$/, () => markdown()],
	[/\.py$/, () => python()],
];

function langFor(path) {
	const p = path.toLowerCase();
	for (const [re, make] of LANGS) if (re.test(p)) return make();
	return null;
}

function langName(path) {
	if (/\.tsx?$/.test(path)) return "TypeScript";
	if (/\.(jsx?|mjs|cjs)$/.test(path)) return "JavaScript";
	if (/\.json5?$/.test(path)) return "JSON";
	if (/\.css$/.test(path)) return "CSS";
	if (/\.(html?|vue|svelte)$/.test(path)) return "HTML";
	if (/\.(md|markdown)$/.test(path)) return "Markdown";
	if (/\.py$/.test(path)) return "Python";
	return "Plain Text";
}

// ---- 文件图标 ------------------------------------------------------------

function iconFor(name, type) {
	if (type === "dir") return "📁";
	const ext = (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
	const map = {
		js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "⚛️", ts: "🟦", tsx: "⚛️",
		json: "🔧", md: "📝", css: "🎨", html: "🌐", py: "🐍",
		png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", svg: "🖼",
		lock: "🔒", yml: "⚙️", yaml: "⚙️", toml: "⚙️", sh: "💻", bat: "💻",
	};
	return map[ext] || "📄";
}

// ---- 模糊匹配（快速打开 Ctrl+P 用）：返回得分或 -1 -----------------------

export function fuzzyScore(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0, score = 0, streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak; // 连续命中加权
			qi++;
		} else streak = 0;
	}
	if (qi < q.length) return -1;
	// 短文件名 / 靠前命中加分
	score += Math.max(0, 40 - t.length) / 10;
	return score;
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="vsc">
	<style>${xtermCss}</style>
	<style>
		.vsc { position: relative; display: flex; height: 100%; min-height: 480px;
			overflow: hidden;
			background: var(--bg, #101016); color: var(--text, #e6e6ef); font-size: 13px; }
		/* ---- 左侧多根文件树 ---- */
		.vsc-side { width: 240px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-side-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px;
			font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.vsc-side-head b { flex: 1; font-weight: 600; }
		.vsc-side-head button { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
		.vsc-side-head button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- 侧栏双 tab：文件 / SSH ---- */
		.vsc-stabs { display: flex; gap: 4px; padding: 6px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-stabs .stab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.vsc-stabs .stab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent);
			opacity: 1; font-weight: 600; }
		.vsc-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.vsc-hosts { flex-shrink: 0; max-height: 32%; overflow: auto; padding: 2px 0 6px; user-select: none; }
		.vsc-sshtree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 12px; user-select: none;
			border-top: 1px solid var(--border, #333); }
		.vsc-sect .cwd { opacity: .45; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; direction: rtl; }
		.vsc-tree { flex: 1; overflow: auto; padding: 2px 0 12px; user-select: none; }
		.vsc-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			white-space: nowrap; line-height: 1.7; }
		.vsc-row:hover { background: var(--bg-elev2, #20202b); }
		.vsc-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		/* 选中态（区别于打开文件的 active）：提示工具栏新建的落点 */
		.vsc-row.sel { background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			box-shadow: inset 2px 0 0 var(--accent, #7c5cff); }
		.vsc-row.loading { opacity: .45; }
		/* 拖拽上传落点高亮 */
		.vsc-row.drop-target { outline: 1px dashed var(--accent, #7c5cff); outline-offset: -2px;
			background: color-mix(in srgb, var(--accent, #7c5cff) 16%, transparent); }
		.vsc-tree.drop-root, .vsc-sshtree.drop-root { outline: 2px dashed var(--accent, #7c5cff); outline-offset: -2px; }
		.vsc-status .vsc-up { color: var(--amber, #fbbf24); }
		.vsc-row .caret { width: 12px; text-align: center; opacity: .55; font-size: 9px; flex-shrink: 0; }
		.vsc-row .nm { overflow: hidden; text-overflow: ellipsis; }
		.vsc-sect { display: flex; align-items: center; gap: 4px; padding: 8px 8px 3px;
			font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; opacity: .75; }
		.vsc-sect b { flex: 1; font-weight: 600; }
		.vsc-sect button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
		.vsc-sect button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-hrow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
			background: var(--text-dim, #666); }
		.vsc-hrow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.vsc-hrow .dot.busy { background: var(--amber, #fbbf24); animation: vscpulse 1s infinite alternate; }
		@keyframes vscpulse { from { opacity: .4 } to { opacity: 1 } }
		.vsc-hrow .ops { display: none; gap: 2px; margin-left: auto; }
		.vsc-hrow:hover .ops { display: flex; }
		.vsc-hrow .ops button { all: unset; cursor: pointer; padding: 0 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.vsc-hrow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.vsc-deps { padding: 4px 10px; }
		.vsc-deps button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 4px 8px; border-radius: 5px; font-size: 11.5px; color: var(--amber, #fbbf24); }
		.vsc-deps button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- 右侧主区 ---- */
		.vsc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		.vsc-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev, #16161d); scrollbar-width: thin; }
		.vsc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px;
			cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
			color: var(--text-dim, #9a9ab0); max-width: 200px; }
		.vsc-tab.active { background: var(--bg, #101016); color: var(--text, #e6e6ef);
			box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
		.vsc-tab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-tab .dot { color: var(--amber, #fbbf24); }
		.vsc-tab .x { all: unset; cursor: pointer; padding: 0 3px; border-radius: 4px; opacity: .55; }
		.vsc-tab .x:hover { opacity: 1; background: var(--bg-elev2, #20202b); }
		.vsc-edwrap { flex: 1; min-height: 0; position: relative; }
		.vsc-empty { position: absolute; inset: 0; display: grid; place-items: center;
			opacity: .45; text-align: center; line-height: 2; }
		.vsc-editor { height: 100%; }
		.vsc-editor .cm-editor { height: 100%; }
		.vsc-editor .cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
		/* ---- 底部终端面板 ---- */
		.vsc-termdrag { height: 4px; cursor: row-resize; flex-shrink: 0;
			background: var(--bg-elev, #16161d); border-top: 1px solid var(--border, #333); }
		.vsc-termdrag:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent); }
		.vsc-termpanel { height: 240px; min-height: 80px; display: flex; flex-direction: column;
			flex-shrink: 0; background: var(--term-bg, #101016); }
		.vsc-termbar { display: flex; align-items: center; gap: 4px; padding: 3px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; user-select: none; }
		.vsc-termbar .tt { opacity: .6; text-transform: uppercase; letter-spacing: .06em; font-size: 10.5px; margin-right: 4px; }
		.vsc-termbar .grow { flex: 1; }
		.vsc-termbar button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 12px; }
		.vsc-termbar button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-ttab { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			border-radius: 5px; color: var(--text-dim, #9a9ab0); white-space: nowrap; max-width: 180px; }
		.vsc-ttab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); color: var(--text, #e6e6ef); }
		.vsc-ttab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-ttab .x { all: unset; cursor: pointer; opacity: .5; font-size: 10px; padding: 0 2px; }
		.vsc-ttab .x:hover { opacity: 1; }
		.vsc-termarea { flex: 1; min-height: 0; position: relative; padding: 4px 6px; }
		.vsc-term { position: absolute; inset: 4px 6px; }
		.vsc-term .xterm { height: 100%; }
		/* ---- 状态栏 ---- */
		.vsc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px;
			border-top: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; color: var(--text-dim, #9a9ab0); }
		.vsc-status .grow { flex: 1; }
		.vsc-status .dirty { color: var(--amber, #fbbf24); }
		.vsc-status .remote { color: var(--green, #4ade80); }
		.vsc-err { color: var(--red, #f87171); }
		/* 快速打开弹层 */
		.vsc-quickopen { position: absolute; left: 50%; top: 40px; transform: translateX(-50%);
			width: min(520px, 80%); z-index: 30; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 10px;
			box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
		.vsc-quickopen input { width: 100%; box-sizing: border-box; background: transparent; color: inherit;
			border: 0; outline: 0; padding: 10px 14px; font: inherit; border-bottom: 1px solid var(--border, #333); }
		.vsc-quickopen ul { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow: auto; }
		.vsc-quickopen li { padding: 5px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
		.vsc-quickopen li.sel, .vsc-quickopen li:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); }
		.vsc-quickopen li small { opacity: .5; margin-left: auto; direction: rtl; }
		.vsc-hidden { display: none !important; }
		/* 树上右键菜单 / 同步菜单 */
		.vsc-menu { position: absolute; z-index: 40; min-width: 150px; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 8px; padding: 4px;
			box-shadow: 0 10px 30px rgba(0,0,0,.4); }
		.vsc-menu button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 5px 10px; border-radius: 5px; font: inherit; }
		.vsc-menu button:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent); }
		.vsc-menu button.dim { opacity: .55; }
		/* 同步进度浮条 */
		.vsc-sync-status { position: absolute; right: 14px; bottom: 44px; z-index: 25; max-width: 70%;
			background: var(--bg-elev2, #20202b); border: 1px solid var(--accent, #7c5cff); border-radius: 8px;
			padding: 6px 12px; font-size: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
		/* 弹层（主机表单 / 同步配置共用样式） */
		.vsc-modal-bg { position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.45);
			display: grid; place-items: center; }
		.vsc-modal { width: min(430px, 90%); max-height: 94%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.vsc-modal h3 { margin: 0 0 10px; }
		.vsc-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 9px 0 3px; }
		.vsc-modal input, .vsc-modal textarea { width: 100%; box-sizing: border-box; background: var(--bg, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.vsc-modal textarea { font: 12px ui-monospace, monospace; resize: vertical; }
		.vsc-modal .grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
		.vsc-modal .hint { font-size: 11px; opacity: .5; margin-top: 8px; line-height: 1.6; }
		.vsc-modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
		.vsc-modal .btns button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); }
		.vsc-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.vsc-modal .btns button:hover { filter: brightness(1.15); }
		/* ---- 手机窄屏适配（≤640px）：桌面端零变化 ---- */
		.vsc-mobilebar { display: none; }
		.vsc-backdrop { display: none; }
		@media (max-width: 640px) {
			/* 主区顶栏：窄屏工具条（☰ + 标题），桌面端隐藏 */
			.vsc-mobilebar { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
				border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
			.vsc-mobilebar .vsc-burger { all: unset; cursor: pointer; font-size: 18px;
				padding: 6px 10px; border-radius: 6px; line-height: 1; }
			.vsc-mobilebar .vsc-burger:hover { background: var(--bg-elev2, #20202b); }
			.vsc-mobilebar .vsc-mtitle { flex: 1; overflow: hidden; text-overflow: ellipsis;
				white-space: nowrap; font-size: 12px; opacity: .7; }
			/* 侧栏变左侧覆盖式抽屉 */
			.vsc-side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 35;
				width: min(280px, 82vw); max-width: 82vw;
				transform: translateX(-105%); transition: transform .22s ease; }
			.vsc.drawer-open .vsc-side { transform: none;
				box-shadow: 8px 0 28px rgba(0,0,0,.5); }
			.vsc.drawer-open .vsc-backdrop { display: block; position: absolute; inset: 0; z-index: 30;
				background: rgba(0,0,0,.45); }
			/* 底部终端面板：占全宽、高度可控，不挤没编辑器 */
			.vsc-termpanel { width: 100%; max-height: 45dvh; }
			.vsc-termbar { min-height: 40px; }
			/* tabs 横滑 + 触摸目标放大 */
			.vsc-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
			.vsc-tab { padding: 8px 8px 8px 12px; }
			.vsc-tab .x { padding: 6px 8px; font-size: 13px; }
			.vsc-hrow .ops button { padding: 6px 8px; font-size: 12px; }
			.vsc-side-head button, .vsc-sect button, .vsc-termbar button { padding: 5px 9px; }
			/* iOS 聚焦缩放：表单字号提到 16px（CodeMirror 编辑区不动） */
			.vsc-quickopen input, .vsc-modal input, .vsc-modal select, .vsc-modal textarea { font-size: 16px; }
			.vsc-modal .grid2 { grid-template-columns: 1fr; }
			.vsc-modal { width: min(430px, 94%); }
			.vsc-quickopen { width: min(520px, 94%); }
			.vsc-status { gap: 8px; overflow-x: auto; white-space: nowrap; }
			.vsc-status .vsc-path { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
		}
		/* 触屏无 hover：行操作按钮常显 */
		@media (hover: none) {
			.vsc-hrow .ops { display: flex; }
		}
	</style>
	<div class="vsc-side">
		<div class="vsc-stabs">
			<button class="stab active" data-pane="files">📁 文件</button>
			<button class="stab" data-pane="ssh">🖥 SSH</button>
		</div>
		<div class="vsc-pane" data-pane="files">
			<div class="vsc-side-head">
				<span style="flex:1"></span>
				<button data-act="new-file" title="新建文件（当前选中的目录）">📄</button>
				<button data-act="new-dir" title="新建文件夹（当前选中的目录）">📁</button>
				<button data-act="upload" title="上传文件到工作区根目录（也可拖拽到文件树）">⬆</button>
				<button data-act="sync-menu" title="同步到服务器（SFTP）">☁</button>
				<button data-act="search" title="按文件名搜索（本地工作区）">🔍</button>
				<button data-act="refresh" title="刷新">⟳</button>
			</div>
			<div class="vsc-tree"></div>
		</div>
		<div class="vsc-pane vsc-hidden" data-pane="ssh">
			<div class="vsc-side-head">
				<span style="flex:1"></span>
				<button data-act="add-host" title="添加主机">🏠</button>
				<button data-act="deps" class="vsc-hidden" title="安装 ssh2 依赖">⚠ssh2</button>
				<button data-act="new-term" title="新建远程终端">🖥</button>
				<button data-act="r-new-file" title="新建文件（当前选中的目录）">📄</button>
				<button data-act="r-new-dir" title="新建文件夹（当前选中的目录）">📁</button>
				<button data-act="r-upload" title="上传文件到当前选中目录">⬆</button>
				<button data-act="r-search" title="按文件名搜索（远端）">🔍</button>
				<button data-act="r-refresh" title="刷新远端目录">⟳</button>
			</div>
			<div class="vsc-hosts"></div>
			<div class="vsc-sshtree"></div>
		</div>
	</div>
	<div class="vsc-backdrop"></div>
	<div class="vsc-main">
		<div class="vsc-mobilebar">
			<button class="vsc-burger" title="文件树">☰</button>
			<span class="vsc-mtitle">文件</span>
		</div>
		<div class="vsc-tabs"></div>
		<div class="vsc-edwrap">
			<div class="vsc-empty">从左侧打开一个文件开始编辑<br><small>Ctrl+P 快速打开 · Ctrl+S 保存</small></div>
			<div class="vsc-editor vsc-hidden"></div>
		</div>
		<div class="vsc-termdrag vsc-hidden"></div>
		<div class="vsc-termpanel vsc-hidden">
			<div class="vsc-termbar">
				<span class="tt">终端</span>
				<span class="tts"></span>
				<button class="t-add" title="新建终端">＋</button>
				<span class="grow"></span>
				<button class="t-hide" title="收起面板">▾</button>
			</div>
			<div class="vsc-termarea"></div>
		</div>
		<div class="vsc-status">
			<span class="vsc-scope"></span>
			<span class="vsc-path">—</span>
			<span class="grow"></span>
			<span class="vsc-lang"></span>
			<span class="vsc-pos"></span>
			<span class="vsc-up"></span>
			<span class="vsc-state"></span>
		</div>
	</div>
	<div class="vsc-quickopen vsc-hidden">
		<input placeholder="输入文件名筛选…（Esc 关闭）" />
		<ul></ul>
	</div>
	<input type="file" multiple class="vsc-filepick vsc-hidden" />
	<div class="vsc-menu vsc-hidden"></div>
	<div class="vsc-sync-status vsc-hidden"></div>
	<div class="vsc-modal-bg vsc-hidden">
		<div class="vsc-modal">
			<h3>同步配置（SFTP）</h3>
			<label>名称（可选，仅作标识）</label><input name="s-name" placeholder="my-server" />
			<label>主机地址 *</label><input name="s-host" placeholder="192.168.1.10" />
			<div class="grid2">
				<span><label>用户名</label><input name="s-user" value="root" /></span>
				<span><label>端口</label><input name="s-port" value="22" /></span>
			</div>
			<label>密码（留空 = 保持不变）</label><input name="s-pass" type="password" autocomplete="off" />
			<label>私钥（PEM，可选）</label><textarea name="s-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>私钥路径（可选，支持 ~ 展开如 ~/.ssh/id_rsa；填写则优先使用）</label><input name="s-keypath" placeholder="~/.ssh/id_rsa" />
			<label>SSH agent socket（可选，如 $SSH_AUTH_SOCK；与密码/私钥二选一）</label><input name="s-agent" placeholder="$SSH_AUTH_SOCK" />
			<label>远端根目录 *（项目同步到服务器的哪个目录）</label><input name="s-root" placeholder="/var/www/app" />
			<label>排除项（vscode-sftp 风格 glob，逗号分隔）</label><input name="s-exclude" placeholder="node_modules/**, dist, *.log" />
			<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="s-autosave" style="width:auto" /> 保存时自动上传当前文件（vscode-sftp 的 uploadOnSave）</label>
			<div class="hint">配置保存在工作区 <b>.vscode/sftp.json</b>（与 vscode-sftp / Natizyskunk.sftp 兼容格式），可直接编辑该文件、Ctrl+S 保存即生效。支持 name / passphrase / privateKeyPath（~ 展开）/ agent（\$SSH_AUTH_SOCK）/ ignore glob / watcher.autoUpload。</div>
			<div class="btns"><button class="cancel">取消</button><button class="test">测试连接</button><button class="primary save-cfg">保存</button></div>
		</div>
	</div>
	<div class="vsc-modal-bg vsc-host-bg vsc-hidden">
		<div class="vsc-modal">
			<h3 class="h-title">新建主机</h3>
			<label>名称（可选）</label><input name="h-name" placeholder="my-server" />
			<div class="grid2">
				<span><label>主机地址 *</label><input name="h-host" placeholder="192.168.1.10" /></span>
				<span><label>端口</label><input name="h-port" value="22" /></span>
			</div>
			<label>用户名</label><input name="h-user" value="root" />
			<label>密码（编辑时留空 = 保持不变）</label><input name="h-pass" type="password" autocomplete="off" />
			<label>私钥（PEM，可选）</label><textarea name="h-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>私钥路径（可选，支持 ~ 展开如 ~/.ssh/id_rsa；填写则优先使用，不必粘贴私钥全文）</label><input name="h-keypath" placeholder="~/.ssh/id_rsa" />
			<label>私钥口令 passphrase（可选，带口令的私钥用）</label><input name="h-pp" type="password" autocomplete="off" />
			<label>SSH agent socket（可选，如 $SSH_AUTH_SOCK；与密码/私钥二选一）</label><input name="h-agent" placeholder="$SSH_AUTH_SOCK" />
			<div class="hint">凭据只保存在本机插件目录（ssh-hosts.json），不会上传。密码 / 私钥 / 私钥路径 / agent 四选一即可。<br>已有 ~/.ssh/config 的无需导入——SSH 面板「⚙ ssh config」自动加载（与 VSCode Remote-SSH 同源，支持 Include / ProxyJump / ProxyCommand），点别名直连。</div>
			<div class="sshcfg-import vsc-hidden"></div>
			<div class="btns"><button class="cancel">取消</button><button class="import-cfg" title="从 ~/.ssh/config 批量导入主机">从 ssh config 导入</button><button class="primary save-host">保存</button></div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".vsc");
		const treeEl = root.querySelector(".vsc-tree");
		const hostsEl = root.querySelector(".vsc-hosts");
		const sshTreeEl = root.querySelector(".vsc-sshtree");
		const tabsEl = root.querySelector(".vsc-tabs");
		const edHost = root.querySelector(".vsc-editor");
		const emptyEl = root.querySelector(".vsc-empty");
		const stScope = root.querySelector(".vsc-scope");
		const stPath = root.querySelector(".vsc-path");
		const stLang = root.querySelector(".vsc-lang");
		const stPos = root.querySelector(".vsc-pos");
		const stState = root.querySelector(".vsc-state");
		const stUp = root.querySelector(".vsc-up");
		const quick = root.querySelector(".vsc-quickopen");
		const quickInput = quick.querySelector("input");
		const quickList = quick.querySelector("ul");
		const menuEl = root.querySelector(".vsc-menu");
		const filePick = root.querySelector(".vsc-filepick");
		const syncStatusEl = root.querySelector(".vsc-sync-status");
		const syncBg = root.querySelector(".vsc-modal-bg:not(.vsc-host-bg)");
		const hostBg = root.querySelector(".vsc-host-bg");
		const dragEl = root.querySelector(".vsc-termdrag");
		const panelEl = root.querySelector(".vsc-termpanel");
		const termTabsEl = root.querySelector(".vsc-termbar .tts");
		const termAreaEl = root.querySelector(".vsc-termarea");

		// ---- 手机端抽屉（窄屏 ☰ 开关；桌面端无影响） ----
		const burger = root.querySelector(".vsc-burger");
		const backdrop = root.querySelector(".vsc-backdrop");
		function closeDrawer() { root.classList.remove("drawer-open"); }
		if (burger) burger.addEventListener("click", () => root.classList.toggle("drawer-open"));
		if (backdrop) backdrop.addEventListener("click", closeDrawer);

		// ---- 请求/响应 -------------------------------------------------------
		const pending = new Map(); // reqId → {resolve}
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => {
					if (pending.delete(reqId)) resolve({ ok: false, error: "请求超时" });
				}, 60000);
			});
		}
		/** scope 路由：remote（connId）自动附加 connId，其余直发 */
		function req(scope, payload) {
			return scope === "local" ? request(payload) : request({ connId: scope, ...payload });
		}

		function toast(text) {
			root.dispatchEvent(new CustomEvent("vsc-toast", { detail: text, bubbles: true }));
			stState.textContent = text;
			stState.classList.add("vsc-err");
			setTimeout(() => { stState.textContent = ""; stState.classList.remove("vsc-err"); }, 4000);
		}

		/** 复制路径（剪贴板 API 不可用时回落 textarea+execCommand，与右栏同口径） */
		function copyText(text) {
			const done = () => toast("已复制路径");
			const fallback = () => {
				try {
					const ta = document.createElement("textarea");
					ta.value = text;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
					done();
				} catch { toast("复制失败"); }
			};
			try {
				if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, fallback);
				else fallback();
			} catch { fallback(); }
		}

		async function pasteClipboardTo(scope, dir) {
			if (!clipboard || clipboard.scope !== scope) { toast("剪贴板为空（先右键复制/剪切一个文件）"); return; }
			const dest = dir ? `${dir.replace(/\/$/, "")}/${clipboard.src.split("/").pop()}` : clipboard.src.split("/").pop();
			if (dest === clipboard.src) { toast("源与目标相同"); return; }
			const wasCut = clipboard.cut;
			const src = clipboard.src;
			const r = await req(scope, { action: "copy", src, dest, move: wasCut });
			if (!r.ok) { toast(`粘贴失败：${r.error}`); return; }
			if (wasCut) {
				clipboard = null;
				for (const k of [...tabs.keys()]) {
					const { scope: s, path } = parseTk(k);
					if (s === scope && (path === src || path.startsWith(src + "/"))) void closeTab(k);
				}
			}
			await invalidateScope(scope);
		}

		/** 创建副本：foo.js → foo_copy.js（重名自动 _copy2…；目录同理，落在源旁边） */
		async function duplicateEntry(scope, srcW, type) {
			const dir = scope === "local" ? localParentOf(srcW) : parentOf(srcW);
			const base = srcW.split("/").pop();
			const dot = type === "dir" ? -1 : base.lastIndexOf(".");
			const stem = dot > 0 ? base.slice(0, dot) : base;
			const ext = dot > 0 ? base.slice(dot) : "";
			let siblings = new Set();
			try {
				const r = await req(scope, { action: "list", dir: dir === "" ? "" : dir });
				if (r.ok) siblings = new Set((r.entries ?? []).map((e) => e.name));
			} catch {}
			for (let i = 0; i < 20; i++) {
				const name = i === 0 ? `${stem}_copy${ext}` : `${stem}_copy${i + 1}${ext}`;
				if (siblings.has(name)) continue;
				const dest = dir ? `${dir.replace(/\/$/, "")}/${name}` : name;
				const r = await req(scope, { action: "copy", src: srcW, dest });
				if (r.ok) {
					selNode = { scope, path: dest, type }; // 新副本成为选中项
					await invalidateScope(scope);
					return;
				}
				if (!String(r.error ?? "").includes("已存在")) { toast(`创建副本失败：${r.error}`); return; }
			}
			toast("创建副本失败：重名次数过多");
		}

		// ---- 状态 ------------------------------------------------------------
		let S = { depsReady: true, depsInstalling: false, hosts: [], conns: [], configHosts: [], configPath: "~/.ssh/config" }; // 服务端广播
		const conns = new Map(); // connId → { label, cwd }
		const connecting = new Set(); // 正在连接中的 hostId
		const expanded = new Set(["local:"]); // 已展开目录（scope:path）
		const dirCache = new Map(); // `${scope}:${dir}` → entries
		const flatFiles = new Set(); // 本地文件路径（Ctrl+P 数据源）
		const tabs = new Map(); // tabKey → {scope, path, name, savedText, binary, dirty, crlf}
		let activeTk = null;
		let selNode = null; // 最近点选的节点 {scope, path, type}——高亮 + 新建文件/文件夹的落点
		let clipboard = null; // {scope, src, cut}——复制/剪切后待粘贴（仅同 scope 内粘贴，与右栏文件列表同口径）

		const tkey = (scope, p) => `${scope}:${p}`;
		function parseTk(k) {
			const i = k.indexOf(":");
			return { scope: k.slice(0, i), path: k.slice(i + 1) };
		}
		function connMeta(connId) {
			return S.conns.find((x) => x.connId === connId);
		}
		function connOfHost(hostId) {
			for (const id of conns.keys()) {
				if (connMeta(id)?.hostId === hostId) return id;
			}
			return null;
		}
		function connLabel(connId) {
			return conns.get(connId)?.label ?? connMeta(connId)?.label ?? connId;
		}

		/** 应用主机状态（初始拉取或广播）；顺带收养服务端仍持有的连接——
		 *  刷新页面后远程目录树立即可见，不用重新连一遍 */
		function applyState(next) {
			S = next ?? S;
			for (const c of S.conns) {
				if (c.status === "connected" && !conns.has(c.connId)) {
					conns.set(c.connId, { label: c.label, cwd: "/" });
				}
			}
			void renderTree();
			renderHosts();
		}

		// ---- 编辑器 ----------------------------------------------------------
		const langComp = new Compartment();
		// 主题跟随：亮色用 cmLight、暗色用 oneDark（Compartment 热切换，无需重建编辑器）
		const themeComp = new Compartment();

		function makeExtensions() {
			return [
				lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
				history(), foldGutter(), drawSelection(), dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(), indentUnit.of("    "), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(),
				crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
					...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
					indentWithTab,
					// 最高优先级：编辑器内 Ctrl+S / Ctrl+P 不被默认 keymap 吃掉
					Prec.highest(keymap.of([
						{ key: "Mod-s", run: () => { void saveActive(); return true; } },
						{ key: "Mod-p", run: () => { openQuickOpen(); return true; } },
					])),
				]),
				langComp.of(langFor(parseTk(activeTk ?? "local:")?.path ?? "") ?? []),
				themeComp.of(isLightTheme() ? cmLight : oneDark),
				EditorView.updateListener.of((u) => {
					if (u.docChanged || u.selectionSet) updateStatus(u.state);
					if (u.docChanged) {
						// 事件驱动脏标记：只有真实编辑才置脏。不能用「doc !== savedText」
						// 判断——CodeMirror 内部把 \r\n 归一化成 \n，CRLF 文件刚打开
						// 就会被误判为未保存。
						const t = tabs.get(activeTk);
						if (t && !t.binary && !t.dirty) {
							t.dirty = true;
							renderTabs();
						}
					}
				}),
			];
		}

		const view = new EditorView({ state: EditorState.create({ extensions: makeExtensions() }), parent: edHost });

		function currentDoc() { return view.state.doc.toString(); }

		function updateStatus(state) {
			const head = state.selection.main.head;
			const line = state.doc.lineAt(head);
			stPos.textContent = `第 ${line.number} 行 · 第 ${head - line.from + 1} 列`;
			if (activeTk) {
				const t = tabs.get(activeTk);
				stState.textContent = t?.binary ? "二进制（只读）" : t?.dirty ? "未保存 ●" : "已保存";
				stState.classList.toggle("dirty", !!t?.dirty);
			}
		}

		// ---- 文件树渲染（本地 + 远程多根） --------------------------------------
		async function ensureDir(scope, dirWire) {
			const key = tkey(scope, dirWire ?? "");
			if (!dirCache.has(key)) {
				const r = await req(scope, { action: "list", dir: dirWire ?? "" });
				if (!r.ok) { toast(`读取目录失败：${r.error}`); return []; }
				dirCache.set(key, r.entries);
				if (scope === "local") { // Ctrl+P 只索引本地
					for (const e of r.entries) {
						if (e.type === "file") flatFiles.add(dirWire ? `${dirWire}/${e.name}` : e.name);
					}
				}
			}
			return dirCache.get(key);
		}

		/** 侧栏双 tab 切换：文件 / SSH */
		function switchPane(name) {
			root.querySelectorAll(".vsc-stabs .stab").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
			root.querySelectorAll(".vsc-pane").forEach((p) => p.classList.toggle("vsc-hidden", p.dataset.pane !== name));
		}
		root.querySelector(".vsc-stabs").addEventListener("click", (ev) => {
			const b = ev.target.closest(".stab");
			if (b) switchPane(b.dataset.pane);
		});

		// 整树重绘都是「清空 → 异步填充」两步：并发调用会交错——后一个清了前一个的
		// 半成品，前一个的异步 append 又落进后一个的树里，最终同一份列表重复出现
		// （挂载时初始 renderTree 与 state 广播触发的 renderTree 并发就是这种情形，
		// 点一下 ⟳ 刷新才正常）。所有整树异步重绘走同一串行队列，一次只跑一个。
		let renderChain = Promise.resolve();
		function enqueue(fn) {
			renderChain = renderChain.then(fn, fn);
			return renderChain;
		}

		async function renderTree() {
			await enqueue(async () => {
				// 重渲染前后保住滚动位置——否则点开文件/状态广播后树跳回顶部，
				// 用户得重新滚回刚才看的地方
				const st = treeEl.scrollTop;
				treeEl.innerHTML = "";
				// 文件 tab 只管本地工作区；远程目录树归 SSH tab（renderRemoteTrees）
				const lh = document.createElement("div");
				lh.className = "vsc-sect";
				lh.innerHTML = `<b>📁 本地工作区</b>`;
				treeEl.appendChild(lh);
				await renderDir("local", "", treeEl, 0);
				renderTreeHighlight();
				applySelHighlight();
				treeEl.scrollTop = st;
			});
		}

		/** SSH tab：主机列表（状态点 / 连接·断开 / 终端 / 编辑 / 删除） */
		function renderHosts() {
			const st = hostsEl.scrollTop;
			hostsEl.innerHTML = "";
			const depsBtn = root.querySelector('.vsc-pane[data-pane="ssh"] button[data-act="deps"]');
			depsBtn.classList.toggle("vsc-hidden", Boolean(S.depsReady));
			depsBtn.title = S.depsInstalling ? "依赖安装中…" : "安装 ssh2 依赖";
			if (!S.depsReady && S.depsInstalling) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "依赖安装中…";
				hostsEl.appendChild(d);
			}
			if (!S.hosts.length && !(S.configHosts ?? []).length) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				const btn = document.createElement("button");
				btn.textContent = "还没有主机，点击添加";
				btn.addEventListener("click", () => openHostModal(null));
				d.appendChild(btn);
				hostsEl.appendChild(d);
			}
			// ~/.ssh/config 自动加载区（与 VSCode Remote-SSH 同源）：免导入直连
			if ((S.configHosts ?? []).length) {
				const sec = document.createElement("div");
				sec.className = "vsc-sect";
				sec.innerHTML = `<b>⚙ ssh config（自动加载）</b>`;
				const edit = document.createElement("button");
				edit.textContent = "✎";
				edit.title = `编辑 ${S.configPath ?? "~/.ssh/config"}（与 VSCode 写法完全一样）`;
				edit.addEventListener("click", () => void openSshConfigEditor());
				sec.appendChild(edit);
				hostsEl.appendChild(sec);
				for (const c of S.configHosts) renderConfigRow(c);
			}
			if ((S.configHosts ?? []).length && S.hosts.length) {
				const sec = document.createElement("div");
				sec.className = "vsc-sect";
				sec.innerHTML = `<b>🏠 手动主机</b>`;
				hostsEl.appendChild(sec);
			}
			for (const h of S.hosts) renderHostRow(h);
			hostsEl.scrollTop = st;
			void renderRemoteTrees(); // SSH tab 下半区：已连接主机的远程目录树
		}

		/** SSH tab 下半区：每台已连接主机的远程目录树（与文件 tab 完全独立） */
		async function renderRemoteTrees() {
			// 与 renderTree 同一队列：并发时防止交错 append 导致远端树重复
			await enqueue(async () => {
				const st = sshTreeEl.scrollTop;
				sshTreeEl.innerHTML = "";
				for (const [connId, c] of conns) {
					const sec = document.createElement("div");
					sec.className = "vsc-sect";
					sec.innerHTML = `<b>🖥 ${esc(c.label)}</b><span class="cwd" title="${esc(c.cwd)}">${esc(c.cwd)}</span>`;
					sshTreeEl.appendChild(sec);
					const sub = document.createElement("div");
					sshTreeEl.appendChild(sub);
					await renderConnTree(connId, sub);
				}
				if (!conns.size) {
					const d = document.createElement("div");
					d.className = "vsc-deps";
					d.textContent = "连接主机后，远程文件列表显示在这里";
					sshTreeEl.appendChild(d);
				}
				sshTreeEl.scrollTop = st;
				applySelHighlight();
			});
		}

		/** ssh config 行：别名 + user@host，点击直连（免导入）；已连则开终端 */
		function renderConfigRow(c) {
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.cfg = c.alias;
			const busy = connecting.has(`cfg:${c.alias}`);
			const live = [...conns.keys()].find((id) => (conns.get(id)?.label ?? "").startsWith(`${c.alias}（`));
			const dotCls = busy ? "busy" : live ? "on" : "";
			const via = c.proxyJump ? ` ⇢ ${esc(c.proxyJump)}` : c.proxyCommand ? " ⇢ ⬢" : "";
			row.innerHTML = `<span class="dot ${dotCls}"></span>`
				+ `<span class="nm" title="${esc(c.username)}@${esc(c.host)}:${c.port}${c.privateKeyPath ? ` · ${esc(c.privateKeyPath)}` : ""}">${esc(c.alias)}<span style="opacity:.5"> ${esc(c.username)}@${esc(c.host)}${via}</span></span>`
				+ `<span class="ops">`
				+ (live ? '<button data-hop="term" title="新建终端">🖥</button>' : '<button data-hop="conn" title="连接">⇄</button>')
				+ `</span>`;
			row.addEventListener("click", async (ev) => {
				const btn = ev.target.closest("button[data-hop]");
				if (btn?.dataset.hop === "term" && live) { showTermPanel(); void newTerm(live); return; }
				if (btn) ev.stopPropagation();
				if (live) { showTermPanel(); void newTerm(live); return; }
				await connectConfig(c.alias);
			});
			hostsEl.appendChild(row);
		}

		function renderHostRow(h) {
			const connId = connOfHost(h.id);
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.host = h.id;
			const busy = connecting.has(h.id) || connMeta(connId)?.status === "connecting";
			const dotCls = busy ? "busy" : connId ? "on" : "";
			row.innerHTML = `<span class="dot ${dotCls}"></span>`
				+ `<span class="nm" title="${esc(h.username)}@${esc(h.host)}:${h.port}">${esc(h.name || h.host)}</span>`
				+ `<span class="ops">`
				+ (connId
					? '<button data-hop="term" title="新建终端">🖥</button><button data-hop="dis" title="断开">⏏</button>'
					: '<button data-hop="conn" title="连接">⇄</button>')
				+ '<button data-hop="edit" title="编辑">✎</button>'
				+ '<button data-hop="del" title="删除">🗑</button></span>';
			row.addEventListener("click", async (ev) => {
				const btn = ev.target.closest("button[data-hop]");
				if (btn) {
					ev.stopPropagation();
					if (btn.dataset.hop === "edit") openHostModal(h);
					else if (btn.dataset.hop === "del") {
						if (confirm(`删除主机「${h.name || h.host}」？`)) {
							const r = await request({ action: "hosts_delete", id: h.id });
							if (!r.ok) toast(`删除失败：${r.error}`);
							else renderHosts();
						}
					} else if (btn.dataset.hop === "term" && connId) {
						showTermPanel();
						void newTerm(connId);
					} else if (btn.dataset.hop === "dis" && connId) {
						void request({ action: "disconnect", connId }); // conn_closed 事件统一清理
					} else if (btn.dataset.hop === "conn") void connectHost(h);
					return;
				}
				// 点主机行：未连则连上（远程目录树出现在下方）；已连则直接开终端
				if (!connId) { await connectHost(h); return; }
				showTermPanel();
				void newTerm(connId);
			});
			hostsEl.appendChild(row);
		}

		/** 连接子树：根 = 探测到的 home（cwd）；cwd ≠ / 时补一行「..」返回上级 */
		async function renderConnTree(connId, parentEl) {
			const c = conns.get(connId);
			if (!c) return;
			if (c.cwd && c.cwd !== "/") {
				const up = document.createElement("div");
				up.className = "vsc-row";
				up.style.paddingLeft = "22px";
				up.innerHTML = `<span class="caret"></span><span>⬆</span><span class="nm">..</span>`;
				up.addEventListener("click", async () => {
					c.cwd = parentOf(c.cwd);
					// 只清本连接的目录缓存，别把其它主机/本地的也丢了
					for (const key of [...dirCache.keys()]) {
						if (key.startsWith(`${connId}:`)) dirCache.delete(key);
					}
					renderHosts(); // 重画 SSH tab 的远端树
				});
				parentEl.appendChild(up);
			}
			await renderDir(connId, c.cwd, parentEl, 1);
		}

		async function renderDir(scope, dirWire, parentEl, depth) {
			const entries = await ensureDir(scope, dirWire);
			await renderEntries(scope, entries, dirWire, parentEl, depth);
		}

		/** 把一层目录条目渲染成行（全量重绘与原地展开共用） */
		async function renderEntries(scope, entries, dirWire, parentEl, depth) {
			for (const e of entries) {
				const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${e.name}` : e.name;
				const row = document.createElement("div");
				row.className = "vsc-row";
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.dataset.scope = scope;
				row.dataset.path = p;
				row.dataset.type = e.type;
				row.dataset.depth = depth;
				const ek = tkey(scope, p);
				const isOpen = expanded.has(ek);
				row.innerHTML = `<span class="caret">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>`
					+ `<span>${iconFor(e.name, e.type)}</span><span class="nm">${esc(e.name)}</span>`;
				row.addEventListener("click", async () => {
					selectNode(scope, p, e.type);
					if (e.type !== "dir") { void openFile(scope, p); return; }
					// 原地展开/收起：只动这一行下面的子容器，不整棵重绘——
					// 整树 innerHTML 清空 + 网络往返会让其它目录闪没再回来
					const caret = row.querySelector(".caret");
					if (expanded.has(ek)) {
						expanded.delete(ek);
						if (caret) caret.textContent = "▸";
						const sub = row.nextElementSibling;
						if (sub instanceof Element && sub.classList.contains("vsc-sub")) sub.remove();
					} else {
						expanded.add(ek);
						if (caret) caret.textContent = "▾";
						await expandDirInPlace(scope, p, row);
					}
				});
				row.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					selectNode(scope, p, e.type); // 右键同样选中：菜单里的新建以此为落点
					showMenu(ev.clientX, ev.clientY, scope, p, e.type);
				});
				parentEl.appendChild(row);
				if (e.type === "dir" && isOpen) {
					const sub = document.createElement("div");
					sub.className = "vsc-sub";
					sub.dataset.loaded = "1";
					parentEl.appendChild(sub);
					await renderDir(scope, p, sub, depth + 1);
				}
			}
		}

		/** 原地展开一个目录：在该行后插入 .vsc-sub 子容器并填充，不动树的其它部分 */
		async function expandDirInPlace(scope, p, row) {
			const ek = tkey(scope, p);
			const depth = Number(row.dataset.depth ?? 0);
			let sub = row.nextElementSibling;
			if (!(sub instanceof Element && sub.classList.contains("vsc-sub"))) {
				sub = document.createElement("div");
				sub.className = "vsc-sub";
				sub.dataset.loaded = "0";
				row.insertAdjacentElement("afterend", sub);
			}
			sub.innerHTML = `<div class="vsc-row loading" style="padding-left:${8 + (depth + 1) * 14}px">`
				+ `<span class="caret"></span><span>⏳</span><span class="nm">加载中…</span></div>`;
			const entries = await ensureDir(scope, p);
			if (!expanded.has(ek)) { sub.remove(); return; } // 等待期间用户又收起了
			sub.innerHTML = "";
			sub.dataset.loaded = "1";
			await renderEntries(scope, entries, p, sub, depth + 1);
			applySelHighlight(); // 新行带上选中态
		}

		/** 点选节点：高亮 + 决定工具栏「新建文件/文件夹」的落点 */
		function selectNode(scope, pathW, type) {
			selNode = { scope, path: pathW, type };
			applySelHighlight();
		}

		/** 下载到用户电脑（本地或远端；base64 经 WS 回传 → Blob 保存；
		 *  Chromium 安全上下文优先 showSaveFilePicker 自选保存位置）。
		 *  远端文件夹由服务端在远端就地 tar.gz 打包后回传 */
		async function downloadToPC(scope, pathW, isDir = false) {
			const name = pathW.split("/").filter(Boolean).pop() || pathW;
			toast(`正在下载 ${name}${isDir ? "（打包中）" : ""}…`);
			const payload = scope === "local"
				? { action: "download", path: pathW }
				: { action: "download", connId: scope, path: pathW };
			const r = await request(payload);
			if (!r.ok) { toast(`下载失败：${r.error}`); return; }
			const bin = atob(r.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			saveBlob(new Blob([bytes]), r.name || (isDir ? `${name}.tar.gz` : name));
		}

		function saveBlob(blob, suggestedName) {
			if (window.showSaveFilePicker) {
				window.showSaveFilePicker({ suggestedName }).then(async (fh) => {
					const w = await fh.createWritable();
					await w.write(blob);
					await w.close();
					stState.textContent = `${suggestedName} 已保存`;
					setTimeout(() => { stState.textContent = ""; }, 3000);
				}).catch((e) => {
					if (e?.name === "AbortError") return; // 用户取消保存对话框不算错误
					fallbackAnchor();
				});
				return;
			}
			fallbackAnchor();
			function fallbackAnchor() {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = suggestedName;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
			}
		}

		function applySelHighlight() {
			root.querySelectorAll(".vsc-row[data-scope]").forEach((el) =>
				el.classList.toggle("sel", !!selNode
					&& el.dataset.scope === selNode.scope && el.dataset.path === selNode.path));
		}

		function renderTreeHighlight() {
			treeEl.querySelectorAll(".vsc-row[data-path]").forEach((el) =>
				el.classList.toggle("active",
					activeTk === tkey(el.dataset.scope, el.dataset.path) && el.dataset.type === "file"));
		}

		// ---- 标签页 ----------------------------------------------------------
		function renderTabs() {
			tabsEl.innerHTML = "";
			for (const [k, t] of tabs.entries()) {
				const el = document.createElement("div");
				el.className = "vsc-tab" + (k === activeTk ? " active" : "");
				el.innerHTML = `<span>${t.scope !== "local" ? "🖥" : iconFor(t.name, "file")}</span>`
					+ `<span class="tn">${esc(t.name)}</span>`
					+ (t.dirty ? '<span class="dot">●</span>' : "")
					+ `<button class="x" title="关闭">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) return;
					void activateTab(k);
				});
				el.querySelector(".x").addEventListener("click", () => void closeTab(k));
				tabsEl.appendChild(el);
			}
		}

		async function openFile(scope, p) {
			closeDrawer(); // 窄屏抽屉：选文件后自动收起
			const k = tkey(scope, p);
			if (!tabs.has(k)) {
				const r = await req(scope, { action: "read", path: p });
				if (!r.ok) { toast(`打开失败：${r.error}`); return; }
				tabs.set(k, {
					scope, path: p, name: p.split("/").pop(),
					savedText: r.text ?? "",
					binary: !!r.binary,
					dirty: false,
					crlf: (r.text ?? "").includes("\r\n"), // 保留原文件行尾风格，保存时写回
				});
				if (r.binary) toast("二进制文件暂不支持编辑");
			}
			await activateTab(k);
		}

		async function activateTab(k) {
			const t = tabs.get(k);
			if (!t) return;
			activeTk = k;
			emptyEl.classList.add("vsc-hidden");
			edHost.classList.remove("vsc-hidden");
			view.setState(EditorState.create({
				doc: t.binary ? "" : t.savedText,
				extensions: makeExtensions(),
			}));
			t.dirty = false; // 新载入的文档永远是干净的
			view.dispatch({ effects: langComp.reconfigure(langFor(t.path) ?? []) });
			stScope.textContent = t.scope !== "local" ? `🖥 ${connLabel(t.scope)}` : "本地";
			stScope.classList.toggle("remote", t.scope !== "local");
			stPath.textContent = t.path;
			stLang.textContent = langName(t.path);
			renderTabs();
			renderTreeHighlight();
			updateStatus(view.state);
			view.focus();
		}

		async function saveActive() {
			const t = tabs.get(activeTk);
			if (!activeTk || !t || t.binary) return false;
			const text = currentDoc();
			// CRLF 文件写回原行尾，避免整个文件被重写成 LF
			const wire = t.crlf ? text.replace(/\n/g, "\r\n") : text;
			const r = await req(t.scope, { action: "write", path: t.path, text: wire });
			if (!r.ok) { toast(`保存失败：${r.error}`); return true; }
			t.savedText = text;
			t.dirty = false;
			renderTabs();
			updateStatus(view.state);
			// 同步配置文件保存后刷新缓存（服务端每次直读文件，无需专门重载）
			if (t.path === syncCfgPath) void refreshSyncCfg();
			// 上传保存：配置开启且是本地文件 → 自动同步到远端（vscode-sftp uploadOnSave）
			else if (syncCfgPub?.configured && syncCfgPub.uploadOnSave && t.scope === "local") {
				void runSync("up", "file", t.path);
			}
			return true;
		}

		async function closeTab(k) {
			const t = tabs.get(k);
			if (t && t.dirty && !confirm(`「${t.name}」有未保存的修改，确定关闭？`)) return;
			tabs.delete(k);
			if (activeTk === k) {
				activeTk = null;
				if (tabs.size) await activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—"; stLang.textContent = ""; stPos.textContent = ""; stState.textContent = "";
					renderTabs();
				}
			} else renderTabs();
		}

		/** 关掉某个范围的所有标签（连接断开时用，不弹确认） */
		function closeTabsOfScope(scope) {
			for (const k of [...tabs.keys()]) {
				if (parseTk(k).scope === scope) tabs.delete(k);
			}
			if (activeTk && parseTk(activeTk).scope === scope) {
				activeTk = null;
				if (tabs.size) void activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—"; stLang.textContent = ""; stPos.textContent = ""; stState.textContent = "";
				}
			}
			renderTabs();
		}

		/** 工作区已切换（主应用 set_cwd → 服务端广播）：本地相对路径全部作废——
		 *  清目录缓存/Ctrl+P 索引、关掉所有本地标签（脏标签计数提示，避免旧项目
		 *  内容被保存进新项目的同名路径）；远程 SSH 标签与连接不受影响。 */
		async function applyWorkspace(newRoot) {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const k of [...expanded]) {
				if (parseTk(k).scope === "local") expanded.delete(k); // 旧项目的展开状态全部作废
			}
			if (selNode?.scope === "local") selNode = null; // 新建文件落点也随旧项目失效
			let dirtyLost = 0;
			for (const [k, t] of tabs.entries()) {
				if (parseTk(k).scope === "local" && t.dirty) dirtyLost++;
			}
			closeTabsOfScope("local");
			await renderTree();
			toast(dirtyLost ? `工作区已切换${newRoot ? `：${newRoot}` : ""}（关闭了 ${dirtyLost} 个未保存的本地标签）` : `工作区已切换${newRoot ? `：${newRoot}` : ""}`);
			void refreshSyncCfg(); // .vscode/sftp.json 每项目独立，重读同步配置
		}

		// ---- 快速打开（Ctrl+P，仅本地） ----------------------------------------
		let flatLoaded = false;
		async function loadFlat() {
			if (flatLoaded) return;
			const r = await request({ action: "flatlist" });
			if (r.ok) {
				flatLoaded = true;
				for (const f of r.files) flatFiles.add(f);
				if (r.truncated) toast("文件较多，列表已截断");
			}
		}

		let quickSel = 0;
		let quickOverride = null; // 文件名搜索模式：[{scope, path, type}]，非空时接管浮层（替代本地 flatFiles）
		function quickMatches() {
			const q = quickInput.value.trim().toLowerCase();
			if (quickOverride) {
				return quickOverride
					.filter((x) => !q || x.path.toLowerCase().includes(q))
					.slice(0, 100);
			}
			const all = [...flatFiles];
			if (!q) return all.slice(0, 100).map((f) => ({ scope: "local", path: f, type: "file" }));
			return all
				.map((f) => ({ f, s: fuzzyScore(quickInput.value.trim(), f.split("/").pop()) + fuzzyScore(quickInput.value.trim(), f) * 0.3 }))
				.filter((x) => x.s >= 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 100)
				.map((x) => ({ scope: "local", path: x.f, type: "file" }));
		}

		function renderQuick() {
			const ms = quickMatches();
			quickSel = Math.min(quickSel, Math.max(0, ms.length - 1));
			quickList.innerHTML = ms.map((x, i) =>
				`<li data-s="${esc(x.scope)}" data-p="${esc(x.path)}" class="${i === quickSel ? "sel" : ""}">`
				+ `${iconFor(x.path.split("/").pop(), x.type)} ${esc(x.path.split("/").pop())}${x.scope !== "local" ? " 🌐" : ""}<small>${esc(x.path)}</small></li>`).join("")
				|| `<li style="opacity:.5;cursor:default">无匹配文件</li>`;
		}

		function openQuickOpen() {
			quickOverride = null; // 回到本地 Ctrl+P 模式
			void loadFlat().then(() => { quickSel = 0; renderQuick(); quick.classList.remove("vsc-hidden"); quickInput.focus(); quickInput.select(); });
		}

		function closeQuickOpen() { quick.classList.add("vsc-hidden"); }

		quickInput.addEventListener("input", () => { quickSel = 0; renderQuick(); });
		quickInput.addEventListener("keydown", (ev) => {
			const ms = quickMatches();
			if (ev.key === "Escape") { closeQuickOpen(); view.focus(); }
			else if (ev.key === "ArrowDown") { quickSel = Math.min(quickSel + 1, ms.length - 1); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "ArrowUp") { quickSel = Math.max(quickSel - 1, 0); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "Enter" && ms[quickSel] && ms[quickSel].type !== "dir") { const t = ms[quickSel]; closeQuickOpen(); void openFile(t.scope, t.path); }
		});
		quickList.addEventListener("click", (ev) => {
			const li = ev.target.closest("li[data-p]");
			if (!li) return;
			const scope = li.dataset.s || "local";
			// 搜索结果里的目录行不可点开（只打开文件）
			if (li.textContent && quickOverride) {
				const hit = quickOverride.find((x) => x.scope === scope && x.path === li.dataset.p);
				if (hit?.type === "dir") return;
			}
			closeQuickOpen(); void openFile(scope, li.dataset.p);
		});

		/** 文件名搜索（本地走工作区全仓，远端以当前选中目录为起点收窄）：结果复用 Ctrl+P 浮层 */
		async function runSearch(scope, baseOverride) {
			let base = baseOverride ?? "";
			if (scope !== "local" && baseOverride === undefined) {
				const t = pickRemoteDir();
				if (!t) return;
				scope = t.connId;
				base = t.dir;
			}
			const q = prompt("搜索文件名：");
			if (!q || !q.trim()) return;
			const r = scope === "local"
				? await request({ action: "search", query: q.trim(), base })
				: await request({ action: "search", connId: scope, query: q.trim(), baseDir: base || "/" });
			if (!r.ok) { toast(`搜索失败：${r.error}`); return; }
			const list = r.results ?? [];
			if (!list.length) { toast("无匹配"); return; }
			if (r.truncated) toast("结果较多，只显示前 50 项");
			quickOverride = list.map((x) => ({ scope, path: x.path, type: x.type }));
			quickSel = 0;
			quickInput.value = q.trim();
			renderQuick();
			quick.classList.remove("vsc-hidden");
			quickInput.focus();
			quickInput.select();
		}

		// ---- 右键菜单（scope 感知） --------------------------------------------
		function parentOf(dir) {
			if (!dir || dir === "/" || dir === ".") return "/";
			const s = dir.replace(/\/$/, "");
			const idx = s.lastIndexOf("/");
			return idx <= 0 ? "/" : s.slice(0, idx);
		}

		function showMenu(x, y, scope, pathW, type) {
			menuEl.innerHTML = "";
			const items = [];
			if (type === "dir") {
				items.push(
					["新建文件", async () => { await promptCreate(scope, pathW, "file"); }],
					["新建文件夹", async () => { await promptCreate(scope, pathW, "dir"); }],
					["上传文件到此处…", async () => {
						const files = await pickFiles();
						if (files.length) void uploadFilesTo(scope, pathW, files);
					}],
				);
			}
			// 同步入右键菜单（vscode-sftp 风格）：本地行直接同步；远端行点击时即时解析相对路径
			if (scope === "local") {
				if (type === "dir") items.push(
					["上传此文件夹 → 远端", () => void runSync("up", "tree", pathW)],
					["下载远端 → 此文件夹", () => void runSync("down", "tree", pathW)],
				);
				else items.push(
					["上传此文件 → 远端", () => void runSync("up", "file", pathW)],
					["下载到电脑", () => void downloadToPC(pathW)],
				);
			} else {
				// 远端与本地工作区无关：只提供「下载到电脑」（文件夹自动 tar.gz 打包）
				items.push([type === "dir" ? "下载到电脑（压缩包）" : "下载到电脑",
					() => void downloadToPC(scope, pathW, type === "dir")]);
			}
			// 文件行也可「上传文件到此处…」（落点 = 其所在目录，与拖拽规则一致）
			if (type !== "dir") {
				items.push(["上传文件到此处…", async () => {
					const files = await pickFiles();
					const dir = scope === "local" ? localParentOf(pathW) : parentOf(pathW);
					if (files.length) void uploadFilesTo(scope, dir, files);
				}]);
			}
			// 文件列表同款：剪切/复制/粘贴（同 scope 内）、创建副本、复制路径
			const _base = pathW.split("/").pop();
			const _rowDir = type === "dir" ? pathW : (scope === "local" ? localParentOf(pathW) : parentOf(pathW));
			items.push(
				["剪切", () => { clipboard = { scope, src: pathW, cut: true }; toast(`已剪切「${_base}」（在目标目录右键粘贴）`); }],
				["复制", () => { clipboard = { scope, src: pathW, cut: false }; toast(`已复制「${_base}」（在目标目录右键粘贴）`); }],
			);
			if (clipboard && clipboard.scope === scope) {
				items.push([clipboard.cut ? "粘贴（移动到此处）" : "粘贴到此处",
					() => void pasteClipboardTo(scope, _rowDir)]);
			}
			items.push(
				["创建副本", () => void duplicateEntry(scope, pathW, type)],
				["复制路径", () => copyText(pathW)],
			);
			items.push(
				["重命名", async () => {
					const nn = prompt("新名称：", pathW.split("/").pop());
					if (!nn || nn === pathW.split("/").pop()) return;
					const r = await req(scope, { action: "rename", path: pathW, newName: nn });
					if (!r.ok) { toast(`重命名失败：${r.error}`); return; }
					await invalidateScope(scope);
				}],
				["删除", async () => {
					if (!confirm(`确定删除「${pathW}」？${type === "dir" ? "（目录将递归删除，不可撤销）" : "（不可撤销）"}`)) return;
					const r = await req(scope, { action: "delete", path: pathW, isDir: type === "dir" });
					if (!r.ok) { toast(`删除失败：${r.error}`); return; }
					// 关闭被删文件（或其子目录下）的活跃标签
					for (const k of [...tabs.keys()]) {
						const { scope: s, path } = parseTk(k);
						if (s === scope && (path === pathW || path.startsWith(pathW + "/"))) void closeTab(k);
					}
					await invalidateScope(scope);
				}],
			);
			if (scope !== "local") {
				// 文件在其所在目录、文件夹在自身目录打开远程终端
				items.push([type === "dir" ? "在此打开终端" : "在所在文件夹打开终端", async () => {
					const dir = type === "dir" ? pathW : parentOf(pathW);
					conns.get(scope).cwd = dir;
					showTermPanel();
					await newTerm(scope, dir);
				}]);
			}
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else b.addEventListener("click", () => { hideMenu(); void fn(); });
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			// 限制在容器内
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 170)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}
		function hideMenu() { menuEl.classList.add("vsc-hidden"); }
		document.addEventListener("click", hideMenu);

		/** 结构变化后清缓存重拉；keepTabs 内容不动 */
		async function invalidateScope(scope) {
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${scope}:`)) dirCache.delete(key);
			}
			if (scope === "local") { flatFiles.clear(); flatLoaded = false; }
			await renderTree();
			renderHosts(); // 远端树也刷（invalidateScope 可能由远端操作触发）
		}

		async function promptCreate(scope, dirWire, kind) {
			const name = prompt(kind === "dir" ? "新文件夹名称：" : "新文件名称（可带子路径 a/b.js）：");
			if (!name) return;
			const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${name.trim()}` : name.trim();
			const r = await req(scope, { action: "create", path: p, kind });
			if (!r.ok) { toast(`创建失败：${r.error}`); return; }
			expanded.add(tkey(scope, dirWire));
			selNode = { scope, path: p, type: kind }; // 新条目成为当前选中，后续新建落在它旁边/里面
			if (kind === "file") void openFile(scope, p);
			await invalidateScope(scope);
		}

		/** 全量刷新：清缓存重拉；磁盘内容为准刷新已开标签 */
		async function refreshAll() {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const [k, t] of tabs.entries()) {
				if (t.binary) continue;
				const r = await req(t.scope, { action: "read", path: t.path });
				if (r.ok && r.text != null) {
					t.savedText = r.text;
					t.crlf = r.text.includes("\r\n");
					t.dirty = false; // 磁盘为准，丢弃未保存编辑
				}
			}
			if (activeTk && tabs.has(activeTk)) await activateTab(activeTk);
			await renderTree();
			renderTabs();
			renderHosts();
		}

		// ---- 上传（工具栏按钮 / 右键菜单 / 拖拽到文件树；本地与远端共用） -------------
		const UPLOAD_CHUNK = 512 * 1024; // 分片字节数（base64 经 WS，避开单帧过大）
		let uploading = false; // 防重入：上一批还在传时忽略新触发

		/** 弹系统文件选择框（multiple），返回 File[]；取消返回 [] */
		function pickFiles() {
			return new Promise((resolve) => {
				filePick.onchange = () => {
					const files = [...(filePick.files ?? [])];
					filePick.value = ""; // 清空以允许下次重选同一批文件
					resolve(files);
				};
				filePick.click();
			});
		}

		/** Uint8Array → base64（btoa 只吃 latin1 字符串，分批防爆栈） */
		function bufToB64(u8) {
			let bin = "";
			for (let i = 0; i < u8.length; i += 0x8000) {
				bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
			}
			return btoa(bin);
		}

		function setUploadProgress(text) {
			stUp.textContent = text;
		}

		/** 单个文件：begin（存在检查 + 覆盖确认）→ 逐片上传 → 末片落盘。返回是否成功 */
		async function uploadOne(scope, dir, file) {
			const name = file.name;
			if (file.size > 100 * 1024 * 1024) { toast(`「${name}」超过 100MB 上限，已跳过`); return false; }
			const begin = await req(scope, { action: "upload_begin", dir, name, size: file.size });
			if (!begin.ok) { toast(`上传失败：${begin.error}`); return false; }
			if (begin.exists && !confirm(`「${name}」已存在，是否覆盖？`)) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				return false;
			}
			const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
			try {
				for (let i = 0; i < total; i++) {
					const slice = file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
					const u8 = new Uint8Array(await slice.arrayBuffer());
					const r = await req(scope, { action: "upload", uploadId: begin.uploadId, i, total, b64: bufToB64(u8) });
					if (!r.ok) throw new Error(r.error);
					setUploadProgress(`⬆ ${name}（${i + 1}/${total}）`);
				}
				return true;
			} catch (err) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				toast(`上传「${name}」失败：${err?.message ?? err}`);
				return false;
			}
		}

		/** 批量上传到某个目录（本地/远端通用），完成后刷新对应树 + 汇总提示 */
		async function uploadFilesTo(scope, dir, files) {
			if (!files?.length) return;
			if (uploading) { toast("正在上传，请稍候…"); return; }
			uploading = true;
			let ok = 0;
			try {
				for (const f of files) if (await uploadOne(scope, dir, f)) ok++;
				if (ok) await invalidateScope(scope);
				setUploadProgress("");
				if (ok === files.length) toast(`已上传 ${ok} 个文件${dir ? ` 到 ${dir}` : "（工作区根目录）"}`);
				else toast(`上传完成：${ok}/${files.length} 成功`);
			} finally {
				uploading = false;
			}
		}

		// ---- 拖拽上传（类 VSCode：文件夹行→该文件夹；文件行→其所在目录；空白处→根） ----
		function isFileDrag(ev) {
			return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
		}

		function clearDropTargets() {
			root.querySelectorAll(".vsc-row.drop-target").forEach((el) => el.classList.remove("drop-target"));
			treeEl.classList.remove("drop-root");
			sshTreeEl.classList.remove("drop-root");
		}

		/** 本地文件的父目录（不同于 parentOf：根级文件返回 "" 而不是 "/"） */
		function localParentOf(p) {
			const i = p.lastIndexOf("/");
			return i <= 0 ? "" : p.slice(0, i);
		}

		/** 当前拖拽落点：{scope, dir}。命中行 → 目录行/文件行所在目录；空白 → 本地根或首台已连主机根 */
		function dropTargetFrom(ev, containerScope) {
			const row = ev.target.closest(".vsc-row");
			if (row && row.dataset.scope) {
				return {
					scope: row.dataset.scope,
					dir: row.dataset.type === "dir" ? row.dataset.path
						: (row.dataset.scope === "local" ? localParentOf(row.dataset.path) : parentOf(row.dataset.path)),
				};
			}
			if (containerScope === "local") return { scope: "local", dir: "" };
			const first = [...conns.keys()][0];
			return first ? { scope: first, dir: conns.get(first).cwd } : null;
		}

		function setDropHighlight(t) {
			clearDropTargets();
			if (!t) return;
			// 具体目录落点：高亮那一行；根目录/远端根落点：高亮整个树容器
			if (t.dir && t.dir !== "/") {
				root.querySelector(`.vsc-row[data-scope="${CSS.escape(t.scope)}"][data-path="${CSS.escape(t.dir)}"]`)
					?.classList.add("drop-target");
			} else {
				(t.scope === "local" ? treeEl : sshTreeEl).classList.add("drop-root");
			}
		}

		/** 主应用把整个窗口当作拖放目标（拖文件即「附加到对话」）；文件树的
		 *  dragover 已 stopPropagation 拦下，这里再清掉它的全屏 📎 提示，
		 *  避免盖在上传落点上方造成歧义（纯视觉清理，不碰其行为）。 */
		function clearAppDropOverlay() {
			const appEl = container.ownerDocument.querySelector(".app");
			if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
		}

		for (const [el, containerScope] of [[treeEl, "local"], [sshTreeEl, null]]) {
			el.addEventListener("dragover", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault(); // 声明自己是合法落点，否则浏览器默认禁止 drop
				ev.stopPropagation(); // 主应用全窗口拖放不参与（不会附加到对话）
				clearAppDropOverlay();
				setDropHighlight(dropTargetFrom(ev, containerScope));
				ev.dataTransfer.dropEffect = "copy";
			});
			el.addEventListener("dragleave", (ev) => {
				if (ev.relatedTarget && el.contains(ev.relatedTarget)) return; // 仍在树内移动
				clearDropTargets();
			});
			el.addEventListener("drop", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault();
				ev.stopPropagation();
				clearDropTargets();
				clearAppDropOverlay();
				const files = [...(ev.dataTransfer?.files ?? [])];
				if (!files.length) { toast("文件夹上传暂不支持，请选择文件"); return; }
				const t = dropTargetFrom(ev, containerScope);
				if (!t) { toast("请先连接一台 SSH 主机"); return; }
				void uploadFilesTo(t.scope, t.dir, files);
			});
		}

		// ---- 空白处右键（与拖拽空白落点一致：本地→工作区根；SSH 树→首台已连主机根） ----
		for (const [el, containerScope] of [[treeEl, "local"], [sshTreeEl, null]]) {
			el.addEventListener("contextmenu", (ev) => {
				const tgt = ev.target instanceof Element ? ev.target : el;
				if (tgt.closest(".vsc-row")) return; // 行行自己有菜单（且已 stopPropagation）
				ev.preventDefault();
				ev.stopPropagation();
				const t = dropTargetFrom(ev, containerScope); // 复用拖拽落点计算，空白→根
				if (!t) { toast("请先连接一台 SSH 主机"); return; }
				hideMenu();
				const items = [];
				items.push(["上传文件到此处…", async () => {
					const files = await pickFiles();
					if (files.length) void uploadFilesTo(t.scope, t.dir, files);
				}]);
				if (clipboard && clipboard.scope === t.scope) {
					items.push([clipboard.cut ? "粘贴（移动到此处）" : "粘贴到此处",
						() => void pasteClipboardTo(t.scope, t.dir)]);
				}
				if (containerScope === "local" && t.dir === "") {
					items.push(["刷新", () => void refreshAll()]);
				}
				menuEl.innerHTML = "";
				for (const [label, fn] of items) {
					const b = document.createElement("button");
					b.textContent = label;
					b.addEventListener("click", () => { hideMenu(); void fn(); });
					menuEl.appendChild(b);
				}
				menuEl.classList.remove("vsc-hidden");
				const rect = root.getBoundingClientRect();
				menuEl.style.left = `${Math.min(ev.clientX - rect.left, rect.width - 170)}px`;
				menuEl.style.top = `${Math.min(ev.clientY - rect.top, rect.height - items.length * 32 - 20)}px`;
			});
		}
		// ---- 工具栏 -----------------------------------------------------------
		root.querySelector(".vsc-side-head").addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation(); // 阻断冒泡：否则 document 的「点任意处关菜单」会把刚打开的 ☁ 菜单立即隐藏
			const act = btn.dataset.act;
			if (act === "refresh") { void refreshAll(); }
			else if (act === "search") { void runSearch("local"); }
			else if (act === "new-file") { void promptCreate("local", pickLocalDir(), "file"); }
			else if (act === "new-dir") { void promptCreate("local", pickLocalDir(), "dir"); }
			else if (act === "upload") { void pickFiles().then((files) => uploadFilesTo("local", "", files)); }
			else if (act === "sync-menu") {
				const rect = btn.getBoundingClientRect();
				showSyncMenu(rect.left, rect.bottom + 4);
			}
		});

		// ---- SSH 主机表单 -------------------------------------------------------
		let modalEditId = null;
		function openHostModal(h) {
			modalEditId = h?.id ?? null;
			hostBg.querySelector(".h-title").textContent = h ? "编辑主机" : "新建主机";
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			q("h-name").value = h?.name ?? "";
			q("h-host").value = h?.host ?? "";
			q("h-port").value = h?.port ?? 22;
			q("h-user").value = h?.username ?? "root";
			q("h-pass").value = "";
			q("h-key").value = "";
			q("h-keypath").value = h?.privateKeyPath ?? "";
			q("h-pp").value = "";
			q("h-agent").value = h?.agent ?? "";
			q("h-pass").placeholder = h?.hasPass ? "已保存（留空保持不变）" : "";
			q("h-key").placeholder = h?.hasKey ? "已保存（留空保持不变）" : "-----BEGIN OPENSSH PRIVATE KEY-----";
			q("h-pp").placeholder = h?.hasPassphrase ? "已保存（留空保持不变）" : "";
			const panel = hostBg.querySelector(".sshcfg-import");
			panel.classList.add("vsc-hidden");
			panel.innerHTML = "";
			hostBg.classList.remove("vsc-hidden");
			q("h-host").focus();
		}
		hostBg.querySelector(".cancel").addEventListener("click", () => hostBg.classList.add("vsc-hidden"));
		hostBg.addEventListener("click", (ev) => { if (ev.target === hostBg) hostBg.classList.add("vsc-hidden"); });
		hostBg.querySelector(".save-host").addEventListener("click", async () => {
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			const body = {
				name: q("h-name").value.trim(),
				host: q("h-host").value.trim(),
				port: Number(q("h-port").value) || 22,
				username: q("h-user").value.trim() || "root",
				password: q("h-pass").value || undefined,
				privateKey: q("h-key").value.trim() || undefined,
				// 口令留空 = 保持不变（与密码/私钥同规则）；路径与 agent 非密文，空串 = 清除
				passphrase: q("h-pp").value || undefined,
				privateKeyPath: q("h-keypath").value.trim(),
				agent: q("h-agent").value.trim(),
			};
			if (modalEditId) body.id = modalEditId;
			const r = await request({ action: "hosts_save", host: body });
			if (!r.ok) { toast(`保存失败：${r.error}`); return; }
			hostBg.classList.add("vsc-hidden");
		});
		hostBg.querySelector(".import-cfg").addEventListener("click", async () => {
			const panel = hostBg.querySelector(".sshcfg-import");
			panel.innerHTML = `<div class="hint">读取 ~/.ssh/config 中…</div>`;
			panel.classList.remove("vsc-hidden");
			const r = await request({ action: "sshconfig_list" });
			if (!r.ok) { panel.innerHTML = `<div class="hint">读取失败：${esc(r.error)}</div>`; return; }
			const fresh = (r.hosts ?? []).filter((x) => !x.imported);
			if (!fresh.length) {
				panel.innerHTML = `<div class="hint">共 ${(r.hosts ?? []).length} 台，均已导入。</div>`;
				return;
			}
			panel.innerHTML = "";
			for (const x of fresh) {
				const label = document.createElement("label");
				label.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:normal";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = true;
				cb.value = x.alias;
				cb.style.width = "auto";
				label.appendChild(cb);
				const span = document.createElement("span");
				span.textContent = `${x.alias} — ${x.username}@${x.host}:${x.port}`
					+ (x.privateKeyPath ? `（${x.privateKeyPath}）` : "");
				label.appendChild(span);
				panel.appendChild(label);
			}
			const btn = document.createElement("button");
			btn.className = "primary";
			btn.textContent = `导入选中`;
			btn.addEventListener("click", async () => {
				const aliases = [...panel.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
				if (!aliases.length) { toast("请先勾选要导入的主机"); return; }
				const r2 = await request({ action: "sshconfig_import", aliases });
				if (!r2.ok) { toast(`导入失败：${r2.error}`); return; }
				panel.classList.add("vsc-hidden");
				panel.innerHTML = "";
				hostBg.classList.add("vsc-hidden");
				toast(`已导入 ${r2.added} 台${r2.skipped ? `（跳过 ${r2.skipped} 台）` : ""}`);
			});
			panel.appendChild(btn);
		});

		/** ssh config 别名直连（免导入，与 VSCode Remote-SSH 同源） */
		async function connectConfig(alias) {
			const key = `cfg:${alias}`;
			if (connecting.has(key)) return;
			// 已有该别名的存活连接则复用
			for (const [id, c] of conns) {
				if ((c.label ?? "").startsWith(`${alias}（`)) return id;
			}
			connecting.add(key);
			renderHosts();
			const r = await request({ action: "config_connect", alias });
			connecting.delete(key);
			if (!r.ok) { toast(`连接失败：${r.error}`); renderHosts(); return null; }
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" };
			renderHosts();
			await renderTree();
			return r.connId;
		}

		/** 编辑 ~/.ssh/config 原文（与 VSCode 写法完全一样，保存自动备份 .bak + 刷新列表） */
		async function openSshConfigEditor() {
			const r = await request({ action: "sshconfig_get" });
			if (!r.ok) { toast(`读取失败：${r.error}`); return; }
			const text = prompt(`编辑 ${S.configPath ?? "~/.ssh/config"}（与 VSCode 写法完全一样）：\nHost 别名\n  HostName 主机\n  User 用户\n  Port 端口\n  IdentityFile 私钥路径\n  ProxyJump 跳板`, r.text ?? "");
			if (text === null) return; // 取消
			const r2 = await request({ action: "sshconfig_save", text });
			if (!r2.ok) toast(`保存失败：${r2.error}`);
			else toast("ssh config 已保存（旧版已备份 .bak），列表已刷新");
		}

		/** 连接一台主机并展开其目录树（探测 home 作起始路径） */
		async function connectHost(h) {
			if (connecting.has(h.id) || connOfHost(h.id)) return;
			connecting.add(h.id);
			renderTree();
			const r = await request({ action: "connect", id: h.id });
			connecting.delete(h.id);
			if (!r.ok) { toast(`连接失败：${r.error}`); renderTree(); return; }
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" }; // 工具栏＋📄/＋📁 默认落点
			renderHosts();
			await renderTree();
		}

		/** 连接断开：清连接态 + 该范围标签/终端/缓存 */
		function handleConnClosed(connId, reason) {
			for (const [, t] of terms.entries()) {
				if (t.connId === connId) disposeTerm(t);
			}
			conns.delete(connId);
			closeTabsOfScope(connId);
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${connId}:`)) dirCache.delete(key);
			}
			if (lastConnId === connId) lastConnId = [...conns.keys()].pop() ?? null;
			if (selNode && selNode.scope === connId) selNode = null;
			renderTermTabs();
			syncPanelVisibility();
			void renderTree();
			renderHosts();
			if (reason) toast(`连接断开：${connLabel(connId)} ${reason}`);
		}

		// ---- 底部终端面板（每台主机可多个 shell） ---------------------------------
		const terms = new Map(); // termId → {id, connId, shellId, label, n, term, fit, el, opened, dead}
		let syncCfgPub = null; // 最近一次 sync_get 的脱敏配置（uploadOnSave / remoteRoot 判断用）
		let syncCfgPath = ".vscode/sftp.json";

		/** 拉取同步配置缓存（服务端每次直读 .vscode/sftp.json，改完保存即生效） */
		async function refreshSyncCfg() {
			const r = await request({ action: "sync_get" });
			if (r.ok) {
				syncCfgPub = r.config;
				syncCfgPath = r.configPath ?? syncCfgPath;
			}
			return r;
		}
		let termSeq = 0;
		let activeTermId = null;
		let lastConnId = null;
		let termH = 240;
		const inputQueue = new Map(); // shellId 未就绪前缓冲输入

		function pickConnId() {
			const t = tabs.get(activeTk);
			if (t && t.scope !== "local" && conns.has(t.scope)) return t.scope;
			if (lastConnId && conns.has(lastConnId)) return lastConnId;
			return [...conns.keys()][0] ?? null;
		}

		function showTermPanel() {
			panelEl.classList.remove("vsc-hidden");
			dragEl.classList.remove("vsc-hidden");
			panelEl.style.height = `${termH}px`;
		}
		function hideTermPanel() {
			panelEl.classList.add("vsc-hidden");
			dragEl.classList.add("vsc-hidden");
		}
		function syncPanelVisibility() {
			if (terms.size) showTermPanel(); else hideTermPanel();
		}
		// 主题跟随：编辑器明暗 + 全部存活终端调色一起切换
		function onThemeChange() {
			try { view.dispatch({ effects: themeComp.reconfigure(isLightTheme() ? cmLight : oneDark) }); } catch {}
			const th = buildTermTheme();
			for (const [, t] of terms.entries()) { try { t.term.options.theme = th; } catch {} }
		}
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		async function newTerm(connId, startCwd) {
			connId = connId ?? pickConnId();
			if (!connId || !conns.has(connId)) { toast("请先连接一台 SSH 主机（左侧点主机名）"); return; }
			const sameConn = [...terms.values()].filter((t) => t.connId === connId).length;
			const t = {
				id: `t${++termSeq}`, connId, shellId: null,
				label: connLabel(connId), n: sameConn + 1, dead: false,
				term: null, fit: null, el: null, opened: false,
			};
			terms.set(t.id, t);
			showTermPanel();
			t.el = document.createElement("div");
			t.el.className = "vsc-term";
			termAreaEl.appendChild(t.el);
			const term = new Terminal({
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				theme: buildTermTheme(),
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			t.term = term;
			t.fit = fit;
			term.open(t.el);
			try { fit.fit(); } catch {}
			term.onData((d) => {
				if (t.dead) return;
				if (t.shellId) ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(d) });
				else {
					if (!inputQueue.has(t.id)) inputQueue.set(t.id, []);
					inputQueue.get(t.id).push(d);
				}
			});
			setActiveTerm(t.id);
			const r = await request({
				action: "shell_open", connId: t.connId,
				cols: term.cols, rows: term.rows,
			});
			if (!r.ok) {
				toast(`打开终端失败：${r.error}`);
				disposeTerm(t);
				renderTermTabs();
				syncPanelVisibility();
				return;
			}
			t.shellId = r.shellId;
			// 补发 shell 就绪前敲入的内容
			const queued = inputQueue.get(t.id);
			if (queued?.length && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(queued.join("")) });
			}
			inputQueue.delete(t.id);
			// 指定起始目录：shell 就绪后补发一条 cd（与手动敲入等效）
			if (startCwd && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(`cd ${shQuote(startCwd)}\n`) });
			}
			term.focus();
		}

		function setActiveTerm(id) {
			activeTermId = id;
			for (const [tid, t] of terms.entries()) {
				t.el.classList.toggle("vsc-hidden", tid !== id);
				if (tid === id) requestAnimationFrame(() => { try { t.fit.fit(); } catch {} t.term?.focus(); });
			}
			renderTermTabs();
		}

		function renderTermTabs() {
			termTabsEl.innerHTML = "";
			for (const [tid, t] of terms.entries()) {
				const el = document.createElement("span");
				el.className = "vsc-ttab" + (tid === activeTermId ? " active" : "");
				el.innerHTML = `<span class="tn">🖥 ${esc(t.label)}${t.n > 1 ? ` ${t.n}` : ""}</span><button class="x" title="关闭">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) { killTerm(t); return; }
					setActiveTerm(tid);
				});
				termTabsEl.appendChild(el);
			}
		}

		function killTerm(t) {
			if (t.shellId) void request({ action: "shell_close", connId: t.connId, shellId: t.shellId });
			disposeTerm(t);
			if (activeTermId === t.id) {
				activeTermId = null;
				const rest = [...terms.keys()];
				if (rest.length) setActiveTerm(rest[rest.length - 1]);
			}
			renderTermTabs();
			syncPanelVisibility();
		}

		function disposeTerm(t) {
			t.dead = true;
			try { t.ro?.disconnect(); } catch {}
			try { t.term?.dispose(); } catch {}
			try { t.el?.remove(); } catch {}
			terms.delete(t.id);
		}

		root.querySelector(".vsc-termbar .t-add").addEventListener("click", () => void newTerm());
		root.querySelector(".vsc-termbar .t-hide").addEventListener("click", hideTermPanel);

		// 面板高度拖拽
		dragEl.addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			const startY = ev.clientY;
			const startH = panelEl.getBoundingClientRect().height;
			const maxH = Math.max(120, root.getBoundingClientRect().height * 0.7);
			const onMove = (e) => {
				termH = Math.round(Math.min(Math.max(startH + (startY - e.clientY), 80), maxH));
				panelEl.style.height = `${termH}px`;
				for (const [, t] of terms.entries()) { try { t.fit.fit(); } catch {} }
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});

		// ---- SFTP 同步（本地工作区 ↔ 远端目录，方向性覆盖） ------------------------
		function showSyncMenu(x, y) {
			menuEl.innerHTML = "";
			const at = tabs.get(activeTk);
			const items = [
				["同步配置…", () => void openSyncModal()],
				["编辑配置文件（.vscode/sftp.json）", () => void openConfigFile()],
				["全部上传（本地 → 远端）", () => void runSync("up", "all", "")],
				["全部下载（远端 → 本地）", () => void runSync("down", "all", "")],
				[at && at.scope === "local" && !at.binary ? `上传当前文件（${at.name}）` : "上传当前文件（先打开本地文件）",
					at && at.scope === "local" && !at.binary ? () => void runSync("up", "file", at.path) : null],
			];
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else b.addEventListener("click", () => { hideMenu(); fn(); });
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 200)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}

		function showSyncProgress(text) {
			syncStatusEl.textContent = text;
			syncStatusEl.classList.remove("vsc-hidden");
		}
		function hideSyncProgressSoon() {
			setTimeout(() => syncStatusEl.classList.add("vsc-hidden"), 2500);
		}

		/** 打开 .vscode/sftp.json：不存在则先写模板/迁移，之后在编辑器里改、Ctrl+S 即生效 */
		async function openConfigFile() {
			const r = await request({ action: "sync_ensure" });
			if (!r.ok) { toast(`打开配置失败：${r.error}`); return; }
			void refreshSyncCfg();
			void openFile("local", r.path);
		}

		async function runSync(dir, scope, path) {
			showSyncProgress(dir === "up" ? "上传中…" : "下载中…");
			const r = await request({ action: "sync_run", dir, scope, path });
			if (!r.ok) { showSyncProgress(`同步失败：${r.error}`); hideSyncProgressSoon(); return; }
			const bad = r.failed?.length ?? 0;
			showSyncProgress(`${dir === "up" ? "上传" : "下载"}完成：${r.total - bad}/${r.total}${bad ? `（${bad} 个失败）` : ""}`);
			hideSyncProgressSoon();
			if (dir === "down") void refreshAll();
		}

		async function openSyncModal() {
			const q = (n) => syncBg.querySelector(`[name="${n}"]`);
			const r = await request({ action: "sync_get" });
			const cfg = r.ok ? r.config : {};
			q("s-name").value = cfg.name ?? "";
			q("s-host").value = cfg.host ?? "";
			q("s-user").value = cfg.username ?? "root";
			q("s-port").value = cfg.port ?? 22;
			q("s-pass").value = "";
			q("s-key").value = "";
			q("s-keypath").value = cfg.privateKeyPath ?? "";
			q("s-agent").value = cfg.agent ?? "";
			q("s-root").value = cfg.remoteRoot ?? "";
			q("s-exclude").value = (cfg.exclude ?? []).join(", ");
			q("s-autosave").checked = Boolean(cfg.uploadOnSave);
			q("s-pass").placeholder = cfg.hasPass ? "已保存（留空保持不变）" : "";
			q("s-keypath").placeholder = cfg.hasKey ? "已保存（留空保持不变）" : "~/.ssh/id_rsa";
			syncBg.classList.remove("vsc-hidden");
		}
		syncBg.querySelector(".cancel").addEventListener("click", () => syncBg.classList.add("vsc-hidden"));
		syncBg.querySelector(".test").addEventListener("click", async () => {
			const r = await request({ action: "sync_test" });
			toast(r.ok ? "连接成功 ✓" : `连接失败：${r.error}`);
		});
		syncBg.querySelector(".save-cfg").addEventListener("click", async () => {
			const q = (n) => syncBg.querySelector(`[name="${n}"]`);
			const body = {
				name: q("s-name").value.trim(),
				host: q("s-host").value.trim(),
				port: Number(q("s-port").value) || 22,
				username: q("s-user").value.trim() || "root",
				password: q("s-pass").value || undefined,
				privateKey: q("s-key").value.trim() || undefined,
				privateKeyPath: q("s-keypath").value.trim(),
				agent: q("s-agent").value.trim(),
				remoteRoot: q("s-root").value.trim(),
				exclude: q("s-exclude").value.split(",").map((s) => s.trim()).filter(Boolean),
				uploadOnSave: q("s-autosave").checked,
			};
			const r = await request({ action: "sync_save", config: body });
			if (!r.ok) { toast(`保存失败：${r.error}`); return; }
			void refreshSyncCfg(); // 缓存同步（uploadOnSave 等立即生效）
			syncBg.classList.add("vsc-hidden");
			toast("已保存到 .vscode/sftp.json");
		});

		// ---- 服务端事件分发 -------------------------------------------------------
		const offData = ctx.onData((payload) => {
			if (!payload) return;
			if (payload.res && pending.has(payload.reqId)) {
				const p = pending.get(payload.reqId);
				pending.delete(payload.reqId);
				p(payload);
				return;
			}
			// 防呆：无 reqId 的响应会被上面的匹配静默丢弃——发请求必须走 request()
			if (payload.res && !payload.reqId) {
				console.warn("[vscode-editor] 收到无 reqId 的响应（已忽略），请用 request() 发请求：", payload.action);
			}
			if (payload.kind === "workspace") { // 服务端工作区切换（主应用 set_cwd）：重建树 + 关本地标签
				void applyWorkspace(payload.root);
				return;
			}
			if (payload.kind === "state") { // 主机/连接列表广播（凭据脱敏）
				applyState(payload.state);
				return;
			}
			switch (payload.event) {
				case "shell_data": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write(b64.bytes(payload.b64));
							break;
						}
					}
					break;
				}
				case "shell_exit": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write("\r\n\x1b[90m〔shell 已退出〕\x1b[0m\r\n");
							break;
						}
					}
					break;
				}
				case "conn_closed":
					handleConnClosed(payload.connId, payload.reason);
					break;
				case "sync_progress":
					showSyncProgress(`同步中 ${payload.done}/${payload.total}：${payload.name ?? ""}`);
					break;
			}
		});

		// ---- 全局快捷键 ---------------------------------------------------------
		function onGlobalKey(ev) {
			if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") {
				ev.preventDefault();
				openQuickOpen();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
			} else if (ev.key === "Escape") {
				if (!quick.classList.contains("vsc-hidden")) closeQuickOpen();
				if (!menuEl.classList.contains("vsc-hidden")) hideMenu();
			}
		}
		container.ownerDocument.addEventListener("keydown", onGlobalKey, true);

		// ---- 启动 ----------------------------------------------------------------
		root.querySelector('.vsc-pane[data-pane="ssh"] .vsc-side-head').addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation(); // 同上
			if (btn.dataset.act === "add-host") openHostModal(null);
			else if (btn.dataset.act === "deps") void request({ action: "deps_install" });
			else if (btn.dataset.act === "new-term") { showTermPanel(); void newTerm(); }
			else if (btn.dataset.act === "r-new-file" || btn.dataset.act === "r-new-dir") {
				const t = pickRemoteDir();
				if (t) void promptCreate(t.connId, t.dir, btn.dataset.act === "r-new-dir" ? "dir" : "file");
			}
			else if (btn.dataset.act === "r-upload") {
				const t = pickRemoteDir();
				if (t) void pickFiles().then((files) => uploadFilesTo(t.connId, t.dir, files));
			}
			else if (btn.dataset.act === "r-search") {
				const t = pickRemoteDir();
				if (t) void runSearch(t.connId, t.dir);
			}
			else if (btn.dataset.act === "r-refresh") {
				void refreshAll();
				void request({ action: "state" }).then((r) => { if (r.ok && r.state) applyState(r.state); }); // 顺带重读 ~/.ssh/config
			}
		});
		/** 本地工具栏（＋📄/＋📁）目标：最近点选的本地节点（文件取其所在目录），否则工作区根 */
		function pickLocalDir() {
			if (selNode?.scope === "local") return selNode.type === "dir" ? selNode.path : parentOf(selNode.path);
			return "";
		}

		/** SSH 工具栏（＋📄/＋📁）目标：最近点选的远端节点（文件取其所在目录），否则第一台已连主机的根 */
		function pickRemoteDir() {
			if (selNode && selNode.scope !== "local" && conns.has(selNode.scope)) {
				return { connId: selNode.scope, dir: selNode.type === "dir" ? selNode.path : parentOf(selNode.path) };
			}
			const first = [...conns.keys()][0];
			if (!first) { toast("请先连接一台 SSH 主机"); return null; }
			return { connId: first, dir: conns.get(first).cwd };
		}

		switchPane("files");
		// 初始拉取：必须带 reqId 走响应通道——无 reqId 的响应会被
		// 「pending 匹配失败」丢弃，且它不是 kind:"state" 广播，永远没人处理
		void request({ action: "state" }).then((r) => {
			if (r.ok && r.state) applyState(r.state);
		});
		void refreshSyncCfg(); // 同步配置缓存（uploadOnSave / 远端根映射用）
		void renderTree();
		renderHosts();

		return () => {
			container.ownerDocument.removeEventListener("keydown", onGlobalKey, true);
			document.removeEventListener("click", hideMenu);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			for (const [, t] of terms.entries()) {
				try { t.ro?.disconnect(); } catch {}
				try { t.term?.dispose(); } catch {}
			}
			terms.clear();
			offData();
			view.destroy();
			root.remove();
		};
	},
};
