// Prerequisite: npm run build once before running this test or the smoke suite.
/**
 * Issue #262 regression (Android/Termux files-panel navigation):
 *
 *   1. Directory symlinks must be listed as "dir" on ALL platforms (previously
 *      only the win32 branch of readDirForUI followed symlinks, so e.g. the
 *      Termux ~/storage/* links showed as files and could not be entered);
 *   2. A symlinked directory must be navigable from the tree;
 *   3. The panel path bar must expand a leading "~/…" to the home directory
 *      (same as completePath/makeDir) instead of treating it as
 *      workspace-relative and degrading to an empty listing;
 *   4. cwd-picker completions must also classify the symlink as "dir" — the
 *      picker only offers directories, so a "file" classification renders as
 *      an empty list (the actual #262 user symptom).
 *
 * The unreadable-"/" machine-root fallback is Android-only (on Linux/CI "/"
 * is listable) and is not covered here.
 */
import { portUp } from "./lib/port-utils.mjs";
import { isolatedTestEnv } from "./lib/isolated-env.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const isolated = isolatedTestEnv("list-files-symlink-home-test");
process.once("exit", isolated.cleanup);
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8923;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// Workspace lives under $HOME (not the system temp dir) — otherwise "~" cannot point at it.
const WS = join(homedir(), `.pi-web-ui-symtest-${randomUUID().slice(0, 8)}`);
const REAL = join(WS, "real");
mkdirSync(REAL, { recursive: true });
writeFileSync(join(WS, "top.txt"), "hello");
writeFileSync(join(REAL, "inner.txt"), "x");
try {
	symlinkSync("real", join(WS, "link"));
} catch (err) {
	// Windows without developer mode denies directory-symlink creation (EPERM) — the test premise does not hold, skip.
	console.log(`skip: cannot create a directory symlink on this platform (${err.code ?? err.message})`);
	rmSync(WS, { recursive: true, force: true });
	process.exit(0);
}

try {
	if (await portUp(PORT)) throw new Error(`Port ${PORT} is already occupied`);
	await sleep(400);
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: { ...isolated.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WS },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let serverErr = "";
	server.stderr.on("data", (d) => (serverErr += d.toString()));
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) {
		console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
		process.exit(1);
	}

	const clientId = randomUUID();
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	/** files / path_completions responses in arrival order. */
	const listResponses = [];
	const completionResponses = [];
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m.type === "files") listResponses.push(m);
		else if (m.type === "path_completions") completionResponses.push(m);
	});
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
	await sleep(800);

	const listAndWait = async (path, match) => {
		ws.send(JSON.stringify({ type: "list_files", path }));
		const t0 = Date.now();
		while (Date.now() - t0 < 8000 && !listResponses.some(match)) await sleep(150);
		return listResponses.filter(match).pop();
	};

	// 1) Symlinked directory is classified as "dir" in the listing.
	const root = await listAndWait("", (m) => m.path === "");
	const link = root?.entries.find((e) => e.name === "link");
	check("directory symlink is listed as dir", link?.type === "dir", `type=${link?.type}`);

	// 2) …and is navigable from the tree.
	const entered = await listAndWait("link", (m) => m.path === "link");
	check(
		"symlinked directory is navigable",
		entered !== undefined && entered.entries.some((e) => e.name === "inner.txt"),
		`entries=${entered ? JSON.stringify(entered.entries) : "none"}`,
	);

	// 3) Path bar "~/…" expands to the home directory (absolute machine-browse).
	const wsBase = WS.split("/").pop();
	const viaTilde = await listAndWait(`~/${wsBase}`, (m) => m.absolute === true && m.path.endsWith(wsBase));
	check(
		'path bar "~/" input expands to the home directory',
		viaTilde !== undefined && viaTilde.entries.some((e) => e.name === "top.txt"),
		`entries=${viaTilde ? viaTilde.entries.map((e) => e.name).join(",") : "none"}`,
	);

	// 4) cwd picker completions must classify the symlink as "dir" (else the
	//    directory-only picker renders an empty list).
	ws.send(JSON.stringify({ type: "complete_path", path: WS + "/" }));
	const t1 = Date.now();
	while (Date.now() - t1 < 8000 && completionResponses.length < 1) await sleep(150);
	const comp = completionResponses.pop();
	const compLink = comp?.completions.find((e) => e.name === "link");
	check("cwd picker classifies directory symlink as dir", compLink?.type === "dir", `type=${compLink?.type}`);

	const alive = server.exitCode === null && (await portUp(PORT));
	check("server stays alive", alive);

	ws.close();
	server.kill("SIGKILL");
} finally {
	rmSync(WS, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
