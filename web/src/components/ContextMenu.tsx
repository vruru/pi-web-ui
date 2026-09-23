import { toUiZoomPixels } from "../ui-zoom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import {
	buildWhenContext,
	closeContextMenu,
	clampMenuPosition,
	contextMenuGlyph,
	contextMenuItems,
	contextMenuRows,
	expandSelectEntries,
	isContextMenuEntryDisabled,
	MENU_MARGIN,
	nextEnabledIndex,
	useContextMenu,
	type ContextMenuRequest,
} from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";

export interface ContextMenuProps {
	/** 点条目时回调（宿主据此分发：view 切视图 / action 交给插件）。
	 *  **host 内置条目不走这里** —— 它们由请求里带的 `onHostAction` 分派（见 dispatch），
	 *  只有插件条目（以及没带分派器的 host 条目）才落到这个回调上。
	 *  第三个参数是右键菜单限定的：kind="select" 的条目在这里展开成子菜单，
	 *  点选子项时带回父条目 + 选中的 option value。 */
	onAction: (entry: UiSlotEntry, target: ContextMenuRequest["target"], value?: string) => void;
}

/**
 * 通用右键菜单渲染层（宿主 UI 扩展点 contextmenu.* 槽位）。
 *
 * 分工：本组件只**渲染**（条目已由调用方用 buildUiSlots 算好，见 context-menu-state.ts），
 * 点击后把 `(entry, target)` 交回宿主 `onAction` —— 宿主才知道 `kind === "view"` 该切哪个
 * 视图、`kind === "action"` 该转给哪个插件。组件自己不做任何业务分发。
 *
 * 关键取舍：
 *  - **portal 到 document.body + `position: fixed`**：右键菜单可能从任何地方弹出（消息、
 *    文件树、左栏会话），挂在使用处会被滚动容器 / `overflow: hidden` 裁剪。fixed 的
 *    测量与钳制使用 `clientX/clientY` 视口坐标；写入 CSS 定位时除以全局 zoom。
 *  - **先渲染再实测尺寸 → clampMenuPosition**：菜单宽度取决于文案长度（插件文案、语言），
 *    估算必然不准，所以用 `useLayoutEffect` 在**绘制前**量一次真实矩形再钳制，既不闪一下
 *    又不会越界。测量的那一帧用 `visibility: hidden`，用户看不到未定位的中间态。
 *  - **事件挂在 document / window 上**：菜单在 portal 里，监听挂在菜单自身只能收到内部事件；
 *    点外部、滚轮、缩放都得全局听 —— 与 Dropdown.tsx 同款做法（那里挂 mousedown/keydown）。
 *    刻意**不监听 scroll**：消息流吸底的程序化 `scrollTop` 同样触发 scroll 事件，
 *    监听了它等于「每来一个新消息就关一次菜单」；手动滚轮由下面的 wheel 监听覆盖。
 *  - **不可用条目用 `aria-disabled` + class，不用原生 `disabled`**：原生 disabled 会让元素
 *    变成「事件死区」（hover/click 都不触发），父菜单的 hover 高亮与「点一下知道为什么灰」
 *    全都做不了；所以置灰由 `isContextMenuEntryDisabled` 在 JS 里判，视觉交给 `.disabled`。
 */
