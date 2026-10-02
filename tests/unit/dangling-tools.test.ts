import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findDanglingToolCalls,
	healDanglingToolCallFile,
	tailAssistantToolCallIds,
} from "../../server/dangling-tools.js";

const assistantWithCalls = (ids: string[], stopReason?: string) => ({
	role: "assistant",
	...(stopReason ? { stopReason } : {}),
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

	it("ignores tool calls from aborted or error assistants (issue #332 online check)", () => {
		const aborted = [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			assistantWithCalls(["call_aborted"], "aborted"),
		];
		expect(findDanglingToolCalls(aborted)).toEqual([]);

		const errored = [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			assistantWithCalls(["call_error"], "error"),
		];
		expect(findDanglingToolCalls(errored)).toEqual([]);
	});
});

describe("tailAssistantToolCallIds (issue #332)", () => {
	it("returns empty set when lastId is null or entries is empty", () => {
		expect(tailAssistantToolCallIds([], null)).toEqual(new Set());
		expect(tailAssistantToolCallIds([], "any")).toEqual(new Set());
	});

	it("returns empty set for aborted assistant (issue #332 minimal repro)", () => {
		const entries = [
			{ id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{
				id: "a1",
				parentId: "u1",
				message: assistantWithCalls(["call_A"], "aborted"),
			},
		];
		expect(tailAssistantToolCallIds(entries, "a1")).toEqual(new Set());
	});

	it("returns empty set for error assistant", () => {
		const entries = [
			{ id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{
				id: "a1",
				parentId: "u1",
				message: assistantWithCalls(["call_E"], "error"),
			},
		];
		expect(tailAssistantToolCallIds(entries, "a1")).toEqual(new Set());
	});

	it("returns toolCallIds of normal active assistant", () => {
		const entries = [
			{ id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{ id: "a1", parentId: "u1", message: assistantWithCalls(["call_1", "call_2"]) },
		];
		expect(tailAssistantToolCallIds(entries, "a1")).toEqual(new Set(["call_1", "call_2"]));
	});

	it("stops and returns empty set when trailing entry is user message", () => {
		const entries = [
			{ id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{ id: "a1", parentId: "u1", message: assistantWithCalls(["call_1"]) },
			{ id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "next" }] } },
		];
		expect(tailAssistantToolCallIds(entries, "u2")).toEqual(new Set());
	});

	it("only traverses the active branch and ignores abandoned branches", () => {
		const entries = [
			{ id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
			{ id: "a_old", parentId: "u1", message: assistantWithCalls(["call_old"]) },
			{ id: "a_active", parentId: "u1", message: assistantWithCalls(["call_active"]) },
		];
		// If lastId is a_active, old branch a_old is never visited
		expect(tailAssistantToolCallIds(entries, "a_active")).toEqual(new Set(["call_active"]));
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

	it("skips old abandoned branch dangling calls (issue #332 branch check)", () => {
		const dir = mkdtempSync(join(tmpdir(), "dangling-"));
		const file = join(dir, "s.jsonl");
		const raw = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } }),
			// Abandoned branch: a_old has a dangling toolCall, but user retried and branched to a_new
			JSON.stringify({
				type: "message",
				id: "a_old",
				parentId: "u1",
				message: assistantWithCalls(["call_old"]),
			}),
			// Active branch: a_new succeeded with normal text, no tool calls
			JSON.stringify({
				type: "message",
				id: "a_new",
				parentId: "u1",
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			}),
		].join("\n");
		writeFileSync(file, `${raw}\n`, "utf8");
		// Should NOT heal call_old onto active branch tail
		expect(healDanglingToolCallFile(file)).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(`${raw}\n`);
	});

	it("does not heal aborted assistant tool calls at tail (issue #332 online check)", () => {
		const dir = mkdtempSync(join(tmpdir(), "dangling-"));
		const file = join(dir, "s.jsonl");
		const raw = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } }),
			JSON.stringify({
				type: "message",
				id: "a_aborted",
				parentId: "u1",
				message: assistantWithCalls(["call_aborted"], "aborted"),
			}),
		].join("\n");
		writeFileSync(file, `${raw}\n`, "utf8");
		// Should NOT append synthetic result for aborted assistant
		expect(healDanglingToolCallFile(file)).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(`${raw}\n`);
	});

	it("mixed scenario: only heals active tail call, ignores old branch (issue #332 mixed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "dangling-"));
		const file = join(dir, "s.jsonl");
		const header = JSON.stringify({ type: "session", id: "s1" });
		const u1 = JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } });
		// Old branch call
		const aOld = JSON.stringify({
			type: "message",
			id: "a_old",
			parentId: "u1",
			message: assistantWithCalls(["call_old"]),
		});
		// Active branch call that hung
		const aActive = JSON.stringify({
			type: "message",
			id: "a_active",
			parentId: "u1",
			message: assistantWithCalls(["call_active"]),
		});
		writeFileSync(file, `${header}\n${u1}\n${aOld}\n${aActive}\n`, "utf8");

		const n = healDanglingToolCallFile(file);
		expect(n).toBe(1);

		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBe(5);
		const synthetic = JSON.parse(lines[4]);
		expect(synthetic.message.role).toBe("toolResult");
		expect(synthetic.message.toolCallId).toBe("call_active");
		expect(synthetic.parentId).toBe("a_active");

		// Second pass is clean
		expect(healDanglingToolCallFile(file)).toBe(0);
	});
});
