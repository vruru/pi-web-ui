import { toUiZoomPixels } from "../ui-zoom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { TIP_MARGIN, computeTipPosition } from "../tip-position";

/** 指针从锚点移到气泡上时先别收起，给这个宽限期（否则气泡永远没法滚/选中文本）。 */
const CLOSE_GRACE_MS = 150;

/**
 * 给任意锚点元素挂一层「悬浮详情」浮层：hover / 键盘聚焦锚点时，把 children 以
 * portal 到 document.body + `position: fixed` 渲染在锚点旁。
 *
 * 为什么不用 CSS `:hover` + `absolute` 挂在锚点里：只要祖先链上有一个
 * `overflow` / `max-height` 滚动容器（如 `.dialog-inline`），贴边弹出的浮层就被
 * 裁掉、而且滚不到（被裁的是滚动容器的 block-start 方向）。portal + fixed 让浮层
 * 彻底脱离那条裁剪链，只受视口约束：右侧/下方放不下时按 computeTipPosition
 * 右对齐 / 向上翻转，实测尺寸后再摆位（文本长度不定，估算不可靠）。
 *
 * 锚点滚动 / 窗口缩放即收起 —— fixed 跟不住会滚动的锚点。
 * 不处理 Esc：宿主对话框通常已把 Esc 用于自己的语义（如取消提问）。
 */
export function HoverDetail({
	anchorRef,
	enabled = true,
	className,
	children,
}: {
	/** 锚点元素：hover / 聚焦它即浮出详情。 */
	anchorRef: RefObject<HTMLElement | null>;
	/** 是否同时响应「聚焦」——触屏上聚焦即点击，传 false 可避免点一下弹一层浮层。 */
	enabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const bubbleRef = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, top: 0 });

	const cancelClose = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);
	const scheduleClose = useCallback(() => {
		cancelClose();
		timer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
	}, [cancelClose]);

	// 锚点上的悬停/聚焦监听（用原生监听：锚点由调用方渲染，拿不到它的 JSX 事件位）。
	useEffect(() => {
		const a = anchorRef.current;
		if (!a) return;
		const enter = () => {
			cancelClose();
			setOpen(true);
		};
		a.addEventListener("mouseenter", enter);
		// 指针可能是移进浮层（portal 到 body，DOM 上不在锚点子树里，所以原生
		// mouseleave 照常触发）。实测 Chromium 把这条 mouseleave **派发在浮层的
		// React onMouseEnter 之后** —— 于是那里的 cancelClose() 会被这里的
		// scheduleClose() 覆盖，浮层 150ms 后自己关掉，再也不能悬停/滚动/选文本。
		// 因此以 relatedTarget 是否落在浮层内为准，与两个事件的先后顺序无关。
		const leave = (e: MouseEvent) => {
			const rt = e.relatedTarget as Node | null;
			if (rt && bubbleRef.current?.contains(rt)) return;
			scheduleClose();
		};
		a.addEventListener("mouseleave", leave);
		if (enabled) {
			a.addEventListener("focus", enter);
			a.addEventListener("blur", scheduleClose);
		}
		return () => {
			cancelClose();
			a.removeEventListener("mouseenter", enter);
			a.removeEventListener("mouseleave", leave);
			a.removeEventListener("focus", enter);
			a.removeEventListener("blur", scheduleClose);
		};
	}, [anchorRef, enabled, cancelClose, scheduleClose]);

	// 挂载首帧：先用锚点预估，避免在左上角闪一下。
	useLayoutEffect(() => {
		if (!open) return;
		const ar = anchorRef.current?.getBoundingClientRect();
		if (!ar) return;
		const next = { left: Math.max(TIP_MARGIN, ar.left - TIP_MARGIN), top: ar.bottom + TIP_MARGIN };
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, anchorRef]);

	// 气泡进 DOM 后实测尺寸，再按视口翻转/对齐。
	useLayoutEffect(() => {
		if (!open) return;
		const b = bubbleRef.current;
		const a = anchorRef.current;
		if (!b || !a) return;
		const next = computeTipPosition(a.getBoundingClientRect(), b.getBoundingClientRect(), {
			width: window.innerWidth,
			height: window.innerHeight,
		});
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, anchorRef, children]);

	// 锚点滚动 / 窗口缩放后 fixed 位置即失效，直接收起。
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	if (!open) return null;
	return createPortal(
		<div
			ref={bubbleRef}
			className={`set-tip-bubble open${className ? ` ${className}` : ""}`}
			role="tooltip"
			style={{ position: "fixed", left: toUiZoomPixels(pos.left), top: toUiZoomPixels(pos.top) }}
			// 指针进到气泡里（滚动 / 选中文本）时不要收起。
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
		>
			{children}
		</div>,
		document.body,
	);
}
