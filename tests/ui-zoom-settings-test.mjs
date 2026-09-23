// Instance-wide UI zoom: distinct clients, late joins, restart and invalid input.
// Zero model calls; isolated data/agent directory and port >= 8900.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 18992);
if (port < 8900 || !Number.isInteger(port)) throw new Error("Use an isolated port >= 8900");
if (await portUp(port)) throw new Error(`Port ${port} is already occupied`);
const dataDir = mkdtempSync(join(tmpdir(), "pi-ui-zoom-"));
const clients = [];
let server;
let logs = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
	for (let i = 0; i < 300; i++) {
		const result = predicate();
		if (result) return result;
		await delay(50);
	}
	throw new Error(`Timed out: ${label}\n${logs.slice(-4000)}`);
}
async function start() {
	server = spawn(
		process.execPath,
		process.env.PI_WEB_TEST_SOURCE === "1" ? ["--import", "tsx", "server/index.ts"] : ["dist/server/index.js"],
		{
			cwd: root,
			env: {
				...process.env,
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(port),
				PI_WEB_DATA_DIR: dataDir,
				PI_WEB_CWD: dataDir,
				PI_CODING_AGENT_DIR: join(dataDir, "agent"),
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_TOKEN: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	server.stdout.on("data", (data) => {
		logs += data;
	});
	server.stderr.on("data", (data) => {
		logs += data;
	});
	server.on("error", (err) => {
		logs += err.message;
	});
	for (let i = 0; i < 300; i++) {
		if (await portUp(port)) return;
		if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
		await delay(50);
	}
	throw new Error(`Server did not start: ${logs}`);
}
async function stop() {
	for (const client of clients.splice(0)) client.ws.terminate();
	if (server && server.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		await exited;
	}
}
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const received = [];
	ws.on("message", (data) => received.push(JSON.parse(data.toString())));
	const client = {
		ws,
		send: (message) => ws.send(JSON.stringify(message)),
		wait: (type, predicate = () => true) =>
			waitFor(() => {
				const index = received.findIndex((message) => message.type === type && predicate(message));
				return index < 0 ? null : received.splice(index, 1)[0];
			}, type),
	};
	clients.push(client);
	await once(ws, "open");
	client.send({ type: "hello", clientId: id });
	client.ready = await client.wait("ready");
	return client;
}
try {
	await start();
	const a = await connect("zoom-a");
	const b = await connect("zoom-b");
	assert.equal(a.ready.uiZoomPercent, 100);
	assert.equal(b.ready.uiZoomPercent, 100);
	assert.equal((await a.wait("settings_state")).settings.uiZoomPercent, 100);
	a.send({ type: "set_settings", uiZoomPercent: 125 });
	for (const client of [a, b]) {
		assert.equal((await client.wait("ui_settings")).uiZoomPercent, 125);
		client.send({ type: "get_settings" });
		await client.wait("settings_state", (message) => message.settings.uiZoomPercent === 125);
	}
	assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "ui-settings.json"), "utf8")), { uiZoomPercent: 125 });
	const c = await connect("zoom-new-device");
	assert.equal(c.ready.uiZoomPercent, 125);
	await c.wait("settings_state", (message) => message.settings.uiZoomPercent === 125);
	b.send({ type: "set_settings", uiZoomPercent: 999 });
	await b.wait("notice", (message) => message.level === "error");
	b.send({ type: "get_settings" });
	await b.wait("settings_state", (message) => message.settings.uiZoomPercent === 125);
	await stop();
	assert.equal(readFileSync(join(dataDir, "client-state.json"), "utf8").includes("uiZoomPercent"), false);
	await start();
	const d = await connect("zoom-after-restart");
	assert.equal(d.ready.uiZoomPercent, 125);
	await d.wait("settings_state", (message) => message.settings.uiZoomPercent === 125);
	d.send({ type: "set_settings", uiZoomPercent: 100 });
	assert.equal((await d.wait("ui_settings")).uiZoomPercent, 100);
	console.log(
		"PASS: UI zoom default, cross-client broadcast, new device, invalid input, restart persistence and reset",
	);
} finally {
	await stop();
	rmSync(dataDir, { recursive: true, force: true });
}
