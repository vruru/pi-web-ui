// Prerequisite: npm run build once before running this test or the smoke suite.
/**
 * Auto-restart handoff test (foreground path):
 *
 * 1. start instance A on PORT
 * 2. start instance B with PI_WEB_RESTART_CHILD=1 on the same PORT — it must
 *    WAIT (not crash with EADDRINUSE) until A releases the port
 * 3. kill A → B takes over and serves /api/health
 */
import { portUp } from "./lib/port-utils.mjs";
import { isolatedTestEnv } from "./lib/isolated-env.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const isolated = isolatedTestEnv("restart-handoff-test");
process.once("exit", isolated.cleanup);
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 18998;
const PROJ = REPO_ROOT;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (await portUp(PORT)) throw new Error(`Port ${PORT} is already occupied`);
await sleep(400);

const env = { ...isolated.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: PROJ };

// Instance A: the old process.
const a = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: PROJ,
	env,
	stdio: "ignore",
});
process.once("exit", () => {
	if (a.exitCode === null && a.signalCode === null) a.kill("SIGKILL");
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
check("instance A up", await portUp(PORT));
const health = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.json().catch(() => null));
check("A answers health", health?.ok === true);

// Instance B: the auto-restart replacement. Must NOT crash — it waits.
const b = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...env, PI_WEB_RESTART_CHILD: "1" },
	stdio: "ignore",
});
process.once("exit", () => {
	if (b.exitCode === null && b.signalCode === null) b.kill("SIGKILL");
});
await sleep(2500);
check("B did not crash while A holds the port", b.exitCode === null, `exitCode=${b.exitCode ?? "still running"}`);

// Kill A → B should take over the port.
a.kill("SIGKILL");
const t0 = Date.now();
let bUp = false;
while (Date.now() - t0 < 15000) {
	try {
		const r = await fetch(`http://localhost:${PORT}/api/health`);
		const j = await r.json().catch(() => null);
		if (j?.ok === true) {
			bUp = true;
			break;
		}
	} catch {
		/* not up yet */
	}
	await sleep(300);
}
check("B took over the port after A exited", bUp);
check("B still alive", b.exitCode === null, `exitCode=${b.exitCode}`);

// Cleanup only the processes created by this test.
for (const child of [a, b]) {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
