import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyUiZoom,
	getUiZoomFactor,
	normalizeUiZoomPercent,
	toUiZoomPixels,
	toUiZoomRect,
	UI_ZOOM_LEVELS,
} from "../../web/src/ui-zoom";
import { computeFloatingPosition } from "../../web/src/use-floating-panel";

afterEach(() => {
	vi.unstubAllGlobals();
	applyUiZoom(100);
});

describe("server-wide UI zoom", () => {
	it("only accepts the six supported scales and defaults corrupt or missing values to 100%", () => {
		expect(UI_ZOOM_LEVELS).toEqual([90, 100, 110, 125, 150, 175]);
		for (const value of UI_ZOOM_LEVELS) expect(normalizeUiZoomPercent(value)).toBe(value);
		for (const value of [undefined, null, "150", 0, 101, -100, NaN, Infinity, {}]) {
			expect(normalizeUiZoomPercent(value)).toBe(100);
		}
	});

	it("updates the root and notifies existing resize listeners only when scale changes", () => {
		const setProperty = vi.fn();
		const style = { zoom: "", setProperty };
		const dispatchEvent = vi.fn();
		vi.stubGlobal("document", { documentElement: { style } });
		vi.stubGlobal("window", { dispatchEvent });
		expect(applyUiZoom(150)).toBe(150);
		expect(style.zoom).toBe("1.5");
		expect(setProperty).toHaveBeenLastCalledWith("--ui-zoom", "1.5");
		expect(dispatchEvent).toHaveBeenCalledOnce();
		expect(dispatchEvent.mock.calls[0][0].type).toBe("resize");
		applyUiZoom(150);
		expect(dispatchEvent).toHaveBeenCalledOnce();
		applyUiZoom(undefined);
		expect(style.zoom).toBe("1");
		expect(dispatchEvent).toHaveBeenCalledTimes(2);
	});

	it.each(UI_ZOOM_LEVELS)("keeps visual anchors aligned with CSS fixed panels at %i percent", (percent) => {
		applyUiZoom(percent);
		const scale = percent / 100;
		expect(getUiZoomFactor()).toBe(scale);
		const rect = toUiZoomRect({ left: 200 * scale, right: 300 * scale, top: 50 * scale, bottom: 80 * scale });
		for (const [key, expected] of Object.entries({
			left: 200,
			right: 300,
			top: 50,
			bottom: 80,
			width: 100,
			height: 30,
		})) {
			expect(rect[key as keyof typeof rect]).toBeCloseTo(expected);
		}
		const pos = computeFloatingPosition(
			rect,
			{ width: toUiZoomPixels(180 * scale), height: toUiZoomPixels(120 * scale) },
			{ width: toUiZoomPixels(1200), height: toUiZoomPixels(800) },
		);
		expect(pos).toEqual({ x: 120, y: 86 });
		expect((pos.x + 180) * scale).toBeCloseTo(300 * scale);
		expect(pos.y * scale).toBeCloseTo(80 * scale + 6 * scale);
	});
});
