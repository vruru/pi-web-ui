/* Self-update E2E: the corner chip shows the running version, opening the
 * dropdown triggers a registry check and displays current/latest + status.
 * (The update itself runs in a visible terminal tab — not exercised here;
 * it would really run npm i -g.)
 * Run: npm run build && node update-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-update-"));
mkdirSync(join(base, "work"), { recursive: true });
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = join(base, "work");
process.env.PI_WEB_DATA_DIR = join(base, "data");
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.PI_WEB_CORE_UPDATE_CHECK = "off";
process.env.PI_WEB_PLUGIN_CATALOG_URL = "off";
mkdirSync(join(base, "agent"), { recursive: true });
writeFileSync(
	join(base, "agent", "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: "probe", extensions: [] }),
);
writeFileSync(join(base, "agent", "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "local-test" } }));
writeFileSync(
	join(base, "agent", "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "local-test",
				models: [
					{ id: "probe", name: "Probe", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 1024 },
				],
			},
		},
	}),
);

// fileURLToPath（不是 URL.pathname）：Windows 上 ".pathname" 得到 "/E:/..."，
// spawn 的脚本参数不存在 → ENOENT，测试根本起不来。
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, [join(repoRoot, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
process.on("exit", () => {
	try {
		// win32 没有负数 PID 的进程组，退回按端口清理。
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	let pkgVersion = "0.0.0";
	try {
		pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	} catch {
		// keep the fallback — the chip assertion below will simply fail loudly
	}
	console.log(`package.json version: ${pkgVersion}`);

	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });

	// A clean config may show the first-run setup; this test only checks updates.
	try {
		await page.locator(".modal-backdrop .modal-close").waitFor({ timeout: 3000 });
		await page.locator(".modal-backdrop .modal-close").click();
	} catch {
		/* no first-run modal */
	}
	// Default layout keeps the version menu in the overflow panel.
	await page.locator(".plugin-topbar-more > button").click();
	// -- corner chip shows the running version -------------------------------
	await page.waitForFunction(
		(v) => [...document.querySelectorAll("button.chip")].some((el) => el.textContent.includes(`v${v}`)),
		pkgVersion,
		{ timeout: 20000 },
	);
	const chip = page.locator(".dropdown", {
		hasText: "v" + pkgVersion,
	});
	check("corner update chip shows v" + pkgVersion, (await chip.count()) > 0);

	// -- open dropdown → registry check completes ----------------------------
	await chip.locator("button.chip").click();
	await page.waitForSelector(".dd-update", { timeout: 5000 });
	const customBuild =
		JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).piWebUiDistribution?.selfUpdate === false;
	if (customBuild) {
		await page.getByText("定制版网页，通过仓库构建包更新。核心和插件可在下方单独更新。").waitFor();
		check(
			"custom build explains its update source",
			await page
				.locator(".dd-update")
				.textContent()
				.then((t) => t.includes("定制版")),
		);
		check(
			"custom build has no public npm update action",
			(await page.getByRole("button", { name: "在终端中更新", exact: true }).count()) === 0,
		);
		check(
			"custom build does not claim to be the latest public release",
			!(await page
				.locator(".dd-update")
				.textContent()
				.then((t) => t.includes("已是最新版本"))),
		);
		check(
			"current version remains visible",
			await page
				.locator(".dd-update")
				.textContent()
				.then((t) => t.includes(`v${pkgVersion}`)),
		);
	} else {
		await page.waitForFunction(
			() => {
				const latest = [...document.querySelectorAll(".dd-row")].find((r) =>
					r.textContent.includes("最新版本"),
				)?.textContent;
				return latest && !latest.includes("检查中");
			},
			{ timeout: 20000 },
		);
		const rows = await page.locator(".dd-row").allTextContents();
		check(
			"current version remains visible",
			rows.some((r) => r.includes(`v${pkgVersion}`)),
		);
		const latest = rows.find((r) => r.includes("最新版本")) ?? "";
		check("latest version resolved", /v\d+\.\d+\.\d+/.test(latest) || latest.includes("失败"));
	}
	check("no page errors", consoleErrors.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
