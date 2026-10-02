/**
 * patch-tool.ts — 导出给 AI Agent 的结构化补丁工具（Hashline Patch Tool）。
 *
 * 核心设计：
 * - 解决标准 edit 工具容易因缩进幻觉、空白字符或行号漂移导致编辑失败的问题。
 * - 补丁语言基于 [path#TAG] 内容哈希锚点，支持精确行替换（PUT N.=M:）、
 *   语法块级替换（PUT N*:，自动匹配闭合括号/缩进）、行前/后插入（PUT <N: / PUT >N:）、
 *   剪切与寄存器粘贴（CUT / PUT @reg）、文件删除（REM）与重命名（MV）。
 * - 当文件被外部改动导致哈希不一致时，自动尝试 3-Way Merge 冲突自愈。
 */

import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	applyHashlinePatch,
	formatHashlineHeader,
	globalSnapshotStore,
	type PatchApplyReport,
} from "./hashline-engine.js";
import { getLiveLspDiagnostics } from "./lsp-tool.js";

export const PATCH_TOOL_NAME = "patch";

export interface PatchToolOptions {
	cwd: string;
	ownerId?: string;
}

export function makePatchTool(options: PatchToolOptions) {
	const cwd = options.cwd;

	return defineTool({
		name: PATCH_TOOL_NAME,
		promptSnippet:
			"apply content-hashed, line-anchored patches to workspace files (prevents stale edits, line drift, and indentation hallucination)",
		label: "Apply Hashline patch",
		description: `Apply content-hashed, line-anchored patches to workspace files — prevents stale edits, line drift, and indentation hallucination.
Each file section starts with \`[path#TAG]\` (or \`[path]\` if the hash is unknown yet). Operations:
- \`PUT N.=M:\` replace lines N..M (inclusive) with the following \`+TEXT\` lines.
- \`PUT N*:\` replace the whole syntactic block starting at line N (closing brace/indent auto-resolved).
- \`PUT <N:\` insert before line N (\`<1\` = head of file); \`PUT >N:\` insert after (\`>$\` = end).
- \`CUT N.=M [@name]\` / \`CUT N* [@name]\` delete lines and save to register; \`PUT <N @name\` / \`PUT >N @name\` paste it.
- \`REM\` delete file; \`MV dest/path\` move/rename file.
- Body rows under \`:\` headers MUST start with \`+\` (\`+\` alone = blank line).
On divergence the engine attempts a 3-way merge. After success the tool returns the next anchor tag and live LSP diagnostics.`,
		parameters: Type.Object({
			patch: Type.String({
				description:
					"The complete Hashline patch text containing one or more [path#TAG] sections with PUT/CUT/REM/MV operations.",
			}),
			timeout: Type.Optional(
				Type.Number({
					description: "Optional execution timeout in seconds.",
				}),
			),
		}),
		async execute(_callId, params: { patch: string; timeout?: number }, _signal, _onUpdate, _ctx) {
			const patchText = typeof params?.patch === "string" ? params.patch : "";
			if (!patchText.trim()) {
				const emptyReport: PatchApplyReport = {
					ok: false,
					summary: "Empty patch text provided.",
					results: [],
					error: "Empty patch",
				};
				return {
					content: [{ type: "text", text: "Error: No patch content provided." }],
					details: emptyReport,
				};
			}

			const report = applyHashlinePatch(patchText, {
				cwd,
				snapshotStore: globalSnapshotStore,
			});

			if (!report.ok) {
				return {
					content: [{ type: "text", text: `Patch Failed:\n${report.summary}` }],
					details: report,
				};
			}

			const textOutput = [report.summary];
			// 为成功修改的文件输出最新的头部标签，方便 Agent 连续进行下一步修改
			for (const r of report.results) {
				if (r.op !== "deleted" && r.newHash) {
					const targetPath = r.newPath || r.filePath;
					textOutput.push(`\nNext edit anchor for ${targetPath}: \`${formatHashlineHeader(targetPath, r.newHash)}\``);
					try {
						const fullPath = resolve(cwd, targetPath);
						const diags = await getLiveLspDiagnostics(fullPath, cwd);
						if (diags) {
							textOutput.push(`\nLive LSP diagnostics for ${targetPath}:\n${diags}`);
						}
					} catch {}
				}
			}

			return {
				content: [{ type: "text", text: textOutput.join("\n") }],
				details: report,
			};
		},
	});
}
