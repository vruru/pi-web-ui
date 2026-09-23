/** Durable core-only update records shared with the detached, SDK-free worker. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const CORE_PACKAGE = "@earendil-works/pi-coding-agent";
import type { CoreUpdateJob } from "./protocol.js";
export type { CoreUpdateJob, CoreUpdateState } from "./protocol.js";
export function stableVersion(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
export function newerVersion(a: string, b: string): boolean {
	const aa = a.split(".").map(Number);
	const bb = b.split(/[.+-]/).slice(0, 3).map(Number);
	for (let i = 0; i < 3; i++) {
		if (!Number.isSafeInteger(aa[i]) || !Number.isSafeInteger(bb[i])) return false;
		if (aa[i] !== bb[i]) return aa[i] > bb[i];
	}
	return b.includes("-");
}
export function writeUpdateJson(file: string, data: unknown): void {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
	renameSync(temp, file);
}
export function readUpdateJob(file: string): CoreUpdateJob | null {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		if (
			value &&
			typeof value.id === "string" &&
			stableVersion(value.targetVersion) &&
			["installing", "restarting", "succeeded", "failed"].includes(value.phase) &&
			Number.isFinite(value.startedAt) &&
			Number.isFinite(value.updatedAt)
		)
			return value;
	} catch {
		/* First run or incomplete/corrupt file: no accepted job. */
	}
	return null;
}
export function updateBusy(job: CoreUpdateJob | null): boolean {
	return job?.phase === "installing" || job?.phase === "restarting";
}
export interface CoreUpdatePlan {
	id: string;
	targetVersion: string;
	previousVersion: string;
	prefix: string;
	packageJson: string;
	npmCli: string;
	launchdTarget: string;
	port: number;
	oldPid: number;
	stateFile: string;
	lockFile: string;
}
