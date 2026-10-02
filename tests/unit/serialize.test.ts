import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { stripTransientRetryErrors, serializeMessage } from "../../server/serialize.js";

function assistantError(id: string): UiMessage {
	return { id, role: "assistant", content: [], stopReason: "error", errorMessage: "500 overloaded" };
}

function assistantText(id: string): UiMessage {
	return { id, role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" };
}

function userText(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: "q" }] };
}

describe("stripTransientRetryErrors", () => {
	it("未重试时原样返回（同一引用）", () => {
		const msgs = [userText("u"), assistantError("a")];
		expect(stripTransientRetryErrors(msgs, false)).toBe(msgs);
	});

	it("重试中去掉末尾连续的 error 气泡", () => {
		const msgs = [userText("u"), assistantText("a1"), assistantError("a2"), assistantError("a3")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out.map((m) => m.id)).toEqual(["u", "a1"]);
	});

	it("末尾不是 error 时不动", () => {
		const msgs = [assistantError("a1"), assistantText("a2")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out).toBe(msgs);
	});

	it("user/tool 消息截断剥离", () => {
		const tool: UiMessage = {
			id: "t-x",
			role: "toolResult",
			content: [{ type: "text", text: "boom" }],
			toolCallId: "x",
			isError: true,
		};
		const msgs = [assistantError("a1"), tool];
		expect(stripTransientRetryErrors(msgs, true)).toBe(msgs);
	});

	it("空数组安全", () => {
		expect(stripTransientRetryErrors([], true)).toEqual([]);
	});
});

describe("serializeMessage: toolResult 的 details", () => {
	const toolResult = (details?: unknown) =>
		({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "present_files",
			content: [{ type: "text", text: "shown" }],
			details,
			isError: false,
			timestamp: 123,
		}) as unknown as Parameters<typeof serializeMessage>[0];

	it("details 原样下发（present_files 卡片的数据面）", () => {
		const details = { items: [{ path: "docs/a.png", abs: "E:/w/docs/a.png", kind: "image", size: 10 }] };
		expect(serializeMessage(toolResult(details), 0)?.details).toEqual(details);
	});

	it("没有 details 时不带该字段（老快照字节一致）", () => {
		expect(serializeMessage(toolResult(undefined), 0)).not.toHaveProperty("details");
	});

	it("超过体积闸门 → 整丢（不截断成不可解析的 JSON）", () => {
		const huge = { items: [{ excerpt: "x".repeat(70_000) }] };
		expect(serializeMessage(toolResult(huge), 0)?.details).toBeUndefined();
	});

	it("序列化不了的值（循环引用）也不炸", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(serializeMessage(toolResult(cyc), 0)?.details).toBeUndefined();
	});
});

