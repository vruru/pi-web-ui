import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownBody } from "../../web/src/components/Markdown.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * Markdown.rawHtml 的「HTML 渲染」专项冒烟测试。
 *
 * 提问对话框（DshQuestionDialog / Dialog）把 question/detail/description/preview
 * 交给 <Markdown rawHtml>，模型可自选 markdown **或 HTML**。这里用
 * react-dom/server.renderToStaticMarkup 在 node 环境渲染，零 token / 零浏览器，
 * 确定性验证 html 分支真实渲染成 DOM 结构（表格/列表/引用/代码块/链接/标题/
 * 任务清单/内嵌原生 HTML），而不是被转义成字面文本。
 *
 * == 关键约定 ==
 *  - rawHtml=false（默认，聊天正文路径）：HTML 被转义，绝不生成对应标签。
 *  - rawHtml=true（提问对话框路径）：HTML 与 markdown 混排、真实渲染。
 *
 * 代码块渲染会走 CopyButton（useT → LanguageProvider），故统一包一层。
 * loadLocale 对 localStorage 有 try/catch，node 环境可安全渲染。
 */
function render(text: string, rawHtml = true): string {
	return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(MarkdownBody, { text, rawHtml })));
}

describe("MarkdownBody rawHtml — HTML 渲染", () => {
	// -- rawHtml=false 的防御性验证（聊天正文不受影响） -----------------------
	it("rawHtml=false：任何内嵌 HTML 都被转义，不生成标签", () => {
		const cases = [
			"<b>b</b>",
			"<table><tr><td>1</td></tr></table>",
			"<a href='https://x'>x</a>",
			"<script>alert(1)</script>",
			"<img src=x onerror=alert(1)>",
		];
		for (const input of cases) {
			const html = render(input, false);
			// 转义后标签名不会作为真实元素出现（应变成 &lt;b&gt; 这类文本）。
			expect(html).not.toMatch(/<b>|<table>|<a |<script|<img/);
		}
	});

	// -- rawHtml=true：真实渲染 HTML 结构 ------------------------------------
	it("rawHtml=true：内嵌原生 HTML 渲染成真实元素", () => {
		const html = render('<b>bold</b> <em>em</em> <span style="color:red">red</span>');
		expect(html).toContain("<b>bold</b>");
		expect(html).toContain("<em>em</em>");
		// sanitize（GitHub 式白名单）剥掉 style 属性，但 span 元素与文本保留。
		expect(html).toContain("<span>red</span>");
	});

	it("rawHtml=true：HTML 表格渲染", () => {
		const html = render("<table><thead><tr><th>k</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>");
		expect(html).toContain("<table");
		expect(html).toContain("<th>k</th>");
		expect(html).toContain("<td>v</td>");
	});

	it("rawHtml=true：HTML 引用块（blockquote）渲染", () => {
		const html = render("<blockquote>quote</blockquote>");
		expect(html).toContain("<blockquote");
		expect(html).toContain("quote");
	});

	it("rawHtml=true：markdown 表格渲染（GFM，remark-gfm）", () => {
		const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<table");
		expect(html).toContain("<td>1</td>");
		expect(html).toContain("<td>2</td>");
	});

	it("rawHtml=true：有序/无序列表渲染", () => {
		const ul = render("- a\n- b");
		expect(ul).toContain("<ul>");
		expect(ul.match(/<\/li>/g)?.length).toBe(2);
		const ol = render("1. x\n2. y");
		expect(ol).toContain("<ol>");
		expect(ol.match(/<\/li>/g)?.length).toBe(2);
	});

	it("rawHtml=true：任务清单（GFM checkbox）渲染", () => {
		const html = render("- [x] done\n- [ ] todo");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("checked");
		// GFM 任务清单给 <li> 加 task-list-item 类，故按闭合标签计数。
		expect(html.match(/<\/li>/g)?.length).toBe(2);
	});

	it("rawHtml=true：标题渲染", () => {
		const html = render("# Big\n\n## Small");
		expect(html).toContain("<h1");
		expect(html).toContain("<h2");
	});

	it("rawHtml=true：行内代码与代码块高亮", () => {
		const inline = render("use `code`");
		expect(inline).toContain("<code>code</code>");

		const block = render("```js\nconst x = 1;\n```");
		// PreWithCopy 包装成 .codeblock + <pre>，rehype-highlight 加 hljs 类。
		expect(block).toContain("<pre");
		expect(block).toContain("hljs");
		expect(block).toContain("<code");
	});

	it("rawHtml=true：链接渲染", () => {
		const html = render("[pi](https://example.com)");
		expect(html).toContain('<a href="https://example.com"');
		expect(html).toContain("pi");
	});

	it("rawHtml=true：markdown 与 HTML 混排（模型自选语法）", () => {
		const html = render("**strong** and **<b>html-b</b>** and <em>html-em</em>");
		expect(html).toContain("<strong>strong</strong>");
		expect(html).toContain("<b>html-b</b>");
		expect(html).toContain("<em>html-em</em>");
	});
});

/**
 * sanitize 专项（rehype-sanitize 默认 schema = GitHub 式白名单）：rawHtml 的信任
 * 模型再宽也是"模型输出"，危险节点必须被剥 —— 脚本/事件属性/白名单外元素/
 * javascript: 协议一个都不能活；常用标签与 markdown 管线（KaTeX/高亮/任务清单）
 * 的产物原样保留。
 */
describe("MarkdownBody rawHtml — sanitize 白名单", () => {
	it("<script> 连内容一起被剥掉，其余文本照常", () => {
		const html = render("hello <script>alert(1)</script> world");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("alert(1)");
		expect(html).toContain("hello");
		expect(html).toContain("world");
	});

	it("事件属性（onerror 等）被剥掉，img 元素本身保留", () => {
		const html = render('<img src="https://example.com/x.png" onerror="alert(1)">');
		expect(html).not.toContain("onerror");
		expect(html).toContain("<img");
		expect(html).toContain("x.png");
	});

	it("白名单外的元素（iframe）被剥掉", () => {
		const html = render('<iframe src="https://evil.example"></iframe><p>stay</p>');
		expect(html).not.toContain("<iframe");
		expect(html).toContain("stay");
	});

	it("javascript: 链接协议被剥掉（href 移除，文本保留）", () => {
		const html = render("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
		expect(html).toContain("click");
	});

	it("raw HTML 的 target 属性被剥掉，MdLink 的安全默认（_blank + noreferrer noopener）兜底", () => {
		const html = render('<a href="https://example.com" target="_self">x</a>');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer noopener"');
		expect(html).not.toContain("_self");
	});

	it("数学公式（KaTeX 路径）不被 sanitize 破坏", () => {
		const html = render("$E=mc^2$");
		expect(html).toContain("katex");
	});

	it("常用标签（b/strong/code/pre）与代码高亮保留", () => {
		const html = render("<b>b</b> `code`");
		expect(html).toContain("<b>b</b>");
		expect(html).toContain("<code>code</code>");
	});
});
