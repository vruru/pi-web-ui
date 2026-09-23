/** Instance-wide UI preferences, separate from per-client sessions and presets. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UI_ZOOM_PERCENTAGES = [90, 100, 110, 125, 150, 175] as const;
export function isUiZoomPercent(value: unknown): value is number {
	return typeof value === "number" && UI_ZOOM_PERCENTAGES.some((candidate) => candidate === value);
}

export class UiSettingsStore {
	private zoom = 100;
	private readonly file: string;
	constructor(private readonly dataDir: string) {
		this.file = join(dataDir, "ui-settings.json");
		try {
			const data = JSON.parse(readFileSync(this.file, "utf8")) as { uiZoomPercent?: unknown } | null;
			if (isUiZoomPercent(data?.uiZoomPercent)) this.zoom = data.uiZoomPercent;
		} catch {
			// Missing or malformed files use the default without overwriting user data.
		}
	}
	get uiZoomPercent(): number {
		return this.zoom;
	}
	setZoom(value: unknown): void {
		if (!isUiZoomPercent(value)) throw new Error("Invalid UI zoom percentage; use 90, 100, 110, 125, 150 or 175.");
		// Commit memory only after disk succeeds: a reported success must survive restart.
		mkdirSync(this.dataDir, { recursive: true });
		const tmp = `${this.file}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, JSON.stringify({ uiZoomPercent: value }, null, 2) + "\n");
			renameSync(tmp, this.file);
		} finally {
			rmSync(tmp, { force: true });
		}
		this.zoom = value;
	}
}
