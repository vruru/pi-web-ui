import { describe, expect, it } from "vitest";
import { diffStreamingCues, type StreamingCueConversation } from "../../web/src/streaming-cues.js";

describe("diffStreamingCues", () => {
	it("首次观察（prevMap === null）不触发任何 cue，仅填充初始状态", () => {
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: false },
			{ id: "c2", title: "对话2", isStreaming: true },
		];
		const res = diffStreamingCues(null, "c1", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(false);
		expect(res.nextMap.get("c2")).toBe(true);
	});

	it("前台活动会话从 false 跃迁到 true → 触发 startCue", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: true },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(true);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(true);
	});

	it("前台活动会话持续流式输出中 → 不触发任何 cue", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: true },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("前台活动会话从 true 跃迁到 false → 触发 finishedConvs 且 isActive 为 true", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: false },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([
			{
				id: "c1",
				title: "对话1",
				isActive: true,
			},
		]);
	});

	it("【核心回归】从正在运行的会话切换到已结束的会话 → 绝对不触发 done，也不触发 start", () => {
		// 场景：c1 正在运行（true），c2 早已结束（false）。
		// 此时 prev 记录了 c1: true, c2: false。
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		// 用户在界面上点击了 c2：activeId 变为 c2，其 activeStreaming 为 false。
		// c1 在后台仍在运行（conversations 中 c1.isStreaming 为 true）。
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "会话1", isStreaming: true },
			{ id: "c2", title: "会话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(true);
		expect(res.nextMap.get("c2")).toBe(false);
	});

	it("【核心回归】后台会话完成 → 及时触发后台 finishedCue，不因未在看该会话而被漏掉或延迟", () => {
		// 场景：用户正在查看已结束的会话 c2。后台会话 c1 正在运行（prev 记录 c1: true, c2: false）。
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		// 后台会话 c1 结束运行：conversations 中 c1.isStreaming 变为 false。
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "后台任务会话", isStreaming: false },
			{ id: "c2", title: "当前会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([
			{
				id: "c1",
				title: "后台任务会话",
				isActive: false, // 明确标记为非当前活动会话（后台会话）
			},
		]);
	});

	it("从空闲会话切换到正在后台运行的会话 → 不误响 startCue，也不误响 done", () => {
		// 场景：c1 在后台运行（true），c2 处于空闲（false）。用户从 c2 切换进 c1 查看进度。
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "后台任务", isStreaming: true },
			{ id: "c2", title: "当前会话", isStreaming: false },
		];
		// activeId 切到 c1，其 activeStreaming 为 true
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("会话被关闭/移出列表（从 conversations 消失）→ 不误报运行完成", () => {
		// 场景：c1 在运行中被强制移出/关闭
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		// conversations 列表中 c1 已被删除
		const convs: StreamingCueConversation[] = [{ id: "c2", title: "会话2", isStreaming: false }];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.finishedConvs).toEqual([]);
	});

	it("多个后台会话同时结束 → finishedConvs 包含所有结束的会话", () => {
		const prev = new Map([
			["c1", true],
			["c2", true],
			["c3", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "任务1", isStreaming: false },
			{ id: "c2", title: "任务2", isStreaming: false },
			{ id: "c3", title: "主会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c3", false, convs);
		expect(res.finishedConvs).toHaveLength(2);
		expect(res.finishedConvs.map((f) => f.id)).toEqual(["c1", "c2"]);
	});

	it("【核心回归】切换首拍 + conversations 列表滞后 → 绝不误响 startCue", () => {
		// 场景：后台会话 c1 刚开流，conversations 列表还没更新（仍报 false），
		// 用户此刻从 c2 切入 c1——prevMap 里 c1 是 false，若照常做边沿判定就会误响「开始」音。
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "刚开流的后台会话", isStreaming: false }, // 列表滞后
			{ id: "c2", title: "原会话", isStreaming: false },
		];
		// activeId 已切到 c1 且 chat.state.isStreaming 为 true，但这是切换后的第一拍。
		const res = diffStreamingCues(prev, "c1", true, convs, "c2");
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("切换首拍之后（activeId 未再变）正常恢复边沿判定 → startCue 触发", () => {
		// 场景：上一拍切换进了 c1（被抑制），本拍用户在 c1 里发出消息开始生成。
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "当前会话", isStreaming: false },
			{ id: "c2", title: "其他", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs, "c1");
		expect(res.startCue).toBe(true);
	});

	it("prevActiveId 未传（旧调用方）→ 保持原边沿判定行为", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [{ id: "c1", title: "会话1", isStreaming: false }];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(true);
	});
});
