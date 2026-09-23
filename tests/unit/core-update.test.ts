import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreUpdateManager, resolveCoreInstallTarget, type CoreInstallTarget } from "../../server/core-update.js";
import { newerVersion, stableVersion, writeUpdateJson } from "../../server/core-update-state.js";

const dirs: string[] = [];
const managers: CoreUpdateManager[] = [];
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-core-update-"));
	dirs.push(dir);
	return dir;
}
function manager(extra: Partial<ConstructorParameters<typeof CoreUpdateManager>[0]> = {}) {
	const dataDir = extra.dataDir ?? tempDir();
	const result = new CoreUpdateManager({
		dataDir,
		currentVersion: "0.87.1",
		sdkEntry: "unused",
		origin: { supervisor: null },
		port: 19001,
		target: null,
		...extra,
	});
	managers.push(result);
	return result;
}
afterEach(() => {
	managers.splice(0).forEach((m) => m.dispose());
	dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const target: CoreInstallTarget = {
	prefix: "/unused",
	packageJson: "/unused/package.json",
	npmCli: "/unused/npm.js",
	launchdTarget: "gui/501/test",
};
describe("core updater", () => {
	it("accepts stable semver only, compares numeric versions without downgrades", () => {
		for (const version of ["0.87.1", "1.0.0"]) expect(stableVersion(version)).toBe(true);
		for (const version of ["1.0.0-beta", "latest", "01.1.1", "1.2.3 && x", "1.2.3+build", null])
			expect(stableVersion(version)).toBe(false);
		expect(newerVersion("0.100.0", "0.99.0")).toBe(true);
		expect(newerVersion("0.87.1", "0.87.1")).toBe(false);
		expect(newerVersion("0.87.0", "0.87.1")).toBe(false);
	});
	it("coalesces checks, rate limits forced checks and keeps errors distinguishable from up-to-date", async () => {
		let now = 1_000_000;
		const fetchLatest = vi.fn(async () => "0.88.0");
		const m = manager({ now: () => now, fetchLatest });
		await Promise.all([m.check(), m.check(true), m.check(true)]);
		expect(fetchLatest).toHaveBeenCalledTimes(1);
		expect(m.getState()).toMatchObject({ latestVersion: "0.88.0", updateAvailable: true, checking: false });
		now += 31_000;
		fetchLatest.mockRejectedValueOnce(new Error("offline"));
		await m.check(true);
		expect(m.getState()).toMatchObject({ latestVersion: "0.88.0", checkError: "offline" });
	});
	it("rejects prerelease registry tags and unsupported installs without a worker", async () => {
		const spawnWorker = vi.fn();
		const m = manager({ fetchLatest: async () => "0.88.0-beta", spawnWorker });
		await m.check();
		expect(m.getState().checkError).toContain("stable");
		await expect(m.start()).rejects.toThrow("unavailable");
		expect(spawnWorker).not.toHaveBeenCalled();
	});
	it("writes an exact-version plan and prevents concurrent or cross-instance updates", async () => {
		const dataDir = tempDir();
		const spawnWorker = vi.fn(async (file: string) => {
			const p = JSON.parse(readFileSync(file, "utf8"));
			expect(p.targetVersion).toBe("0.88.0");
			expect(p.prefix).toBe("/unused");
			return 123;
		});
		const m = manager({ dataDir, target, fetchLatest: async () => "0.88.0", spawnWorker });
		const first = m.start();
		await expect(m.start()).rejects.toThrow("already running");
		await first;
		expect(m.getState().job?.phase).toBe("installing");
		const other = manager({ dataDir, target, fetchLatest: async () => "0.88.0", spawnWorker });
		await expect(other.start()).rejects.toThrow("already running");
		expect(spawnWorker).toHaveBeenCalledTimes(1);
	});
	it("worker launch failure is persisted and releases the exclusive lock", async () => {
		const dataDir = tempDir();
		const spawnWorker = vi.fn().mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValue(123);
		const m = manager({ dataDir, target, fetchLatest: async () => "0.88.0", spawnWorker });
		await expect(m.start()).rejects.toThrow("spawn failed");
		expect(m.getState().job?.phase).toBe("failed");
		await m.start();
		expect(spawnWorker).toHaveBeenCalledTimes(2);
	});
	it("reconciles persisted worker state after service restart and detects a worker that never started", () => {
		const dataDir = tempDir();
		let now = 100_000;
		const job = {
			id: "a",
			phase: "restarting",
			targetVersion: "0.88.0",
			startedAt: now,
			updatedAt: now,
			workerPid: process.pid,
		};
		writeUpdateJson(join(dataDir, "core-update.json"), job);
		const m = manager({ dataDir, currentVersion: "0.88.0", now: () => now });
		expect(m.getState().job?.phase).toBe("restarting");
		writeUpdateJson(join(dataDir, "core-update.json"), { ...job, phase: "succeeded" });
		expect(m.getState().job?.phase).toBe("succeeded");
		writeUpdateJson(join(dataDir, "core-update.json"), { ...job, workerPid: undefined });
		now += 16_000;
		expect(m.getState().job?.phase).toBe("failed");
	});
	it("recovers a lock whose owner died before writing its job", async () => {
		const dataDir = tempDir();
		writeUpdateJson(join(dataDir, "core-update.lock"), { id: "abandoned", pid: 2147483647, startedAt: 1 });
		const m = manager({
			dataDir,
			now: () => 100_000,
			target,
			fetchLatest: async () => "0.88.0",
			spawnWorker: async () => 123,
		});
		await m.start();
		expect(m.getState().job?.phase).toBe("installing");
	});
	it("targets the actual global package prefix, not the Node/npm installation prefix", () => {
		const root = tempDir();
		const prefix = join(root, "pi-prefix");
		const pkg = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }),
		);
		writeFileSync(join(pkg, "dist/index.js"), "");
		const nodePrefix = join(root, "separate-node");
		mkdirSync(join(nodePrefix, "bin"), { recursive: true });
		mkdirSync(join(nodePrefix, "lib/node_modules/npm/bin"), { recursive: true });
		writeFileSync(join(nodePrefix, "bin/node"), "");
		writeFileSync(join(nodePrefix, "lib/node_modules/npm/bin/npm-cli.js"), "");
		const result = resolveCoreInstallTarget({
			sdkEntry: join(pkg, "dist/index.js"),
			origin: { supervisor: "launchd", name: "pi-web-ui" },
			mode: "global",
			platform: "darwin",
			nodePath: join(nodePrefix, "bin/node"),
			uid: 501,
		});
		expect(result.prefix).toBe(realpathSync(prefix));
		expect(result.npmCli).toContain("separate-node");
		expect(result.launchdTarget).toBe("gui/501/com.xingshuyin.pi-web-ui");
	});
});
