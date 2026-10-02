/**
 * 目标模式 2.0（唯一路径）的循环单测：执行对话干活 + 当前对话当审查者。
 *
 * 全链路用 fake GoalHost 驱动，不需要真模型：
 *   - 服务端循环：派活给常驻执行者 → 等它结束 → 取样 → 把审查指令交给主对话；
 *   - 「主对话的 verdict」由测试直接调 onAgentEnd 模拟（就是 agent_end 钩子的入口）；
 *   - 断言轮次推进、pass/受阻收尾、审查重试、服务端熔断、降级回 self。
 *
 * 先例：tests/unit/goal-wizard-target.test.ts（同一套 fake host 手法）。
 */
import { describe, it, expect } from "vitest";
import {
	GoalService,
	parseWizardOutput,
	type GoalConversation,
	type GoalHost,
	type RoleWaitOutcome,
} from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const EXEC_ID = "sa-exec";

function makeConv(
	svc: GoalService,
	mainSent: string[],
	mainLastText: { value: string },
	customCards: { customType: string; text: string; details: unknown }[],
): GoalConversation {
	const conv: GoalConversation = {
		id: "conv-a",
		title: "会话 A",
		cwd: "/tmp/proj",
		session: {
			isStreaming: false,
			isIdle: true,
			sendUserMessage: async (text: string) => void mainSent.push(text),
			sendCustomMessage: async (msg: { customType: string; content: { text: string }[]; details?: unknown }) => {
				customCards.push({
					customType: msg.customType,
					text: msg.content.map((c) => c.text).join(""),
					details: msg.details,
				});
			},
			getLastAssistantText: () => mainLastText.value,
			getSessionStats: () => ({ totalMessages: 0 }),
		} as unknown as GoalConversation["session"],
		wizardRunning: false,
		goalGeneration: 0,
		goal: svc.makeGoalStatus(),
	};
	return Object.assign(conv, { mainSent, mainLastText });
}

interface Harness {
	svc: GoalService;
	host: GoalHost;
	sent: ServerMessage[];
	spawned: { role: string; prompt: string; model?: string | null }[];
	steered: string[];
	stopped: string[];
	dismissed: string[];
	customCards: { customType: string; text: string; details: unknown }[];
	roleSends: { convId: string; message: string; deliverAs?: string }[];
	conv: () => GoalConversation & { mainSent: string[]; mainLastText: { value: string } };
	/** 模拟执行对话被用户关掉（之后 hasConv 返回 false）。 */
	setGone: (v: boolean) => void;
	/** 模拟服务排空开关。 */
	setQuiesced: (v: boolean) => void;
}

