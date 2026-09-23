import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDanglingToolCalls, healDanglingToolCallFile } from "../../server/dangling-tools.js";

const assistantWithCalls = (ids: string[]) => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
});

const toolResult = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: Date.now(),
});

describe("findDanglingToolCalls", () => {
	it("healthy transcript has none", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			assistantWithCalls(["a"]),
			toolResult("a"),
		];
		expect(findDanglingToolCalls(msgs)).toEqual([]);
	});

	it("trailing toolCall without result is dangling", () => {
		const msgs = [{ role: "user", content: [] }, assistantWithCalls(["a"]), toolResult("a"), assistantWithCalls(["b"])];
		expect(findDanglingToolCalls(msgs)).toEqual([{ toolCallId: "b", toolName: "bash" }]);
	});

	it("only the unmatched call is reported", () => {
		const msgs = [assistantWithCalls(["a", "b"]), toolResult("a")];
		expect(findDanglingToolCalls(msgs)).toEqual([{ toolCallId: "b", toolName: "bash" }]);
	});

	it("accepts SessionManager entries with { message } wrapper", () => {
		const entries = [
			{ type: "message", id: "1", parentId: null, message: assistantWithCalls(["x"]) },
			{ type: "message", id: "2", parentId: "1", message: { role: "user", content: [] } },
		];
		expect(findDanglingToolCalls(entries)).toEqual([{ toolCallId: "x", toolName: "bash" }]);
	});
});

describe("healDanglingToolCallFile", () => {
	it("appends one synthetic toolResult per dangling call, chained", () => {
		const dir = mkdtempSync(join(tmpdir(), "dangling-"));
		const file = join(dir, "s.jsonl");
		const header = JSON.stringify({ type: "session", id: "s1", cwd: "/tmp" });
		const a = JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: assistantWithCalls(["call-1", "call-2"]),
		});
		writeFileSync(file, `${header}\n${a}\n`, "utf8");
		const n = healDanglingToolCallFile(file);
		expect(n).toBe(2);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBe(4);
		const e1 = JSON.parse(lines[2]);
		const e2 = JSON.parse(lines[3]);
		expect(e1.message.role).toBe("toolResult");
		expect(e1.message.toolCallId).toBe("call-1");
		expect(e1.parentId).toBe("m1");
		expect(e2.parentId).toBe(e1.id);
		expect(e2.message.toolCallId).toBe("call-2");
		// healed file is clean on second pass
		expect(healDanglingToolCallFile(file)).toBe(0);
	});

	it("healthy file is untouched", () => {
		const dir = mkdtempSync(join(tmpdir(), "dangling-"));
		const file = join(dir, "s.jsonl");
		const raw = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, message: assistantWithCalls(["a"]) }),
			JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: toolResult("a") }),
		].join("\n");
		writeFileSync(file, `${raw}\n`, "utf8");
		expect(healDanglingToolCallFile(file)).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(`${raw}\n`);
	});
});
