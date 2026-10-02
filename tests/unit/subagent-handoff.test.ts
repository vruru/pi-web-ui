import { describe, expect, it, vi } from "vitest";
import {
	makeSubagentTools,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "../../server/subagents.js";
import { SUBAGENT_TOOL_NAMES } from "../../server/tool-manager.js";

function makeMockHost(subagents: Record<string, SubagentSnapshot> = {}): SubagentToolHost {
	return {
		spawnSubagent: vi.fn().mockResolvedValue("sa-target-1234"),
		getSubagent: vi.fn((id: string) => subagents[id]),
		listSubagents: vi.fn(() => Object.values(subagents)),
		steerSubagent: vi.fn().mockResolvedValue(undefined),
		stopSubagent: vi.fn().mockResolvedValue(undefined),
		handoffSubagent: vi.fn().mockResolvedValue(undefined),
		listTemplates: vi.fn(() => []),
		isTemplateUsable: vi.fn(() => true),
		lang: () => "zh",
	};
}

describe("subagent_handoff (Peer-to-Peer Hand-off)", () => {
	it("SUBAGENT_TOOL_NAMES 和 makeSubagentTools 包含 subagent 工具", () => {
		expect(SUBAGENT_TOOL_NAMES).toContain("subagent");
		const host = makeMockHost();
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		const tool = tools.find((t) => t.name === "subagent");
		expect(tool).toBeDefined();
		expect(tool?.label).toBe("Subagent manager");
	});

	it("不能交接给自身，交接给自身时应拒绝并返回错误提示", async () => {
		const host = makeMockHost({
			"sa-self-1111": {
				convId: "sa-self-1111",
				type: "analysis",
				title: "Self",
				prompt: "Do something",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		});
		const tools = makeSubagentTools(host, () => "zh", "sa-self-1111");
		const tool = tools.find((t) => t.name === "subagent")!;

		const result = (await tool.execute(
			"call-1",
			{
				action: "handoff",
				toRunId: "sa-self-1111",
				payload: "My analysis results",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0].text).toContain("不能交接给自身");
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("目标子代理不存在时，应返回未找到提示", async () => {
		const host = makeMockHost({});
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		const tool = tools.find((t) => t.name === "subagent")!;

		const result = (await tool.execute(
			"call-2",
			{
				action: "handoff",
				toRunId: "sa-nonexistent",
				payload: "Some payload",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0].text).toContain("未找到目标子代理");
		expect(host.handoffSubagent).not.toHaveBeenCalled();
	});

	it("正常交接时，调用 host.handoffSubagent 并返回成功信息与 details", async () => {
		const host = makeMockHost({
			"sa-dev-2222": {
				convId: "sa-dev-2222",
				type: "implement",
				title: "Implement",
				prompt: "Write code",
				state: "running",
				streaming: true,
				messageCount: 2,
				output: "",
			},
		});
		const tools = makeSubagentTools(host, () => "zh", "sa-source-1111");
		const tool = tools.find((t) => t.name === "subagent")!;

		const result = (await tool.execute(
			"call-3",
			{
				action: "handoff",
				toRunId: "sa-dev-2222",
				payload: "Architecture design completed. Implement module X.",
			},
			undefined as any,
			undefined as any,
			{} as any,
		)) as {
			content: Array<{ type: string; text: string }>;
			details: { fromRunId: string; toRunId: string; timestamp: number };
		};

		expect(host.handoffSubagent).toHaveBeenCalledWith(
			"sa-source-1111",
			"sa-dev-2222",
			"Architecture design completed. Implement module X.",
		);
		expect(result.content[0].text).toContain("已成功将产物交接给同行子代理");
		expect(result.details.fromRunId).toBe("sa-source-1111");
		expect(result.details.toRunId).toBe("sa-dev-2222");
	});

	it("withSubagentOwner 正确传递 ownerId 作为默认来源", async () => {
		const host = makeMockHost();
		const wrapped = withSubagentOwner(host, "conv-owner-root");
		await wrapped.handoffSubagent("", "sa-target-9999", "task payload");
		expect(host.handoffSubagent).toHaveBeenCalledWith("conv-owner-root", "sa-target-9999", "task payload");
	});
});
