/**
 * 消息区底缘渐隐（未钉底时的半行淡出）。
 *
 * 病根：向上翻阅时 `.messages` 的滚动视口底缘正好落在目标药丸行 / chips 行 /
 * 输入区的上沿，下一条消息被拦腰切断 —— 看着像被下面那条不透明带子「遮挡」，
 * 其实那就是滚动容器的裁剪边（实测：钉底时最后一条消息底边 690、药丸行顶边 701，
 * 两者并不重叠）。
 *
 * 口径（回归点）：
 *   1. 渐变层画在 `.messages-wrap::after`，**不给 `.messages` 加 mask** ——
 *      mask 会让滚动容器成为内部 position:fixed 后代的包含块（消息里的下拉菜单、
 *      图片灯箱会跟着内容滚走）；项目已在 `.messages-wrap` 的 container-type 上
 *      踩过同一类包含块的坑。
 *   2. 默认 opacity:0，只在 `:has(> .messages.anchor-live)`（MessageList 标记的
 *      「未钉底 / 逃逸阅读」）时点亮：钉底时最后一条消息完整可见，糊它反而像 bug。
 *   3. pointer-events:none —— 渐变层不能吃掉消息区的点击/滚动。
 *   4. z-index:0 —— 必须压在「回到底部」按钮（z-index 1）与提问导航条（15）之下。
 *
 * 本测试只读 web/src/styles.css：毫秒级、零端口、零浏览器（CI 必跑）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不用 process.cwd()，同 text-wrap.test.ts 的理由）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

function bodyOf(selector: string): string {
	const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
	const hit = re.exec(CSS)?.[1];
	expect(hit, `styles.css 里没有规则：${selector}`).toBeDefined();
	return hit!;
}

describe("消息区底缘渐隐", () => {
	it("渐变层挂在 .messages-wrap::after 上（不是滚动容器本身）", () => {
		const body = bodyOf(".messages-wrap::after");
		expect(/position:\s*absolute/.test(body)).toBe(true);
		expect(/bottom:\s*0/.test(body)).toBe(true);
		expect(/height:\s*\d+px/.test(body), "渐变要有确定高度（不是整条糊掉）").toBe(true);
		expect(/background:\s*linear-gradient\(/.test(body)).toBe(true);
		// 不许吃掉交互
		expect(/pointer-events:\s*none/.test(body)).toBe(true);
		// 压在「回到底部」（1）与提问导航条（15）之下
		expect(/z-index:\s*0\b/.test(body)).toBe(true);
	});

	it("默认关闭，只在未钉底（.messages.anchor-live）时点亮", () => {
		const base = bodyOf(".messages-wrap::after");
		expect(/opacity:\s*0\s*;/.test(base), "默认必须透明（钉底时不糊最后一条消息）").toBe(true);
		const on = bodyOf(".messages-wrap:has(> .messages.anchor-live)::after");
		expect(/opacity:\s*1\s*;/.test(on)).toBe(true);
	});

	it("不给 .messages 加 mask/filter（那会让内部 fixed 后代改包含块）", () => {
		const body = bodyOf(".messages");
		expect(/mask(-image)?\s*:/.test(body), "滚动容器上出现 mask 会打歪 fixed 下拉/灯箱").toBe(false);
		expect(/filter\s*:/.test(body), "滚动容器上出现 filter 同样会改包含块").toBe(false);
	});
});
