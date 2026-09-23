import { describe, expect, it } from "vitest";
import {
	draggedPanelPercent,
	normalizePanelRatios,
	PANEL_RATIOS_KEY,
	readPanelRatios,
	resizePanelRatio,
} from "../../web/src/panel-widths";
const storage = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null });
describe("proportional side panels", () => {
	it("defaults to 20 percent columns and migrates legacy pixel preferences against visual viewport width once", () => {
		expect(readPanelRatios(storage({}), 1200)).toEqual({ left: 20, right: 20 });
		expect(
			readPanelRatios(storage({ "pi-web-ui:left-panel-width": "300", "pi-web-ui:right-panel-width": "240" }), 1200),
		).toEqual({ left: 25, right: 20 });
	});
	it("uses saved percentages regardless of viewport width or old pixel preferences", () => {
		const saved = storage({ [PANEL_RATIOS_KEY]: '{"left":25,"right":15}', "pi-web-ui:left-panel-width": "520" });
		for (const width of [600, 1200, 2400]) expect(readPanelRatios(saved, width)).toEqual({ left: 25, right: 15 });
	});
	it("bounds corrupt values and preserves space for the conversation without hiding columns", () => {
		expect(normalizePanelRatios({ left: 40, right: 40 })).toEqual({ left: 30, right: 30 });
		expect(normalizePanelRatios({ left: -50, right: NaN })).toEqual({ left: 10, right: 20 });
		expect(resizePanelRatio({ left: 20, right: 35 }, "left", 90)).toEqual({ left: 25, right: 35 });
		expect(resizePanelRatio({ left: 30, right: 25 }, "right", 20)).toEqual({ left: 30, right: 20 });
	});
	it("dragging the same relative visual distance is invariant under zoom", () => {
		for (const zoom of [0.9, 1, 1.25, 1.75]) expect(draggedPanelPercent(20, 120 * zoom, 1200 * zoom)).toBe(30);
		expect(draggedPanelPercent(20, -120, 1200)).toBe(10);
		expect(draggedPanelPercent(20, 120, 0)).toBe(20);
	});
});