export function ContextMenu({ onAction }: ContextMenuProps): JSX.Element | null {
	const menu = useContextMenu();

	// 条目与渲染行：menu 未打开时给空数组（hook 不能条件调用，只能在下面提前 return）。
	// useMemo 依赖 menu 的引用 —— 打开期间 menu 不换对象 → 这两个数组稳定，effect 不会白跑。
	const items = useMemo(() => (menu ? contextMenuItems(menu.entries) : []), [menu]);
	/** kind="select" 在右键菜单里没有下拉位置 —— 展开成子菜单（见 expandSelectEntries）。
	 *  长度/顺序与 items 一一对应，rows/下标导航直接对着 menuItems 算。 */
	const { items: menuItems, selectParents } = useMemo(() => expandSelectEntries(items), [items]);
	const rows = useMemo(() => contextMenuRows(menuItems), [menuItems]);
	// 求值上下文：这次菜单是哪个槽位 + 右键了什么对象（file/dir/running/message）。
	// 有它插件的肯定形 when（如 "file.isDir"）才能现场求值；没它走 legacy 语义。
	const whenCtx = useMemo(
		() => (menu ? buildWhenContext(menu.slot, menu.target) : undefined),
		// target 是 openContextMenu 时新造的对象，引用每次都变 —— 只取里面的 kind 标量。
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[menu, menu?.slot, menu?.target.kind],
	);

	const rootRef = useRef<HTMLDivElement>(null);
	const subRef = useRef<HTMLDivElement>(null);

	// pos = 实测尺寸后钳制出来的最终坐标；null 表示「还没量过」（那一帧先隐藏）。
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	/** 当前高亮的根层条目下标（-1 = 无）。指针 hover 与方向键共用它。 */
	const [active, setActive] = useState(-1);
	/** 当前展开的子菜单所属的根条目下标（-1 = 没展开）。协议约定只一层。 */
	const [subOpen, setSubOpen] = useState(-1);
	/** 子菜单贴右边缘放不下时翻到父项左侧（判据见下面的 effect）。 */
	const [subFlip, setSubFlip] = useState(false);
	/** 子菜单竖向越界时上移的像素（负值）。 */
	const [subShift, setSubShift] = useState(0);

	// 高亮下标同时留一份在 ref：document 上的键盘监听只挂一次，事件回调里读 ref 拿最新值，
	// 避免「每次 hover 都要重新 addEventListener」。
	const activeRef = useRef(-1);
	const setActiveIndex = (index: number) => {
		activeRef.current = index;
		setActive(index);
	};

	// ---- 子菜单条目（只算当前展开的那一个；select 展开后的合成 children 同样走这里）----
	const subItems = useMemo(
		() => (subOpen >= 0 ? contextMenuItems(menuItems[subOpen]?.children ?? []) : []),
		[menuItems, subOpen],
	);
	const subRows = useMemo(() => contextMenuRows(subItems), [subItems]);

	/**
	 * 触发一个根层条目：带子菜单的**只展开不触发**（协议：children 是「更多操作」，
	 * 点它本身不该有副作用）；置灰的什么都不做（连菜单都不关，让用户看清自己点的是哪条）。
	 */
	const activate = (index: number) => {
		const entry = menuItems[index];
		if (!menu || !entry || isContextMenuEntryDisabled(entry, whenCtx)) return;
		if (entry.children?.length) {
			// 不做「点击切换折叠」：hover 已经展开了，再点一下反而收起会很费解（见下面 hover 逻辑）。
			setSubOpen(index);
			return;
		}
		// 分派器说「菜单先别关」时（第二段确认）就不关 —— 它已经把菜单换成下一段内容了。
		if (!dispatch(entry, menu)) closeContextMenu();
	};

	/**
	 * 条目 → 谁来执行：
	 *  - `source === "host"`（宿主内置项）且请求里带了分派器 → 交给**打开菜单的那个组件**。
	 *    为什么：内置条目的实现要知道「右键的是哪个目录 / 哪条会话」，那是打开菜单的上下文
	 *    （请求里的 target），App 只知道插件动作。返回值 true = 分派器已接管「关不关」。
	 *  - 其余（插件条目，或没带分派器的 host 条目）→ 照旧回宿主 App 的 onAction。
	 */
	const dispatch = (entry: UiSlotEntry, req: ContextMenuRequest, value?: string): boolean => {
		if (entry.source === "host" && req.onHostAction) return req.onHostAction(entry, req.target) === true;
		onAction(entry, req.target, value);
		return false;
	};

	// 键盘监听挂在 document 上（只挂一次），却必须调到**最新那次渲染的** activate 闭包
	// （里面有最新的 items / menu / onAction）。layout effect 在 commit 后、用户事件之前刷新，
	// 所以 ref 里的闭包永远是最新的。
	const activateRef = useRef(activate);
	useLayoutEffect(() => {
		activateRef.current = activate;
	});

	// ---- 打开时：复位高亮/子菜单 + 焦点进菜单 ----
	useEffect(() => {
		if (!menu) {
			activeRef.current = -1;
			setActive(-1);
			setSubOpen(-1);
			return;
		}
		// 默认高亮第一条可用条目：键盘用户一进来按 Enter 就能触发，不必先按方向键。
		const first = nextEnabledIndex(menuItems, -1, 1, whenCtx);
		activeRef.current = first;
		setActive(first);
		setSubOpen(-1);
		rootRef.current?.focus();
	}, [menu, menuItems, whenCtx]);

	// ---- 实测尺寸后钳制坐标（绘制前完成，避免闪一下） ----
	useLayoutEffect(() => {
		if (!menu) {
			setPos(null);
			return;
		}
		const el = rootRef.current;
		if (!el) return; // 极端时序（还没挂上）：下一帧渲染还会跑一次 effect
		const rect = el.getBoundingClientRect();
		setPos(clampMenuPosition(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight));
	}, [menu, menuItems]);

	// ---- 子菜单翻转 / 竖向钳制 ----
	useLayoutEffect(() => {
		const el = subRef.current;
		const root = rootRef.current;
		if (subOpen < 0 || !el || !root) {
			setSubFlip(false);
			setSubShift(0);
			return;
		}
		const rect = el.getBoundingClientRect();
		const rootRect = root.getBoundingClientRect();
		const spaceRight = window.innerWidth - rootRect.right;
		const spaceLeft = rootRect.left;
		// 判据只用「子菜单宽度 + 根菜单矩形」，**不看**自己当前是否已翻转 ——
		// 否则会抖：翻到左侧后 "右侧放不下" 依然成立，下一次测量又翻回右侧，来回震荡。
		setSubFlip(spaceRight < rect.width + MENU_MARGIN && spaceLeft > spaceRight);
		// 超出视口下沿就整体上移（上移量以「顶部还能留 8px」为上限，不把顶部的父项甩出视口）。
		const overflow = rect.bottom - (window.innerHeight - MENU_MARGIN);
		setSubShift(overflow > 0 ? -Math.min(overflow, Math.max(0, rect.top - MENU_MARGIN)) : 0);
	}, [subOpen, menuItems]);

	// ---- 关闭时机：点外部 / 缩放 / 菜单外的滚轮（刻意不监听 scroll，见文件头注释） ----
	useEffect(() => {
		if (!menu) return;
		const inside = (target: EventTarget | null) =>
			rootRef.current && target instanceof Node && rootRef.current.contains(target);
		const onDown = (e: MouseEvent) => {
			// 菜单内部的按下（含右键）不关；再右键一次还能重选（与 LeftPanel/RightPanel 的既有行为一致）。
			if (inside(e.target)) return;
			closeContextMenu();
		};
		const onWheel = (e: WheelEvent) => {
			if (inside(e.target)) return; // 菜单自己滚（长菜单）不该关
			closeContextMenu();
		};
		const onResize = () => closeContextMenu();
		// mousedown/wheel 用捕获：宿主若在冒泡链上 stopPropagation，我们仍然收得到。
		document.addEventListener("mousedown", onDown, true);
		window.addEventListener("wheel", onWheel, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("wheel", onWheel, true);
			window.removeEventListener("resize", onResize);
		};
	}, [menu]);

	// ---- 键盘 ----
	useEffect(() => {
		if (!menu) return;
		const move = (delta: number) => {
			const next = nextEnabledIndex(menuItems, activeRef.current, delta, whenCtx);
			activeRef.current = next;
			setActive(next);
		};
		const onKey = (e: KeyboardEvent) => {
			switch (e.key) {
				case "Escape":
					// Esc 一律关整个菜单（含子菜单一起收），这是用户对「弹窗」的普遍预期。
					e.preventDefault();
					closeContextMenu();
					return;
				case "Tab":
					// 菜单不锁焦点（没有 aria-modal 语义）：Tab 直接收起并让焦点回落到页面。
					closeContextMenu();
					return;
				case "ArrowDown":
					e.preventDefault();
					move(1);
					return;
				case "ArrowUp":
					e.preventDefault();
					move(-1);
					return;
				case "ArrowRight":
					if (menuItems[activeRef.current]?.children?.length) {
						e.preventDefault();
						setSubOpen(activeRef.current);
					}
					return;
				case "ArrowLeft":
					if (subOpen >= 0) {
						e.preventDefault();
						setSubOpen(-1);
					}
					return;
				case "Enter":
				case " ":
					// 必须 preventDefault：焦点在 <button> 上时 Enter/Space 的默认行为是「再点一次」，
					// 不拦住就会触发两遍（一遍我们这里、一遍原生 click）。
					e.preventDefault();
					activateRef.current(activeRef.current);
					return;
				default:
					return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [menu, menuItems, subOpen, whenCtx]);

	// 高亮项滚进视野（长菜单 + 键盘导航时，高亮可能在可视区外）。
	// scrollIntoView 用可选调用：极少数宿主环境（无头/测试 DOM）没实现它，而这里抛错会
	// 直接炸掉整棵 React 树 —— 滚个视野而已，不值得。
	useEffect(() => {
		if (active < 0) return;
		rootRef.current?.querySelector('[data-ctx-active="true"]')?.scrollIntoView?.({ block: "nearest" });
	}, [active]);

	// 菜单没打开 → 什么都不画（hook 已在上面全部调用完毕）。
	if (!menu) return null;

	/** 子项点击：一层为止（协议不再递归），同样交回宿主/内置分派器，然后收起整个菜单。
	 *  select 展开的合成子项先回查：回父条目 + 选中的 option value。 */
	const runChild = (entry: UiSlotEntry) => {
		const sel = selectParents.get(entry.id);
		if (sel) {
			if (isContextMenuEntryDisabled(sel.parent, whenCtx)) return;
			if (menu && !dispatch(sel.parent, menu, sel.value)) closeContextMenu();
			return;
		}
		if (isContextMenuEntryDisabled(entry, whenCtx)) return;
		if (dispatch(entry, menu)) return; // 分派器要求保持打开（第二段确认）
		closeContextMenu();
	};

	/** 画一个条目（根层与子层共用；子层的 index 只用于自己的高亮/hover，不参与根层导航）。 */
	const renderItem = (entry: UiSlotEntry, index: number, isRoot: boolean) => {
		const disabled = isContextMenuEntryDisabled(entry, whenCtx);
		const hasChildren = Boolean(entry.children?.length);
		const glyph = contextMenuGlyph(entry.icon);
		const isActive = isRoot && active === index;
		return (
			<div className="ctx-menu-itemwrap" role="none" key={`${entry.id}#${index}`}>
				<button
					type="button"
					role="menuitem"
					className={`ctx-menu-item${disabled ? " disabled" : ""}${isActive ? " active" : ""}${
						hasChildren ? " has-sub" : ""
					}`}
					// 无障碍：label 就是可见文案；禁用/子菜单用 aria 表达（不用原生 disabled，见文件头注释）。
					aria-label={entry.label}
					// 插件声明的悬浮提示（UiContribution.hint）：没有就不给 title，别拿 label 凑。
					title={entry.hint}
					aria-disabled={disabled || undefined}
					aria-haspopup={hasChildren ? "menu" : undefined}
					aria-expanded={hasChildren ? subOpen === index : undefined}
					data-ctx-active={isActive ? "true" : undefined}
					onMouseEnter={
						isRoot
							? () => {
									setActiveIndex(index);
									// hover 即展开子菜单（键盘用户走 ArrowRight）。置灰项不展开。
									if (hasChildren && !disabled) setSubOpen(index);
								}
							: undefined
					}
					onClick={() => (isRoot ? activate(index) : runChild(entry))}
				>
					{glyph ? (
						<span className="ctx-menu-icon" aria-hidden="true">
							{glyph}
						</span>
					) : null}
					<span className="ctx-menu-label">{entry.label}</span>
					{entry.badge ? <span className="ctx-menu-badge">{entry.badge}</span> : null}
					{hasChildren ? (
						<span className="ctx-menu-caret" aria-hidden="true">
							▸
						</span>
					) : null}
				</button>
				{isRoot && hasChildren && subOpen === index ? (
					<div
						ref={subRef}
						className={`ctx-menu-sub${subFlip ? " left" : ""}`}
						role="menu"
						aria-label={entry.label}
						// 竖向越界只用 marginTop 上移（`top: -5px` 与父项对齐的基准留给 CSS，别在 JS 里写死）。
						style={subShift ? { marginTop: toUiZoomPixels(subShift) } : undefined}
					>
						{subRows.map((row) =>
							row.kind === "sep" ? (
								<div key={row.key} className="ctx-menu-sep" role="separator" />
							) : (
								renderItem(row.entry, row.index, false)
							),
						)}
					</div>
				) : null}
			</div>
		);
	};

	return createPortal(
		<div
			ref={rootRef}
			className="ctx-menu"
			role="menu"
			// 槽位 + 被右键对象给读屏用户一点上下文：没有菜单自身的 i18n 文案（那是宿主的事），
			// 这里只给机器可读的定位信息。
			aria-label={menu.target.label ? `${menu.slot}: ${menu.target.label}` : menu.slot}
			tabIndex={-1}
			style={{
				left: toUiZoomPixels(pos?.x ?? menu.x),
				top: toUiZoomPixels(pos?.y ?? menu.y),
				// 还没实测尺寸的那一帧先藏起来（layout effect 在绘制前就把它换成最终坐标）。
				visibility: pos ? "visible" : "hidden",
			}}
			onContextMenu={(e) => {
				// 菜单内部的右键不冒泡给宿主（否则宿主的 contextmenu 会再开一次菜单 / 触发浏览器菜单）。
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			{rows.map((row) =>
				row.kind === "sep" ? (
					<div key={row.key} className="ctx-menu-sep" role="separator" />
				) : (
					renderItem(row.entry, row.index, true)
				),
			)}
		</div>,
		document.body,
	);
}
