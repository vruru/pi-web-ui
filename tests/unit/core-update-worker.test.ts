import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUpdateJob, writeUpdateJson, type CoreUpdatePlan } from "../../server/core-update-state.js";
import { runCoreUpdate, type WorkerEffects } from "../../server/core-update-worker.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-core-worker-"));
	dirs.push(dir);
	const plan: CoreUpdatePlan = {
		id: "test",
		targetVersion: "0.88.0",
		previousVersion: "0.87.1",
		prefix: "/unused",
		packageJson: "/unused/package.json",
		npmCli: "/unused/npm.js",
		launchdTarget: "unused",
		port: 1,
		oldPid: 1,
		stateFile: join(dir, "state.json"),
		lockFile: join(dir, "lock.json"),
	};
	let version = plan.previousVersion;
	let now = 1_000;
	writeUpdateJson(plan.stateFile, {
		id: plan.id,
		phase: "installing",
		targetVersion: plan.targetVersion,
		startedAt: now,
		updatedAt: now,
	});
	writeUpdateJson(plan.lockFile, { id: plan.id });
	const effects: WorkerEffects = {
		backup: vi.fn(async () => {}),
		restore: vi.fn(async () => {
			version = plan.previousVersion;
		}),
		cleanup: vi.fn(),
		validate: vi.fn(async () => {}),
		install: vi.fn(async (_plan, v) => {
			version = v;
		}),
		restart: vi.fn(async () => {}),
		health: vi.fn(async () => ({ piVersion: version, pid: 2 })),
		installedVersion: () => version,
		sleep: async (ms) => {
			now += ms;
		},
		now: () => now,
	};
	return { plan, effects };
}
describe("detached core update worker", () => {
	it("only succeeds after install verification, fresh SDK import, restart and a new healthy process", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.health)
			.mockResolvedValueOnce({ piVersion: plan.targetVersion, pid: plan.oldPid })
			.mockRejectedValueOnce(new Error("restarting"));
		await runCoreUpdate(plan, effects);
		expect(readUpdateJob(plan.stateFile)?.phase).toBe("succeeded");
		expect(effects.backup).toHaveBeenCalledOnce();
		expect(effects.validate).toHaveBeenCalledWith(plan, plan.targetVersion);
		expect(effects.health).toHaveBeenCalledTimes(3);
		expect(effects.restore).not.toHaveBeenCalled();
		expect(existsSync(plan.lockFile)).toBe(false);
	});
	it("restores from local backup after partial npm failure without needing another download", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.install).mockRejectedValueOnce(
			Object.assign(new Error("secret registry credential"), { cmd: "npm" }),
		);
		await runCoreUpdate(plan, effects);
		const result = readUpdateJob(plan.stateFile);
		expect(result?.phase).toBe("failed");
		expect(result?.error).toContain("Previous core version restored");
		expect(result?.error).not.toContain("secret");
		expect(effects.install).toHaveBeenCalledOnce();
		expect(effects.restore).toHaveBeenCalledOnce();
		expect(effects.restart).not.toHaveBeenCalled();
	});
	it("rejects a broken SDK import and restores old files without restarting the existing process", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.validate).mockRejectedValueOnce(new Error("incompatible API"));
		await runCoreUpdate(plan, effects);
		expect(readUpdateJob(plan.stateFile)?.phase).toBe("failed");
		expect(effects.restore).toHaveBeenCalledOnce();
		expect(effects.restart).not.toHaveBeenCalled();
	});
	it("timeout waiting for the new runtime restores the old version and restarts it", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.health).mockResolvedValue({ piVersion: plan.previousVersion, pid: 2 });
		await runCoreUpdate(plan, effects);
		expect(readUpdateJob(plan.stateFile)?.error).toContain("90 seconds");
		expect(effects.restore).toHaveBeenCalledOnce();
		expect(effects.restart).toHaveBeenCalledTimes(2);
	});
	it("does not claim successful restoration when the old service fails its health check", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.health).mockRejectedValue(new Error("offline"));
		await runCoreUpdate(plan, effects);
		expect(readUpdateJob(plan.stateFile)?.error).toContain("restoration failed");
		expect(effects.cleanup).not.toHaveBeenCalled();
	});
	it("preserves the backup and another worker lock if recovery fails", async () => {
		const { plan, effects } = fixture();
		vi.mocked(effects.install).mockRejectedValueOnce(new Error("install failed"));
		vi.mocked(effects.restore).mockRejectedValueOnce(new Error("disk full"));
		writeUpdateJson(plan.lockFile, { id: "different" });
		await runCoreUpdate(plan, effects);
		expect(readUpdateJob(plan.stateFile)?.error).toContain("restoration failed");
		expect(effects.cleanup).not.toHaveBeenCalled();
		expect(existsSync(plan.lockFile)).toBe(true);
	});
});
