import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Follow live output unless an actual reading gesture explicitly pauses it. */
export function useMessageScroll({
	active = true,
	hasMessages = true,
	resetKey,
}: {
	active?: boolean;
	hasMessages?: boolean;
	resetKey: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const escapedRef = useRef(false);
	const [stickBottom, setStickBottom] = useState(true);
	const activeRef = useRef(active);
	activeRef.current = active && hasMessages;
	const previousTop = useRef(0);
	const scrollbarDrag = useRef(false);

	const pause = useCallback(() => {
		stickRef.current = false;
		escapedRef.current = true;
		setStickBottom(false);
	}, []);
	const snap = useCallback(() => {
		const el = scrollRef.current;
		if (!el || !activeRef.current || !stickRef.current || escapedRef.current) return;
		// Direct assignment is deliberately instant; never animate streaming output.
		el.scrollTop = el.scrollHeight;
		previousTop.current = el.scrollTop;
	}, []);
	const scrollToBottom = useCallback(() => {
		stickRef.current = true;
		escapedRef.current = false;
		setStickBottom(true);
		snap();
	}, [snap]);
	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el || !activeRef.current) return;
		const upwards = el.scrollTop < previousTop.current - 1;
		if (scrollbarDrag.current && upwards) pause();
		else if (escapedRef.current && !upwards && el.scrollHeight - el.clientHeight - el.scrollTop <= 2) {
			scrollToBottom();
		}
		previousTop.current = el.scrollTop;
		if (!escapedRef.current) snap();
	}, [pause, scrollToBottom, snap]);

	useLayoutEffect(() => {
		if (!active) return;
		if (hasMessages) scrollToBottom();
		else {
			if (scrollRef.current) scrollRef.current.scrollTop = 0;
			previousTop.current = 0;
			stickRef.current = true;
			escapedRef.current = false;
			setStickBottom(true);
		}
	}, [active, hasMessages, resetKey, scrollToBottom]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		// Scrolling an inner tool-output pane shouldn't pause the outer transcript.
		const pauseForTarget = (target: EventTarget | null) => {
			if (!activeRef.current || el.scrollTop <= 0) return;
			let node = target instanceof Element ? target : null;
			while (node && node !== el) {
				if (node instanceof HTMLElement && node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return;
				node = node.parentElement;
			}
			pause();
		};
		const wheel = (e: WheelEvent) => {
			if (e.deltaY < 0) pauseForTarget(e.target);
		};
		let touchY: number | null = null;
		const touchStart = (e: TouchEvent) => {
			touchY = e.touches[0]?.clientY ?? null;
		};
		const touchMove = (e: TouchEvent) => {
			const next = e.touches[0]?.clientY;
			if (next !== undefined && touchY !== null && next > touchY) pauseForTarget(e.target);
			touchY = next ?? null;
		};
		const keydown = (e: KeyboardEvent) => {
			const target = e.target instanceof HTMLElement ? e.target : null;
			if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
			if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) {
				pauseForTarget(e.target);
			}
		};
		const pointerDown = (e: PointerEvent) => {
			scrollbarDrag.current = e.target === el;
		};
		const pointerUp = () => {
			scrollbarDrag.current = false;
		};
		const visible = () => {
			if (document.visibilityState === "visible" && activeRef.current) scrollToBottom();
		};
		el.addEventListener("wheel", wheel, { passive: true });
		el.addEventListener("touchstart", touchStart, { passive: true });
		el.addEventListener("touchmove", touchMove, { passive: true });
		el.addEventListener("keydown", keydown);
		el.addEventListener("pointerdown", pointerDown);
		window.addEventListener("pointerup", pointerUp);
		document.addEventListener("visibilitychange", visible);
		return () => {
			el.removeEventListener("wheel", wheel);
			el.removeEventListener("touchstart", touchStart);
			el.removeEventListener("touchmove", touchMove);
			el.removeEventListener("keydown", keydown);
			el.removeEventListener("pointerdown", pointerDown);
			window.removeEventListener("pointerup", pointerUp);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [pause, scrollToBottom]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		let frame = 0;
		const schedule = () => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					snap();
				});
		};
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		const observeRows = () => {
			ro?.disconnect();
			ro?.observe(el);
			for (const child of el.children) ro?.observe(child);
		};
		observeRows();
		const mo = new MutationObserver(() => {
			observeRows();
			schedule();
		});
		mo.observe(el, { childList: true, subtree: true, characterData: true });
		el.addEventListener("load", schedule, true);
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			ro?.disconnect();
			mo.disconnect();
			el.removeEventListener("load", schedule, true);
			window.removeEventListener("resize", schedule);
		};
	}, [snap]);

	return { scrollRef, stickRef, escapedRef, stickBottom, setStickBottom, scrollToBottom, onScroll, pause, snap };
}
