import { toUiZoomPixels } from "./ui-zoom";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import { readLocalStorage, writeLocalStorage } from "./use-local-storage";

export interface UseResizableOptions {
	/** 调节轴向："x"（宽度）或 "y"（高度），默认 "x"。 */
	axis?: "x" | "y";
	/** 默认/初始尺寸（px）。 */
	defaultSize: number;
	/** 最小尺寸（px），默认 0。 */
	min?: number;
	/** 最大尺寸（px），默认 Infinity。 */
	max?: number;
	/**
	 * 拖拽方向反转（默认 false）。
	 * false: 向右/向下增加尺寸（如左侧栏拉宽）；
	 * true: 向左/向上增加尺寸（如右侧栏向左拉宽、或输入框向上拉高）。
	 */
	reverse?: boolean;
	/** 可选：localStorage 持久化 key。 */
	storageKey?: string;
	/** 尺寸变更回调。 */
	onResize?: (size: number) => void;
}

export interface UseResizableResult {
	/** 当前尺寸（px）。 */
	size: number;
	/** 当前是否正在拖拽中。 */
	isDragging: boolean;
	/** 直接解构绑定在拖拽手柄（handle）上的事件属性。 */
	handleProps: {
		onPointerDown: (e: ReactPointerEvent) => void;
		onDoubleClick: (e: ReactMouseEvent) => void;
		style: {
			touchAction: "none";
			userSelect: "none";
		};
	};
	/** 手动设置尺寸。 */
	setSize: (size: number) => void;
	/** 重置为默认尺寸。 */
	reset: () => void;
}

/**
 * 纯函数：限制尺寸在 min 与 max 之间。
 */
export function clampSize(size: number, min = 0, max = Infinity): number {
	return Math.round(Math.min(Math.max(size, min), max));
}

/**
 * 拖拽尺寸调节 Hook。
 *
 * 解决痛点：
 * 1. 【指针捕获丢失】：采用 `setPointerCapture`，指针拖出视口或移入 iframe 也绝不丢捕获；
 * 2. 【误选文本防御】：拖拽期间自动锁定 `body { user-select: none }`；
 * 3. 【双击复位与持久化】：开箱支持双击手柄复位默认尺寸，并自动同步 localStorage。
 */
export function useResizable(options: UseResizableOptions): UseResizableResult {
	const { axis = "x", defaultSize, min = 0, max = Infinity, reverse = false, storageKey, onResize } = options;

	const [size, setSizeState] = useState<number>(() => {
		if (storageKey) {
			const saved = readLocalStorage(storageKey, defaultSize);
			if (typeof saved === "number" && !Number.isNaN(saved)) {
				return clampSize(saved, min, max);
			}
		}
		return clampSize(defaultSize, min, max);
	});

	const [isDragging, setIsDragging] = useState(false);

	const onResizeRef = useRef(onResize);
	useLayoutEffect(() => {
		onResizeRef.current = onResize;
	});

	const dragStartRef = useRef<{
		startCoord: number;
		startSize: number;
	} | null>(null);

	const setSize = useCallback(
		(newSize: number) => {
			const clamped = clampSize(newSize, min, max);
			setSizeState(clamped);
			if (storageKey) {
				writeLocalStorage(storageKey, clamped);
			}
			onResizeRef.current?.(clamped);
		},
		[min, max, storageKey],
	);

	const reset = useCallback(() => {
		setSize(defaultSize);
	}, [setSize, defaultSize]);

	const onPointerDown = useCallback(
		(e: ReactPointerEvent) => {
			// 仅响应鼠标左键或触控
			if (e.button !== 0) return;

			const target = e.currentTarget;
			target.setPointerCapture(e.pointerId);

			const startCoord = axis === "x" ? e.clientX : e.clientY;
			dragStartRef.current = {
				startCoord,
				startSize: size,
			};

			setIsDragging(true);
			document.body.style.userSelect = "none";

			const onPointerMove = (moveEvent: PointerEvent) => {
				if (!dragStartRef.current) return;
				const currentCoord = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
				const delta = toUiZoomPixels(currentCoord - dragStartRef.current.startCoord);
				const effectiveDelta = reverse ? -delta : delta;
				const nextSize = dragStartRef.current.startSize + effectiveDelta;
				setSize(nextSize);
			};

			const onPointerUp = (upEvent: PointerEvent) => {
				try {
					target.releasePointerCapture(upEvent.pointerId);
				} catch {
					// 忽略已释放异常
				}
				target.removeEventListener("pointermove", onPointerMove as EventListener);
				target.removeEventListener("pointerup", onPointerUp as EventListener);
				target.removeEventListener("pointercancel", onPointerUp as EventListener);

				dragStartRef.current = null;
				setIsDragging(false);
				document.body.style.userSelect = "";
			};

			target.addEventListener("pointermove", onPointerMove as EventListener);
			target.addEventListener("pointerup", onPointerUp as EventListener);
			target.addEventListener("pointercancel", onPointerUp as EventListener);
		},
		[axis, size, reverse, setSize],
	);

	const onDoubleClick = useCallback(
		(e: ReactMouseEvent) => {
			e.preventDefault();
			reset();
		},
		[reset],
	);

	// 卸载时清理 userSelect
	useEffect(() => {
		return () => {
			document.body.style.userSelect = "";
		};
	}, []);

	return {
		size,
		isDragging,
		handleProps: {
			onPointerDown,
			onDoubleClick,
			style: {
				touchAction: "none",
				userSelect: "none",
			},
		},
		setSize,
		reset,
	};
}
