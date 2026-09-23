/** Browser-local side-panel proportions, independent of interface zoom. */
export type PanelSide = "left" | "right";
export interface PanelRatios {
	left: number;
	right: number;
}
export const PANEL_DEFAULT_PERCENT = 20;
export const PANEL_RATIOS_KEY = "pi-web-ui:panel-width-percent";
const MIN = 10;
const MAX = 40;
const TOTAL_MAX = 60;
const clamp = (value: number) => Math.max(MIN, Math.min(MAX, value));

export function normalizePanelRatios(value: Partial<PanelRatios>): PanelRatios {
	let left = clamp(Number.isFinite(value.left) ? value.left! : PANEL_DEFAULT_PERCENT);
	let right = clamp(Number.isFinite(value.right) ? value.right! : PANEL_DEFAULT_PERCENT);
	if (left + right > TOTAL_MAX) {
		const scale = TOTAL_MAX / (left + right);
		left *= scale;
		right *= scale;
	}
	return { left, right };
}

export function resizePanelRatio(current: PanelRatios, side: PanelSide, percent: number): PanelRatios {
	const safe = normalizePanelRatios(current);
	const other = side === "left" ? "right" : "left";
	return {
		...safe,
		[side]: Math.min(TOTAL_MAX - safe[other], clamp(Number.isFinite(percent) ? percent : PANEL_DEFAULT_PERCENT)),
	};
}

/** Both pointer delta and container width are visual pixels; do not divide by zoom again. */
export function draggedPanelPercent(start: number, deltaVisual: number, layoutVisualWidth: number): number {
	return layoutVisualWidth > 0 ? start + (deltaVisual / layoutVisualWidth) * 100 : start;
}

export function readPanelRatios(storage: Pick<Storage, "getItem">, layoutVisualWidth: number): PanelRatios {
	try {
		const saved = JSON.parse(storage.getItem(PANEL_RATIOS_KEY) ?? "null");
		if (saved && typeof saved === "object") return normalizePanelRatios(saved);
	} catch {
		/* Fall back to legacy widths or defaults. */
	}
	const legacy = (side: PanelSide) => {
		const pixels = Number(storage.getItem(`pi-web-ui:${side}-panel-width`));
		return layoutVisualWidth > 0 && pixels >= 180 && pixels <= 520
			? (pixels / layoutVisualWidth) * 100
			: PANEL_DEFAULT_PERCENT;
	};
	return normalizePanelRatios({ left: legacy("left"), right: legacy("right") });
}