/** fake host：脚本化执行者结局 / diff 序列 / 生成失败。 */
function makeHarness(opts?: {
	spawnFails?: boolean;
	waitOutcomes?: RoleWaitOutcome[];
	diffs?: string[];
	readRole?: () =>
		| {
				text: string;
				errorSnippet?: string;
				streaming?: boolean;
				lastTool?: string;
				usage?: { input: number; output: number };
		  }
		| undefined;
	/** 执行对话一失联（模拟用户在左栏把它关了）。 */
	gone?: boolean;
	/** 工作区是否有可信 git 信号（false = 非仓库目录：停滞判定应跳过）。 */
	repoAvailable?: boolean;
	/** 服务排空（quiesce）：新目标拒绝、中途不再派单。 */
	quiesced?: boolean;
	/** 计划看板描述（供审查 prompt 联动测试）。 */
	planDesc?: string;
}): Harness {
	const goneFlag = { value: opts?.gone === true };
	const quiesceFlag = { value: opts?.quiesced === true };
	const sent: ServerMessage[] = [];
	const spawned: Harness["spawned"] = [];
	const steered: string[] = [];
	const stopped: string[] = [];
	const dismissed: string[] = [];
	const convs = new Map<string, GoalConversation>();
	// 主对话收到的全部消息（既服务端 kick，也委派循环交回的审查指令）。
	const mainSent: string[] = [];
	const mainLastText = { value: "" };
	const customCards: { customType: string; text: string; details: unknown }[] = [];
	const roleSends: { convId: string; message: string; deliverAs?: string }[] = [];
	let waitIdx = 0;
	let diffIdx = 0;
	const host: GoalHost = {
		clientId: "c",
		agentDir: "/tmp/agent",
		stateStore: {
			getGoalPrefs: () => null,
			saveGoalPrefs: () => {},
		} as unknown as GoalHost["stateStore"],
		webUi: null as unknown as GoalHost["webUi"],
		emit: (m) => void sent.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => quiesceFlag.value,
		activeConvId: () => "conv-a",
		activeConv: () => convs.get("conv-a")!,
		getConv: (id) => convs.get(id),
		cwd: () => "/tmp/proj",
		// 每轮取样一次 diff：默认每轮都不同（= 有进展），脚本化时按序取（同值 = 停滞）。
		gitDiff: async () => {
			const arr = opts?.diffs;
			if (!arr || arr.length === 0) return `diff-${++diffIdx}`;
			return arr[Math.min(diffIdx++, arr.length - 1)]!;
		},
		goalModeEnabled: () => true,
		lang: () => "zh",
		describePlan: () => opts?.planDesc ?? "No active plan.",
		isGitRepo: async () => opts?.repoAvailable !== false,
		roleDeadlineMs: () => 1000,
		spawnRoleAgent: async ({ role, prompt, model }) => {
			if (opts?.spawnFails) throw new Error("子代理数量已达上限（16 个）");
			spawned.push({ role, prompt, model });
			return EXEC_ID;
		},
		waitRoleAgent: async () => {
			const arr = opts?.waitOutcomes;
			if (!arr || arr.length === 0) return "done";
			return arr[Math.min(waitIdx++, arr.length - 1)]!;
		},
		sendRoleAgent: async (convId, message, deliverAs) => {
			roleSends.push({ convId, message, deliverAs });
			if (convId === EXEC_ID) steered.push(message);
			else mainSent.push(message);
			return true;
		},
		readRoleAgent: (id) => (id === EXEC_ID ? (opts?.readRole?.() ?? { text: "已改完并自测通过。" }) : undefined),
		stopRoleAgent: async (id) => void stopped.push(id),
		dismissRoleAgent: async (id) => void dismissed.push(id),
		hasConv: (id) => (goneFlag.value ? false : id === EXEC_ID || convs.has(id)),
	};
	const boot = new GoalService(host);
	const conv = Object.assign(makeConv(boot, mainSent, mainLastText, customCards), { mainSent, mainLastText });
	convs.set("conv-a", conv);
	return {
		svc: boot,
		host,
		sent,
		spawned,
		steered,
		stopped,
		dismissed,
		customCards,
		roleSends,
		conv: () => conv as unknown as ReturnType<Harness["conv"]>,
		setGone: (v) => {
			goneFlag.value = v;
		},
		setQuiesced: (v) => {
			quiesceFlag.value = v;
		},
	};
}

const notices = (h: Harness): string[] =>
	(h.sent.filter((m) => m.type === "notice") as { text: string }[]).map((m) => m.text);

