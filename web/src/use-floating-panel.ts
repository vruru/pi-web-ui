import { toUiZoomPixels, toUiZoomRect } from "./ui-zoom";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useEscapeKey } from "./shortcut-stack";

export interface FloatingRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface FloatingSize {
	width: number;
	height: number;
}

export interface FloatingPositionOptions {
	/** 对齐方式：默认 "right"（右对齐到触发器右缘）。 */
	align?: "left" | "right";
	/** 默认展开方向：默认 "bottom"（挂在触发器下方）。 */
	side?: "bottom" | "top";
	/** 触发器与面板间距（px），默认 6。 */
	gap?: number;
	/** 距离视口边缘的安全边距（px），默认 8。 */
	margin?: number;
}

/**
 * 纯函数：计算浮层面板在视口中的最终坐标（position: fixed）。
 *
 * 核心规则：
 * 1. 水平对齐：按 align（默认 right）对齐到触发器边缘，并在 [margin, viewport.width - panel.width - margin] 间安全钳制；
 * 2. 垂直展开：
 *    - 默认 side="bottom"：挂在触发器下方；若下方超出视口则翻到上方；若上下都放不下则贴顶（y=margin）靠内滚；
 *    - 若 side="top"：挂在触发器上方；若上方超出视口则翻到下方；若上下都放不下则贴顶钳制；
 * 3. 绝不依赖任何 DOM 或浏览器状态，纯数学计算，保证单测完备覆盖。
 */
export function computeFloatingPosition(
	anchor: FloatingRect,
	panel: FloatingSize,
	viewport: FloatingSize,
	options: FloatingPositionOptions = {},
): { x: number; y: number } {
	const { align = "right", side = "bottom", gap = 6, margin = 8 } = options;

	const w = panel.width;
	const h = panel.height;
	const maxW = Math.max(0, viewport.width - w - margin);
	const maxH = Math.max(0, viewport.height - h - margin);

	// 水平坐标
	let x = align === "left" ? anchor.left : anchor.right - w;
	x = Math.max(margin, Math.min(x, maxW));

	// 垂直坐标
	let y: number;
	if (side === "top") {
		y = anchor.top - h - gap;
		// 上方放不下就翻到下方
		if (y < margin && anchor.bottom + gap + h <= viewport.height - margin) {
			y = anchor.bottom + gap;
		}
	} else {
		// 默认 bottom
		y = anchor.bottom + gap;
		// 下方放不下就翻到上方
		if (y + h > viewport.height - margin && anchor.top - h - gap >= margin) {
			y = anchor.top - h - gap;
		}
	}

	// 无论哪侧翻转，最终都钳在视口内（两边都放不下时贴顶靠 max-height 内滚）
	if (y > maxH) y = maxH;
	if (y < margin) y = margin;

	return { x: Math.round(x), y: Math.round(y) };
}

export type FloatingAnchor = RefObject<HTMLElement | null> | HTMLElement | FloatingRect | DOMRect | null | undefined;

export interface UseFloatingPanelOptions extends FloatingPositionOptions {
	/** 是否处于打开状态（默认 true）。若弹窗挂载时即打开，保持默认即可。 */
	open?: boolean;
	/**
	 * 锚点：可以是触发按钮的 RefObject、DOM 节点、或点击时抓取的矩形快照。
	 * 若为 DOM 节点或 Ref，在滚动/缩放时会自动读取最新的 getBoundingClientRect()。
	 */
	anchor: FloatingAnchor;
	/**
	 * 可选：触发器元素本体（当 anchor 传入的是快照时，用于判断点击事件是否点在触发器身上）。
	 */
	anchorEl?: HTMLElement | null;
	/**
	 * 关闭回调（点击外部、按 Escape 时调用）。
	 * 内部走 ref，无论传入的函数身份是否变化，都不会引起 document 监听的重新注册。
	 */
	onClose: () => void;
	/**
	 * 额外的内部节点判断：返回 true 表示该 target 视为浮层内部，不触发外部点击关闭。
	 */
	isInside?: (target: Node) => boolean;
}

export interface UseFloatingPanelResult {
	/** 绑定在浮层根 DOM 上的 ref。 */
	panelRef: RefObject<HTMLDivElement | null>;
	/** 计算出的视口坐标（null 表示尚未实测）。 */
	pos: { x: number; y: number } | null;
	/** 直接应用在浮层 style 上的位置样式（已含 fixed、left、top、visibility）。 */
	style: CSSProperties;
	/** 手动触发一次重新测量和定位。 */
	measure: () => void;
}

