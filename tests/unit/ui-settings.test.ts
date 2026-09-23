import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UI_ZOOM_PERCENTAGES, UiSettingsStore } from "../../server/ui-settings.js";

const dirs: string[] = [];
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-ui-settings-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("instance UI settings", () => {
	it("defaults to 100 and persists every supported step across store recreation", () => {
		const dir = tempDir();
		const store = new UiSettingsStore(dir);
		expect(store.uiZoomPercent).toBe(100);
		for (const value of UI_ZOOM_PERCENTAGES) {
			store.setZoom(value);
			expect(new UiSettingsStore(dir).uiZoomPercent).toBe(value);
		}
		expect(JSON.parse(readFileSync(join(dir, "ui-settings.json"), "utf8"))).toEqual({ uiZoomPercent: 175 });
	});
	it("rejects invalid updates without replacing the accepted value", () => {
		const store = new UiSettingsStore(tempDir());
		store.setZoom(125);
		for (const value of [0, 101, 200, NaN, Infinity, "125", null, undefined, {}]) {
			expect(() => store.setZoom(value)).toThrow("Invalid UI zoom");
			expect(store.uiZoomPercent).toBe(125);
		}
	});
	it("ignores malformed disk data without rewriting it", () => {
		const dir = tempDir();
		const file = join(dir, "ui-settings.json");
		for (const raw of ["broken", "null", '{"uiZoomPercent":900}', '{"uiZoomPercent":"125"}']) {
			writeFileSync(file, raw);
			expect(new UiSettingsStore(dir).uiZoomPercent).toBe(100);
			expect(readFileSync(file, "utf8")).toBe(raw);
		}
	});
	it("keeps the last committed state when the disk write fails", () => {
		const dir = tempDir();
		const store = new UiSettingsStore(dir);
		store.setZoom(125);
		rmSync(join(dir, "ui-settings.json"));
		mkdirSync(join(dir, "ui-settings.json"));
		expect(() => store.setZoom(150)).toThrow();
		expect(store.uiZoomPercent).toBe(125);
	});
});
