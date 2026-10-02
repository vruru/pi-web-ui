import { describe, expect, it } from "vitest";
import { PlanManager } from "../../server/plan-manager.js";
import type { PlanStep } from "../../server/protocol.js";
import { makePlanUpdateTool } from "../../server/agent-service.js";

describe("结构化任务计划状态机与看板管理 (PlanManager / Plan Mode)", () => {
	it("初始状态为空", () => {
		const pm = new PlanManager();
		expect(pm.getPlan("conv-1")).toBeNull();
		expect(pm.describePlan("conv-1")).toBe("No active plan.");
	});

	it("设置和规范化计划步骤", () => {
		const pm = new PlanManager();
		const steps: PlanStep[] = [
			{ id: "1", title: "需求调研与设计", status: "done", description: "完成 API 设计" },
			{ id: "2", title: "编写核心模块代码", status: "in_progress" },
			{ id: "3", title: "运行单元测试", status: "pending" },
		];

		const plan = pm.setPlan("conv-1", steps);
		expect(plan).toBeTruthy();
		expect(plan.steps.length).toBe(3);
		// 自动识别 in_progress 步骤为 activeStepId
		expect(plan.activeStepId).toBe("2");
		expect(plan.steps[0].status).toBe("done");
		expect(plan.steps[1].status).toBe("in_progress");
		expect(plan.steps[2].status).toBe("pending");
	});

	it("增量更新步骤状态并自动推进 activeStepId", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "step-1", title: "步骤一", status: "in_progress" },
			{ id: "step-2", title: "步骤二", status: "pending" },
		]);

		// 步骤一完成
		const updated = pm.updateStep("conv-1", "step-1", { status: "done" });
		expect(updated).toBeTruthy();
		expect(updated?.steps[0].status).toBe("done");
		// 完成后自动推进到下一个 pending 步骤
		expect(updated?.activeStepId).toBe("step-2");

		// 将步骤二设为进行中
		const updated2 = pm.updateStep("conv-1", "step-2", { status: "in_progress" });
		expect(updated2?.activeStepId).toBe("step-2");
	});

	it("updateStep 剥掉 patch 里的 id，title/description 与 setPlan 同口径截断", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [{ id: "step-1", title: "原标题", status: "in_progress", description: "原描述" }]);

		// patch 带 id：不允许改 id（activeStepId 的锚点，改了会悬空）
		const patched = pm.updateStep("conv-1", "step-1", {
			id: "hijacked",
			title: "新标题",
			status: "in_progress",
		});
		expect(patched?.steps[0].id).toBe("step-1");
		expect(patched?.activeStepId).toBe("step-1");
		expect(patched?.steps[0].title).toBe("新标题");

		// 超长截断：title ≤200、description ≤1000（与 setPlan 一致）
		const long = pm.updateStep("conv-1", "step-1", {
			title: "T".repeat(500),
			description: "D".repeat(2000),
		});
		expect(long?.steps[0].title.length).toBe(200);
		expect(long?.steps[0].description?.length).toBe(1000);

		// patch 不带 description 时保留旧值；显式空串清除
		expect(pm.updateStep("conv-1", "step-1", { status: "pending" })?.steps[0].description).toBeDefined();
		expect(pm.updateStep("conv-1", "step-1", { description: "" })?.steps[0].description).toBeUndefined();
	});

	it("格式化计划文本供模型上下文使用", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "1", title: "第一步", status: "done" },
			{ id: "2", title: "第二步", status: "in_progress", description: "正在进行中..." },
		]);

		const text = pm.describePlan("conv-1");
		expect(text).toContain("Plan Progress: 1/2 completed");
		expect(text).toContain("[x] 1. 第一步");
		expect(text).toContain("[>] 2. 第二步 (current)");
		expect(text).toContain("正在进行中...");
	});

	it("清空计划", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [{ id: "1", title: "第一步", status: "pending" }]);
		expect(pm.getPlan("conv-1")).not.toBeNull();

		pm.clearPlan("conv-1");
		expect(pm.getPlan("conv-1")).toBeNull();
	});

	it("plan_update 工具携带决策就绪型提示词规范并支持受影响清单", async () => {
		const pm = new PlanManager();
		const messages: unknown[] = [];
		const tool = makePlanUpdateTool(
			pm,
			() => "conv-1",
			(msg) => messages.push(msg),
			() => {},
		);

		// 验证 promptSnippet 与 promptGuidelines 规范
		expect(tool.promptSnippet).toBeTruthy();
		const guidelines = (tool.promptGuidelines as string[]).join("\n");
		expect(guidelines).toContain("decision-ready steps");
		expect(guidelines).toContain("File Touch List");
		expect(guidelines).toContain("rollback");

		// 执行更新
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await tool.execute(
			"call-1",
			{
				steps: [
					{
						id: "step-1",
						title: "定位问题代码",
						status: "done",
						description: "Discovery: 确认了配置解析中的异常分支",
					},
					{
						id: "step-2",
						title: "修复并添加测试",
						status: "in_progress",
						description: "Files touched: server/agent-service.ts; Rollback: git checkout server/agent-service.ts",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		const plan = pm.getPlan("conv-1");
		expect(plan).toBeTruthy();
		expect(plan?.steps.length).toBe(2);
		expect(plan?.steps[1].description).toContain("Files touched");
		expect(plan?.steps[1].description).toContain("Rollback");
		expect(messages.length).toBeGreaterThan(0);
	});
});
