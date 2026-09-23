// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { HintTip } from "../../web/src/components/HintTip.js";

/**
 * HintTip 回归：滚动/缩放不收起（跟随锚点），锚点滚出视口才收。
 * 真 jsdom + 真 React 渲染；rAF 打成同步桩（jsdom 的帧回调不可靠）。
 */

import { applyUiZoom } from "../../web/src/ui-zoom.js";

let root: Root | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	applyUiZoom(100);
});

/** rAF 同步执行（滚动跟随的节流回调立刻跑完，可断言）。 */
function stubSyncRaf() {
	vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	}) as typeof requestAnimationFrame);
	vi.stubGlobal("cancelAnimationFrame", () => {});
}

/** 渲染并 hover 打开气泡，返回问号锚点。 */
function openTip(text = "很长很长的说明文本") {
	stubSyncRaf();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(HintTip, { text }));
	});
	const anchor = container.querySelector(".set-tip") as HTMLElement;
	// React 的 onMouseEnter 基于 mouseover 合成（mouseenter 不冒泡，直接派发测不到）。
	act(() => {
		anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	});
	expect(document.querySelector(".set-tip-bubble")).toBeTruthy();
	return anchor;
}

const bubble = () => document.querySelector(".set-tip-bubble");

describe("HintTip 滚动跟随", () => {
	it("滚动/缩放不收起气泡", () => {
		openTip();
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(bubble()).toBeTruthy();
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(bubble()).toBeTruthy();
	});

	it("锚点滚出视口才收起", () => {
		const anchor = openTip();
		anchor.getBoundingClientRect = () =>
			({
				left: 0,
				top: 900,
				right: 20,
				bottom: 920,
				width: 20,
				height: 20,
				x: 0,
				y: 900,
				toJSON() {},
			}) as DOMRect;
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(bubble()).toBeNull();
	});

	it("鼠标离开仍收起（旧行为不变）", () => {
		const anchor = openTip();
		act(() => {
			anchor.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		});
		expect(bubble()).toBeNull();
	});
	it("150% 缩放时 portal 提示框 CSS 坐标换算后仍贴住锚点", () => {
		applyUiZoom(150);
		const anchor = openTip();
		anchor.getBoundingClientRect = () =>
			({ left: 150, right: 180, top: 100, bottom: 130, width: 30, height: 30 }) as DOMRect;
		const tip = bubble() as HTMLElement;
		tip.getBoundingClientRect = () => ({ left: 0, right: 150, top: 0, bottom: 60, width: 150, height: 60 }) as DOMRect;
		act(() => window.dispatchEvent(new Event("resize")));
		expect(parseFloat(tip.style.left) * 1.5).toBeCloseTo(142);
		expect(parseFloat(tip.style.top) * 1.5).toBeCloseTo(138);
	});
});
