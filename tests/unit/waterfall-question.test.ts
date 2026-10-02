import { describe, it, expect } from "vitest";
import type { UiQuestion } from "../../server/protocol.js";

describe("级联动态问卷（Waterfall Questioning）", () => {
	function isQuestionVisible(qq: UiQuestion, selections: Record<string, string[]>): boolean {
		if (!qq.dependsOn) return true;
		const depSelected = selections[qq.dependsOn.questionId] ?? [];
		if (qq.dependsOn.value === undefined) return depSelected.length > 0;
		const expected = Array.isArray(qq.dependsOn.value) ? qq.dependsOn.value : [qq.dependsOn.value];
		return depSelected.some((ans) => expected.includes(ans));
	}

	function getEffectiveOptions(q: UiQuestion, selections: Record<string, string[]>) {
		if (q.optionsMap && q.dependsOn) {
			const depAnswers = selections[q.dependsOn.questionId] ?? [];
			for (const ans of depAnswers) {
				if (q.optionsMap[ans]) return q.optionsMap[ans];
			}
		}
		return q.options ?? [];
	}

	it("无 dependsOn 时题目恒可见", () => {
		const q: UiQuestion = { id: "q1", question: "Root question" };
		expect(isQuestionVisible(q, {})).toBe(true);
	});

	it("dependsOn 未指定具体 value 时，前序题有回答即展示", () => {
		const q: UiQuestion = {
			id: "q2",
			question: "Follow-up",
			dependsOn: { questionId: "q1" },
		};
		expect(isQuestionVisible(q, {})).toBe(false);
		expect(isQuestionVisible(q, { q1: ["any"] })).toBe(true);
	});

	it("dependsOn 指定特定 value 时，只有匹配才展示", () => {
		const q: UiQuestion = {
			id: "q2",
			question: "React details",
			dependsOn: { questionId: "framework", value: "React" },
		};
		expect(isQuestionVisible(q, { framework: ["Vue"] })).toBe(false);
		expect(isQuestionVisible(q, { framework: ["React"] })).toBe(true);
	});

	it("dependsOn 支持数组候选值", () => {
		const q: UiQuestion = {
			id: "q2",
			question: "Fullstack details",
			dependsOn: { questionId: "framework", value: ["Next.js", "Nuxt.js"] },
		};
		expect(isQuestionVisible(q, { framework: ["Express"] })).toBe(false);
		expect(isQuestionVisible(q, { framework: ["Next.js"] })).toBe(true);
		expect(isQuestionVisible(q, { framework: ["Nuxt.js"] })).toBe(true);
	});

	it("optionsMap 根据前序题答案动态提供有效选项", () => {
		const q: UiQuestion = {
			id: "state",
			question: "State management",
			dependsOn: { questionId: "framework" },
			optionsMap: {
				React: [{ label: "Zustand" }, { label: "Redux" }],
				Vue: [{ label: "Pinia" }, { label: "Vuex" }],
			},
		};

		expect(getEffectiveOptions(q, { framework: ["React"] })).toEqual([{ label: "Zustand" }, { label: "Redux" }]);
		expect(getEffectiveOptions(q, { framework: ["Vue"] })).toEqual([{ label: "Pinia" }, { label: "Vuex" }]);
	});
});
