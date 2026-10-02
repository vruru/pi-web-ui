/* 浏览器 E2E：点击「另一处」行打开菜单，明确接管后才搬迁。
 * 两个独立浏览器验证真实所有权转移，缺 Chrome 时跳过。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设 PI_WEB_CHROME 可指定路径）");
	process.exit(0);
}

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-elsewhere-click-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
freePort(PORT);
mkdirSync(WORK, { recursive: true });

/** 种一条历史会话（格式与 pi CLI/TUI 相同）。 */
function seedSession(cwd, id, text) {
	const dir = join(AGENT_DIR, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text }], timestamp: 1722700801000 },
			}),
		].join("\n") + "\n",
	);
	return file;
}
seedSession(WORK, "elsewhere-click-seed", "点击过户回归用的对话");
// 隔离的 agent 目录得先有 auth/models，否则首启弹「首次配置」挡住界面（零 token）。
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "sk-mock",
					models: [{ id: "ui-click-mock", name: "Mock" }],
				},
			},
		},
		null,
		2,
	),
);

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
		process.exitCode = 1;
	}
};

let server;
let browser;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

/** 等页面安静（服务端刚 build 过时页面会自愈重载一次）。 */
async function settle(page, quietMs = 2500) {
	let last = Date.now();
	const onNav = (f) => {
		if (f === page.mainFrame()) last = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		for (let i = 0; i < 80; i++) {
			if (Date.now() - last >= quietMs) break;
			await sleep(250);
		}
	} finally {
		page.off("framenavigated", onNav);
	}
}

/** 点一个元素：headless 下 locator.click() 偶发不达，按坐标派发真实鼠标事件。 */
async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** 打开一页（独立 context → 独立 sessionStorage → 独立 clientId）。 */
async function openPage(context) {
	const page = await context.newPage();
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);
	return page;
}

try {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_WEB_CWD: WORK,
			PI_CODING_AGENT_DIR: AGENT_DIR,
			// 扁平「额外会话根」：种子会话直接以 *.jsonl 平铺在那里就会被列出。
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
			PI_WEB_TOKEN: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	// ---- 页面 A：持有那条会话（点开历史会话 → 进「运行的对话」）-------------
	const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const pageA = await openPage(ctxA);
	const errorsA = [];
	pageA.on("pageerror", (e) => errorsA.push(String(e)));
	const leftA = pageA.locator(".panel-left").first();
	const histRow = leftA.locator(".panel-sessions .session-item").first();
	check("A：历史会话行可见", await until(async () => (await histRow.count()) > 0, 50, 250));
	await tap(pageA, histRow);
	check(
		"A：打开后「运行的对话」出现自有行",
		await until(async () => (await leftA.locator(".lp-section-convs .lp-row").count()) > 0, 50, 250),
	);

	// ---- 页面 B：应看到该对话作为「另一处」行 -----------------------------
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const pageB = await openPage(ctxB);
	const errorsB = [];
	pageB.on("pageerror", (e) => errorsB.push(String(e)));
	const leftB = pageB.locator(".panel-left").first();
	const elsewhereRow = leftB.locator(".session-item.elsewhere-item").first();
	check(
		"B：看到「另一处」行",
		await until(async () => (await elsewhereRow.count()) > 0, 60, 250),
		await leftB
			.locator(".panel-left, .panel-left")
			.first()
			.innerText()
			.catch(() => ""),
	);

	// 保留键盘可访问性；fork 使用带 button 角色的容器，内部另有菜单按钮。
	check("「另一处」行具有按钮角色", (await elsewhereRow.getAttribute("role")) === "button");
	check("「另一处」行可用键盘聚焦", (await elsewhereRow.getAttribute("tabindex")) === "0");

	await tap(pageB, elsewhereRow);
	const menu = pageB.locator(".ctx-menu");
	await menu.waitFor({ state: "visible" });
	check("第一次点击打开接管菜单", await menu.isVisible());
	check("打开菜单不自动搬迁", (await elsewhereRow.count()) > 0);
	const takeoverAction = menu
		.locator('[role="menuitem"]')
		.filter({ hasText: /Take over|接管|过户/i })
		.first();
	await tap(pageB, takeoverAction);
	const movedToSelf = await until(
		async () =>
			(await leftB.locator(".session-item.elsewhere-item").count()) === 0 &&
			(await leftB.locator(".lp-section-convs .session-item:not(.elsewhere-item)").count()) > 0,
		60,
		250,
	);
	check("菜单接管完成过户（elsewhere 行消失、变成本页自有对话）", movedToSelf);

	check("A：页面无 JS 报错", errorsA.length === 0, errorsA.join(" | "));
	check("B：页面无 JS 报错", errorsB.length === 0, errorsB.join(" | "));

	console.log(`\n${passed} check(s) passed`);
} catch (err) {
	console.error(`FAIL: ${err.stack || err}`);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	try {
		if (server?.pid) process.kill(-server.pid);
	} catch {
		try {
			server?.kill();
		} catch {
			/* ignore */
		}
	}
	await sleep(300);
}
