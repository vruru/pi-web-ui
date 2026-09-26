// Persisted schedules must be manageable in Background tasks, even with no processes.
// Uses two isolated browsers, an isolated server/data directory, and zero model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { SchedulerStore } from "../dist/server/scheduler-tasks.js";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

if (!CHROME_PATH) throw new Error("Chrome is required for this UI regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 18995);
assert(Number.isInteger(port) && port >= 8900);
assert.equal(await portUp(port), false, "test port must be unoccupied");
const base = mkdtempSync(join(tmpdir(), "bg-scheduled-ui-"));
const agent = join(base, "agent");
mkdirSync(agent);
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				apiKey: "test-only",
				baseUrl: "http://127.0.0.1:1",
				models: [{ id: "mock", name: "Mock", contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock" }));
const store = new SchedulerStore(base);
store.upsert({
	id: "existing",
	name: "Persisted recurring check",
	cwd: base,
	kind: "interval",
	spec: "3300000",
	prompt: "Never fires during test",
	enabled: true,
	conversationId: "c5",
	sessionFile: join(base, "session.jsonl"),
	oneShot: false,
});
store.upsert({
	id: "paused",
	name: "Paused cron check",
	cwd: base,
	kind: "cron",
	spec: "0 9 * * *",
	prompt: "Never fires",
	enabled: false,
});
let server;
let browser;
let logs = "";
async function start() {
	server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
		cwd: root,
		env: {
			...process.env,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: base,
			PI_WEB_CWD: base,
			PI_CODING_AGENT_DIR: agent,
			PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"),
			PI_WEB_TOKEN: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_ENGINE: "pi",
			PI_WEB_TABS: "chat,tasks,settings",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (s) => {
		logs += s;
	});
	server.stderr.on("data", (s) => {
		logs += s;
	});
	for (let i = 0; i < 200; i++) {
		if (await portUp(port)) return;
		if (server.exitCode !== null) throw new Error(logs);
		await delay(100);
	}
	throw new Error(`Server startup failed: ${logs}`);
}
async function stop() {
	if (server && server.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		await exited;
	}
}
async function open(page) {
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.locator(".bg-task-chip").click();
	await page.locator('[data-schedule-id="existing"]').waitFor();
}
async function paused(page, value) {
	await page.waitForFunction(
		(value) => document.querySelector('[data-schedule-id="existing"]')?.classList.contains("off") === value,
		value,
	);
}
try {
	await start();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const a = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
	const b = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
	await open(a);
	await open(b);
	assert.equal(await a.locator(".bg-task-count").textContent(), "2");
	assert.equal(await a.locator(".bg-task-chip .bg-task-badge").textContent(), "2");
	assert.equal(await a.locator(".bg-task-empty").count(), 0);
	assert.equal(await a.locator(".bg-task-stopall").count(), 0);
	assert.match(await a.locator('[data-schedule-id="paused"]').textContent(), /0 9 \* \* \*/);
	const row = a.locator('[data-schedule-id="existing"]');
	await row.locator("button").first().click();
	await paused(a, true);
	await paused(b, true);
	const disk = JSON.parse(readFileSync(join(base, "scheduler-tasks.json"), "utf8")).tasks.existing;
	assert.equal(disk.enabled, false);
	assert.equal(disk.sessionFile, join(base, "session.jsonl"));
	assert.equal(disk.conversationId, "c5");
	await a.locator(".bg-task-foot button").first().click();
	assert.equal(await row.count(), 1);
	await b.locator('[data-schedule-id="existing"] button').first().click();
	await paused(a, false);
	await paused(b, false);
	// Pausing survives a cold server restart, and stays resumable in a newly opened modal.
	await row.locator("button").first().click();
	await paused(a, true);
	await stop();
	await start();
	await open(a);
	await paused(a, true);
	await row.locator("button").first().click();
	await paused(a, false);
	await a.setViewportSize({ width: 390, height: 720 });
	await a.waitForTimeout(200);
	const bounds = await a.locator(".bg-task-modal").boundingBox();
	assert(
		bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391 && bounds.y >= -1 && bounds.y + bounds.height <= 721,
	);
	assert.equal(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
	mkdirSync(join(root, "output/playwright"), { recursive: true });
	await a.screenshot({ path: join(root, "output/playwright/bg-scheduled-mobile.png") });
	a.once("dialog", (dialog) => dialog.dismiss());
	await row.locator("button").last().click();
	assert.equal(await row.count(), 1);
	a.once("dialog", (dialog) => dialog.accept());
	await row.locator("button").last().click();
	await row.waitFor({ state: "detached" });
	assert.equal(await a.locator(".bg-task-count").textContent(), "1");
	console.log(
		"PASS: seeded schedules, counts, refresh, pause/resume, two-client sync, restart persistence, mobile fit, delete confirmation; zero model calls",
	);
} finally {
	await browser?.close();
	await stop();
	rmSync(base, { recursive: true, force: true });
}
