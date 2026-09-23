import { describe, expect, it, vi } from "vitest";
import { CoreUpdateAdmission } from "../../server/core-update-admission.js";
import type { CoreUpdateState } from "../../server/protocol.js";

function fixture() {
	let gated = false;
	let active = 0;
	const state: CoreUpdateState = {
		currentVersion: "1.0.0",
		latestVersion: "1.0.1",
		updateAvailable: true,
		checkedAt: 1,
		checking: false,
		canUpdate: true,
		job: null,
	};
	const service = {
		quiesce: vi.fn(() => {
			gated = true;
		}),
		unquiesce: vi.fn(() => {
			gated = false;
		}),
		isQuiesced: () => gated,
		activeConversations: () => active,
		pendingMessages: () => 0,
	};
	const manager = {
		getState: () => state,
		start: vi.fn(async () => {
			expect(gated).toBe(true);
			state.job = { id: "job", phase: "installing", targetVersion: "1.0.1", startedAt: 1, updatedAt: 1 };
		}),
	};
	const admission = new CoreUpdateAdmission(manager, service, () => false);
	return {
		admission,
		manager,
		service,
		state,
		setActive: (n: number) => {
			active = n;
		},
	};
}

describe("core update admission", () => {
	it("refuses active conversations without installing or interrupting them", async () => {
		const f = fixture();
		f.setActive(1);
		expect(f.admission.getState().canUpdate).toBe(false);
		await expect(f.admission.start()).rejects.toThrow(/active conversations/);
		expect(f.manager.start).not.toHaveBeenCalled();
		expect(f.service.quiesce).not.toHaveBeenCalled();
	});
	it("holds the gate across install/restart, releases after failure, rejects concurrent requests", async () => {
		const f = fixture();
		await f.admission.start();
		expect(f.service.isQuiesced()).toBe(true);
		await expect(f.admission.start()).rejects.toThrow(/already running/);
		f.state.job!.phase = "restarting";
		f.admission.sync();
		expect(f.service.isQuiesced()).toBe(true);
		f.state.job!.phase = "failed";
		f.admission.sync();
		expect(f.service.isQuiesced()).toBe(false);
		expect(f.manager.start).toHaveBeenCalledTimes(1);
	});
	it("releases its gate when starting the worker fails", async () => {
		const f = fixture();
		f.manager.start.mockRejectedValueOnce(new Error("spawn failed"));
		await expect(f.admission.start()).rejects.toThrow("spawn failed");
		expect(f.service.isQuiesced()).toBe(false);
	});
	it("never clears an operator's preexisting drain gate", async () => {
		const f = fixture();
		f.service.quiesce();
		await expect(f.admission.start()).rejects.toThrow(/Resume/);
		f.admission.sync();
		expect(f.service.isQuiesced()).toBe(true);
		expect(f.service.unquiesce).not.toHaveBeenCalled();
	});
	it("a replacement server resumes the gate while the detached worker verifies restart", () => {
		const f = fixture();
		f.state.job = { id: "job", phase: "restarting", targetVersion: "1.0.1", startedAt: 1, updatedAt: 1 };
		f.admission.sync();
		expect(f.service.isQuiesced()).toBe(true);
		f.state.job.phase = "succeeded";
		f.admission.sync();
		expect(f.service.isQuiesced()).toBe(false);
	});
});
