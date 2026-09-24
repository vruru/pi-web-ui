#!/usr/bin/env node
// Run a supervised service in a real, dedicated Herdr pane, retaining injected caller identity.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw Error("Usage: herdr-service.mjs <executable> [args...]");
const name = process.env.PI_WEB_HERDR_SESSION || "pi-web-ui";
const herdr = process.env.PI_WEB_HERDR_BIN || "herdr";
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function api(args) {
	const raw = execFileSync(herdr, ["--session", name, ...args], {
		encoding: "utf8",
		timeout: 10000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const value = raw.trim() ? JSON.parse(raw) : {};
	if (value.error) throw Error(value.error.message);
	return value.result;
}
const dir = mkdtempSync(join(tmpdir(), "pi-web-herdr-"));
const pidFile = join(dir, "pid");
let pane,
	childPid,
	stopping = false;
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function stop() {
	if (stopping) return;
	stopping = true;
	if (childPid && alive(childPid)) {
		process.kill(childPid, "SIGTERM");
		for (let n = 0; n < 50 && alive(childPid); n++) await sleep(100);
		if (alive(childPid)) process.kill(childPid, "SIGKILL");
	}
	if (pane) {
		try {
			api(["pane", "close", pane]);
		} catch {}
	}
	rmSync(dir, { recursive: true, force: true });
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
	try {
		api(["workspace", "list"]);
	} catch {
		const log = openSync(process.env.PI_WEB_HERDR_LOG || join(tmpdir(), "pi-web-herdr.log"), "a", 0o600);
		const server = spawn(herdr, ["--session", name, "server"], { detached: true, stdio: ["ignore", log, log] });
		server.on("error", (e) => console.error(e));
		server.unref();
		let ready = false;
		for (let n = 0; n < 50; n++) {
			await sleep(100);
			try {
				api(["workspace", "list"]);
				ready = true;
				break;
			} catch {}
		}
		if (!ready) throw Error("Herdr server did not start");
	}
	const result = api([
		"workspace",
		"create",
		"--cwd",
		process.env.PI_WEB_CWD || process.cwd(),
		"--label",
		"Pi Web service",
		"--no-focus",
	]);
	pane = result.root_pane.pane_id;
	// Pass the supervisor environment explicitly; keep Herdr's own pane/socket variables intact.
	const env = Object.entries(process.env)
		.filter(([k]) => !k.startsWith("HERDR_"))
		.map(([k, v]) => `${k}=${quote(v)}`);
	const script = join(dir, "start.sh");
	const redirects =
		(process.env.PI_WEB_HERDR_STDOUT ? ` >> ${quote(process.env.PI_WEB_HERDR_STDOUT)}` : "") +
		(process.env.PI_WEB_HERDR_STDERR ? ` 2>> ${quote(process.env.PI_WEB_HERDR_STDERR)}` : "");
	writeFileSync(
		script,
		`#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec env ${env.join(" ")} ${[executable, ...args].map(quote).join(" ")}${redirects}\n`,
		{ mode: 0o700 },
	);
	api(["pane", "run", pane, `exec /bin/sh ${quote(script)}`]);
	for (let n = 0; n < 100 && !stopping; n++) {
		try {
			childPid = Number(readFileSync(pidFile, "utf8"));
			if (childPid > 1) break;
		} catch {}
		await sleep(100);
	}
	if (!childPid) throw Error("Managed service process did not start");
	console.log(`Herdr service: session=${name} pane=${pane} pid=${childPid}`);
	while (!stopping && alive(childPid)) await sleep(500);
} finally {
	await stop();
}
