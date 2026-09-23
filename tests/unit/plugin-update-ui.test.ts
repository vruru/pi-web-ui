// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePluginUpdates } from "../../web/src/use-plugin-updates";
vi.mock("../../web/src/auth-token", () => ({ withToken: (url: string) => url }));
let root: Root;
let available: Set<string>;
function Harness({ revision = "initial" }: { revision?: string }) {
	available = usePluginUpdates(true, revision);
	return createElement("div", null, [...available].join(","));
}
beforeEach(() => {
	root = createRoot(document.createElement("div"));
});
afterEach(() => {
	act(() => root.unmount());
	vi.unstubAllGlobals();
});
it("only advertises confirmed updates and clears after successful installation", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				updates: [{ id: "new", updatable: true }, { id: "current", updatable: false }, { id: "unknown" }],
			}),
		})
		.mockResolvedValueOnce({ ok: true, json: async () => ({ updates: [{ id: "new", updatable: false }] }) });
	vi.stubGlobal("fetch", fetcher);
	await act(async () => root.render(createElement(Harness)));
	expect([...available]).toEqual(["new"]);
	await act(async () => root.render(createElement(Harness, { revision: "job-done" })));
	expect(available.size).toBe(0);
});
it("does not advertise an update on network failure", async () => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
	await act(async () => root.render(createElement(Harness)));
	expect(available.size).toBe(0);
});
it("ignores stale results from the check preceding an installation", async () => {
	let resolve!: (value: unknown) => void;
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			)
			.mockResolvedValue({ ok: true, json: async () => ({ updates: [] }) }),
	);
	await act(async () => root.render(createElement(Harness)));
	await act(async () => root.render(createElement(Harness, { revision: "updated" })));
	await act(async () =>
		resolve({ ok: true, json: async () => ({ updates: [{ id: "old-result", updatable: true }] }) }),
	);
	expect(available.size).toBe(0);
});
