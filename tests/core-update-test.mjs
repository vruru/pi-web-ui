/** Core update admission/protocol smoke: no registry, installation or restart.
 * Run after build: node tests/core-update-test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-web-core-update-test-"));
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const workDir = join(base, "work");
for (const dir of [dataDir, agentDir, workDir]) mkdirSync(dir);
const token = "core-update-local-smoke";
const sockets = [];
let server;
let serverLog = "";
let port = 20000 + Math.floor(Math.random() * 10000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, label, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
function connect(id) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
	sockets.push(socket);
	const messages = [];
	socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
	socket.on("open", () => socket.send(JSON.stringify({ type: "hello", clientId: id })));
	socket.on("error", (error) => messages.push({ type: "connection_error", error: String(error) }));
	return { socket, messages };
}
function assertInitial(state, currentVersion) {
	assert.ok(state, "ready must carry coreUpdate state");
	assert.equal(state.currentVersion, currentVersion, "core version must match the actual loaded SDK");
	assert.equal(state.latestVersion, null, "unknown latest version must not be fabricated");
	assert.equal(state.checkedAt, null, "disabled auto-check must not contact the registry");
	assert.equal(state.checking, false);
	assert.equal(state.updateAvailable, false);
	assert.equal(state.canUpdate, false, "foreground test service cannot perform managed core updates");
	assert.equal(typeof state.unsupportedReason, "string");
	assert.ok(state.unsupportedReason.length > 0);
	assert.equal(state.job, null, "no update worker should have been started");
}

try {
	while (await portUp(port)) port = 20000 + Math.floor(Math.random() * 10000);
	const env = {
		...process.env,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: token,
		PI_WEB_CORE_UPDATE_CHECK: "off",
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_OFFLINE: "1",
	};
	// Never inherit the desktop/session launch origin and accidentally permit a restart.
	for (const key of ["PI_WEB_LAUNCHED_BY", "PI_WEB_SERVICE_NAME", "XPC_SERVICE_NAME", "INVOCATION_ID"]) {
		delete env[key];
	}
	server = spawn(process.execPath, [join(repo, "dist/server/index.js")], {
		cwd: repo,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (chunk) => {
		serverLog += chunk;
	});
	server.stderr.on("data", (chunk) => {
		serverLog += chunk;
	});
	const baseUrl = `http://127.0.0.1:${port}`;
	const headers = { Authorization: `Bearer ${token}` };
	let health;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Server exited before ready: ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/api/health`, { headers });
			if (response.ok) {
				health = await response.json();
				break;
			}
		} catch {
			/* startup */
		}
		await sleep(100);
	}
	assert.ok(health?.piVersion, "health must expose the running core version");

	const wrong = await fetch(`${baseUrl}/api/core-update`, { headers: { Authorization: "Bearer wrong-token" } });
	assert.equal(wrong.status, 401, "core update status requires authentication");
	const noToken = await fetch(`${baseUrl}/api/core-update`);
	assert.equal(noToken.status, 401);
	const response = await fetch(`${baseUrl}/api/core-update`, { headers });
	assert.equal(response.status, 200);
	const httpState = await response.json();
	assertInitial(httpState, health.piVersion);
	console.log("✓ authenticated HTTP status reports the actual SDK and an unchecked, unsupported update state");

	const first = connect("core-update-first");
	const second = connect("core-update-second");
	const [readyA, readyB] = await Promise.all([
		waitFor(() => first.messages.find((m) => m.type === "ready"), "first ready"),
		waitFor(() => second.messages.find((m) => m.type === "ready"), "second ready"),
	]);
	assertInitial(readyA.coreUpdate, health.piVersion);
	assertInitial(readyB.coreUpdate, health.piVersion);
	// The second attach itself is accepted work, so the transient busy reason
	// can change between these two ready frames. Version/install state is shared.
	const { busyReason: _busyA, ...stableA } = readyA.coreUpdate;
	const { busyReason: _busyB, ...stableB } = readyB.coreUpdate;
	assert.deepEqual(stableA, stableB);
	console.log("✓ both clients receive the same authoritative core update state");

	const before = first.messages.length;
	first.socket.send(JSON.stringify({ type: "update_pi_core" }));
	const rejection = await waitFor(
		() => first.messages.slice(before).find((m) => m.type === "notice" && m.level === "error"),
		"unsupported core update rejection",
	);
	assert.ok(rejection.text || rejection.textEn, "unsupported update rejection needs an explanatory notice");
	const afterState = await (await fetch(`${baseUrl}/api/core-update`, { headers })).json();
	assertInitial(afterState, health.piVersion);
	for (const client of [first, second]) {
		for (const message of client.messages.filter((m) => m.type === "core_update_state")) {
			assertInitial(message.state, health.piVersion);
		}
	}
	assert.ok(
		!readdirSync(dataDir).some((file) => /^core-update.*(?:job|plan|lock)/.test(file)),
		"no worker job/plan/lock is created",
	);
	console.log("✓ unsupported update is rejected without a job, registry check, installer or restart");
	console.log("ALL CORE UPDATE PROTOCOL CHECKS PASSED");
} catch (error) {
	console.error(error);
	console.error(serverLog);
	process.exitCode = 1;
} finally {
	for (const socket of sockets) socket.terminate();
	if (server && server.exitCode === null) {
		const stopped = once(server, "exit");
		server.kill("SIGTERM");
		await Promise.race([stopped, sleep(3000)]);
		if (server.exitCode === null && server.signalCode === null) {
			server.kill("SIGKILL");
			await stopped;
		}
	}
	rmSync(base, { recursive: true, force: true });
}
