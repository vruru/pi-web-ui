/**
 * server/plan-manager.ts
 *
 * 结构化任务计划看板与步骤状态机（Plan Mode / Step State Machine）。
 *
 * 借鉴 DeepSeek Harness (DSH) 的 dsh-plan-mode：
 * 1. 任务步骤状态机（Step State Machine）：
 *    - 步骤字段：id, title, status ("pending" | "in_progress" | "done" | "failed"), description
 *    - 总体进度与当前执行中步骤
 * 2. 计划管理与更新（PlanManager）：
 *    - 模型可通过 customTool `plan_update` 更新
 *    - 客户端也可通过协议消息 `plan_update` 调整
 *    - 状态自动同步到快照 `UiState.plan`
 */

import type { PlanState, PlanStep, PlanStepStatus } from "./protocol.js";

const VALID_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "done", "failed"]);

export class PlanManager {
	private plans = new Map<string, PlanState>();

	/** 获取指定会话的计划状态。 */
	getPlan(conversationId: string): PlanState | null {
		return this.plans.get(conversationId) ?? null;
	}

	/** 设置/全量更新指定会话的计划。 */
	setPlan(conversationId: string, steps: PlanStep[], activeStepId?: string | null): PlanState {
		const normalizedSteps: PlanStep[] = (Array.isArray(steps) ? steps : []).map((s, idx) => {
			const status = (VALID_STATUSES.has(s.status) ? s.status : "pending") as PlanStepStatus;
			return {
				id: String(s.id || `step-${idx + 1}`),
				title: String(s.title || "").slice(0, 200),
				status,
				...(s.description ? { description: String(s.description).slice(0, 1000) } : {}),
			};
		});

		// 自动推断 activeStepId：优先显式传参；否则推断第一个 in_progress 的步骤
		let effectiveActiveId = activeStepId;
		if (effectiveActiveId === undefined) {
			const inProg = normalizedSteps.find((s) => s.status === "in_progress");
			effectiveActiveId = inProg ? inProg.id : null;
		}

		const state: PlanState = {
			steps: normalizedSteps,
			activeStepId: effectiveActiveId,
			updatedAt: Date.now(),
		};

		this.plans.set(conversationId, state);
		return state;
	}

	/** 增量更新单个步骤的状态或内容。 */
	updateStep(conversationId: string, stepId: string, patch: Partial<PlanStep>): PlanState | null {
		const current = this.plans.get(conversationId);
		if (!current) return null;

		const idx = current.steps.findIndex((s) => s.id === stepId);
		if (idx === -1) return null;

		const currentStep = current.steps[idx];
		const nextStatus = patch.status && VALID_STATUSES.has(patch.status) ? patch.status : currentStep.status;

		// patch 里剥掉 id：步骤 id 是 activeStepId / first-match 推进的锚点，
		// 被改掉会让 activeStepId 悬空（指向不存在的步骤）。
		const { id: _ignored, ...rest } = patch;
		const nextStep: PlanStep = {
			...currentStep,
			...rest,
			status: nextStatus,
			// title/description 与 setPlan 同口径截断（200/1000），防超长内容撑爆快照。
			title: String(rest.title ?? currentStep.title ?? "").slice(0, 200),
		};
		const description = String(rest.description ?? currentStep.description ?? "").slice(0, 1000);
		if (description) nextStep.description = description;
		else delete nextStep.description;

		const nextSteps = [...current.steps];
		nextSteps[idx] = nextStep;

		let nextActive = current.activeStepId;
		if (patch.status === "in_progress") {
			nextActive = stepId;
		} else if (current.activeStepId === stepId && patch.status) {
			// 当前活动步骤已完成或失败，自动推进到下一个待执行步骤
			const nextPending = nextSteps.find((s) => s.status === "pending" || s.status === "in_progress");
			nextActive = nextPending ? nextPending.id : null;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plans.set(conversationId, nextState);
		return nextState;
	}

	/** 清除指定会话的计划。 */
	clearPlan(conversationId: string): void {
		this.plans.delete(conversationId);
	}

	/** 格式化计划为简洁文本，供模型上下文或诊断使用。 */
	describePlan(conversationId: string): string {
		const plan = this.getPlan(conversationId);
		if (!plan || plan.steps.length === 0) return "No active plan.";

		const doneCount = plan.steps.filter((s) => s.status === "done").length;
		const total = plan.steps.length;
		const lines = [`Plan Progress: ${doneCount}/${total} completed`];

		for (let i = 0; i < plan.steps.length; i++) {
			const s = plan.steps[i];
			const icon =
				s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "failed" ? "[!]" : "[ ]";
			const activeTag = s.id === plan.activeStepId ? " (current)" : "";
			lines.push(`${icon} ${i + 1}. ${s.title}${activeTag}`);
			if (s.description) {
				lines.push(`     ${s.description}`);
			}
		}

		return lines.join("\n");
	}
}
