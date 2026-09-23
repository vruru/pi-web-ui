/** Server-wide interface scale. CSS zoom on html includes body portals. */
export const UI_ZOOM_LEVELS = [90, 100, 110, 125, 150, 175] as const;

let appliedPercent = 100;

export function normalizeUiZoomPercent(value: unknown): number {
	return typeof value === "number" && UI_ZOOM_LEVELS.some((level) => level === value) ? value : 100;
}

export function getUiZoomFactor(): number {
	return appliedPercent / 100;
}

/** Pointer coordinates and DOMRect values are visual pixels; CSS lengths aren't. */
export function toUiZoomPixels(value: number): number {
	return value / getUiZoomFactor();
}

export function toUiZoomRect(rect: { left: number; right: number; top: number; bottom: number }) {
	return {
		left: toUiZoomPixels(rect.left),
		right: toUiZoomPixels(rect.right),
		top: toUiZoomPixels(rect.top),
		bottom: toUiZoomPixels(rect.bottom),
		width: toUiZoomPixels(rect.right - rect.left),
		height: toUiZoomPixels(rect.bottom - rect.top),
	};
}

/** Apply authoritative server state; never store a separate per-browser preference. */
export function applyUiZoom(value: unknown): number {
	const percent = normalizeUiZoomPercent(value);
	const changed = percent !== appliedPercent;
	appliedPercent = percent;
	if (typeof document !== "undefined") {
		const root = document.documentElement;
		root.style.zoom = String(getUiZoomFactor());
		root.style.setProperty("--ui-zoom", String(getUiZoomFactor()));
	}
	// Existing floating-panel and terminal-fit listeners must remeasure immediately.
	if (changed && typeof window !== "undefined") window.dispatchEvent(new Event("resize"));
	return percent;
}
