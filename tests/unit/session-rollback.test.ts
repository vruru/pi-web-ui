import { describe, it, expect } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("检查点回滚（Checkpoint Rollback）", () => {
	it("通过 branch(entryId) 截断会话上下文至目标检查点", () => {
		const sm = SessionManager.create(".");
		sm.newSession();

		const id1 = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: Date.now(),
		});
		const id2 = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Step 2" }],
			timestamp: Date.now(),
		});
		const id3 = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Bad question that went wrong" }],
			timestamp: Date.now(),
		});
		const id4 = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Bad question 2" }],
			timestamp: Date.now(),
		});

		// 初始叶子节点为 id4
		expect(sm.getLeafId()).toBe(id4);
		expect(sm.buildSessionContext().messages.length).toBe(4);

		// 回滚到 id2
		sm.branch(id2);
		expect(sm.getLeafId()).toBe(id2);

		// 回滚后上下文只包含 id1 和 id2
		const context = sm.buildSessionContext();
		expect(context.messages.length).toBe(2);
		expect((context.messages[0] as { content: unknown[] }).content[0]).toEqual({ type: "text", text: "Hello" });
		expect((context.messages[1] as { content: unknown[] }).content[0]).toEqual({ type: "text", text: "Step 2" });

		// 继续追加新消息，新消息以 id2 作为 parentId
		const id5 = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Fixed question" }],
			timestamp: Date.now(),
		});
		const entry5 = sm.getEntry(id5);
		expect(entry5?.parentId).toBe(id2);
		expect(sm.buildSessionContext().messages.length).toBe(3);
	});
});
