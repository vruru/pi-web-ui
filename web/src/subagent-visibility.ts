import type { ConversationSummary } from "./types";

/** Collapse idle children without deleting their transcripts or hiding active descendants. */
export function finishedSubagentIds(conversations: ConversationSummary[], activeId: string | null): Set<string> {
	const byId = new Map(conversations.map((c) => [c.id, c]));
	const finished = new Set(
		conversations
			.filter(
				(c) =>
					(c.isSubagent || c.parentId) &&
					!c.isStreaming &&
					!c.hasQuestion &&
					c.id !== activeId &&
					(c.messageCount > 0 || c.error || c.canceled),
			)
			.map((c) => c.id),
	);
	for (const c of conversations) {
		if (finished.has(c.id)) continue;
		const seen = new Set<string>([c.id]);
		let parentId = c.parentId;
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			finished.delete(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
	}
	return finished;
}
