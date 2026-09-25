import { describe, expect, it, vi } from "vitest";
import {
	collectSubagentDescendantIds,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	type SubagentToolHost,
	type SubagentSnapshot,
} from "../../server/subagents.js";

/** 一个假的 host，工具调用不会真正执行会话（只验证走通与参数透传）。 */
function makeHostSpies() {
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (_prompt, type, _cwd) => `sa-${type}-abc`),
		getSubagent: vi.fn(() => undefined),
		acknowledgeSubagentResults: vi.fn(),
		listSubagents: vi.fn(() => []),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		listTemplates: vi.fn(() => [{ name: "reviewer", description: "只读审查" }]),
		isTemplateUsable: vi.fn((name: string) => name === "reviewer"),
	};
	return host;
}

describe("subagents tools", () => {
	it("注册 7 个 subagent_* 工具", () => {
		const host = makeHostSpies();
		const tools = makeSubagentTools(host);
		expect(tools.map((t) => t.name)).toEqual([
			"subagent_spawn",
			"subagent_get_result",
			"subagent_steer",
			"subagent_list",
			"subagent_stop",
			"subagent_wait_all",
			"subagent_templates",
		]);
		// 全部有 description + 参数 schema。
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.parameters).toBeDefined();
		}
	});

	it("subagent_spawn 透传 prompt/type/cwd/template/model 给 host", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host, () => "zh");
		const ctx = { cwd: "/root/proj" } as never;
		const result = await spawn.execute!(
			"t1",
			{ prompt: "调研", type: "explore", template: "reviewer", cwd: "/other", model: "anthropic/claude-opus-4-5" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"调研",
			"explore",
			"/other",
			"reviewer",
			"anthropic/claude-opus-4-5",
			undefined,
			undefined,
		);
		// 结果文本含 convId（host 返回值）与类型。
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-explore-abc");
		expect(text.text).toContain("模板：reviewer");
		expect(text.text).toContain("模型：anthropic/claude-opus-4-5");
	});

	it("subagent_spawn 未传 cwd 时用 ctx.cwd；不传 template/model 时按缺省", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, { cwd: "/root/proj" } as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"p",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			undefined,
		);
	});

	it("subagent_spawn 支持 persist=true 创建普通持久化对话", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host, () => "zh");
		const result = await spawn.execute!("t1", { prompt: "架构重构", persist: true } as never, undefined, undefined, {
			cwd: "/root/proj",
		} as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"架构重构",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			true,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("普通持久化对话已启动");
	});

	it("subagent_spawn 模板不存在/停用时不启动并提示", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host, () => "zh");
		const result = await spawn.execute!("t1", { prompt: "p", template: "ghost" } as never, undefined, undefined, {
			cwd: "/x",
		} as never);
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("不可用");
		expect(text.text).toContain("ghost");
	});

	it("subagent_get_result 对未知 runId 提示未找到", async () => {
		const host = makeHostSpies();
		const [, getResult] = makeSubagentTools(host, () => "zh");
		const result = await getResult.execute!("t1", { runId: "nope" } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("未找到");
	});

	it("subagent_steer / subagent_stop 透传 runId", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-1"
				? {
						convId: "sa-1",
						type: "general",
						title: "t",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
					}
				: undefined,
		);
		const [, , steer, , stop] = makeSubagentTools(host);
		await steer.execute!("t1", { runId: "sa-1", message: "改方向" } as never, undefined, undefined, {} as never);
		await stop.execute!("t1", { runId: "sa-1" } as never, undefined, undefined, {} as never);
		expect(host.steerSubagent).toHaveBeenCalledWith("sa-1", "改方向");
		expect(host.stopSubagent).toHaveBeenCalledWith("sa-1");
	});

	it("subagent_steer / subagent_stop 对未知 runId 报未找到（不谎报成功）", async () => {
		const host = makeHostSpies();
		const [, , steer, , stop] = makeSubagentTools(host, () => "zh");
		const r1 = await steer.execute!(
			"t1",
			{ runId: "ghost", message: "hi" } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect((r1.content?.[0] as { text: string }).text).toContain("未找到");
		expect(host.steerSubagent).not.toHaveBeenCalled();
		const r2 = await stop.execute!("t1", { runId: "ghost" } as never, undefined, undefined, {} as never);
		expect((r2.content?.[0] as { text: string }).text).toContain("未找到");
		expect(host.stopSubagent).not.toHaveBeenCalled();
	});

	it("subagent_spawn 启动失败转返回文本（不直接抛异常）", async () => {
		const host = makeHostSpies();
		(host.spawnSubagent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("子代理数量已达上限（16 个）"));
		const [spawn] = makeSubagentTools(host, () => "zh");
		const result = await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, {
			cwd: "/x",
		} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("启动失败");
		expect(text.text).toContain("16");
	});

	it("subagent_list 汇总 host 返回", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "调研",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "…",
			},
		]);
		const [, , , list] = makeSubagentTools(host);
		const result = await list.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-1");
		expect(text.text).toContain("explore");
		expect(text.text).toContain("running");
	});

	it("subagent_templates 列出宿主返回的可用模板", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "reviewer", description: "只读审查" },
			{ name: "reporter", description: "报告整理" },
		]);
		const tools = makeSubagentTools(host);
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("reviewer");
		expect(text.text).toContain("reporter");
		expect(text.text).toContain("subagent_spawn");
	});

	it("subagent_templates 忽略旧模板模型，保留思考强度说明", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "thinker", description: "审查", model: "anthropic/claude-opus-4-5", thinkingLevel: "high" },
			{ name: "plain", description: "默认" },
		]);
		const zh = makeSubagentTools(host, () => "zh");
		const zhText = (
			(await zh.find((t) => t.name === "subagent_templates")!.execute!(
				"t1",
				{} as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] }
		).content[0].text;
		expect(zhText).toContain("思考强度：high");
		expect(zhText).not.toContain("anthropic/claude-opus-4-5");
		// 未配置的两个维度都要说清是「跟随主对话」，否则 AI 会以为子代理没有模型/强度
		expect(zhText).toContain("跟随派发者当前模型，跟随主对话思考强度");

		const en = makeSubagentTools(host, () => "en");
		const enText = (
			(await en.find((t) => t.name === "subagent_templates")!.execute!(
				"t1",
				{} as never,
				undefined,
				undefined,
				{} as never,
			)) as { content: { text: string }[] }
		).content[0].text;
		expect(enText).toContain("thinking: high");
		expect(enText).toContain("follows the main conversation thinking level");
	});

	it("subagent_templates 空清单给出引导文案", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const tools = makeSubagentTools(host, () => "zh");
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("当前没有");
	});

	it("subagent_get_result 报错子代理明确标出错误文本", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-err",
			type: "general",
			title: "调研",
			prompt: "",
			state: "done",
			streaming: false,
			error: "Error from provider (Console Go): Upstream request failed: [400] Provider returned error",
			messageCount: 2,
			output: "",
		});
		const [, getResult] = makeSubagentTools(host, () => "zh");
		const result = await getResult.execute!("t1", { runId: "sa-err" } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("error（报错）");
		expect(text.text).toContain("400");
	});

	it("subagent_wait_all 等到全部终态后汇总结果（含错误标记）", async () => {
		const host = makeHostSpies();
		const sa1 = {
			convId: "sa-1",
			type: "explore",
			title: "调研 A",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 3,
			output: "结论 A",
		};
		const sa2 = {
			convId: "sa-2",
			type: "review",
			title: "审查 B",
			prompt: "",
			state: "done",
			streaming: false,
			error: "provider 400",
			messageCount: 2,
			output: "",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (id === "sa-2" ? sa2 : sa1));
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-1", "sa-2"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("全部 2 个子代理已收口");
		expect(text.text).toContain("结论 A");
		expect(text.text).toContain("provider 400");
	});

	it("subagent_wait_all 调用者自身永不计入等待（防 self-wait deadlock）", async () => {
		const host = makeHostSpies();
		// 子代理 sa-self 调 wait_all 且不传 runIds：只等自己的后代 sa-other（parentId 指向自身）。
		// 不排除自身 = 自己等自己、永远到超时；排除后应立即收口且结果里不含自身。
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-other",
				type: "explore",
				title: "别人",
				prompt: "",
				state: "done",
				streaming: false,
				messageCount: 2,
				output: "OK",
				parentId: "sa-self",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-self"
				? {
						convId: "sa-self",
						type: "general",
						title: "我自己",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
						parentId: "c-main",
					}
				: {
						convId: "sa-other",
						type: "explore",
						title: "别人",
						prompt: "",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "OK",
						parentId: "sa-self",
					},
		);
		const tools = makeSubagentTools(host, () => "zh", "sa-self");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("全部 1 个子代理已收口");
		expect(text.text).toContain("sa-other");
		expect(text.text).not.toContain("sa-self");
	});

	it("subagent_wait_all 排除自身后为空时直接返回（不等超时）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		]);
		const tools = makeSubagentTools(host, () => "zh", "sa-self");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("没有需要等待的子代理");
	});

	it("subagent_wait_all 显式 runIds 里含自身时同样排除", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-other"
				? {
						convId: "sa-other",
						type: "general",
						title: "别人",
						prompt: "",
						state: "done",
						streaming: false,
						messageCount: 1,
						output: "OK",
					}
				: undefined,
		);
		const tools = makeSubagentTools(host, () => "zh", "sa-self");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-self", "sa-other"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("全部 1 个子代理已收口");
		expect(text.text).toContain("sa-other");
	});

	it("subagent_wait_all 长输出留头留尾（结论在尾部不能丢）", async () => {
		const host = makeHostSpies();
		const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
		lines[99] = "FINAL-CONCLUSION";
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-long",
			type: "explore",
			title: "长输出",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 5,
			output: lines.join("\n"),
		});
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-long"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("FINAL-CONCLUSION");
		expect(text.text).toContain("line-1");
		expect(text.text).toContain("省略");
		expect(text.text).not.toContain("line-50");
	});

	it("subagent_wait_all 短输出原样返回（不加省略标记）", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-short",
			type: "general",
			title: "短输出",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 2,
			output: "line-1\nline-2\nline-3",
		});
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-short"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("line-1\n  line-2\n  line-3");
		expect(text.text).not.toContain("省略");
	});

	it("subagent_wait_all 空 runIds 时等当前全部运行中的子代理", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-a",
				type: "general",
				title: "A",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-b",
				type: "general",
				title: "B",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-a"
				? {
						convId: "sa-a",
						type: "general",
						title: "A",
						prompt: "",
						state: "done",
						streaming: false,
						messageCount: 2,
						output: "OK A",
					}
				: {
						convId: "sa-b",
						type: "general",
						title: "B",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
					},
		);
		const tools = makeSubagentTools(host, () => "zh");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		// sa-b 一直运行 → 超时返回未完成名单
		expect(text.text).toContain("1 个仍在运行");
		expect(text.text).toContain("sa-b");
	});

	it("subagent_wait_all 两层嵌套：子代理无参只等后代，不等父级/无关兄弟（防父子互等到超时）", async () => {
		const host = makeHostSpies();
		// c-main → sa-parent → sa-child；另有无关兄弟 sa-uncle（同属 c-main）。
		// sa-parent 无参等待应只圈住 sa-child：父级自chain不在等待集，无关兄弟也不进集。
		const byId: Record<string, never> = {} as never;
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-parent",
				type: "general",
				title: "父",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-child",
				type: "explore",
				title: "子",
				prompt: "",
				state: "done",
				streaming: false,
				messageCount: 2,
				output: "DONE",
				parentId: "sa-parent",
			},
			{
				convId: "sa-uncle",
				type: "general",
				title: "叔",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
			const all: Record<
				string,
				{ convId: string; parentId?: string; state: string; streaming: boolean; output: string }
			> = {
				"sa-parent": { convId: "sa-parent", parentId: "c-main", state: "running", streaming: true, output: "" },
				"sa-child": { convId: "sa-child", parentId: "sa-parent", state: "done", streaming: false, output: "DONE" },
				"sa-uncle": { convId: "sa-uncle", parentId: "c-main", state: "running", streaming: true, output: "" },
			};
			const r = all[id];
			if (!r) return undefined;
			return {
				convId: r.convId,
				type: "general",
				title: r.convId,
				prompt: "",
				state: r.state,
				streaming: r.streaming,
				messageCount: 1,
				output: r.output,
				parentId: r.parentId,
			};
		});
		void byId;
		const tools = makeSubagentTools(host, () => "zh", "sa-parent");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		// 后代已完成 → 立即收口，不等到超时；结果里只有后代，没有父自己与无关兄弟。
		expect(text.text).toContain("全部 1 个子代理已收口");
		expect(text.text).toContain("sa-child");
		expect(text.text).not.toContain("sa-uncle");
	});

	it("subagent_wait_all 叶子无参等待父级时直接返回空（不等超时）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-parent",
				type: "general",
				title: "父",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-leaf",
				type: "general",
				title: "叶",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-leaf"
				? {
						convId: "sa-leaf",
						type: "general",
						title: "叶",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
						parentId: "sa-parent",
					}
				: {
						convId: "sa-parent",
						type: "general",
						title: "父",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
						parentId: "c-main",
					},
		);
		// sa-leaf 无后代：无参等待应直接返回空，而不是把父级圈进来互等到超时。
		const tools = makeSubagentTools(host, () => "zh", "sa-leaf");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!("t1", { timeoutSeconds: 1 } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("没有需要等待的子代理");
	});

	it("subagent_wait_all 显式 runIds 含祖先时剔除祖先（不死锁）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-parent",
				type: "general",
				title: "父",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-leaf",
				type: "general",
				title: "叶",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-leaf"
				? {
						convId: "sa-leaf",
						type: "general",
						title: "叶",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
						parentId: "sa-parent",
					}
				: {
						convId: "sa-parent",
						type: "general",
						title: "父",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
						parentId: "c-main",
					},
		);
		// sa-leaf 显式等父 sa-parent：父正在卡着等叶，圈进来必互等到超时，应直接剔除报空。
		const tools = makeSubagentTools(host, () => "zh", "sa-leaf");
		const waitTool = tools.find((t) => t.name === "subagent_wait_all")!;
		const result = await waitTool.execute!(
			"t1",
			{ runIds: ["sa-parent"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("没有需要等待的子代理");
	});
});