describe("委托执行（Plan A / delegated）", () => {
	it("设目标即拉起常驻执行者，执行轮结束后把审查指令交给主对话", async () => {
		const h = makeHarness();
		await h.svc.setGoal("把 README 补全", { maxRounds: 0, locked: true });

		expect(h.spawned).toHaveLength(1);
		expect(h.spawned[0]!.role).toBe("executor");
		expect(h.spawned[0]!.prompt).toContain("把 README 补全");
		// 主对话没有被注入「请开始实现」（它是审查者，干活的是执行对话）
		expect(h.conv().mainSent.some((t) => t.includes("现在开始实现"))).toBe(false);

		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		const reviewPrompt = h.conv().mainSent.at(-1)!;
		expect(reviewPrompt).toContain("验收者");
		expect(reviewPrompt).toContain("已改完并自测通过。");
		expect(reviewPrompt).toContain('"verdict"');
		expect(h.conv().goal.round).toBe(1);
		expect(h.conv().goal.phase).toBe("reviewing");
		expect(h.conv().goal.roles?.executor?.convId).toBe(EXEC_ID);
	});

	it("verdict=pass → 清目标并移出执行对话", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 A", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"全部满足"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.goal).toBeNull();
		expect(h.conv().goal.verdict).toBe("pass");
		expect(h.conv().goal.phase).toBe("idle");
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().mainSent.some((t) => t.includes("目标已达成并通过审查"))).toBe(true);
	});

	it("verdict=fail → 审查意见派回同一个执行对话（记忆连续），轮次 +1", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 B", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"还差单测"}';
		h.svc.onAgentEnd(h.conv(), false);

		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);
		expect(h.spawned).toHaveLength(1); // 复用同一个执行对话，不重开
		expect(h.steered).toHaveLength(1);
		expect(h.steered[0]).toContain("还差单测");
		expect(h.steered[0]).toContain("第 2");
	});

	it("审查回合不给 JSON：收紧契约重试一次，仍无 → 受阻（保留目标）", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 C", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = "我觉得差不多了（没有 JSON）";
		h.svc.onAgentEnd(h.conv(), false);
		// 第二次审查请求（重试）
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().mainSent.at(-1)).toContain("只回一个 JSON");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.phase).toBe("blocked");
		expect(h.conv().goal.goal).toBe("目标 C"); // 受阻保留目标文本，用户可处置
		expect(h.spawned).toHaveLength(1); // 受阻轮没有再派活
		expect(notices(h).some((t) => t.includes("受阻"))).toBe(true);
	});

	it("连续两轮工作区零改动 → 服务端熔断（不问审查者）", async () => {
		const h = makeHarness({ diffs: ["same-diff", "same-diff", "same-diff"] });
		await h.svc.setGoal("目标 D", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"还不行"}';
		// 第 1、2 轮由审查者判 fail；第 3 轮取样发现连续两轮无进展 → 直接受阻
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.round).toBe(3);
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("未检测到有效文件修改");
	});

	it("宿主没有角色对话桥 → 拒绝设目标（目标模式只有一条路径，不降级）", async () => {
		const h = makeHarness();
		// 模拟未接线 / 非 pi 引擎：抽掉 spawnRoleAgent
		delete (h.host as { spawnRoleAgent?: unknown }).spawnRoleAgent;
		await h.svc.setGoal("目标 K", { maxRounds: 0, locked: true });
		expect(h.conv().goal.goal).toBeNull();
		expect(h.spawned).toHaveLength(0);
		expect(notices(h).some((t) => t.includes("不支持"))).toBe(true);
	});

	it("执行对话拉不起来（配额满）→ 当场中止并把原因摆到目标条（不再降级）", async () => {
		const h = makeHarness({ spawnFails: true });
		await h.svc.setGoal("目标 E", { maxRounds: 0, locked: true });
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.spawned).toHaveLength(0);
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.phase).toBe("blocked");
		expect(h.conv().goal.status).toContain("执行对话创建失败");
		expect(h.conv().mainSent.some((t) => t.includes("现在开始实现"))).toBe(false); // 不再注入 self kick
		expect(notices(h).some((t) => t.includes("无法创建执行对话"))).toBe(true);
		expect(notices(h).some((t) => t.includes("普通对话名额"))).toBe(true);
	});

	it("执行者本轮超时 → 停掉它并在预算内继续下一轮（反馈写明超时）", async () => {
		const h = makeHarness({ waitOutcomes: ["timeout", "done"] });
		await h.svc.setGoal("目标 F", { maxRounds: 3, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		// 超时轮不花审查 token：第一条派回执行者的消息就是超时反馈
		expect(h.stopped).toContain(EXEC_ID);
		expect(h.steered.at(-1)).toContain("超时");
		expect(h.conv().goal.round).toBe(2);
	});

	it("执行者被手动中止（子代理 ⏹）→ 循环立即收束，不再派下一轮", async () => {
		const h = makeHarness({ waitOutcomes: ["canceled", "done"] });
		await h.svc.setGoal("目标 H", { maxRounds: 0, locked: true });
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("已暂停");
		expect(h.conv().goal.round).toBe(1); // 没有因为中止而再派一轮
		expect(h.steered).toHaveLength(0); // 不得再向执行对话追加回合
		expect(h.conv().goal.goal).toBe("目标 H"); // 目标保留，可重新设定或点停止退出
	});

	it("执行对话被移出（hasConv=false）→ 受阻收尾，不留在指向死对话的状态", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 I", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		await h.svc.whenAwaitingVerdict("conv-a");
		// 用户在审查期间把执行对话关掉 → 下一轮派活前发现失联
		h.setGone(true);
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("被移出");
		expect(h.conv().goal.roles?.executor).toBeUndefined(); // 不留指向死对话的按钮
		expect(h.spawned).toHaveLength(1); // 不会自己重新拉起一个执行者
		expect(h.steered).toHaveLength(0); // 也不会向死对话追加回合
	});

	it("循环进行中 clearGoal（■ 停止目标）= 停掉并移出执行对话", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 J", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false); // 审查 fail → 进入第 2 轮派活
		await h.svc.whenAwaitingVerdict("conv-a");
		expect(h.steered).toHaveLength(1);
		await h.svc.clearGoal();
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().goal.goal).toBeNull();
		expect(h.steered).toHaveLength(1); // 停止后再无新的派活
	});

	it("A1：执行者连续两轮 error → 受阻收尾（不限轮也不空转），执行对话被移出", async () => {
		const h = makeHarness({ waitOutcomes: ["error"] });
		await h.svc.setGoal("目标 Err", { maxRounds: 0, locked: true }); // 默认：锁定 + 不限轮
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.round).toBe(2);
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("连续 2 轮报错");
		expect(h.conv().goal.goal).toBe("目标 Err"); // 受阻保留目标文本
		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID); // A6 联动：受阻也不再常驻占名额
	});

	it("A2：非 git 目录（无 diff）不判停滞，审查正常迭代", async () => {
		const h = makeHarness({ diffs: ["", ""], repoAvailable: false });
		await h.svc.setGoal("回答架构问题", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true); // 第 1 轮审查
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"再细化"}';
		h.svc.onAgentEnd(h.conv(), false);
		// 第 2 轮的审查照常到来（而不是被「无进展」熔断吃掉）
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);
		expect(h.conv().goal.verdict).toBe("pending");
		await h.svc.clearGoal();
	});

	it("A3：clearGoal 紧跟 setGoal —— 旧循环退场后新目标接力启动", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 1", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		await h.svc.clearGoal();
		await h.svc.setGoal("目标 2", { maxRounds: 0, locked: true });
		// 新循环走到审查点：旧循环退场时消费了排队的启动请求
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.goal).toBe("目标 2");
		expect(h.spawned).toHaveLength(2);
		expect(h.spawned[1]!.prompt).toContain("目标 2");
		await h.svc.clearGoal();
	});

	it("A4：审查回合被中止 —— 只作废本次审查，目标与执行对话都保留", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 P", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		// 用户掐掉那段机器 JSON 回合：不是要把整个目标连执行者一起清掉
		const notice = h.svc.onAgentEnd(h.conv(), true);
		expect(h.conv().goal.goal).toBe("目标 P");
		expect(h.conv().goal.phase).not.toBe("idle");
		expect(h.dismissed).toEqual([]);
		expect(h.stopped).toEqual([]);
		expect(notice?.text).toContain("审查回合已中止");
		// 本轮进入无 JSON 重试（收紧契约），而不是直接收尾
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().mainSent.at(-1)).toContain("只回一个 JSON");
		await h.svc.clearGoal();
	});

	it("A5：先复述示例 pass、后给真结论 fail —— 取最后一个合法 verdict", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 V", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value =
			'示例：{"verdict":"pass","feedback":"<一句话：满足了什么>"} 我的结论：{"verdict":"fail","feedback":"还差单测"}';
		h.svc.onAgentEnd(h.conv(), false);
		// 判 fail 进入第 2 轮，而不是被示例带偏直接 pass 收尾
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);
		expect(h.steered.at(-1)).toContain("还差单测");
		await h.svc.clearGoal();
	});

	it("B4：总开关关闭（stopAllGoals）→ 在飞循环全停、执行者被移出、目标清空", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 M", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		await h.svc.stopAllGoals();
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.goal).toBeNull();
		expect(h.conv().goal.phase).toBe("idle");
		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.spawned).toHaveLength(1); // 停后不再派活
		// 迟到的 verdict 不得复活目标（代次已作废）
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"晚到"}';
		h.svc.onAgentEnd(h.conv(), false);
		expect(h.conv().goal.goal).toBeNull();
		expect(h.conv().goal.verdict).toBe("pending");
	});

	it("B4：无在飞目标时 stopAllGoals 无声（不打扰）", async () => {
		const h = makeHarness();
		await h.svc.stopAllGoals();
		const notices = h.sent.filter((m) => m.type === "notice");
		expect(notices).toHaveLength(0);
	});

	it("B5：排空期间 setGoal 直接拒绝（不动目标状态、不拉执行者）", async () => {
		const h = makeHarness({ quiesced: true });
		await h.svc.setGoal("目标 Q", { maxRounds: 0, locked: true });
		expect(h.conv().goal.goal).toBeNull();
		expect(h.spawned).toHaveLength(0);
		expect(h.conv().goal.phase).toBe("idle");
	});

	it("B5：排空发生在中途 —— 存量回合跑完，下一轮不再派（blocked 收尾）", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 W", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true); // 第 1 轮存量：审查照常
		// 审查期间服务进入排空 → fail 的 verdict 回来后不再派第 2 轮
		h.setQuiesced(true);
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("排空");
		expect(h.conv().goal.round).toBe(1); // 没有派第 2 轮
		expect(h.spawned).toHaveLength(1);
		expect(h.steered).toHaveLength(0);
		expect(h.dismissed).toContain(EXEC_ID);
	});

	it("B3：审查开始卡先于审查指令（customType goal-review，前端有专属卡片）", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 R", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);

		const starts = h.customCards.filter((c) => c.customType === "goal-review");
		expect(starts).toHaveLength(1);
		expect(starts[0]!.text).toContain("第 1");
		expect(starts[0]!.text).toContain("审查");
		expect((starts[0]!.details as { phase: string }).phase).toBe("start");
		await h.svc.clearGoal();
	});

	it("B3：fail 结论卡 + 排队插话按序发出（followUp，不污染 verdict）", async () => {
		const h = makeHarness({ diffs: ["a", "b", "c"] });
		await h.svc.setGoal("目标 S", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		// 审查回合里用户插了两句话（prompt() 入口会把它们顺延到这里）
		h.conv().deferredPrompts = ["插话1：顺便问下", "插话2：还有这个"];
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"还差单测"}';
		h.svc.onAgentEnd(h.conv(), false);
		// 第 2 轮审查到来：结论卡 + 插话都已发出，且插话在第 2 轮审查指令之前
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);
		const results = h.customCards.filter(
			(c) => c.customType === "goal-review" && (c.details as { phase: string }).phase === "result",
		);
		expect(results).toHaveLength(1);
		expect(results[0]!.text).toContain("未通过");
		expect(results[0]!.text).toContain("还差单测");
		const flushed = h.roleSends.filter((s) => s.convId === "conv-a" && s.message.startsWith("插话"));
		expect(flushed.map((s) => s.message)).toEqual(["插话1：顺便问下", "插话2：还有这个"]);
		expect(flushed.every((s) => s.deliverAs === "followUp")).toBe(true);
		// 顺序：审查指令1 → 插话 → 审查指令2（插话绝不插进审查回合里）
		const mainFlow = h.roleSends.filter((s) => s.convId === "conv-a").map((s) => s.message);
		expect(mainFlow[0]).toContain("验收者");
		expect(mainFlow[1]).toBe("插话1：顺便问下");
		expect(mainFlow[2]).toBe("插话2：还有这个");
		expect(mainFlow[3]).toContain("验收者");
		await h.svc.clearGoal();
	});

	it("B3：pass 结论卡 + 排队插话照发（目标正常收尾）", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 T", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		h.conv().deferredPrompts = ["插话：收到"];
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"全部满足"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.goal).toBeNull();
		const results = h.customCards.filter(
			(c) => c.customType === "goal-review" && (c.details as { phase: string }).phase === "result",
		);
		expect(results).toHaveLength(1);
		expect(results[0]!.text).toContain("通过");
		const flushed = h.roleSends.filter((s) => s.convId === "conv-a" && s.message.startsWith("插话"));
		expect(flushed).toHaveLength(1);
		expect(flushed[0]!.deliverAs).toBe("followUp");
	});

	it("B3：clearGoal 时排队插话也发出（不断用户的话）", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 U", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		h.conv().deferredPrompts = ["插话：别停"];
		await h.svc.clearGoal();
		await h.svc.whenDelegatedSettled("conv-a");

		const flushed = h.roleSends.filter((s) => s.convId === "conv-a" && s.message.startsWith("插话"));
		expect(flushed).toHaveLength(1);
		expect(h.conv().goal.goal).toBeNull();
	});

	it("F2：执行者 vitals 进 roles（streaming + activity），目标条可展示", async () => {
		const h = makeHarness({
			readRole: () => ({ text: "改完两处并自测", streaming: true, lastTool: "edit" }),
		});
		await h.svc.setGoal("目标 V", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);

		const role = h.conv().goal.roles?.executor;
		expect(role?.convId).toBe(EXEC_ID);
		expect(role?.streaming).toBe(true);
		expect(role?.activity).toContain("edit");
		await h.svc.clearGoal();
	});

	it("F3：执行者用量按轮累计进 goal_status.usage", async () => {
		let n = 0;
		const h = makeHarness({
			diffs: ["a", "b", "c"],
			readRole: () => {
				n++;
				return { text: "改完", usage: { input: 1000 * n, output: 200 * n } };
			},
		});
		await h.svc.setGoal("目标 W", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		h.svc.onAgentEnd(h.conv(), false);
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);

		const statuses = h.sent.filter((m) => m.type === "goal_status") as {
			status: { usage?: { inputTokens: number; outputTokens: number } };
		}[];
		const last = statuses.at(-1)!.status;
		// 第 1 轮增量 1000/200 + 第 2 轮派活后取样前尚无增量 → 至少第 1 轮部分
		expect(last.usage!.inputTokens).toBeGreaterThanOrEqual(1000);
		expect(last.usage!.outputTokens).toBeGreaterThanOrEqual(200);
		await h.svc.clearGoal();
		// 清目标即清累计
		expect(h.conv().goal.usage).toBeUndefined();
	});

	it("F4：终态落历史（pass/blocked），清目标不清空，cap 20", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		// pass 一轮
		await h.svc.setGoal("目标 H1", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"全过"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.conv().goal.history).toHaveLength(1);
		expect(h.conv().goal.history![0]).toMatchObject({ goal: "目标 H1", verdict: "pass", rounds: 1 });
		// blocked 一轮（停滞两轮）——目标文本保留的同时历史也记
		await h.svc.setGoal("目标 H2", { maxRounds: 0, locked: true });
		h.setQuiesced(true); // 借排空直接收尾，避免再走两轮停滞
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"x"}';
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.history).toHaveLength(2);
		expect(h.conv().goal.history![0]).toMatchObject({ goal: "目标 H2", verdict: "blocked" });
		// 清目标不断历史
		h.setQuiesced(false);
		await h.svc.clearGoal();
		expect(h.conv().goal.goal).toBeNull();
		expect(h.conv().goal.history).toHaveLength(2);
	});

	it("F4：历史 cap 20（21 个终态只留最近 20）", async () => {
		const h = makeHarness();
		for (let i = 1; i <= 21; i++) {
			await h.svc.setGoal(`目标 C${i}`, { maxRounds: 0, locked: true });
			expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
			h.conv().mainLastText.value = '{"verdict":"pass","feedback":"过"}';
			h.svc.onAgentEnd(h.conv(), false);
			await h.svc.whenDelegatedSettled("conv-a");
		}
		expect(h.conv().goal.history).toHaveLength(20);
		expect(h.conv().goal.history![0]!.goal).toBe("目标 C21");
		expect(h.conv().goal.history!.at(-1)!.goal).toBe("目标 C2");
	});

	it("A6：预算用尽（exhausted）也移出执行对话，不再占普通对话名额", async () => {
		const h = makeHarness({ waitOutcomes: ["error"] });
		await h.svc.setGoal("目标 Y", { maxRounds: 1, locked: true });
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("fail");
		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
	});

	it("clearGoal 会停掉并移出常驻执行对话（循环不再派活）", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 G", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		await h.svc.clearGoal();
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().goal.goal).toBeNull();
		// 清目标后到来的 verdict 不得改状态（代次作废）
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"晚到的结论"}';
		h.svc.onAgentEnd(h.conv(), false);
		expect(h.conv().goal.verdict).toBe("pending");
		expect(h.spawned).toHaveLength(1);
	});

	it("P1：审查指令自动注入 describePlan（#389 计划与审查联动）", async () => {
		const planText = "Plan Progress: 1/2 completed\n[x] 1. Init repo\n[>] 2. Add auth test";
		const h = makeHarness({ planDesc: planText });
		await h.svc.setGoal("目标 P", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		// 审查指令交回给主对话
		const reviewMsg = h.conv().mainSent.find((m) => m.includes("[goal-review]"));
		expect(reviewMsg).toBeDefined();
		expect(reviewMsg).toContain("【任务计划看板当前状态】");
		expect(reviewMsg).toContain("Plan Progress: 1/2 completed");
		expect(reviewMsg).toContain("核验时请同时核实上述计划步骤的推进与完成状态是否真实");
	});

	it("P2：parseWizardOutput 能够正确分离 GOAL 与 STEPS 并解析步骤", () => {
		const raw = `
Some preamble text that should be ignored.
GOAL: 实现用户注册接口并补充自动化测试
STEPS:
1. 数据库迁移 | 创建 users 数据表与唯一索引
2. 编写注册控制器: 校验邮箱密码格式并加密存储
3. 单元测试 | 覆盖正常注册与重复邮箱异常分支
(include 2 to 6 concrete steps)
		`;
		const res = parseWizardOutput(raw);
		expect(res.goal).toBe("实现用户注册接口并补充自动化测试");
		expect(res.steps).toHaveLength(3);
		expect(res.steps[0]).toEqual({
			id: "step-1",
			title: "数据库迁移",
			status: "pending",
			description: "创建 users 数据表与唯一索引",
		});
		expect(res.steps[1]).toEqual({
			id: "step-2",
			title: "编写注册控制器",
			status: "pending",
			description: "校验邮箱密码格式并加密存储",
		});
		expect(res.steps[2]).toEqual({
			id: "step-3",
			title: "单元测试",
			status: "pending",
			description: "覆盖正常注册与重复邮箱异常分支",
		});
	});

	it("P3：parseWizardOutput 纯 GOAL 无 STEPS 时平稳回退", () => {
		const raw = "GOAL: 仅仅是一个单行目标描述";
		const res = parseWizardOutput(raw);
		expect(res.goal).toBe("仅仅是一个单行目标描述");
		expect(res.steps).toEqual([]);
	});
});

describe("核心更新准入：目标运行中算在途工作", () => {
	it("未设目标为 0；执行/审查循环在飞时 > 0（含轮次间隙）；收尾后归 0", async () => {
		const h = makeHarness();
		expect(h.svc.pendingCoreWork()).toBe(0);
		await h.svc.setGoal("目标 C", { maxRounds: 0, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		// 此刻执行者已停、主对话还没开始审查：没有任何对话在流式输出。
		expect(h.conv().session.isStreaming).toBe(false);
		expect(h.svc.pendingCoreWork()).toBeGreaterThan(0);
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"ok"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.svc.pendingCoreWork()).toBe(0);
	});
});
