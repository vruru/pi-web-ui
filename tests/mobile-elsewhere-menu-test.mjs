// Isolated real touch browser: no production socket, sessions or model requests.
// npm run build:web && node tests/mobile-elsewhere-menu-test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const dist = fileURLToPath(new URL("../web/dist/", import.meta.url));
const server = createServer(async (req, res) => {
	const pathname = new URL(req.url, "http://localhost").pathname;
	const file = resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
	if (!file.startsWith(dist)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const data = await readFile(file);
		res.setHeader(
			"content-type",
			{ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[
				extname(file)
			] ?? "application/octet-stream",
		);
		res.end(data);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((r) => server.listen(8996, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
try {
	for (const mobile of [true, false]) {
		const ctx = await browser.newContext({
			viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
			isMobile: mobile,
			hasTouch: mobile,
		});
		const page = await ctx.newPage();
		const sent = [];
		await page.routeWebSocket("**/ws", (ws) =>
			ws.onMessage((raw) => {
				const m = JSON.parse(raw);
				sent.push(m);
				if (m.type === "hello")
					ws.send(
						JSON.stringify({
							type: "conversations",
							activeId: "local",
							conversations: [
								{
									id: "local",
									title: "Local fixture",
									cwd: "/fixture",
									messageCount: 2,
									isStreaming: false,
									isSubagent: false,
								},
							],
							elsewhere: [
								{
									owner: "other-browser",
									convId: "remote",
									title: "Remote fixture",
									cwd: "/fixture",
									isStreaming: true,
									requiresTakeover: true,
								},
							],
						}),
					);
			}),
		);
		await page.goto("http://127.0.0.1:8996/");
		if (mobile) {
			const toggle = page.locator(".panel-toggle").first();
			await toggle.tap();
		}
		const row = page.locator(".elsewhere-item").filter({ hasText: "Remote fixture" });
		await row.waitFor({ state: "visible" });
		if (mobile) await row.tap();
		else await row.click();
		const menu = page.locator(".ctx-menu");
		await menu.waitFor({ state: "visible" });

		const action = menu
			.locator('[role="menuitem"]')
			.filter({ hasText: /Take over|接管|过户/i })
			.first();
		if (mobile) await action.tap();
		else await action.click();
		assert(sent.some((m) => m.type === "take_over_conversation" && m.owner === "other-browser" && m.id === "remote"));
		if (mobile) {
			await page.locator(".panel-toggle").first().tap();
			const more = page.locator(".lp-elsewhere-act");
			const box = await more.boundingBox();
			assert(box.width >= 44 && box.height >= 44);
			await more.tap();
			await menu.waitFor({ state: "visible" });
		} else {
			await row.click({ button: "right" });
			await menu.waitFor({ state: "visible" });
		}
		console.log(
			`PASS ${mobile ? "mobile touch" : "desktop"} row opens menu, takeover targets correct owner/id, alternative menu entry works`,
		);
		await ctx.close();
	}
} finally {
	await browser.close();
	await new Promise((r) => server.close(r));
}
