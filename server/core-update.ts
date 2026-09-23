import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchOrigin } from "./launch-origin.js";
import {
	CORE_PACKAGE,
	newerVersion,
	readUpdateJob,
	stableVersion,
	updateBusy,
	writeUpdateJson,
	type CoreUpdatePlan,
	type CoreUpdateState,
} from "./core-update-state.js";

export type { CoreUpdateState } from "./core-update-state.js";
export interface CoreInstallTarget {
	prefix: string;
	packageJson: string;
	npmCli: string;
	launchdTarget: string;
}
/** Resolve from the SDK actually loaded, never `npm root -g` from a different Node install. */
export function resolveCoreInstallTarget(input: {
	sdkEntry: string;
	origin: LaunchOrigin;
	mode?: string;
	platform?: NodeJS.Platform;
	nodePath?: string;
	uid?: number;
}): CoreInstallTarget {
	if ((input.platform ?? process.platform) !== "darwin" || input.origin.supervisor !== "launchd")
		throw new Error("Automatic core updates require a macOS launchd-managed pi-web-ui service.");
	if ((input.mode ?? process.env.PI_WEB_SDK)?.trim().toLowerCase() !== "global")
		throw new Error("Automatic core updates require PI_WEB_SDK=global.");
	let dir = dirname(realpathSync(input.sdkEntry.startsWith("file:") ? fileURLToPath(input.sdkEntry) : input.sdkEntry));
	let packageJson = "";
	for (;;) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			try {
				if (JSON.parse(readFileSync(file, "utf8")).name === CORE_PACKAGE) {
					packageJson = file;
					break;
				}
			} catch {
				/* Keep looking. */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!packageJson) throw new Error("Cannot locate the running Pi core package.");
	const prefix = resolve(dirname(packageJson), "../../../..");
	if (join(prefix, "lib", "node_modules", CORE_PACKAGE, "package.json") !== packageJson)
		throw new Error("The running Pi core is not a standalone global installation.");
	accessSync(join(prefix, "lib", "node_modules"), constants.W_OK);
	accessSync(dirname(packageJson), constants.W_OK);
	const nodePath = realpathSync(input.nodePath ?? process.execPath);
	const npmCli = resolve(dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js");
	if (!existsSync(npmCli)) throw new Error("Cannot locate npm next to the running Node installation.");
	const name = input.origin.name ?? "pi-web-ui";
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Unrecognized launchd service name.");
	const label = name === "pi-web-ui" ? "com.xingshuyin.pi-web-ui" : `com.${name}.server`;
	return { prefix, packageJson, npmCli, launchdTarget: `gui/${input.uid ?? process.getuid!()}/${label}` };
}

interface ManagerOptions {
	dataDir: string;
	currentVersion: string;
	sdkEntry: string;
	origin: LaunchOrigin;
	port: number;
	onChange?: (state: CoreUpdateState) => void;
	/** Dependency injection for isolated tests, never accepted from browser input. */
	fetchLatest?: () => Promise<string>;
	target?: CoreInstallTarget | null;
	now?: () => number;
	spawnWorker?: (planFile: string) => Promise<number>;
}
export class CoreUpdateManager {
	private readonly stateFile: string;
	private readonly lockFile: string;
	private readonly target: CoreInstallTarget | null;
	private readonly now: () => number;
	private state: CoreUpdateState;
	private checking: Promise<CoreUpdateState> | null = null;
	private starting = false;
	private disposed = false;
	private lastAttempt = 0;
	private readonly poll: ReturnType<typeof setInterval>;
	constructor(private readonly options: ManagerOptions) {
		mkdirSync(options.dataDir, { recursive: true });
		this.stateFile = join(options.dataDir, "core-update.json");
		this.lockFile = join(options.dataDir, "core-update.lock");
		this.now = options.now ?? Date.now;
		let reason: string | undefined;
		let target: CoreInstallTarget | null = null;
		try {
			target = options.target !== undefined ? options.target : resolveCoreInstallTarget(options);
		} catch (error) {
			reason = error instanceof Error ? error.message : "Unsupported core installation.";
		}
		this.target = target;
		this.state = {
			currentVersion: options.currentVersion,
			latestVersion: null,
			updateAvailable: false,
			checkedAt: null,
			checking: false,
			canUpdate: Boolean(target),
			...(!target
				? { unsupportedReason: reason ?? "Automatic core updates are unavailable for this installation." }
				: {}),
			job: readUpdateJob(this.stateFile),
		};
		this.refreshJob();
		this.poll = setInterval(() => this.refreshJob(), 500);
		this.poll.unref();
	}
	getState(): CoreUpdateState {
		this.refreshJob();
		return structuredClone(this.state);
	}
	private emit(): void {
		if (!this.disposed) this.options.onChange?.(structuredClone(this.state));
	}
	private refreshJob(): void {
		let job = readUpdateJob(this.stateFile);
		if (updateBusy(job) && job) {
			let alive = true;
			if (job.workerPid) {
				try {
					process.kill(job.workerPid, 0);
				} catch {
					alive = false;
				}
			}
			if (
				(!alive && this.now() - job.updatedAt > 5000) ||
				(!job.workerPid && this.now() - job.updatedAt > 15_000) ||
				this.now() - job.updatedAt > 25 * 60_000
			) {
				job = {
					...job,
					phase: "failed",
					updatedAt: this.now(),
					error: "Core update worker stopped before completion. Check the core installation before retrying.",
				};
				writeUpdateJson(this.stateFile, job);
				this.releaseLock(job.id);
			}
		}
		if (!updateBusy(job)) {
			try {
				const lock = JSON.parse(readFileSync(this.lockFile, "utf8"));
				if (typeof lock.id === "string" && Number.isInteger(lock.pid) && this.now() - lock.startedAt > 15_000) {
					try {
						process.kill(lock.pid, 0);
					} catch {
						this.releaseLock(lock.id);
					}
				}
			} catch {
				/* No valid abandoned lock. */
			}
		}
		if (JSON.stringify(job) !== JSON.stringify(this.state.job)) {
			this.state.job = job;
			this.emit();
		}
	}
	async check(force = false): Promise<CoreUpdateState> {
		if (this.checking) return this.checking;
		const age = this.now() - this.lastAttempt;
		if (this.lastAttempt && age < (force ? 30_000 : 6 * 60 * 60_000)) return this.getState();
		this.lastAttempt = this.now();
		this.state.checking = true;
		delete this.state.checkError;
		this.emit();
		this.checking = (async () => {
			try {
				const latest = this.options.fetchLatest ? await this.options.fetchLatest() : await fetchStableCoreVersion();
				if (!stableVersion(latest)) throw new Error("Registry latest tag is not a stable core version.");
				this.state.latestVersion = latest;
				this.state.updateAvailable = newerVersion(latest, this.state.currentVersion);
				this.state.checkedAt = this.now();
			} catch (error) {
				this.state.checkError = error instanceof Error ? error.message : "Unable to check the latest core version.";
			} finally {
				this.state.checking = false;
				this.emit();
			}
			return this.getState();
		})();
		try {
			return await this.checking;
		} finally {
			this.checking = null;
		}
	}
	async start(): Promise<CoreUpdateState> {
		if (this.starting || updateBusy(this.getState().job)) throw new Error("A Pi core update is already running.");
		if (!this.target) throw new Error(this.state.unsupportedReason);
		this.starting = true;
		let id: string | undefined;
		let planFile: string | undefined;
		try {
			await this.check(true);
			if (this.state.checkError || !this.state.latestVersion || !this.state.updateAvailable)
				throw new Error(this.state.checkError ?? "The running Pi core is already up to date.");
			if (!stableVersion(this.options.currentVersion))
				throw new Error("Cannot automatically replace a prerelease core installation.");
			id = randomUUID();
			// O_EXCL is the cross-process single-writer gate, not just a UI flag.
			writeFileSync(this.lockFile, JSON.stringify({ id, pid: process.pid, startedAt: this.now() }), {
				flag: "wx",
				mode: 0o600,
			});
			const job = {
				id,
				phase: "installing" as const,
				targetVersion: this.state.latestVersion,
				startedAt: this.now(),
				updatedAt: this.now(),
			};
			writeUpdateJson(this.stateFile, job);
			planFile = join(this.options.dataDir, `core-update-plan-${id}.json`);
			const plan: CoreUpdatePlan = {
				...this.target,
				id,
				targetVersion: job.targetVersion,
				previousVersion: this.options.currentVersion,
				port: this.options.port,
				oldPid: process.pid,
				stateFile: this.stateFile,
				lockFile: this.lockFile,
			};
			writeUpdateJson(planFile, plan);
			await (this.options.spawnWorker ?? spawnCoreWorker)(planFile);
			this.refreshJob();
			return this.getState();
		} catch (error) {
			if (id) {
				const job = readUpdateJob(this.stateFile);
				if (job?.id === id)
					writeUpdateJson(this.stateFile, {
						...job,
						phase: "failed",
						updatedAt: this.now(),
						error: error instanceof Error ? error.message : "Could not start core update.",
					});
				this.releaseLock(id);
			}
			if (planFile) rmSync(planFile, { force: true });
			this.refreshJob();
			throw error;
		} finally {
			this.starting = false;
		}
	}
	private releaseLock(id: string): void {
		try {
			if (JSON.parse(readFileSync(this.lockFile, "utf8")).id === id) rmSync(this.lockFile, { force: true });
		} catch {
			/* No owned lock. */
		}
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.poll);
	}
}
export async function fetchStableCoreVersion(): Promise<string> {
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(CORE_PACKAGE)}/latest`, {
		signal: AbortSignal.timeout(10_000),
		headers: { Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`Core registry check failed (HTTP ${response.status}).`);
	const text = await response.text();
	if (text.length > 1024 * 1024) throw new Error("Core registry response is too large.");
	const value = JSON.parse(text) as { name?: string; version?: unknown; deprecated?: string };
	if (value.name !== CORE_PACKAGE || !stableVersion(value.version) || value.deprecated)
		throw new Error("Registry latest tag does not identify a supported stable Pi core release.");
	return value.version;
}
async function spawnCoreWorker(planFile: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./core-update-worker.js", import.meta.url)), planFile],
			{
				detached: true,
				stdio: "ignore",
				cwd: dirname(planFile),
				env: process.env,
			},
		);
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve(child.pid!);
		});
	});
}
