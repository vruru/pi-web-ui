import { expect, it } from "vitest";
import { finishedSubagentIds } from "../../web/src/subagent-visibility";
import type { ConversationSummary } from "../../web/src/types";
const conv = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	cwd: "/project",
	messageCount: 2,
	isStreaming: false,
	isSubagent: true,
	...extra,
});
it("collapses finished children including persisted children but never main sessions", () => {
	expect([
		...finishedSubagentIds(
			[conv("old"), conv("saved", { isSubagent: false, parentId: "main" }), conv("main", { isSubagent: false })],
			null,
		),
	]).toEqual(["old", "saved"]);
});
it("keeps active, streaming, waiting and newly initializing children visible", () => {
	expect([
		...finishedSubagentIds(
			[
				conv("active"),
				conv("running", { isStreaming: true }),
				conv("question", { hasQuestion: true }),
				conv("new", { messageCount: 0 }),
				conv("failed", { messageCount: 0, error: "failed" }),
				conv("canceled", { messageCount: 0, canceled: true }),
			],
			"active",
		),
	]).toEqual(["failed", "canceled"]);
});
it("keeps ancestors of visible descendants, and handles cycles", () => {
	const rows = [
		conv("root"),
		conv("middle", { parentId: "root" }),
		conv("running", { parentId: "middle", isStreaming: true }),
		conv("old", { parentId: "root" }),
	];
	expect([...finishedSubagentIds(rows, null)]).toEqual(["old"]);
	expect([
		...finishedSubagentIds([conv("a", { parentId: "b" }), conv("b", { parentId: "a", isStreaming: true })], null),
	]).toEqual([]);
});
it("automatically hides completed work and reveals resumed work without deleting records", () => {
	const child = conv("child", { isStreaming: true });
	const rows = [child];
	expect(finishedSubagentIds(rows, null).size).toBe(0);
	child.isStreaming = false;
	expect(finishedSubagentIds(rows, null).has("child")).toBe(true);
	child.isStreaming = true;
	expect(finishedSubagentIds(rows, null).size).toBe(0);
	expect(rows).toEqual([child]);
});
