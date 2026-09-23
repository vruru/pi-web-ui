/** No Pi imports: npm replaces the SDK while this detached worker stays alive. */
import { execFile } from "node:child_process";
import { cpSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	CORE_PACKAGE,
	readUpdateJob,
	stableVersion,
	writeUpdateJson,
	type CoreUpdatePlan,
} from "./core-update-state.js";

const exec = promisify(execFile);
export interface WorkerEffects {
	backup(plan: CoreUpdatePlan): Promise<void>;
	restore(plan: CoreUpdatePlan): Promise<void>;
	cleanup(plan: CoreUpdatePlan): void;
	validate(plan: CoreUpdatePlan, version: string): Promise<void>;
	install(plan: CoreUpdatePlan, version: string): Promise<void>;
	restart(plan: CoreUpdatePlan): Promise<void>;
	health(plan: CoreUpdatePlan): Promise<{ piVersion?: string; pid?: number }>;
	installedVersion(plan: CoreUpdatePlan): string;
	sleep(ms: number): Promise<void>;
	now(): number;
}
const backupPath = (plan: CoreUpdatePlan) => join(dirname(plan.stateFile), `core-update-backup-${plan.id}`);
export const realWorkerEffects: WorkerEffects = {
	async backup(plan) {
		cpSync(dirname(plan.packageJson), backupPath(plan), { recursive: true, errorOnExist: true, force: false });
	},
	async restore(plan) {
		rmSync(dirname(plan.packageJson), { recursive: true, force: true });
		renameSync(backupPath(plan), dirname(plan.packageJson));
	},
	cleanup(plan) {
		rmSync(backupPath(plan), { recursive: true, force: true });
	},
	async validate(plan, version) {
		const entry = pathToFileURL(join(dirname(plan.packageJson), "dist/index.js")).href;
		const script = "const sdk = await import(process.argv[1]); if (sdk.VERSION !== process.argv[2]) process.exit(2);";
		await exec(process.execPath, ["--input-type=module", "-e", script, entry, version], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
	},
	async install(plan, version) {
		await exec(
			process.execPath,
			[
				plan.npmCli,
				"install",
				"--global",
				"--prefix",
				plan.prefix,
				"--registry=https://registry.npmjs.org",
				"--no-audit",
				"--ignore-scripts",
				"--no-fund",
				`${CORE_PACKAGE}@${version}`,
			],
			{
				timeout: 10 * 60_000,
				maxBuffer: 2 * 1024 * 1024,
				env: { ...process.env, npm_config_update_notifier: "false" },
			},
		);
	},
	async restart(plan) {
		await exec("/bin/launchctl", ["kickstart", "-k", plan.launchdTarget], { timeout: 30_000 });
	},
	async health(plan) {
		const response = await fetch(`http://127.0.0.1:${plan.port}/api/health`, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) throw new Error("Health endpoint unavailable");
		return (await response.json()) as { piVersion?: string; pid?: number };
	},
	installedVersion(plan) {
		return JSON.parse(readFileSync(plan.packageJson, "utf8")).version;
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: Date.now,
};

export async function runCoreUpdate(plan: CoreUpdatePlan, effects: WorkerEffects = realWorkerEffects): Promise<void> {
	if (!stableVersion(plan.targetVersion) || !stableVersion(plan.previousVersion))
		throw new Error("Invalid core version");
	const original = readUpdateJob(plan.stateFile);
	if (!original || original.id !== plan.id) throw new Error("Update ownership mismatch");
	const write = (phase: "installing" | "restarting" | "succeeded" | "failed", error?: string) =>
		writeUpdateJson(plan.stateFile, {
			...original,
			phase,
			workerPid: process.pid,
			updatedAt: effects.now(),
			...(error ? { error } : {}),
		});
	let restartAttempted = false;
	let backedUp = false;
	let keepBackup = false;
	try {
		write("installing");
		await effects.backup(plan);
		backedUp = true;
		await effects.install(plan, plan.targetVersion);
		if (effects.installedVersion(plan) !== plan.targetVersion)
			throw new Error("Installed core version did not match the requested version");
		await effects.validate(plan, plan.targetVersion);
		write("restarting");
		restartAttempted = true;
		await effects.restart(plan);
		const deadline = effects.now() + 90_000;
		while (effects.now() < deadline) {
			try {
				const health = await effects.health(plan);
				if (health.piVersion === plan.targetVersion && health.pid && health.pid !== plan.oldPid) {
					write("succeeded");
					return;
				}
			} catch {
				/* Restart window: listener need not be ready yet. */
			}
			await effects.sleep(1000);
		}
		throw new Error("Service did not reconnect with the requested core version within 90 seconds");
	} catch (error) {
		// npm can partially replace the SDK even when installation fails. Restore the
		// previously running version before allowing another attempt.
		let recovery: string;
		try {
			if (backedUp) await effects.restore(plan);
			if (effects.installedVersion(plan) !== plan.previousVersion) throw new Error("Version verification failed");
			await effects.validate(plan, plan.previousVersion);
			if (restartAttempted) {
				await effects.restart(plan);
				const deadline = effects.now() + 90_000;
				let restoredHealthy = false;
				while (effects.now() < deadline) {
					try {
						const health = await effects.health(plan);
						if (health.piVersion === plan.previousVersion && health.pid && health.pid !== plan.oldPid) {
							restoredHealthy = true;
							break;
						}
					} catch {
						/* Wait for the restored service. */
					}
					await effects.sleep(1000);
				}
				if (!restoredHealthy) throw new Error("Restored core did not become healthy");
			}
			recovery = "Previous core version restored.";
		} catch {
			keepBackup = true;
			recovery = "Automatic restoration failed; reinstall the previous core version manually.";
		}
		// Never expose npm output: it may contain authenticated registry URLs.
		const reason =
			error instanceof Error && !("cmd" in error) ? error.message : "Core installation or service restart failed";
		write("failed", `${reason} ${recovery}`);
	} finally {
		if (!keepBackup) {
			try {
				effects.cleanup(plan);
			} catch {
				/* Cleanup must not mask the final job state. */
			}
		}
		try {
			const lock = JSON.parse(readFileSync(plan.lockFile, "utf8"));
			if (lock.id === plan.id) rmSync(plan.lockFile, { force: true });
		} catch {
			/* Do not delete a different worker's lock. */
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const planPath = process.argv[2];
	try {
		const plan = JSON.parse(readFileSync(planPath, "utf8")) as CoreUpdatePlan;
		await runCoreUpdate(plan);
	} finally {
		if (planPath) rmSync(planPath, { force: true });
	}
}
