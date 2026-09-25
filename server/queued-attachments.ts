import type { AgentSession } from "@earendil-works/pi-coding-agent";
export interface QueuedImagePayload {
	text: string;
	images?: Parameters<AgentSession["steer"]>[1];
}
/** SDK queue events expose text only. Keep image payloads for lossless queue editing. */
export function syncQueuedImages(previous: QueuedImagePayload[], texts: readonly string[]): QueuedImagePayload[] {
	if (texts.length >= previous.length && previous.every((p, i) => p.text === texts[i])) {
		return [...previous, ...texts.slice(previous.length).map((text) => ({ text }))];
	}
	// SDK consumes the first matching message; match from the tail to retain later duplicates.
	const remaining = [...previous];
	const result: QueuedImagePayload[] = [];
	for (let i = texts.length - 1; i >= 0; i--) {
		const index = remaining.findLastIndex((p) => p.text === texts[i]);
		result.unshift(index < 0 ? { text: texts[i] } : remaining.splice(index, 1)[0]);
	}
	return result;
}
