/**
 * 插件 SVG 图标渲染（manifest.json `iconSvg` / catalog `iconSvg`）。
 *
 * 服务端只做形状校验（见 server/icon-svg.ts），真正的 XSS 过滤在这里：
 * `sanitizeIconSvg` 白名单标签 + 属性，渲染经 `dangerouslySetInnerHTML`。
 * 有合法 iconSvg 就画 SVG，否则回落 emoji/字符（`icon`）。
 */
import type { JSX } from "react";

/** 允许保留的 SVG 标签，**按 SVG/XML 的原始大小写书写**（`clipPath` / `linearGradient` …）。
 *  写错大小写不会报错，但 DOMParser 解析出的 tagName 保留原文，比较时匹配不上。 */
const ALLOWED_TAGS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"rect",
	"line",
	"polyline",
	"polygon",
	"ellipse",
	"use",
	"defs",
	"clipPath",
	"linearGradient",
	"radialGradient",
	"stop",
]);

/** 允许保留的 SVG 属性，同样按原始大小写书写（`viewBox` / `gradientUnits` / `gradientTransform`）。
 *  属性值里的 `javascript:` / `data:` / `vbscript:` 另有拦截（见下）。
 *  ⚠ 漏一个属性 = 图标静默缺一块：`points`（polyline/polygon）漏了就是**整个图标不可见**
 *  （run-trace 的 FiActivity 踩过），`ry` 漏了椭圆/圆角矩形不渲染。加新图标后跑
 *  tests/unit/plugin-icon-dom.test.ts 的“白名单必须覆盖内置图标用到的标签/属性”那条。 */
const ALLOWED_ATTRS = new Set([
	"viewBox",
	"xmlns",
	"d",
	"fill",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"opacity",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"width",
	"height",
	"points",
	"offset",
	"stop-color",
	"stop-opacity",
	"fill-opacity",
	"stroke-opacity",
	"stroke-miterlimit",
	"fill-rule",
	"clip-rule",
	"vector-effect",
	"preserveAspectRatio",
	"transform",
	"clip-path",
	"id",
	"href",
	"xlink:href",
	"xmlns:xlink",
	"gradientUnits",
	"gradientTransform",
]);

/** 整棵删除（连同内容）的元标签：它们的子节点是代码 / 文本 / 外来命名空间，
 *  展平（子节点上移）等于把内容漏进 SVG。键一律小写（与 tagName.toLowerCase() 同口径）。 */
const DROPPED_TAGS = new Set(["script", "style", "title", "desc", "foreignobject"]);

/** 白名单比较**一律大小写不敏感**：DOMParser 解析 XML 时属性 / 标签名保留原文
 *  （是 `viewBox`，不是 `viewbox`），拿小写化的名字去比带大写的键会**永不匹配**。
 *  历史上就是这么把 `viewBox` 整条剥掉的：没有 viewBox 的 SVG 不再做坐标系映射，
 *  路径按 1 用户单位 = 1 CSS px 直接画进 1em 的容器里 —— 24×24 的图标只剩左上角一块、
 *  右下被裁（“图标超出边框只看见一半”），而且**改字号只能换一个被裁的视口**，
 *  怎么调都对不上。`clipPath` / `linearGradient` / `radialGradient` / `gradientUnits`
 *  同理（当作未知标签展平后图形走形）。 */
const ALLOWED_TAGS_LC = new Set([...ALLOWED_TAGS].map((tag) => tag.toLowerCase()));
const ALLOWED_ATTRS_LC = new Set([...ALLOWED_ATTRS].map((name) => name.toLowerCase()));

/** 标签是否在图标白名单里（大小写不敏感）。导出供单测直接锁白名单口径。 */
export function isAllowedIconTag(tag: string): boolean {
	return ALLOWED_TAGS_LC.has(tag.toLowerCase());
}

/** 属性是否在图标白名单里（大小写不敏感）。导出供单测直接锁白名单口径。 */
export function isAllowedIconAttr(name: string): boolean {
	return ALLOWED_ATTRS_LC.has(name.toLowerCase());
}

/**
 * 消毒内联 SVG：非白名单标签整个丢掉（含其内容，如果是 script/style/title/desc
 * /foreignObject 这类元标签；图形标签只丢标签本身、保留安全的子节点）；非白名单属性 / 事件
 * 处理器 / javascript: 一律剥掉。返回可注入的 SVG 字符串，非法返回 null。
 * 纯函数（有单测；白名单口径见导出的 isAllowedIconTag / isAllowedIconAttr）。
 */
export function sanitizeIconSvg(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s || s.length > 8192) return null;
	if (!/^<svg[\s>]/.test(s.startsWith("<?xml") ? s.slice(s.indexOf("?>") + 2).trimStart() : s)) return null;
	// DOMParser 只在浏览器里有；SSR/单测（node）下退化为正则快检。
	if (typeof DOMParser === "undefined") {
		if (/<script[\s>]/i.test(s) || /\son\w+\s*=/i.test(s) || /javascript\s*:/i.test(s)) return null;
		return s;
	}
	const doc = new DOMParser().parseFromString(s, "image/svg+xml");
	if (doc.querySelector("parsererror")) return null;
	const root = doc.documentElement;
	if (root.tagName.toLowerCase() !== "svg") return null;
	const clean = (el: Element): void => {
		// Snapshot live DOM collections before removing or replacing their members.
		const children = [...el.children];
		for (const child of children) {
			const tag = child.tagName.toLowerCase();
			if (!isAllowedIconTag(tag)) {
				// 元标签整棵丢；未知图形标签展平（子节点上移，保留合法内容）。
				if (DROPPED_TAGS.has(tag)) {
					child.remove();
				} else {
					clean(child);
					child.replaceWith(...child.childNodes);
				}
				continue;
			}
			const attributes = [...child.attributes];
			for (const attr of attributes) {
				const name = attr.name.toLowerCase();
				if (!isAllowedIconAttr(name) || /^on/i.test(name) || /^(javascript|data|vbscript):/i.test(attr.value.trim())) {
					child.removeAttribute(attr.name);
				}
			}
			clean(child);
		}
	};
	const rootAttributes = [...root.attributes];
	for (const attr of rootAttributes) {
		const name = attr.name.toLowerCase();
		if (!isAllowedIconAttr(name) || /^on/i.test(name)) root.removeAttribute(attr.name);
	}
	clean(root);
	return new XMLSerializer().serializeToString(root);
}

/** 插件徽标：有合法 iconSvg 就画 SVG，否则把 `icon` 原样当文本画
 *  （与原来 `{entry.icon ? <span>{entry.icon}</span> : null}` 完全一致）。
 *  调用方若不想把宿主图标词表名（如 "mic"）当文字画出来，自行按
 *  isGlyphIcon 过滤后再传 icon（见 SlotTabs）。 */
export function PluginIcon({
	icon,
	iconSvg,
	className,
}: {
	icon?: string;
	iconSvg?: string;
	className?: string;
}): JSX.Element | null {
	const safe = sanitizeIconSvg(iconSvg);
	if (safe) {
		return <span className={className ?? "plugin-icon-svg"} aria-hidden dangerouslySetInnerHTML={{ __html: safe }} />;
	}
	if (icon) {
		return (
			<span className={className ? `${className} plugin-icon-glyph` : "plugin-icon-glyph"} aria-hidden>
				{icon}
			</span>
		);
	}
	return null;
}