describe("serializeMessage: toolResult 的图片", () => {
	const toolResultWith = (content: unknown[]) =>
		({
			role: "toolResult",
			toolCallId: "tc-shot",
			toolName: "web_shot",
			content,
			isError: false,
			timestamp: 456,
		}) as unknown as Parameters<typeof serializeMessage>[0];

	it("图片块下发为 UiImageBlock（卡片直接显示），文字照常拼接", () => {
		const msg = serializeMessage(
			toolResultWith([
				{ type: "text", text: "shot of example.com" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			]),
			0,
		);
		expect(msg?.content).toEqual([
			{ type: "text", text: "shot of example.com", truncated: false },
			{ type: "image", dataUrl: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" },
		]);
	});

	it("兼容 legacy { source } 包裹形状", () => {
		const msg = serializeMessage(
			toolResultWith([{ type: "image", source: { type: "base64", data: "eA==", mediaType: "image/jpeg" } }]),
			0,
		);
		expect(msg?.content).toEqual([{ type: "image", dataUrl: "data:image/jpeg;base64,eA==", mimeType: "image/jpeg" }]);
	});

	it("纯图片结果不带空文本块", () => {
		const msg = serializeMessage(toolResultWith([{ type: "image", data: "eA==", mimeType: "image/png" }]), 0);
		expect(msg?.content).toHaveLength(1);
		expect(msg?.content[0]).toMatchObject({ type: "image" });
	});

	it("无图片时形状与旧版一致（单个文本块）", () => {
		const msg = serializeMessage(toolResultWith([{ type: "text", text: "ok" }]), 0);
		expect(msg?.content).toEqual([{ type: "text", text: "ok", truncated: false }]);
	});

	it("超大图片回落占位文本（不断半截 base64）", () => {
		const msg = serializeMessage(
			toolResultWith([{ type: "image", data: "x".repeat(3_000_000), mimeType: "image/png" }]),
			0,
		);
		expect(msg?.content).toEqual([{ type: "text", text: "[image result]", truncated: false }]);
	});

	it("图片超数时多余的回落占位文本", () => {
		const content = Array.from({ length: 10 }, () => ({ type: "image", data: "eA==", mimeType: "image/png" }));
		const msg = serializeMessage(toolResultWith(content), 0);
		const images = (msg?.content ?? []).filter((b) => b.type === "image");
		const texts = (msg?.content ?? []).filter((b) => b.type === "text");
		expect(images).toHaveLength(8);
		expect(texts.map((b) => (b as { text: string }).text).join("\n")).toBe("[image result]\n[image result]");
	});
});

describe("serializeMessage: system 消息不进快照", () => {
	it("system role 返回 null", () => {
		const sys = {
			role: "system",
			content: "",
			timestamp: 789,
		} as unknown as Parameters<typeof serializeMessage>[0];
		expect(serializeMessage(sys, 0)).toBeNull();
	});
});

describe("serializeMessage: assistant thinking 与 custom details 的体积闸门", () => {
	it("thinking 走 TEXT_CAP：超长思维链被截断并带 [truncated] 尾标", () => {
		const msg = serializeMessage(
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "x".repeat(200_001) }],
				timestamp: 1,
			} as unknown as Parameters<typeof serializeMessage>[0],
			0,
		);
		const block = msg?.content[0] as { type: string; thinking: string };
		expect(block.type).toBe("thinking");
		expect(block.thinking.startsWith("x".repeat(1000))).toBe(true);
		expect(block.thinking.length).toBeLessThan(200_100);
		expect(block.thinking.endsWith("[truncated]")).toBe(true);
	});

	it("thinking 未超限时原样下发", () => {
		const msg = serializeMessage(
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "短思维链" }],
				timestamp: 1,
			} as unknown as Parameters<typeof serializeMessage>[0],
			0,
		);
		expect(msg?.content[0]).toEqual({ type: "thinking", thinking: "短思维链" });
	});

	it("custom details 超 TOOL_DETAILS_CAP → 整丢（与 toolResult details 同一口径）", () => {
		const msg = serializeMessage(
			{
				role: "custom",
				customType: "my-widget",
				content: [{ type: "text", text: "hi" }],
				details: { blob: "x".repeat(70_000) },
				timestamp: 2,
			} as unknown as Parameters<typeof serializeMessage>[0],
			0,
		);
		expect(msg).not.toHaveProperty("details");
	});

	it("custom details 未超限原样下发；循环引用也不炸", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		const cycMsg = serializeMessage(
			{
				role: "custom",
				customType: "my-widget",
				content: [],
				details: cyc,
				timestamp: 3,
			} as unknown as Parameters<typeof serializeMessage>[0],
			0,
		);
		expect(cycMsg).not.toHaveProperty("details");
		const details = { fileName: "a.png" };
		const okMsg = serializeMessage(
			{
				role: "custom",
				customType: "attachment",
				content: [],
				details,
				timestamp: 4,
			} as unknown as Parameters<typeof serializeMessage>[0],
			0,
		);
		expect(okMsg?.details).toEqual(details);
	});
});
