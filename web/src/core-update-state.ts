import { useSyncExternalStore } from "react";
import type { CoreUpdateState } from "./types";

let state: CoreUpdateState | null = null;
const listeners = new Set<() => void>();
export function setCoreUpdateState(next: CoreUpdateState | null): void {
	state = next;
	for (const listener of listeners) listener();
}
export function getCoreUpdateState(): CoreUpdateState | null {
	return state;
}
export function subscribeCoreUpdate(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function useCoreUpdateState(): CoreUpdateState | null {
	return useSyncExternalStore(subscribeCoreUpdate, getCoreUpdateState, getCoreUpdateState);
}

/** A notice preference only: versions and upgrade state always come from the server. */
const NOTICE_KEY = "pi-web-ui:core-update-notices";
const notified = new Set<string>();
export function claimCoreUpdateNotice(version: string): boolean {
	if (notified.has(version)) return false;
	try {
		const previous: unknown = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? "[]");
		if (Array.isArray(previous)) for (const item of previous) if (typeof item === "string") notified.add(item);
	} catch {
		/* Storage can be disabled; memory still prevents repeated notices. */
	}
	if (notified.has(version)) return false;
	notified.add(version);
	try {
		localStorage.setItem(NOTICE_KEY, JSON.stringify([...notified].slice(-30)));
	} catch {
		/* optional */
	}
	return true;
}
export function isCoreUpdateRunning(state: CoreUpdateState | null): boolean {
	return state?.job?.phase === "installing" || state?.job?.phase === "restarting";
}
export function resetCoreUpdateNoticesForTest(): void {
	notified.clear();
}