describe("collectSubagentDescendantIds", () => {
	const items = [
		{ id: "parent", isSubagent: false },
		{ id: "sa-1", parentId: "parent", isSubagent: true },
		{ id: "sa-2", parentId: "sa-1", isSubagent: true },
		{ id: "plain", parentId: "parent", isSubagent: false },
		{ id: "other", isSubagent: false },
		{ id: "sa-x", parentId: "other", isSubagent: true },
	];

	it("收集直接 + 嵌套子代理后代（root 自身与普通对话不含）", () => {
		expect(collectSubagentDescendantIds(items, "parent").sort()).toEqual(["sa-1", "sa-2"]);
	});

	it("中间层 convo 也能收拢自己的子树", () => {
		expect(collectSubagentDescendantIds(items, "sa-1")).toEqual(["sa-2"]);
	});

	it("无后代 / 未知 root 返回空", () => {
		expect(collectSubagentDescendantIds(items, "sa-2")).toEqual([]);
		expect(collectSubagentDescendantIds(items, "ghost")).toEqual([]);
	});

	it("parentId 环不会死循环", () => {
		const loop = [
			{ id: "a", parentId: "b", isSubagent: true },
			{ id: "b", parentId: "a", isSubagent: true },
		];
		expect(collectSubagentDescendantIds(loop, "parent")).toEqual([]);
		expect(collectSubagentDescendantIds(loop, "a")).toEqual(["b"]);
	});
});

