import { describe, expect, it } from "vitest";
import { fileExtension, findFileHandler, syncFileHandlers } from "../../web/src/plugin-file-handlers.js";
import type { UiPluginInfo } from "../../server/protocol.js";

const plugin = (id: string, overrides: Partial<UiPluginInfo> = {}): UiPluginInfo =>
	({
		id,
		name: id,
		hasClient: true,
		...overrides,
	}) as UiPluginInfo;

describe("plugin file handler matching", () => {
	it("extracts a case-insensitive extension from workspace paths", () => {
		expect(fileExtension("reports/Annual.XLSX")).toBe(".xlsx");
		expect(fileExtension("README")).toBe("");
		expect(fileExtension(".env")).toBe("");
	});

	it("matches by extension and prefers higher priority", () => {
		syncFileHandlers(
			[
				plugin("low", { fileHandlers: [{ id: "default", extensions: [".xlsx"], priority: 0 }] }),
				plugin("high", { fileHandlers: [{ id: "default", extensions: [".XLSX"], priority: 100 }] }),
			],
			7,
		);
		expect(findFileHandler("a.xlsx")?.plugin.id).toBe("high");
		expect(findFileHandler("a.xls")).toBeNull();
	});

	it("ignores error plugins and those without a client bundle", () => {
		syncFileHandlers(
			[
				plugin("bad", {
					error: "boom",
					fileHandlers: [{ id: "default", extensions: [".xlsx"], priority: 100 }],
				}),
				plugin("noclient", {
					hasClient: false,
					fileHandlers: [{ id: "default", extensions: [".xlsx"], priority: 100 }],
				}),
			],
			8,
		);
		expect(findFileHandler("a.xlsx")).toBeNull();
		syncFileHandlers([], 9);
	});
});
