// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreUpdateStatus } from "../../web/src/components/CoreUpdateStatus";
import {
	claimCoreUpdateNotice,
	getCoreUpdateState,
	resetCoreUpdateNoticesForTest,
	setCoreUpdateState,
	subscribeCoreUpdate,
} from "../../web/src/core-update-state";
import type { CoreUpdateState } from "../../server/protocol";

const send = vi.hoisted(() => vi.fn());
vi.mock("../../web/src/app-globals", () => ({ appSend: send }));
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
const initial: CoreUpdateState = {
	currentVersion: "0.87.1",
	latestVersion: "0.88.0",
	updateAvailable: true,
	checkedAt: 1234,
	checking: false,
	canUpdate: true,
	job: null,
};
function render(connected = true) {
	act(() => root.render(createElement(CoreUpdateStatus, { connected, status: connected ? "open" : "closed" })));
}
function click(selector: string) {
	const button = document.querySelector<HTMLButtonElement>(selector);
	expect(button).not.toBeNull();
	act(() => button!.click());
}
function receive(patch: Partial<CoreUpdateState>) {
	act(() => setCoreUpdateState({ ...initial, ...patch }));
}

beforeEach(() => {
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	resetCoreUpdateNoticesForTest();
	setCoreUpdateState(null);
	send.mockClear();
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("core updater footer", () => {
	it("waits for the stable footer before claiming a notice when ready precedes the first snapshot", () => {
		receive({});
		// The ready frame connects the minimal footer. The first chat snapshot
		// replaces it with the full slot-based footer, remounting this component.
		act(() =>
			root.render(
				createElement(CoreUpdateStatus, { key: "minimal", connected: true, status: "open", allowAutoNotice: false }),
			),
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(localStorage.getItem("pi-web-ui:core-update-notices")).toBeNull();
		act(() => root.render(createElement(CoreUpdateStatus, { key: "full", connected: true, status: "open" })));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(localStorage.getItem("pi-web-ui:core-update-notices")).toBe('["0.88.0"]');
	});
	it("opens once per new version, remembers dismissal across remount, and retains a badge", () => {
		receive({});
		render();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		click(".core-update-close");
		receive({ checking: true });
		receive({});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		act(() => root.unmount());
		root = createRoot(container);
		render();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector(".core-update-badge")).not.toBeNull();
		receive({ latestVersion: "0.89.0" });
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});
	it("shows actual running version, sends only explicit installs and waits for authoritative progress", () => {
		receive({});
		render();
		expect(send).not.toHaveBeenCalled();
		expect(document.querySelector("dd")?.textContent).toBe("0.87.1");
		click(".core-update-actions .primary");
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: "update_pi_core" });
		expect(document.querySelector(".core-update-progress")?.textContent).toBe("coreUpdateStarting");
		expect(document.querySelector<HTMLButtonElement>(".core-update-actions .primary")?.disabled).toBe(true);
		receive({ job: { id: "job", phase: "restarting", targetVersion: "0.88.0", startedAt: 1, updatedAt: 2 } });
		expect(document.querySelector(".core-update-progress")?.textContent).toBe("coreUpdateRestarting");
		render(false);
		receive({
			currentVersion: "0.88.0",
			updateAvailable: false,
			job: { id: "job", phase: "succeeded", targetVersion: "0.88.0", startedAt: 1, updatedAt: 3 },
		});
		expect(document.querySelector(".core-update-progress")?.textContent).toBe("coreUpdateReconnecting");
		render(true);
		expect(document.querySelector(".core-update-progress")).toBeNull();
		expect(document.querySelector(".status-conn-label")?.textContent).toBe("connected");
	});
	it("keeps failures actionable and blocks unsupported, busy and disconnected installs", () => {
		receive({
			job: { id: "job", phase: "failed", targetVersion: "0.88.0", startedAt: 1, updatedAt: 2, error: "npm failed" },
		});
		render();
		expect(document.querySelector(".core-update-error")?.textContent).toBe("npm failed");
		expect(document.querySelector<HTMLButtonElement>(".core-update-actions .primary")?.disabled).toBe(false);
		for (const patch of [{ canUpdate: false }, { busyReason: "Working" }]) {
			receive(patch);
			expect(document.querySelector<HTMLButtonElement>(".core-update-actions .primary")?.disabled).toBe(true);
		}
		receive({});
		render(false);
		expect(document.querySelector<HTMLButtonElement>(".core-update-actions .primary")?.disabled).toBe(true);
	});
	it("supports manual version checks without initiating installation", () => {
		receive({ updateAvailable: false });
		render();
		click(".core-update-trigger");
		click(".core-update-actions button");
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: "check_core_update", force: true });
	});
	it("discovers an update through HTTP before the first chat connection attaches", async () => {
		const installing = {
			...initial,
			job: { id: "job", phase: "installing" as const, targetVersion: "0.88.0", startedAt: 1, updatedAt: 2 },
		};
		vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => installing } as Response);
		await act(async () => {
			root.render(createElement(CoreUpdateStatus, { connected: false, status: "closed" }));
		});
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/core-update"),
			expect.objectContaining({ cache: "no-store" }),
		);
		expect(document.querySelector(".status-conn-label")?.textContent).toBe("coreUpdateUpdating");
		expect(getCoreUpdateState()?.job?.phase).toBe("installing");
	});
	it("retains the server snapshot and only persists notification preferences", () => {
		const listener = vi.fn();
		const unsub = subscribeCoreUpdate(listener);
		setCoreUpdateState(initial);
		expect(getCoreUpdateState()).toBe(initial);
		expect(listener).toHaveBeenCalledOnce();
		unsub();
		expect(claimCoreUpdateNotice("0.88.0")).toBe(true);
		resetCoreUpdateNoticesForTest();
		expect(claimCoreUpdateNotice("0.88.0")).toBe(false);
		expect(localStorage.length).toBe(1);
		expect(localStorage.getItem(localStorage.key(0)!)).toBe('["0.88.0"]');
	});
});
