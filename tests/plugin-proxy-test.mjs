/**
 * 通用代理 + live-preview 插件端到端测试（零 token、自包含）。
 *
 * 起真服务，把仓库 plugins/live-preview 装进临时 data-dir：
 * - /liveserver/ → index.html（含相对资源引用 + 注入的自动刷新脚本）
 * - /liveserver/style.css、/liveserver/app.js → 相对路径子资源可用
 * - /md/docs/a.md → Markdown 渲染成 HTML（含代码围栏与表格）
 * - Range 单段 → 206；缺失文件 → 404；越界（..）→ 拿不到工作区外文件
 * - /__livepreview/events → SSE 首帧含 version
 *
 * 运行：先 npm run build:server，再 node tests/plugin-proxy-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8984;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = join(import.meta.dirname, "..");

const serverPath = process.execPath;
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-proxy-data-"));
const workDir = mkdtempSync(join(tmpdir(), "pi-web-proxy-work-"));
const outsideDir = mkdtempSync(join(tmpdir(), "pi-web-proxy-out-"));

// 工作区夹具
writeFileSync(
	join(workDir, "index.html"),
	`<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1>hi preview</h1><script src="./app.js"></script></body></html>`,
);
writeFileSync(join(workDir, "style.css"), "body { color: red; }\n");
writeFileSync(join(workDir, "app.js"), "console.log('preview app');\n");
mkdirSync(join(workDir, "docs"), { recursive: true });
writeFileSync(
	join(workDir, "docs", "a.md"),
	`# 标题\n\nHello **加粗**\n\n\`\`\`js\nconsole.log(1);\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`,
);
writeFileSync(join(outsideDir, "secret.txt"), "OUTSIDE-MARKER-42");

// 被测插件装进临时 data-dir（装即存在，attach 时激活）
cpSync(join(REPO, "plugins", "live-preview"), join(dataDir, "plugins", "live-preview"), { recursive: true });

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}
const ok = (name) => console.log(`✓ ${name}`);

async function connectWs() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "proxy-test" })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

try {
	proc = spawn(serverPath, [join(REPO, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
			PI_WEB_TOKEN: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 20000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	// WS attach 触发插件激活（代理前缀随之注册）。注意：前缀未注册时请求会落进 SPA
	// catch-all 回 200 的 index.html，所以不能用 `.ok` 判活（issue #295 后 ready 先于
	// attach 到达，attach 完成前的第一次轮询必是 SPA 200）——必须等到插件真实内容。
	const sock = await connectWs();
	let up = false;
	for (let i = 0; i < 40; i++) {
		try {
			const r = await fetch(`${BASE}/liveserver/`);
			if (r.ok && (await r.text()).includes("__livepreview/events")) {
				up = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!up) fail("代理前缀 /liveserver 长时间未生效（插件未激活？）");

	// -- HTML 首页：相对资源引用保留 + 刷新脚本注入 -------------------------------
	let r = await fetch(`${BASE}/liveserver/`);
	let html = await r.text();
	if (r.status !== 200 || !html.includes("./style.css") || !html.includes("__livepreview/events"))
		fail(`GET /liveserver/ 异常：${r.status}`);
	else ok("GET /liveserver/ → index.html（含相对引用 + 刷新脚本）");
	if (!html.includes('content="/liveserver"')) fail("刷新脚本基址 meta 缺失（x-pi-proxy-prefix 未透传？）");
	else ok("代理前缀头透传 → meta 基址正确");

	// -- 相对子资源 ----------------------------------------------------------------
	r = await fetch(`${BASE}/liveserver/style.css`);
	if (r.status !== 200 || !(await r.text()).includes("color: red")) fail(`style.css 异常：${r.status}`);
	else ok("GET /liveserver/style.css → 200（相对路径可用）");
	r = await fetch(`${BASE}/liveserver/app.js`);
	if (r.status !== 200 || !(r.headers.get("content-type") ?? "").includes("javascript"))
		fail(`app.js 异常：${r.status}`);
	else ok("GET /liveserver/app.js → 200 + js MIME");

	// -- Markdown 渲染 ---------------------------------------------------------------
	r = await fetch(`${BASE}/md/docs/a.md`);
	html = await r.text();
	if (r.status !== 200 || !html.includes("<h1>标题</h1>") || !html.includes("加粗") || !html.includes("<table>"))
		fail(`md 渲染异常：${r.status}`);
	else ok("GET /md/docs/a.md → 渲染 HTML（标题/加粗/围栏/表格）");

	// -- 目录列表 --------------------------------------------------------------------
	r = await fetch(`${BASE}/md/docs/`);
	html = await r.text();
	if (r.status !== 200 || !html.includes("a.md")) fail(`目录列表异常：${r.status}`);
	else ok("GET /md/docs/ → 目录列表");

	// -- 404 --------------------------------------------------------------------------
	r = await fetch(`${BASE}/liveserver/no-such-file.html`);
	if (r.status !== 404) fail(`缺失文件应 404，实际 ${r.status}`);
	else ok("缺失文件 → 404");

	// -- 越界：工作区外文件拿不到 -------------------------------------------------------
	const traversals = [`${BASE}/liveserver/%2e%2e/%2e%2e/secret.txt`, `${BASE}/md/..%2f..%2fsecret.txt`];
	for (const u of traversals) {
		try {
			r = await fetch(u);
			const body = await r.text();
			if (body.includes("OUTSIDE-MARKER-42")) fail(`越界读到工作区外文件：${u}`);
		} catch {
			/* 连接层拒绝也算通过 */
		}
	}
	ok("越界路径拿不到工作区外文件");

	// -- Range 单段 → 206 ---------------------------------------------------------------
	r = await fetch(`${BASE}/liveserver/style.css`, { headers: { Range: "bytes=0-4" } });
	if (r.status !== 206 || !(r.headers.get("content-range") ?? "").startsWith("bytes 0-4/"))
		fail(`Range 应 206，实际 ${r.status}`);
	else ok("Range 单段 → 206 + Content-Range");

	// -- SSE 首帧 ------------------------------------------------------------------------
	const ctl = new AbortController();
	const sseRes = await fetch(`${BASE}/liveserver/__livepreview/events`, {
		headers: { Accept: "text/event-stream" },
		signal: ctl.signal,
	});
	const reader = sseRes.body.getReader();
	const decoder = new TextDecoder();
	let first = "";
	while (!first.includes("\n\n")) {
		const { done, value } = await reader.read();
		if (done) break;
		first += decoder.decode(value, { stream: true });
	}
	ctl.abort();
	if (sseRes.status !== 200 || !first.includes("version")) fail(`SSE 异常：${sseRes.status}`);
	else ok("SSE __livepreview/events → 首帧含 version");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 600));
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
