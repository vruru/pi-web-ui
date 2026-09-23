import { expect, it } from "vitest";
import { CoreUpdateWorkTracker } from "../../server/core-update-work.js";
import { CoreUpdateAdmission } from "../../server/core-update-admission.js";

it("keeps accepted async session changes busy until they settle without losing receiver or errors", async () => {
	const tracker = new CoreUpdateWorkTracker();
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
	await expect(admission.start()).rejects.toThrow(/active conversations/);
	finish();
	expect(await pending).toBe(42);
	expect(tracker.pending).toBe(0);
	await expect(wrapped.fail()).rejects.toThrow("failed");
	expect(tracker.pending).toBe(0);
});