describe("subagentTitle", () => {
	it("取 prompt 首行并截断", () => {
		expect(subagentTitle("调研 RPC 路径")).toBe("调研 RPC 路径");
		expect(subagentTitle("第一行\n第二行")).toBe("第一行");
		expect(subagentTitle("x".repeat(80))).toHaveLength(41);
	});
});

describe("subagents language (issue #91)", () => {
	it("默认英文：未知 runId / 空模板清单返回英文", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const tools = makeSubagentTools(host);
		const [, getResult] = tools;
		const r1 = await getResult.execute!("t1", { runId: "nope" } as never, undefined, undefined, {} as never);
		expect((r1.content?.[0] as { text: string }).text).toContain("not found");
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const r2 = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		expect((r2.content?.[0] as { text: string }).text).toContain("No subagent templates");
	});

	it("工具 definition 中英内联（英文在前）", () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		expect(spawn.description).toContain("subagent");
		// 中文半句仍在（zh 会话行为不变）
		expect(spawn.description).toContain("子代理");
	});
});

describe("withSubagentOwner (issue #95)", () => {
	it("包装后 spawn 自动把 ownerId（真正的派发会话）作为父对话传入", async () => {
		const host = makeHostSpies();
		// c1 的 runtime 用它自己的工具派发：即使此刻 UI 正看着别的会话（active），
		// 子代理父对话也必须记到 c1（工具调用方），否则左栏会错组/沉底。
		const owned = withSubagentOwner(host, "c1");
		const tools = makeSubagentTools(owned);
		const [spawn] = tools;
		await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, { cwd: "/p1" } as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith("p", "general", "/p1", undefined, undefined, "c1", undefined);
	});

	it("包装不影响其余 host 方法透传", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		expect(owned.listTemplates()).toEqual([{ name: "reviewer", description: "只读审查" }]);
		expect(owned.isTemplateUsable("reviewer")).toBe(true);
		expect(owned.isTemplateUsable("ghost")).toBe(false);
	});
});

