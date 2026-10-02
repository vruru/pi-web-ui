/**
 * 工具提示词卫生守卫 — 所有发给模型的工具定义提示词必须为精简纯英文。
 *
 * 背景：工具定义的 description / promptSnippet / promptGuidelines 直接进入模型
 * 上下文。历史上曾用 bilingual(en, zh) 双语内联（issue #91），后统一为纯英文精简
 * （zh 文案仅在 per-call 返回文本与 UI 层保留）。本测试防回潮：
 *  1. server/*.ts 工具定义文件不得再调用 bilingual()（白名单外的残留即失败）；
 *  2. server/*.ts 的 description/promptSnippet/promptGuidelines 值不得含中文；
 *  3. 主 description 长度上限（patch-tool 这类操作语法参考单独豁免）；
 *  4. 插件 *.mjs 的 description/promptSnippet 行不得含中文（label/execute 返回
 *     文本/注释是 UI 与对话内容，允许中文，不在检查范围）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 仍允许使用 bilingual() 的文件（面向用户的 relay 文案，非工具定义）。 */
const BILINGUAL_ALLOW = new Set(["i18n.ts", "dsh-client.ts", "dsh-agent-service.ts"]);

/** CJK 检查豁免（非模型提示词）：斜杠命令 UI、用户可编辑模板数据、宿主 API 目录、
 *  tool-manager 的工具预设说明（设置面板 UI）。 */
const CJK_ALLOW = new Set(["slash-commands.ts", "subagent-templates.ts", "plugin-api-catalog.ts", "tool-manager.ts"]);

/** 主 description 长度上限（字符）；操作语法参考类工具单独豁免。 */
const MAIN_DESC_CAP = 700;
const MAIN_DESC_EXEMPT = new Set(["patch-tool.ts"]);

const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;

function serverFiles(): string[] {
	return readdirSync(join(ROOT, "server"))
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
		.map((f) => join(ROOT, "server", f));
}

/** 解析一个「字符串表达式」（字面量按 + 拼接；返回 null 表示不是纯字符串）。 */
function readStr(src: string, i: number): { text: string; end: number } | null {
	const q = src[i];
	if (q !== '"' && q !== "'" && q !== "`") return null;
	let j = i + 1;
	let out = "";
	while (j < src.length && src[j] !== q) {
		if (src[j] === "\\") {
			const n = src[j + 1];
			out += n === "n" ? "\n" : n === "t" ? "\t" : n;
			j += 2;
		} else out += src[j++];
	}
	if (src[j] !== q) return null;
	return { text: out, end: j + 1 };
}

function readConcat(src: string, i: number): { text: string; end: number } | null {
	let out = "";
	let j = i;
	let expectOperand = true;
	for (;;) {
		while (/\s/.test(src[j] ?? "")) j++;
		const c = src[j];
		if (c === "+") {
			j++;
			expectOperand = true;
			continue;
		}
		if (c === ")" || c === "," || c === ";" || c == null) break;
		if (!expectOperand) break;
		const s = readStr(src, j);
		if (!s) return null;
		out += s.text;
		j = s.end;
		expectOperand = false;
	}
	return { text: out, end: j };
}

describe("tool prompt hygiene（工具提示词纯英文精简）", () => {
	it("server 工具定义文件不再调用 bilingual()", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (BILINGUAL_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			const calls = src.match(/\bbilingual\s*\(/g);
			if (calls) offenders.push(`${file}: ${calls.length} 处`);
		}
		expect(offenders, `以下文件仍有 bilingual() 调用：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server description/promptSnippet/promptGuidelines 值不含中文", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (CJK_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			for (const key of ["description", "promptSnippet", "promptGuidelines"]) {
				let idx = 0;
				while ((idx = src.indexOf(key + ":", idx)) !== -1) {
					const line = src.slice(0, idx).split("\n").length;
					idx += key.length + 1;
					let j = idx;
					while (/\s/.test(src[j])) j++;
					const r = readConcat(src, j);
					if (!r) continue; // 标识符/复杂表达式跳过（常量描述由审查保证）
					idx = r.end;
					if (CJK.test(r.text)) offenders.push(`${file}:${line} ${key} 含中文: ${r.text.slice(0, 60)}`);
				}
			}
		}
		expect(offenders, `以下工具提示词含中文：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server 主 description 不超过长度上限", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (MAIN_DESC_EXEMPT.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			let idx = 0;
			while ((idx = src.indexOf("description:", idx)) !== -1) {
				const line = src.slice(0, idx).split("\n").length;
				idx += "description:".length;
				let j = idx;
				while (/\s/.test(src[j])) j++;
				const r = readConcat(src, j);
				if (!r) continue;
				// 只看「工具定义的主描述」：同名对象里通常紧跟 name/label。这里放宽为
				// 所有 description 值（参数描述远短于上限，不会误伤）。
				if (r.text.length > MAIN_DESC_CAP) offenders.push(`${file}:${line} ${r.text.length}c`);
			}
		}
		expect(offenders, `以下 description 超过 ${MAIN_DESC_CAP}c：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("插件 *.mjs 的 description/promptSnippet 行不含中文", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) {
					if (f !== "node_modules") walk(p);
					continue;
				}
				if (!f.endsWith(".mjs")) continue;
				const lines = readFileSync(p, "utf8").split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!/^\s*(description|promptSnippet|promptGuidelines)\s*[:=]/.test(lines[i])) continue;
					// registerCommand 的 description/descriptionEn 是 UI 文案，跳过
					const ahead = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
					if (ahead.includes("registerCommand") || ahead.includes("descriptionEn")) continue;
					// 单行含中文即报（跨行描述的续行由同组审查保证）；变量插值/动态拼接跳过
					const m = lines[i].match(/(["'`])((?:\\.|(?!\1).)*)\1/);
					if (m && CJK.test(m[2])) offenders.push(`${p}:${i + 1} ${m[2].slice(0, 60)}`);
				}
			}
		};
		walk(join(ROOT, "plugins"));
		expect(offenders, `以下插件提示词行含中文：\n${offenders.join("\n")}`).toEqual([]);
	});
});
