import { expect, it } from "vitest";
import { CoreUpdateWorkTracker } from "../../server/core-update-work.js";
import { CoreUpdateAdmission } from "../../server/core-update-admission.js";
import { pendingCoreWork, withCoreWork } from "../../server/core-work.js";

it("keeps accepted async session changes busy until they settle without losing receiver or errors", async () => {
	const tracker = new CoreUpdateWorkTracker(new Set(["change", "fail"]));
	let finish!: () => void;
	const target = {
		value: 42,
		async change() {
			await new Promise<void>((r) => {
				finish = r;
			});
			return this.value;
		},
		sync() {
			return this.value;
		},
		async fail() {
			throw new Error("failed");
		},
	};
	const wrapped = tracker.wrap(target);
	expect(wrapped.sync()).toBe(42);
	expect(tracker.pending).toBe(0);
	const pending = wrapped.change();
	expect(tracker.pending).toBe(1);
	const admission = new CoreUpdateAdmission(
		{
			getState: () => ({
				currentVersion: "1.0.0",
				latestVersion: "1.0.1",
				updateAvailable: true,
				checkedAt: 1,
				checking: false,
				canUpdate: true,
				job: null,
			}),
			start: async () => {
				throw new Error("must not install");
			},
		},
		{ quiesce() {}, unquiesce() {}, isQuiesced: () => false, activeConversations: () => 0, pendingMessages: () => 0 },
		() => false,
		() => tracker.pending,
	);
	await expect(admission.start()).rejects.toThrow(/pending/);
	finish();
	expect(await pending).toBe(42);
	expect(tracker.pending).toBe(0);
	await expect(wrapped.fail()).rejects.toThrow("failed");
	expect(tracker.pending).toBe(0);
});

it("does not count an unrelated request that never settles", () => {
	const tracker = new CoreUpdateWorkTracker(new Set(["change"]));
	const wrapped = tracker.wrap({
		readOnly: () => new Promise<void>(() => {}),
	});
	void wrapped.readOnly();
	expect(tracker.pending).toBe(0);
});

it("preserves the original receiver for work counted inside an unwrapped method", async () => {
	let finish!: () => void;
	const target = {
		prompt() {
			return withCoreWork(
				this,
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
		},
	};
	const wrapped = new CoreUpdateWorkTracker(new Set<string>()).wrap(target);
	const prompt = wrapped.prompt();
	expect(pendingCoreWork(target)).toBe(1);
	const admission = new CoreUpdateAdmission(
		{
			getState: () => ({
				currentVersion: "1.0.0",
				latestVersion: "1.0.1",
				updateAvailable: true,
				checkedAt: 1,
				checking: false,
				canUpdate: true,
				job: null,
			}),
			start: async () => {
				throw new Error("must not install");
			},
		},
		{ quiesce() {}, unquiesce() {}, isQuiesced: () => false, activeConversations: () => 0, pendingMessages: () => 0 },
		() => false,
		() => pendingCoreWork(target),
	);
	await expect(admission.start()).rejects.toThrow(/pending/);
	finish();
	await prompt;
	expect(pendingCoreWork(target)).toBe(0);
});
