import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MAX_PENDING_WS_MESSAGES, PendingCommandQueue, resetPendingDropWarn } from "../../server/ws-pending-queue.js";

/** 最小 ClientMessage 构造：pending 队列只存引用不解释内容。 */
const msg = (n: number) =>
	({ type: "get_state" as const, seq: n }) as unknown as Parameters<PendingCommandQueue["push"]>[0];

beforeEach(() => {
	resetPendingDropWarn();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("attach 前 pending 命令队列上限", () => {
	it("默认上限 256（对齐任务建议值）", () => {
		expect(MAX_PENDING_WS_MESSAGES).toBe(256);
	});

	it("未超限时先进先出，drain 取走全部并清空", () => {
		const q = new PendingCommandQueue();
		for (let i = 0; i < 3; i++) q.push(msg(i));
		expect(q.size).toBe(3);
		expect(q.dropped).toBe(0);
		const out = q.drain();
		expect(out).toHaveLength(3);
		expect(q.size).toBe(0);
		// drain 再次调用返回空（重放后不会重复分发）。
		expect(q.drain()).toHaveLength(0);
	});

	it(`超限（${256} 条）丢最旧：新消息入队、队头被挤掉、dropped 计数`, () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const q = new PendingCommandQueue();
		const total = MAX_PENDING_WS_MESSAGES + 5;
		for (let i = 0; i < total; i++) q.push(msg(i));
		expect(q.size).toBe(MAX_PENDING_WS_MESSAGES);
		expect(q.dropped).toBe(5);
		// 队头应是最旧的存活消息（i=5，前 5 条被丢），队尾是最新一条。
		const out = q.drain();
		expect((out[0] as unknown as { seq: number }).seq).toBe(5);
		expect((out[out.length - 1] as unknown as { seq: number }).seq).toBe(total - 1);
	});

	it("超限告警 60s 内节流为一条，drain/clear 后可继续使用", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const q = new PendingCommandQueue();
		for (let i = 0; i < MAX_PENDING_WS_MESSAGES + 2; i++) q.push(msg(i)); // 队列填满 + 溢出 2 条
		// 队列已满，这一整轮每次 push 都挤掉队头：drop = 2 + (256 + 3)。
		for (let i = 0; i < MAX_PENDING_WS_MESSAGES + 3; i++) q.push(msg(i));
		expect(warn).toHaveBeenCalledTimes(1); // 节流：连续超限只 warn 一次
		expect(q.dropped).toBe(2 + (MAX_PENDING_WS_MESSAGES + 3));
		q.clear();
		expect(q.size).toBe(0);
		q.push(msg(99));
		expect(q.size).toBe(1);
		expect(q.drain()[0]).toBeDefined();
	});

	it("自定义容量（构造参数）同样生效", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const q = new PendingCommandQueue(2);
		q.push(msg(1));
		q.push(msg(2));
		q.push(msg(3));
		expect(q.size).toBe(2);
		expect(q.dropped).toBe(1);
		const out = q.drain();
		expect((out[0] as unknown as { seq: number }).seq).toBe(2);
	});
});
