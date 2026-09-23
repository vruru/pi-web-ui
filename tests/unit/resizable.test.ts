// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { clampSize, useResizable } from "../../web/src/use-resizable.js";

import { applyUiZoom } from "../../web/src/ui-zoom.js";

let root: Root | null = null;

beforeEach(() => {
	localStorage.clear();
	applyUiZoom(100);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	localStorage.clear();
	applyUiZoom(100);
});

describe("useResizable & clampSize", () => {
	it("clampSize: 限制在 min 与 max 范围并取整", () => {
		expect(clampSize(150, 100, 200)).toBe(150);
		expect(clampSize(50, 100, 200)).toBe(100);
		expect(clampSize(250, 100, 200)).toBe(200);
		expect(clampSize(120.6, 0, 300)).toBe(121);
	});

	it("useResizable: 初始化与手动 setSize / reset", () => {
		let hook: ReturnType<typeof useResizable> | null = null;

		function TestComponent() {
			hook = useResizable({ defaultSize: 250, min: 100, max: 500 });
			return createElement("div", null, hook.size);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(hook!.size).toBe(250);

		// 手动设置有效尺寸
		act(() => {
			hook!.setSize(320);
		});
		expect(hook!.size).toBe(320);

		// 超出上限钳制
		act(() => {
			hook!.setSize(800);
		});
		expect(hook!.size).toBe(500);

		// reset 回默认尺寸
		act(() => {
			hook!.reset();
		});
		expect(hook!.size).toBe(250);
	});

	it("useResizable: 双击手柄自动重置为默认尺寸", () => {
		let hook: ReturnType<typeof useResizable> | null = null;

		function TestComponent() {
			hook = useResizable({ defaultSize: 200, min: 50, max: 400 });
			return createElement("div", {
				className: "handle",
				...hook.handleProps,
			});
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		act(() => {
			hook!.setSize(350);
		});
		expect(hook!.size).toBe(350);

		const handleEl = container.querySelector(".handle")!;

		// 双击手柄
		act(() => {
			handleEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});

		expect(hook!.size).toBe(200);
	});
	it.each([90, 150, 175])("缩放 %i%% 时拖拽仍与指针保持等长移动", (zoom) => {
		applyUiZoom(zoom);
		let hook: ReturnType<typeof useResizable> | null = null;
		function TestComponent() {
			hook = useResizable({ defaultSize: 200, min: 50, max: 400 });
			return createElement("div", { className: "handle", ...hook.handleProps });
		}
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root!.render(createElement(TestComponent)));
		const handle = container.querySelector<HTMLElement>(".handle")!;
		handle.setPointerCapture = vi.fn();
		handle.releasePointerCapture = vi.fn();
		act(() => handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, button: 0 })));
		act(() => handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100 + zoom })));
		expect(hook!.size).toBe(300);
		act(() => handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
	});
});
