// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus } from "../../web/src/types.js";

/**
 * 目标条折叠态只是一枚**悬浮**小药丸，不是一条面板、也不占高度。
 *
 * 之前折叠态渲染的是 `<div class="goalbar goalbar-collapsed">`：`.goalbar` 那套
 * 边框/底色/圆角/内边距全留着，主题还会用 `.goalbar { border-top: … !important }`
 * 画一条通栏细线 —— 于是一条横跨整列的带子横在最后一条消息上把它切断（用户实报
 * 「折叠时一整行遮挡底部消息」「下面一整条不透明」）。现在折叠态只渲染
 * `.goalbar-collapsed`，且**脱离文档流**（position:absolute + bottom:100%，浮在输入区
 * 上沿），与「回到底部」同一路数：收起时消息区一路通到输入框，底缘不再多出一条带子。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

let root: Root | null = null;

const inactiveGoal = {
	status: "idle",
	goal: null,
	conversationId: "c-1",
} as unknown as GoalStatus;

function mount() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, {
					goal: inactiveGoal,
					models: [],
					modelsLoading: false,
					activeConversationId: "c-1",
				} as unknown as Parameters<typeof GoalBar>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function bodyOf(selector: string) {
	// 前缀允许 `}`（上一条规则收尾）或 `,`（多选择器规则里的第 2/N 个）——
	// 回退分支那条把 .dialog-inline 与 .plan-board 写在同一条规则里。
	const re = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
	return re.exec(CSS)?.[1] ?? "";
}

describe("目标条折叠态", () => {
	it("渲染 .goalbar-collapsed，且不带 .goalbar 面板类", () => {
		const container = mount();
		const bar = container.querySelector(".goalbar-collapsed");
		expect(bar).not.toBeNull();
		expect(bar!.classList.contains("goalbar")).toBe(false);
		// 整条里没有「面板皮」：只有药丸本身
		expect(container.querySelector(".goalbar-hint")).not.toBeNull();
		expect(container.querySelector(".goalbar-row")).toBeNull();
	});

	it("CSS：.goalbar-collapsed 自己是悬浮一行（无边框/底色/内边距，且不外溢）", () => {
		const body = bodyOf(".goalbar-collapsed");
		expect(body).not.toBe("");
		expect(/border\s*:/.test(body), "折叠态不该有边框（通栏带子的根因）").toBe(false);
		expect(/background\s*:/.test(body), "折叠态不该有底色").toBe(false);
		expect(/padding\s*:/.test(body), "折叠态不该有面板内边距").toBe(false);
		expect(/display\s*:\s*flex/.test(body)).toBe(true);
		expect(/justify-content\s*:\s*center/.test(body), "药丸应整行水平居中（与 0.96.x 一致）").toBe(true);
		// 行容器口径：先钉 min-width:0 + max-width:100%（插件条目也不许顶宽）
		expect(/min-width\s*:\s*0/.test(body)).toBe(true);
		expect(/max-width\s*:\s*100%/.test(body)).toBe(true);
	});

	it("CSS：脱离文档流，浮在输入区上沿（不吃高度、不吃事件）", () => {
		const body = bodyOf(".goalbar-collapsed");
		// 与「回到底部」同一路数：absolute + bottom:100%（宿主槽高 0 → 消息区底缘之上）
		expect(/position:\s*absolute/.test(body)).toBe(true);
		expect(/bottom:\s*100%/.test(body)).toBe(true);
		expect(/left:\s*0/.test(body)).toBe(true);
		expect(/right:\s*0/.test(body)).toBe(true);
		// 通栏的行不能吃掉事件：空白处照常滚动/选中正文
		expect(/pointer-events:\s*none/.test(body)).toBe(true);
		expect(/pointer-events:\s*auto/.test(bodyOf(".goalbar-collapsed > *"))).toBe(true);
		// 定位上下文只在折叠态建（展开态保持 static：里面的 fixed 底抽屉不能被改包含块）
		expect(bodyOf(".goalbar-slot")).toMatch(/flex:\s*none/);
		expect(bodyOf(".goalbar-slot:has(.goalbar-collapsed)")).toMatch(/position:\s*relative/);
		// 始终贴输入区上沿 4px：药丸不因滚动状态上抬，回到底部靠浮标自己让层
		expect(body).toMatch(/margin:\s*0 var\(--chat-inset\) 4px/);
		expect(CSS, "别再为回到底部上抬药丸（改成浮标自己上抬）").not.toMatch(
			/\.main:has\(\.messages\.anchor-live\) \.goalbar-collapsed/,
		);
		// 问卷/看板在中间时退回文档流
		const fallback = bodyOf(".main:has(.dialog-inline) .goalbar-collapsed");
		expect(fallback).toMatch(/position:\s*static/);
	});

	it("CSS：回到底部浮标回到底边正中，抬到目标药丸上方（不叠）", () => {
		const jump = bodyOf(".scroll-bottom");
		// 回到底边正中（最初的位置）
		expect(jump).toMatch(/left:\s*50%/);
		expect(jump).toMatch(/transform:\s*translateX\(-50%\)/);
		// 贴底 4px（比原来的 16px 更近；本轮只动间距，不动按钮尺寸）
		expect(jump).toMatch(/bottom:\s*4px/);
		// 尺寸是原件：12px 字 / 6/14 内边距 / gap 6（不许拿「缩小按钮」代替「缩间距」）
		expect(jump).toMatch(/font-size:\s*12px/);
		expect(jump).toMatch(/padding:\s*6px 14px/);
		expect(jump).toMatch(/gap:\s*6px/);
		// 药丸**浮在消息区内**时上抬一层：同在正中，只改高度不横移。
		// 选择器必须排除「药丸已退回文档流」的两种情形（.plan-board / .dialog-inline）：
		// 那时药丸不在消息区里，浮标却还让位 → 按钮凭空离底 ~50px、悬在正文中间
		// （用户实报「回到底部距离太远了」）。
		const lifted = bodyOf(
			".main:has(.goalbar-collapsed):not(:has(.plan-board)):not(:has(.dialog-inline)) .scroll-bottom",
		);
		expect(lifted).toMatch(/bottom:\s*32px/);
		expect(lifted).not.toMatch(/right:/);
		// 药丸 24px 高 + 4px 贴边 = 占 4~28，抬 32 → 两者间距恒为 4px
		// （不许回到 52/40 那种大片留白，也不许压到 30 以下贴上药丸）
		const lift = Number(/bottom:\s*(\d+)px/.exec(lifted)?.[1] ?? "0");
		expect(lift).toBe(32);
	});

	it("CSS：收起态药丸尺寸是原件（只收贴边间距，不缩药丸）", () => {
		const hint = bodyOf(".goalbar-hint");
		expect(hint).toMatch(/font-size:\s*12px/);
		expect(hint).toMatch(/padding:\s*4px 10px/);
		expect(hint).toMatch(/gap:\s*7px/);
		// 间距归间距：药丸贴输入区上沿 8px → 4px（见 .goalbar-collapsed 的 margin）
		expect(bodyOf(".goalbar-collapsed")).toMatch(/margin:\s*0 var\(--chat-inset\) 4px/);
	});

	it("CSS：兜底把 .goalbar 面板皮从折叠态抹掉（老 bundle/插件带回面板类也不画带子）", () => {
		// 主题对 .goalbar 的底色/上边框写的是 !important，只能同权重压。
		const body = bodyOf(".goalbar.goalbar-collapsed");
		expect(body).not.toBe("");
		expect(/border:\s*0\s*!important/.test(body)).toBe(true);
		expect(/background:\s*none\s*!important/.test(body)).toBe(true);
		expect(/box-shadow:\s*none\s*!important/.test(body)).toBe(true);
		expect(/padding:\s*0\s*!important/.test(body)).toBe(true);
	});
});
