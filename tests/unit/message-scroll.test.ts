// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMessageScroll } from "../../web/src/use-message-scroll.js";

let root: Root;
let hook: ReturnType<typeof useMessageScroll>;
let el: HTMLDivElement;
let top: number;
let height: number;
let viewport: number;
let frames: FrameRequestCallback[];
let resize: ResizeObserverCallback;

let current = { active: true, resetKey: "a", hasMessages: true };
function StableHarness() {
	hook = useMessageScroll(current);
	return createElement("div", {
		ref: (node: HTMLDivElement | null) => {
			hook.scrollRef.current = node;
			if (!node) return;
			el = node;
			Object.defineProperties(node, {
				scrollTop: {
					configurable: true,
					get: () => top,
					set: (v: number) => {
						top = Math.max(0, Math.min(v, height - viewport));
					},
				},
				scrollHeight: { configurable: true, get: () => height },
				clientHeight: { configurable: true, get: () => viewport },
			});
		},
		onScroll: hook.onScroll,
	});
}
function update(active = true, resetKey = "a", hasMessages = true) {
	current = { active, resetKey, hasMessages };
	act(() => root.render(createElement(StableHarness)));
}
function flushFrames() {
	const batch = frames.splice(0);
	act(() => batch.forEach((cb) => cb(0)));
}
function up() {
	act(() => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
	top -= 100;
	act(() => el.dispatchEvent(new Event("scroll", { bubbles: true })));
}
beforeEach(() => {
	top = 0;
	height = 1000;
	viewport = 200;
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frames.push(cb);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(cb: ResizeObserverCallback) {
				resize = cb;
			}
			observe() {}
			disconnect() {}
		},
	);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	update();
});
afterEach(() => {
	act(() => root.unmount());
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("message transcript follows actual reading intent", () => {
	it("首次显示立即到底，晚到内容和容器缩小继续跟随，不播放动画", async () => {
		expect(top).toBe(800);
		height = 1200;
		await act(async () => {
			el.append(document.createTextNode("stream"));
		});
		flushFrames();
		expect(top).toBe(1000);
		viewport = 100;
		resize([], {} as ResizeObserver);
		flushFrames();
		expect(top).toBe(1100);
		expect(hook.stickBottom).toBe(true);
	});
	it("布局负向位移不冒充手动上滚，不显示回到底部", () => {
		top = 350;
		act(() => hook.onScroll());
		expect(top).toBe(800);
		expect(hook.stickBottom).toBe(true);
	});
	it("真实上滚立即暂停；新增输出不会拉回；点击底部后继续跟随", () => {
		up();
		expect(hook.stickBottom).toBe(false);
		height = 1500;
		act(() => hook.snap());
		expect(top).toBe(700);
		act(() => hook.scrollToBottom());
		expect(top).toBe(1300);
		expect(hook.stickBottom).toBe(true);
	});
	it("隐藏再返回或切会话，均放弃旧阅读位置并显示最新底部", () => {
		up();
		update(false);
		height = 1600;
		act(() => hook.snap());
		expect(top).toBe(700);
		update(true);
		expect(top).toBe(1400);
		expect(hook.stickBottom).toBe(true);
		up();
		update(true, "b");
		expect(top).toBe(1400);
		expect(hook.stickBottom).toBe(true);
	});
	it("滚动条大幅上拖和键盘翻页同样暂停，回到底部恢复", () => {
		act(() => el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
		top = 100;
		act(() => hook.onScroll());
		expect(hook.stickBottom).toBe(false);
		act(() => window.dispatchEvent(new Event("pointerup")));
		top = 800;
		act(() => hook.onScroll());
		expect(hook.stickBottom).toBe(true);
		act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
		expect(hook.stickBottom).toBe(false);
	});
	it("仅在工具内部滚动不会停止消息列表跟随", () => {
		const inner = document.createElement("div");
		Object.defineProperties(inner, {
			scrollTop: { value: 50 },
			scrollHeight: { value: 500 },
			clientHeight: { value: 100 },
		});
		el.append(inner);
		act(() => inner.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true })));
		expect(hook.stickBottom).toBe(true);
	});
	it("浏览器页面重新可见时显示最新底部", () => {
		up();
		height = 1800;
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		expect(top).toBe(1600);
		expect(hook.stickBottom).toBe(true);
	});
});

it("空白模板从顶部显示且缩放不吸到底部，首条消息恢复跟随", () => {
	update(true, "empty", false);
	expect(top).toBe(0);
	top = 100;
	resize([], {} as ResizeObserver);
	flushFrames();
	expect(top).toBe(100);
	expect(hook.stickBottom).toBe(true);
	update(true, "empty", true);
	expect(top).toBe(800);
});
