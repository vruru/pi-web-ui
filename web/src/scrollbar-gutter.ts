import { toUiZoomPixels } from "./ui-zoom";
/**
 * 维护 CSS 变量 `--msgs-gutter`：`.messages` 滚动容器**每侧**的 gutter 宽度
 * （= 滚动条占位宽度）。`.messages` 带 `scrollbar-gutter: stable both-edges`，
 * 内容盒左右各被扣掉一条 gutter，所以它的 `padding-inline` 要减掉这个值，才能
 * 与容器外（没有滚动条、没有 gutter）的输入框列严丝合缝——见 styles.css 顶部
 * 「中央列几何」。gutter 宽度无法用 CSS 读取，只能 JS 实测。
 *
 * 取值分两级：
 * 1. **首帧前**（main.tsx 在 createRoot().render 之前调用）：用与 `.messages`
 *    滚动条设置完全一致的探针测一个初值，避免初始布局用占位值闪一下。
 *    探针必须写 `overflow-y: auto` + `scrollbar-gutter: stable both-edges`：
 *    用 `overflow-y: scroll` 量到的是叠加层滚动条（Windows 实测 0px），而
 *    `.messages` 的 stable 是「占位型」滚动条（同平台 10px）——量错就是历史上
 *    「消息列恒比输入框窄 20px」的根因。
 * 2. **`.messages` 一出现就改用真实元素实测**（探针只是代理：个别浏览器/设备
 *    上「探针预留、真实滚动容器不预留」或反之，会让消息列多缩/少缩一条 gutter，
 *    极端情况下 padding 被相减成 0 ⇒ 内容贴边）。窗口尺寸变化时再校一次
 *    （滚动条宽度可能随页面缩放、系统「自动隐藏滚动条」设置变化）。
 * gutter 由 `stable` 保证与内容、滚动位置无关，所以只在这几个时机量。
 */
export function installScrollbarGutterVar(): void {
	if (typeof document === "undefined") return;
	setGutter(probeGutter());
	watchRealMessages();
}

/** 写入 CSS 变量（非法值忽略，保持上一次的值）。 */
function setGutter(px: number): void {
	if (!Number.isFinite(px) || px < 0) return;
	document.documentElement.style.setProperty("--msgs-gutter", `${Math.round(px * 100) / 100}px`);
}

/** 探针初值：与 `.messages` 的滚动条设置逐项一致，both-edges → 左右各一条。 */
function probeGutter(): number {
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:fixed;top:-9999px;left:0;width:100px;height:100px;overflow-y:auto;scrollbar-gutter:stable both-edges;visibility:hidden;pointer-events:none;";
	document.body.appendChild(probe);
	// offset-client 是两侧 gutter 之和（叠加层滚动条平台为 0，同样正确）
	const gutter = (probe.offsetWidth - probe.clientWidth) / 2;
	probe.remove();
	return gutter;
}

/**
 * 真实元素的每侧 gutter：塞一个 0×0 探针当子元素，量它比「内容盒左缘」还往里
 * 偏了多少。比 `offsetWidth - clientWidth` 更直接——不依赖各浏览器对
 * both-edges 下 clientWidth 的定义。
 */
function realGutter(el: HTMLElement): number {
	const marker = document.createElement("div");
	marker.style.cssText = "width:0;height:0;pointer-events:none;";
	el.appendChild(marker);
	const cs = getComputedStyle(el);
	const elBox = el.getBoundingClientRect();
	const markerBox = marker.getBoundingClientRect();
	const border = Number.parseFloat(cs.borderLeftWidth) || 0;
	const padding = Number.parseFloat(cs.paddingLeft) || 0;
	const gutter = toUiZoomPixels(markerBox.left - elBox.left) - border - padding;
	marker.remove();
	return gutter;
}

/** `.messages` 首次挂载后实测一次，另外每次窗口尺寸变化再校一次。 */
function watchRealMessages(): void {
	const refresh = (): boolean => {
		const el = document.querySelector<HTMLElement>(".messages");
		if (!el) return false;
		setGutter(realGutter(el));
		return true;
	};
	// 窗口尺寸变化（含手机横竖屏）后重校：滚动条宽度可能随页面缩放/
	// 系统「自动隐藏滚动条」设置改变，避免拿旧值一直算错。
	let raf = 0;
	window.addEventListener("resize", () => {
		if (raf) return;
		raf = window.requestAnimationFrame(() => {
			raf = 0;
			refresh();
		});
	});
	if (refresh()) return;
	// 会话快照到达后才挂载（切对话时 key 变化也会重建）→ 等它出现。
	// 探针插入/移除会再次触发回调，所以量到一次就 disconnect（否则自触发循环）。
	const observer = new MutationObserver(() => {
		if (refresh()) observer.disconnect();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	window.setTimeout(() => observer.disconnect(), 60_000);
}