/**
 * 统一的浮层面板定位与交互 Hook。
 *
 * 解决 4 大经典痛点：
 * 1. 【滚动不关闭】：页面滚动（包括消息流自动滚动）时只重算位置，严禁关闭面板；
 * 2. 【Portal 坐标贴合】：脱离父容器裁剪（portal 到 body）的同时，保持对触发器动态贴合；
 * 3. 【触发器点击防打架】：点触发器自己不会因为 mousedown 先关、click 又开而导致关不掉；
 * 4. 【按键安全】：Esc 捕获期拦截，onClose 走 ref 避免闭包丢失按键。
 */
export function useFloatingPanel(options: UseFloatingPanelOptions): UseFloatingPanelResult {
	const {
		open = true,
		anchor,
		anchorEl,
		onClose,
		isInside,
		align = "right",
		side = "bottom",
		gap = 6,
		margin = 8,
	} = options;

	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	const resolveAnchorRect = (): FloatingRect | null => {
		if (!anchor) return null;
		if ("current" in anchor) {
			return anchor.current?.getBoundingClientRect() ?? null;
		}
		if (typeof (anchor as HTMLElement).getBoundingClientRect === "function") {
			return (anchor as HTMLElement).getBoundingClientRect();
		}
		const r = anchor as FloatingRect;
		if (
			typeof r.left === "number" &&
			typeof r.right === "number" &&
			typeof r.top === "number" &&
			typeof r.bottom === "number"
		) {
			return r;
		}
		return null;
	};

	const resolveAnchorElement = (): HTMLElement | null => {
		if (anchorEl) return anchorEl;
		if (anchor && "current" in anchor) return anchor.current;
		if (anchor && typeof (anchor as HTMLElement).getBoundingClientRect === "function") {
			return anchor as HTMLElement;
		}
		return null;
	};

	const measure = () => {
		if (!open) return;
		const panelEl = panelRef.current;
		if (!panelEl) return;
		const panelRect = panelEl.getBoundingClientRect();
		if (panelRect.width === 0 && panelRect.height === 0) return;

		// 若 anchor 元素仍在 DOM 树中，优先获取实时 getBoundingClientRect()
		const targetEl = resolveAnchorElement();
		const anchorRect = targetEl && targetEl.isConnected ? targetEl.getBoundingClientRect() : resolveAnchorRect();

		if (!anchorRect) return;

		const nextPos = computeFloatingPosition(
			toUiZoomRect(anchorRect),
			{ width: toUiZoomPixels(panelRect.width), height: toUiZoomPixels(panelRect.height) },
			{ width: toUiZoomPixels(window.innerWidth), height: toUiZoomPixels(window.innerHeight) },
			{ align, side, gap, margin },
		);

		setPos((prev) => (prev?.x === nextPos.x && prev?.y === nextPos.y ? prev : nextPos));
	};

	// 挂载/打开后、以及依赖项变化时触发实测
	useLayoutEffect(() => {
		if (open) {
			measure();
		} else {
			setPos(null);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, anchor, anchorEl, align, side, gap, margin]);

	// 通过 Esc 快捷键栈调度：优先消费 Esc 并关闭本浮层，防止外层 Modal 等被一锅端关掉
	useEscapeKey(() => {
		onCloseRef.current();
	}, open);

	useEffect(() => {
		if (!open) return;

		const checkInside = (target: EventTarget | null): boolean => {
			if (!(target instanceof Node)) return false;
			if (panelRef.current?.contains(target)) return true;
			const el = resolveAnchorElement();
			if (el?.contains(target)) return true;
			if (isInside?.(target)) return true;
			return false;
		};

		const onDown = (e: MouseEvent) => {
			if (!checkInside(e.target)) {
				onCloseRef.current();
			}
		};

		// 核心纪律：页面滚动/缩放时只重算坐标，绝不关闭！
		document.addEventListener("mousedown", onDown, true);
		window.addEventListener("resize", measure, true);
		window.addEventListener("scroll", measure, true);

		return () => {
			document.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("resize", measure, true);
			window.removeEventListener("scroll", measure, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, anchor, anchorEl]);

	const style: CSSProperties = {
		position: "fixed",
		left: pos?.x ?? -9999,
		top: pos?.y ?? -9999,
		visibility: pos ? "visible" : "hidden",
	};

	return { panelRef, pos, style, measure };
}
