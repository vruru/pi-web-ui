/* 浏览器 E2E（钉住对话常驻运行列表）：
 *
 *   1. seed 一条有内容的假会话 → 左栏历史行；点开它进「运行的对话」
 *   2. 运行行右键 → 菜单含「钉住」、不含「取消钉住」→ 点「钉住」
 *   3. 行上出现 📌 标记
 *   4. 把它切走（点成 active 后新建对话）→ 仍在运行列表里（空闲无终端也保留 = 本功能）
 *   5. 右键 → 「取消钉住」→ 标记消失；再走一遍同样的切换 → 该对话被释放（恢复旧行为）
 *
 * 零 token：switch_session 打开 seeded 会话即给运行列表造出内容，全程不调模型。
 * 缺 Chrome 时 SKIP。运行：npm run build && node tests/conv-pin-browser-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-convpin-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "readme.txt"), "hello\n");

/** 与 context-menu-ui-test.mjs 同款 seed：平铺 jsonl 进 PI_CODING_AGENT_SESSION_DIR。 */
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
const SEED_TEXT = "钉住回归用的对话";
seedSession(WORK, "pin-seed", SEED_TEXT);

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

async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function rightClick(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("rightClick: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

const menuItems = (page) => page.locator(".ctx-menu .ctx-menu-item, .ctx-menu .ctx-item");
async function menuTexts(page) {
	return (await menuItems(page).allTextContents()).map((s) => s.trim());
}
async function hasMenuItem(page, text) {
	return (await menuTexts(page)).some((t) => t.includes(text));
}
async function clickMenuItem(page, text) {
	await tap(page, menuItems(page).filter({ hasText: text }).first());
}

/** seeded 会话在左栏运行区的那一行（按 seed 文案定位）。 */
const seededRow = (page) => page.locator(".lp-section-convs .lp-row").filter({ hasText: SEED_TEXT }).first();

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		// 容器内以 root 跑需要跳过 sandbox（本机 CI 环境加这俩参数也无害）。
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	// headless chromium 的 navigator.languages 默认是 en-US，而 locale 选择
	// 顺序里浏览器语言优先于实例默认 → 给 context 直接指定中文，断言文案才是
	// 中文（被测逻辑与语言无关）。
	const context = await browser.newContext({ locale: "zh-CN" });
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });

	// 打开 seeded 会话 → 它有内容，进「运行的对话」。
	const leftPanel = page.locator(".panel-left").first();
	const historyRow = leftPanel.locator(".panel-sessions .lp-row").first();
	check("左栏列出 seeded 历史会话", await until(async () => (await historyRow.count()) > 0, 40, 250));
	await tap(page, historyRow);
	const runningSection = leftPanel.locator(".lp-section-convs").first();
	check("打开后进入「运行的对话」区", await until(async () => (await runningSection.count()) > 0, 50, 250));

	// ---- 1. 未钉住时右键：菜单给的是「钉住」，没有「取消钉住」 ------------------
	await rightClick(page, seededRow(page));
	check("运行行右键弹菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	const textsBefore = await menuTexts(page);
	check(
		"菜单含「钉住」",
		textsBefore.some((t) => t.includes("钉住") && !t.includes("取消")),
		textsBefore.join(" | "),
	);
	check("菜单此时不含「取消钉住」", !textsBefore.some((t) => t.includes("取消钉住")));

	// ---- 2. 点「钉住」→ 行上出现 📌 -------------------------------------------
	await clickMenuItem(page, "钉住");
	check("菜单点后关闭", await until(async () => (await page.locator(".ctx-menu").count()) === 0, 20, 150));
	check(
		"钉住后行上有 📌 标记",
		await until(async () => (await seededRow(page).locator(".pin-badge").count()) > 0, 40, 250),
	);
	const pinnedNotice = await until(
		async () =>
			(await page
				.locator(".notice, .toast")
				.filter({ hasText: /已钉住对话|Pinned/ })
				.count()) > 0,
		30,
		200,
	);
	check("服务端回了「已钉住」回执", pinnedNotice);

	// ---- 3. 切走（先点成 active 再新建对话）→ 钉住的对话仍留在运行列表 --------
	await tap(page, seededRow(page).locator(".session-item"));
	await sleep(600);
	await tap(page, leftPanel.locator('button.lp-new-chat-action[aria-label*="新对话"]').first());
	await sleep(600);
	check(
		"新建对话切走后，钉住的对话仍在运行列表（核心断言）",
		await until(async () => (await seededRow(page).count()) > 0, 40, 250),
	);
	check("📌 标记仍在", await until(async () => (await seededRow(page).locator(".pin-badge").count()) > 0, 30, 200));

	// ---- 4. 取消钉住：标记消失，同样的切换之后它被释放（恢复旧行为）----------
	await rightClick(page, seededRow(page));
	check("右键再次弹菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	check("已钉住时菜单文案换成「取消钉住」", await hasMenuItem(page, "取消钉住"), (await menuTexts(page)).join(" | "));
	await clickMenuItem(page, "取消钉住");
	check(
		"取消钉住后 📌 标记消失",
		await until(async () => (await seededRow(page).locator(".pin-badge").count()) === 0, 40, 250),
	);
	// 点回 seeded 会话（让它成为 active），再新建对话 → 未钉住时置换释放。
	await tap(page, seededRow(page).locator(".session-item"));
	await sleep(600);
	await tap(page, leftPanel.locator('button.lp-new-chat-action[aria-label*="新对话"]').first());
	check(
		"未钉住时同样的切换会把它移出运行列表（对照）",
		await until(async () => (await seededRow(page).count()) === 0, 40, 250),
		"切走即释放 = 旧行为",
	);

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
	console.log(`\n${passed} checks passed`);
}

try {
	await main();
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	if (server?.pid) {
		try {
			server.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