describe("subagent parent retention", () => {
	it("有存活子代理指向父对话时保留父对话", () => {
		type Conv = { id: string; parentId?: string };
		const convs = new Map<string, Conv>([
			["c1", { id: "c1" }],
			["sa-1", { id: "sa-1", parentId: "c1" }],
		]);
		const hasLiveChild = (id: string) => [...convs.values()].some((child) => child.parentId === id);
		expect(hasLiveChild("c1")).toBe(true);
		convs.delete("sa-1");
		expect(hasLiveChild("c1")).toBe(false);
	});
});

describe("subagent completion acknowledgement", () => {
	function snapshot(id: string, streaming: boolean): SubagentSnapshot {
		return {
			convId: id,
			type: "general",
			title: id,
			prompt: "",
			state: streaming ? "running" : "done",
			streaming,
			messageCount: 2,
			output: `output ${id}`,
		};
	}

	it("acknowledges only terminal get_result responses", async () => {
		const host = makeHostSpies();
		const child = snapshot("child", true);
		vi.mocked(host.getSubagent).mockReturnValue(child);
		const tool = makeSubagentTools(host).find((t) => t.name === "subagent_get_result")!;
		await tool.execute!("partial", { runId: "child" }, undefined, undefined, {} as never);
		expect(host.acknowledgeSubagentResults).not.toHaveBeenCalled();
		child.streaming = false;
		child.state = "done";
		await tool.execute!("complete", { runId: "child" }, undefined, undefined, {} as never);
		expect(host.acknowledgeSubagentResults).toHaveBeenCalledExactlyOnceWith(["child"]);
	});

	it("a timed-out wait acknowledges completed results including descendants, not partial or missing results", async () => {
		vi.useFakeTimers();
		try {
			const host = makeHostSpies();
			const children = [
				snapshot("done", false),
				snapshot("pending", true),
				{ ...snapshot("descendant", false), parentId: "done" },
			];
			vi.mocked(host.listSubagents).mockReturnValue(children);
			vi.mocked(host.getSubagent).mockImplementation((id) => children.find((c) => c.convId === id));
			const tool = makeSubagentTools(host).find((t) => t.name === "subagent_wait_all")!;
			const result = tool.execute!(
				"wait",
				{ runIds: ["done", "pending", "missing"], timeoutSeconds: 1 },
				undefined,
				undefined,
				{} as never,
			);
			await vi.advanceTimersByTimeAsync(1500);
			await result;
			expect(host.acknowledgeSubagentResults).toHaveBeenCalledExactlyOnceWith(["done", "descendant"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not acknowledge results when wait or get_result is aborted", async () => {
		const host = makeHostSpies();
		const children = [snapshot("done", false), snapshot("pending", true)];
		vi.mocked(host.listSubagents).mockReturnValue(children);
		vi.mocked(host.getSubagent).mockImplementation((id) => children.find((c) => c.convId === id));
		const tools = makeSubagentTools(host);
		const signal = AbortSignal.abort();
		await tools.find((t) => t.name === "subagent_wait_all")!.execute!(
			"wait",
			{ runIds: ["done", "pending"] },
			signal,
			undefined,
			{} as never,
		);
		await tools.find((t) => t.name === "subagent_get_result")!.execute!(
			"get",
			{ runId: "done" },
			signal,
			undefined,
			{} as never,
		);
		expect(host.acknowledgeSubagentResults).not.toHaveBeenCalled();
	});

	it("resolves the caller at execution after a transferred conversation receives a new ID", async () => {
		const host = makeHostSpies();
		let callerId = "old-parent";
		const children = [snapshot("new-parent", true), { ...snapshot("child", false), parentId: "new-parent" }];
		vi.mocked(host.listSubagents).mockReturnValue(children);
		vi.mocked(host.getSubagent).mockImplementation((id) => children.find((c) => c.convId === id));
		const tool = makeSubagentTools(host, undefined, () => callerId).find((t) => t.name === "subagent_wait_all")!;
		callerId = "new-parent";
		await tool.execute!("wait", {}, undefined, undefined, {} as never);
		expect(host.acknowledgeSubagentResults).toHaveBeenCalledExactlyOnceWith(["child"]);
	});
});
