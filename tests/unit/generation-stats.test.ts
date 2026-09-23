import { describe, expect, it } from "vitest";
import { GenerationStatsTracker } from "../../server/generation-stats";

function delta(tracker: GenerationStatsTracker, text: string, now: number, type = "text_delta") {
	tracker.observe({ type: "message_update", assistantMessageEvent: { type, delta: text } }, now);
}

function end(tracker: GenerationStatsTracker, output: number | undefined, now: number) {
	tracker.observe({ type: "message_end", message: { role: "assistant", usage: { output } } }, now);
}

describe("GenerationStatsTracker", () => {
	it("excludes TTFT, replaces estimates with provider output, and freezes at message end", () => {
		const tracker = new GenerationStatsTracker();
		expect(tracker.snapshot(0)).toBeUndefined();
		tracker.observe({ type: "agent_start" }, 0);
		delta(tracker, "", 5000);
		expect(tracker.snapshot(9000)?.tokensPerSecond).toBeNull();
		delta(tracker, "abcdefgh", 10000);
		delta(tracker, "ijklmnop", 11000);
		expect(tracker.snapshot(11000)).toEqual({
			tokensPerSecond: 4,
			outputTokens: 4,
			durationMs: 1000,
			estimated: true,
			isStreaming: true,
		});
		end(tracker, 20, 12000);
		expect(tracker.snapshot(999999)).toEqual({
			tokensPerSecond: 10,
			outputTokens: 20,
			durationMs: 2000,
			estimated: false,
			isStreaming: false,
		});
		tracker.observe({ type: "agent_end" }, 999999);
		expect(tracker.snapshot()?.tokensPerSecond).toBe(10);
	});

	it("resets each assistant message and excludes intervening tool execution", () => {
		const tracker = new GenerationStatsTracker();
		delta(tracker, "abcdefgh", 1000, "toolcall_delta");
		end(tracker, 12, 2000);
		tracker.observe({ type: "tool_execution_start" }, 2001);
		tracker.observe({ type: "message_end", message: { role: "toolResult" } }, 50000);
		expect(tracker.snapshot(50000)?.tokensPerSecond).toBe(12);
		tracker.observe({ type: "message_start", message: { role: "assistant" } }, 50000);
		delta(tracker, "next", 60000);
		end(tracker, 5, 61000);
		expect(tracker.snapshot(61000)?.tokensPerSecond).toBe(5);
		expect(tracker.snapshot(61000)?.outputTokens).toBe(5);
	});

	it("counts text, thinking, and tool arguments without per-delta rounding inflation", () => {
		const tracker = new GenerationStatsTracker();
		delta(tracker, "a", 0);
		delta(tracker, "b", 100, "thinking_delta");
		delta(tracker, "cd", 200, "toolcall_delta");
		delta(tracker, "思考", 300, "thinking_delta");
		delta(tracker, "ignored", 400, "toolcall_start");
		expect(tracker.snapshot(1000)?.outputTokens).toBe(3);
		end(tracker, undefined, 1000);
		expect(tracker.snapshot(1000)?.estimated).toBe(true);
		expect(tracker.snapshot(1000)?.tokensPerSecond).toBe(3);
	});

	it("keeps concurrent conversations independent", () => {
		const a = new GenerationStatsTracker();
		const b = new GenerationStatsTracker();
		delta(a, "abcdefgh", 0);
		delta(b, "一二三四", 1000);
		end(a, 5, 2000);
		end(b, 9, 4000);
		expect(a.snapshot()?.tokensPerSecond).toBe(2.5);
		expect(b.snapshot()?.tokensPerSecond).toBe(3);
	});

	it("does not manufacture timing for a complete response without deltas", () => {
		const tracker = new GenerationStatsTracker();
		tracker.observe({ type: "agent_start" }, 0);
		end(tracker, 100, 5000);
		expect(tracker.snapshot()).toMatchObject({ tokensPerSecond: null, outputTokens: 100, durationMs: 0 });
	});

	it("guards zero output and zero/very short/negative duration", () => {
		for (const endAt of [1000, 1000.01, 1050, 999]) {
			const tracker = new GenerationStatsTracker();
			delta(tracker, "buffered response", 1000);
			end(tracker, 100, endAt);
			expect(tracker.snapshot()?.tokensPerSecond).toBeNull();
			expect(tracker.snapshot()!.durationMs).toBeGreaterThanOrEqual(0);
		}
		const tracker = new GenerationStatsTracker();
		delta(tracker, "x", 0);
		end(tracker, 0, 1000);
		expect(tracker.snapshot()?.tokensPerSecond).toBeNull();
	});

	it("retains estimates on missing/invalid usage and freezes an interrupted stream", () => {
		for (const output of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const tracker = new GenerationStatsTracker();
			delta(tracker, "abcdefgh", 0);
			end(tracker, output, 1000);
			expect(tracker.snapshot()).toMatchObject({ outputTokens: 2, estimated: true, tokensPerSecond: 2 });
		}
		const tracker = new GenerationStatsTracker();
		delta(tracker, "abcdefgh", 0);
		tracker.observe({ type: "agent_end" }, 1000);
		expect(tracker.snapshot(60000)).toMatchObject({ isStreaming: false, tokensPerSecond: 2, durationMs: 1000 });
	});
});
