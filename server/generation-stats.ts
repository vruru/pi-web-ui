import type { UiGenerationStats } from "./protocol.js";

/** Sub-100ms / buffered single-chunk responses do not provide a useful sample. */
const MIN_SAMPLE_MS = 100;

interface GenerationEvent {
	type: string;
	message?: unknown;
	assistantMessageEvent?: { type: string; delta?: unknown };
}

/** Cheap streaming estimate; accumulate fractional units before rounding so
 *  splitting one token across several transport chunks cannot inflate it. */
function tokenUnits(text: string): number {
	let units = 0;
	for (const char of text) units += char.codePointAt(0)! > 0xff ? 1 : 0.25;
	return units;
}

function messageInfo(value: unknown): { role?: string; usage?: { output?: number }; content?: unknown } {
	return value && typeof value === "object" ? value : {};
}

function contentUnits(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let units = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") units += tokenUnits(block.text);
		if (block.type === "thinking" && typeof block.thinking === "string") units += tokenUnits(block.thinking);
		if (block.type === "toolCall" && block.arguments != null) {
			try {
				units += tokenUnits(JSON.stringify(block.arguments));
			} catch {
				// Malformed extension content should never interfere with generation.
			}
		}
	}
	return units;
}

/** Per-conversation, per-assistant-message timing. The monotonic clock starts
 *  with the first nonempty content delta, excluding TTFT and tool execution.
 *  This measures observed stream duration, not a provider's internal eval time. */
export class GenerationStatsTracker {
	private firstDeltaAt: number | undefined;
	private units = 0;
	private current: UiGenerationStats | undefined;

	observe(event: GenerationEvent, now = performance.now()): void {
		const message = messageInfo(event.message);
		if (event.type === "agent_start" || (event.type === "message_start" && message.role === "assistant")) {
			this.start();
		} else if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (
				delta &&
				["text_delta", "thinking_delta", "toolcall_delta"].includes(delta.type) &&
				typeof delta.delta === "string" &&
				delta.delta.length > 0
			) {
				if (!this.current?.isStreaming) this.start();
				this.firstDeltaAt ??= now;
				this.units += tokenUnits(delta.delta);
				this.current!.outputTokens = Math.ceil(this.units);
			}
		} else if (event.type === "message_end" && message.role === "assistant") {
			if (!this.current?.isStreaming) this.start();
			const output = message.usage?.output;
			if (typeof output === "number" && Number.isFinite(output) && output >= 0) {
				this.current!.outputTokens = output;
				this.current!.estimated = false;
			} else if (!this.units) {
				this.current!.outputTokens = Math.ceil(contentUnits(message.content));
			}
			this.finish(now);
		} else if (event.type === "agent_end" || event.type === "tool_execution_start") {
			// Also freeze interrupted streams that never emitted message_end.
			this.finish(now);
		}
	}

	snapshot(now = performance.now()): UiGenerationStats | undefined {
		if (!this.current) return undefined;
		const durationMs = this.current.isStreaming
			? this.firstDeltaAt === undefined
				? 0
				: Math.max(0, now - this.firstDeltaAt)
			: this.current.durationMs;
		return {
			...this.current,
			durationMs,
			tokensPerSecond:
				durationMs >= MIN_SAMPLE_MS && this.current.outputTokens > 0
					? (this.current.outputTokens * 1000) / durationMs
					: null,
		};
	}

	private start(): void {
		this.firstDeltaAt = undefined;
		this.units = 0;
		this.current = { tokensPerSecond: null, outputTokens: 0, durationMs: 0, estimated: true, isStreaming: true };
	}

	private finish(now: number): void {
		if (!this.current?.isStreaming) return;
		this.current = { ...this.snapshot(now)!, isStreaming: false };
	}
}
