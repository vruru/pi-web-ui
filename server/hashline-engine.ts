/**
 * hashline-engine.ts — 基于内容哈希锚定与语法块解析的高可靠 Patch 引擎。
 *
 * 核心设计（借鉴 @oh-my-pi/hashline）：
 * 1. [path#TAG] 内容哈希锚点：每个 hunk 绑定文件内容的 4-hex 校验和，杜绝模型基于陈旧行号盲改。
 * 2. PUT N*= 语法块级替换：通过括号嵌套（Brace matching）与缩进（Indentation）自动识别代码块闭合，
 *    模型无需数行号，消除最常见的行号漂移问题。
 * 3. 3-Way Merge 冲突自愈：若磁盘文件已被修改导致哈希不匹配，通过快照与 diff 进行三方合并，
 *    无重叠冲突时平滑合入，冲突时提供带行号的准确定位提示。
 * 4. 寄存器支持（CUT / PUT @reg）：支持在跨文件或同文件内部移动代码段。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const HL_HASH_LENGTH = 4;

/** 归一化文本换行符与尾随空白（确保哈希跨平台一致） */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 计算文件的 4 位十六进制内容哈希（大写） */
export function computeFileHash(text: string): string {
	const normalized = normalizeLineEndings(text).replace(/[ \t]+(?=\n|$)/g, "");
	const hash = createHash("sha256").update(normalized, "utf8").digest("hex");
	return hash.slice(0, HL_HASH_LENGTH).toUpperCase();
}

/** 为文件生成带哈希的段头：[src/app.ts#A1B2] */
export function formatHashlineHeader(filePath: string, hash: string): string {
	return `[${filePath}#${hash}]`;
}

/** 为文本输出带行号的展示视图：1:line1\n2:line2 */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = normalizeLineEndings(text).split("\n");
	return lines.map((l, i) => `${startLine + i}:${l}`).join("\n");
}

// ----------------------------------------------------------------------------
// 语法块解析（Block Resolver）
// ----------------------------------------------------------------------------

/**
 * 启发式语法块边界解析：从 startLine（1-indexed）开始，定位该语句块的闭合行。
 * 支持：
 * 1. 括号/大括号嵌套语言（JS/TS/Rust/Go/C/C++/Java/PHP）：匹配同深度闭合 '}'。
 * 2. 缩进敏感语言（Python/YAML/Makefile）：匹配缩进回退的边界。
 * 3. Markdown 标题：匹配同级或更高级标题的边界。
 */
export function resolveBlockSpan(
	lines: readonly string[],
	startLine: number,
	filePath = "",
): { start: number; end: number } {
	const n = lines.length;
	const sIdx = Math.max(0, Math.min(n - 1, startLine - 1));
	const startContent = lines[sIdx] ?? "";
	const trimmedStart = startContent.trim();

	// 1. Markdown 标题：## Title -> 下一个同级或更高级标题
	const isMd = /\.(md|markdown|mdx)$/i.test(filePath);
	const mdHeaderMatch = trimmedStart.match(/^(#{1,6})\s+/);
	if (isMd && mdHeaderMatch) {
		const level = mdHeaderMatch[1].length;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i].trim();
			const m = line.match(/^(#{1,6})\s+/);
			if (m && m[1].length <= level) break;
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	// 2. 缩进语言判定（Python、YAML、Make）
	const isIndentLang = /\.(py|yaml|yml|makefile|dockerfile)$/i.test(filePath) || !startContent.includes("{");
	if (isIndentLang && (trimmedStart.endsWith(":") || !trimmedStart.includes("{"))) {
		const baseIndent = startContent.match(/^[ \t]*/)?.[0].length ?? 0;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i];
			if (line.trim().length === 0) {
				// 空行不打断块，只要后面还有更深缩进
				continue;
			}
			const curIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
			if (curIndent <= baseIndent) {
				break;
			}
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	// 3. 大括号 / 括号计数解析（JS/TS/Rust/Go/C/C++ 等）
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let seenOpen = false;
	let endIdx = sIdx;

	for (let i = sIdx; i < n; i++) {
		const line = lines[i];
		let inString: string | null = null;
		let escaped = false;

		for (let j = 0; j < line.length; j++) {
			const char = line[j];
			const next = line[j + 1];

			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (inString) {
				if (char === inString) inString = null;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				inString = char;
				continue;
			}
			// 单行注释
			if (char === "/" && next === "/") break;

			if (char === "{") {
				braceDepth++;
				seenOpen = true;
			} else if (char === "}") {
				braceDepth--;
			} else if (char === "(") {
				parenDepth++;
			} else if (char === ")") {
				parenDepth--;
			} else if (char === "[") {
				bracketDepth++;
			} else if (char === "]") {
				bracketDepth--;
			}
		}

		endIdx = i;
		if (seenOpen && braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0) {
			break;
		}
	}

	return { start: sIdx + 1, end: endIdx + 1 };
}

// ----------------------------------------------------------------------------
// 补丁语法抽象语法树与解析器
// ----------------------------------------------------------------------------

export type HunkOpKind =
	| "put_range" // PUT 10.=25:
	| "put_block" // PUT 10*:
	| "insert_before" // PUT <10:
	| "insert_after" // PUT >10:
	| "insert_after_block" // PUT >10*:
	| "cut_range" // CUT 10.=25 [@reg]
	| "cut_block" // CUT 10* [@reg]
	| "paste_at" // PUT <10 @reg 或 PUT >10 @reg
	| "paste_over_range" // PUT 10.=25 @reg
	| "paste_over_block" // PUT 10* @reg
	| "remove_file" // REM
	| "move_file"; // MV dest/path.ts

export interface Hunk {
	kind: HunkOpKind;
	lineStart?: number;
	lineEnd?: number;
	registerName?: string;
	targetPath?: string;
	bodyLines: string[];
}

export interface PatchSection {
	filePath: string;
	expectedHash?: string;
	hunks: Hunk[];
}

/**
 * 解析 Hashline 补丁文本
 */
export function parseHashlinePatch(patchText: string): PatchSection[] {
	const lines = normalizeLineEndings(patchText).split("\n");
	const sections: PatchSection[] = [];
	let currentSection: PatchSection | null = null;
	let currentHunk: Hunk | null = null;

	const flushHunk = () => {
		if (currentHunk && currentSection) {
			currentSection.hunks.push(currentHunk);
			currentHunk = null;
		}
	};

	const flushSection = () => {
		flushHunk();
		if (currentSection) {
			sections.push(currentSection);
			currentSection = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		// 1. 段落头: [path#TAG] 或 [path]
		const secMatch = rawLine.match(/^\s*\[([^#\]]+)(?:#([0-9a-fA-F]{4}))?\]\s*$/);
		if (secMatch) {
			flushSection();
			currentSection = {
				filePath: secMatch[1].trim(),
				expectedHash: secMatch[2] ? secMatch[2].toUpperCase() : undefined,
				hunks: [],
			};
			continue;
		}

		if (!currentSection) {
			// 未进入段落前的空白或注释跳过
			continue;
		}

		// 2. 文件级指令: REM (删除当前文件)
		if (/^REM\b/i.test(trimmed)) {
			flushHunk();
			currentSection.hunks.push({ kind: "remove_file", bodyLines: [] });
			continue;
		}

		// 3. 文件级指令: MV dest (重命名/移动当前文件)
		const mvMatch = trimmed.match(/^MV\s+([^\s]+)/i);
		if (mvMatch) {
			flushHunk();
			currentSection.hunks.push({ kind: "move_file", targetPath: mvMatch[1], bodyLines: [] });
			continue;
		}

		// 4. CUT 指令: CUT N.=M [@reg] 或 CUT N* [@reg]
		const cutMatch = trimmed.match(/^CUT\s+(\d+)(?:\.=(\d+)|\*)\s*(?:@([a-zA-Z0-9_-]+))?/);
		if (cutMatch) {
			flushHunk();
			const start = parseInt(cutMatch[1], 10);
			const isBlock = trimmed.includes("*");
			const end = cutMatch[2] ? parseInt(cutMatch[2], 10) : start;
			const reg = cutMatch[3];
			currentSection.hunks.push({
				kind: isBlock ? "cut_block" : "cut_range",
				lineStart: start,
				lineEnd: isBlock ? undefined : end,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}

		// 5. 粘贴指令 (无冒号头): PUT <N @reg / PUT >N @reg / PUT N.=M @reg / PUT N* @reg
		const pasteMatch = trimmed.match(/^PUT\s+(<|>)?(\d+)(?:\.=(\d+)|\*)?\s+@([a-zA-Z0-9_-]+)/);
		if (pasteMatch && !trimmed.endsWith(":")) {
			flushHunk();
			const prefix = pasteMatch[1]; // < 或 >
			const num = parseInt(pasteMatch[2], 10);
			const endNum = pasteMatch[3] ? parseInt(pasteMatch[3], 10) : num;
			const isBlock = trimmed.includes("*");
			const reg = pasteMatch[4];
			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = "insert_after";
			} else if (isBlock) {
				kind = "paste_over_block";
			} else {
				kind = "paste_over_range";
			}
			currentSection.hunks.push({
				kind,
				lineStart: num,
				lineEnd: endNum,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}

		// 6. 替换或插入指令头 (带冒号):
		// PUT N.=M: / PUT N*: / PUT <N: / PUT >N: / PUT >N*: / PUT <$: / PUT >$:
		const putHeaderMatch = trimmed.match(/^PUT\s+(<|>)?(\d+|\$)(?:\.=(\d+)|\*)?:$/);
		if (putHeaderMatch) {
			flushHunk();
			const prefix = putHeaderMatch[1];
			const anchorStr = putHeaderMatch[2];
			const start = anchorStr === "$" ? -1 : parseInt(anchorStr, 10);
			const end = putHeaderMatch[3] ? parseInt(putHeaderMatch[3], 10) : start;
			const isBlock = trimmed.includes("*");

			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = isBlock ? "insert_after_block" : "insert_after";
			} else if (isBlock) {
				kind = "put_block";
			} else {
				kind = "put_range";
			}

			currentHunk = {
				kind,
				lineStart: start,
				lineEnd: isBlock ? undefined : end,
				bodyLines: [],
			};
			continue;
		}

		// 7. 内容行 (以 '+' 开头)
		if (rawLine.startsWith("+")) {
			if (currentHunk) {
				currentHunk.bodyLines.push(rawLine.slice(1));
			}
			continue;
		}
	}

	flushSection();
	return sections;
}

// ----------------------------------------------------------------------------
// 快照存储与三方合并恢复（Snapshot Store & 3-Way Merge Recovery）
// ----------------------------------------------------------------------------

export class HashlineSnapshotStore {
	/** 单个文件保留的快照代数上限（LRU）：全局单例会跨整个会话存活，反复编辑
	 *  同一文件会让快照按编辑次数无界增长，必须驱逐最旧一代。 */
	private static readonly MAX_PER_FILE = 200;

	private snapshots = new Map<string, Map<string, string>>(); // path -> (hash -> content)

	record(filePath: string, text: string): string {
		const hash = computeFileHash(text);
		let fileMap = this.snapshots.get(filePath);
		if (!fileMap) {
			fileMap = new Map();
			this.snapshots.set(filePath, fileMap);
		}
		// 先删后插：覆盖同代快照的同时把访问序刷到尾部（Map 插入序即 LRU 序）
		fileMap.delete(hash);
		fileMap.set(hash, text);
		while (fileMap.size > HashlineSnapshotStore.MAX_PER_FILE) {
			const oldest = fileMap.keys().next().value;
			if (oldest === undefined) break;
			fileMap.delete(oldest);
		}
		return hash;
	}

	get(filePath: string, hash: string): string | undefined {
		const fileMap = this.snapshots.get(filePath);
		if (!fileMap) return undefined;
		const key = hash.toUpperCase();
		const hit = fileMap.get(key);
		if (hit !== undefined) {
			// get 命中即 refresh：重插到尾部，正在参与三方合并的快照不被 LRU 驱逐
			fileMap.delete(key);
			fileMap.set(key, hit);
		}
		return hit;
	}
}

/** 全局会话级快照单例 */
export const globalSnapshotStore = new HashlineSnapshotStore();

/**
 * 启发式三方行合并：
 * baseLines: 制作补丁时的原始文件快照
 * currentLines: 磁盘当前的最新文件
 * targetHunks: 针对 baseLines 计算出的目标改动行区间
 *
 * 核心逻辑：若磁盘文件的改动未侵入 targetHunks 所在的锚点行，则将锚点行映射到最新文件的对应行，安全完成合并。
 */
export function tryRecoverEdits(
	baseText: string,
	currentText: string,
	hunks: Hunk[],
	_filePath: string,
): { success: boolean; remappedHunks?: Hunk[]; reason?: string } {
	const baseLines = normalizeLineEndings(baseText).split("\n");
	const curLines = normalizeLineEndings(currentText).split("\n");

	// 若内容完全相同，无需恢复
	if (baseText === currentText) return { success: true, remappedHunks: hunks };

	// 简单行偏移探测：计算首个不一致行与行数差
	let firstDiff = -1;
	for (let i = 0; i < Math.max(baseLines.length, curLines.length); i++) {
		if (baseLines[i] !== curLines[i]) {
			firstDiff = i + 1;
			break;
		}
	}

	if (firstDiff === -1) return { success: true, remappedHunks: hunks };

	// 检查是否有 hunk 的锚点位于差异产生点之前或之后
	const delta = curLines.length - baseLines.length;
	const remapped: Hunk[] = [];

	for (const hunk of hunks) {
		const start = hunk.lineStart ?? 1;
		const end = hunk.lineEnd ?? start;

		if (start < firstDiff && end < firstDiff) {
			// 在差异行之前，行号保持不变
			remapped.push({ ...hunk });
		} else {
			// 差异行之后，尝试应用行号平移 delta
			const shiftedStart = Math.max(1, start + delta);
			const shiftedEnd = Math.max(1, end + delta);

			// 校验平移后的周围文本是否与 base 时的上下文匹配
			const baseSnippet = baseLines.slice(Math.max(0, start - 2), Math.min(baseLines.length, end + 1)).join("\n");
			const curSnippet = curLines
				.slice(Math.max(0, shiftedStart - 2), Math.min(curLines.length, shiftedEnd + 1))
				.join("\n");

			if (baseSnippet.trim() === curSnippet.trim() || delta === 0) {
				remapped.push({
					...hunk,
					lineStart: shiftedStart,
					lineEnd: hunk.lineEnd !== undefined ? shiftedEnd : undefined,
				});
			} else {
				return {
					success: false,
					reason: `目标文件在第 ${firstDiff} 行附近发生外部修改，补丁锚点（第 ${start} 行）产生冲突`,
				};
			}
		}
	}

	return { success: true, remappedHunks: remapped };
}

// ----------------------------------------------------------------------------
// 补丁执行器（Patcher）
// ----------------------------------------------------------------------------

export interface ApplySectionResult {
	filePath: string;
	op: "updated" | "deleted" | "moved";
	oldHash?: string;
	newHash?: string;
	linesChanged: number;
	newPath?: string;
	recovered?: boolean;
}

export interface PatchApplyReport {
	ok: boolean;
	summary: string;
	results: ApplySectionResult[];
	error?: string;
}

/**
 * 应用 Hashline 补丁
 * 支持传入虚拟或物理文件读写器（便于单元测试或沙箱执行）
 */
export function applyHashlinePatch(
	patchText: string,
	options: {
		cwd?: string;
		readFile?: (relPath: string) => string | null;
		writeFile?: (relPath: string, content: string) => void;
		deleteFile?: (relPath: string) => void;
		snapshotStore?: HashlineSnapshotStore;
	} = {},
): PatchApplyReport {
	const cwd = options.cwd ?? process.cwd();
	const store = options.snapshotStore ?? globalSnapshotStore;

	const defaultRead = (p: string) => {
		const full = resolve(cwd, p);
		if (!existsSync(full)) return null;
		return readFileSync(full, "utf8");
	};

	const defaultWrite = (p: string, content: string) => {
		const full = resolve(cwd, p);
		const dir = dirname(full);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(full, content, "utf8");
	};

	const defaultDelete = (p: string) => {
		const full = resolve(cwd, p);
		if (existsSync(full)) {
			unlinkSync(full);
		}
	};

	const read = options.readFile ?? defaultRead;
	const write = options.writeFile ?? defaultWrite;
	const remove = options.deleteFile ?? defaultDelete;

	const sections = parseHashlinePatch(patchText);
	if (sections.length === 0) {
		return { ok: false, summary: "未能从输入中解析出有效的 [path#TAG] 补丁段", results: [] };
	}

	const clipboard = new Map<string, string[]>(); // 命名剪切板寄存器
	const plannedWrites = new Map<string, string>(); // path -> 新内容
	const plannedDeletes = new Set<string>();
	const results: ApplySectionResult[] = [];

	// ===== 阶段 1: 预检所有文件并计算目标内容 =====
	for (const sec of sections) {
		// 越界安全防护
		const rel = relative(cwd, resolve(cwd, sec.filePath));
		if (
			rel === ".." ||
			rel.startsWith(".." + sep) ||
			rel.startsWith("../") ||
			rel.startsWith("..\\") ||
			isAbsolute(rel)
		) {
			return {
				ok: false,
				summary: `路径越界：禁止修改工作区外的文件 ${sec.filePath}`,
				results: [],
				error: `Path traversal denied: ${sec.filePath}`,
			};
		}

		// 同一次 patch 内对同文件的后续段落，优先使用前面段落生成的新内容
		const currentText = plannedWrites.get(sec.filePath) ?? read(sec.filePath);
		if (currentText === null) {
			return {
				ok: false,
				summary: `文件不存在：${sec.filePath}（hashline 仅支持修改已存在的文件，新建文件请使用 write 工具）`,
				results: [],
				error: `File not found: ${sec.filePath}`,
			};
		}

		const isCrlf = currentText.includes("\r\n");
		const eol = isCrlf ? "\r\n" : "\n";

		const liveHash = computeFileHash(currentText);
		let workingText = currentText;
		let isRecovered = false;

		// 哈希校验与三方冲突自愈（快照按绝对路径优先隔离，兼容相对路径回退）
		const absFilePath = resolve(cwd, sec.filePath);
		if (sec.expectedHash && sec.expectedHash !== liveHash) {
			const snapshot = store.get(absFilePath, sec.expectedHash) ?? store.get(sec.filePath, sec.expectedHash);
			if (snapshot) {
				const recovery = tryRecoverEdits(snapshot, currentText, sec.hunks, sec.filePath);
				if (recovery.success && recovery.remappedHunks) {
					sec.hunks = recovery.remappedHunks;
					isRecovered = true;
				} else {
					return {
						ok: false,
						summary: `文件内容已发生变动，且三方合流失败：${sec.filePath}（预期哈希 #${sec.expectedHash}，实际哈希 #${liveHash}；${recovery.reason ?? "冲突"}）\n请重新使用 read 工具查看该文件最新内容后再提交 patch。`,
						results: [],
						error: `Hash mismatch and recovery failed on ${sec.filePath}`,
					};
				}
			} else {
				return {
					ok: false,
					summary: `文件内容与锚点不一致：${sec.filePath}（预期哈希 #${sec.expectedHash}，实际哈希 #${liveHash}）\n请重新使用 read 工具读取该文件以获取最新行号与 #TAG。`,
					results: [],
					error: `Hash mismatch on ${sec.filePath} (#${sec.expectedHash} vs #${liveHash})`,
				};
			}
		}

		const hasTrailingNewline = workingText.endsWith("\n");
		let lines = normalizeLineEndings(workingText).split("\n");
		if (hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		let isDeleted = false;
		let moveDest: string | undefined = undefined;

		// 倒序/顺序处理 hunks。为了保证行号不受前面 hunk 影响，从后往前执行行号替换；
		// 但先提取 CUT 的内容到寄存器
		for (const h of sec.hunks) {
			if (h.kind === "remove_file") {
				isDeleted = true;
				break;
			}
			if (h.kind === "move_file") {
				if (!h.targetPath) continue;
				const destRel = relative(cwd, resolve(cwd, h.targetPath));
				if (
					destRel === ".." ||
					destRel.startsWith(".." + sep) ||
					destRel.startsWith("../") ||
					destRel.startsWith("..\\") ||
					isAbsolute(destRel)
				) {
					return {
						ok: false,
						summary: `路径越界：禁止移动文件到工作区外 ${h.targetPath}`,
						results: [],
						error: `Path traversal denied on move target: ${h.targetPath}`,
					};
				}
				moveDest = h.targetPath;
				continue;
			}

			// 语法块展开
			if (h.kind === "put_block" || h.kind === "cut_block" || h.kind === "paste_over_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.start;
				h.lineEnd = span.end;
			} else if (h.kind === "insert_after_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.end;
				h.kind = "insert_after";
			}

			// 捕获到寄存器
			if (h.kind === "cut_range" || h.kind === "cut_block") {
				const start = Math.max(1, h.lineStart ?? 1);
				const end = Math.min(lines.length, h.lineEnd ?? start);
				const captured = lines.slice(start - 1, end);
				const regKey = h.registerName || "_anon";
				clipboard.set(regKey, captured);
			}
		}

		if (isDeleted) {
			plannedDeletes.add(sec.filePath);
			results.push({
				filePath: sec.filePath,
				op: "deleted",
				oldHash: liveHash,
				linesChanged: lines.length,
			});
			continue;
		}

		// 行号越界校验与重叠校验
		for (const h of sec.hunks) {
			if (h.kind === "remove_file" || h.kind === "move_file") continue;
			if (h.lineStart !== -1 && typeof h.lineStart === "number") {
				if (h.lineStart < 1 || h.lineStart > Math.max(1, lines.length)) {
					return {
						ok: false,
						summary: `行号越界：${sec.filePath} 第 ${h.lineStart} 行（文件总共只有 ${lines.length} 行）。请重新使用 read 工具核验行号。`,
						results: [],
						error: `Line out of bounds: line ${h.lineStart} in ${sec.filePath} (${lines.length} lines total)`,
					};
				}
				if (h.lineEnd !== undefined && h.lineEnd > Math.max(1, lines.length)) {
					return {
						ok: false,
						summary: `行号越界：${sec.filePath} 结束行 ${h.lineEnd} 超过文件总行数（总共 ${lines.length} 行）。`,
						results: [],
						error: `Line out of bounds: end line ${h.lineEnd} in ${sec.filePath} (${lines.length} lines total)`,
					};
				}
			}
		}

		const replacementSpans: Array<{ start: number; end: number }> = [];
		for (const h of sec.hunks) {
			let s: number;
			let e: number;
			if (h.kind === "insert_before" || h.kind === "insert_after") {
				// insert 类 hunk 也纳入重叠校验（锚点单行）：执行时按行号降序 splice，
				// 若锚点行被同补丁的 replace/cut 覆盖删除、或与其它 insert 锚点重合，
				// 插入位置会随前面的改动串位，产出与模型意图不符的内容。保守策略：
				// 锚点行与任何 replace span / 其它 insert 锚点重叠即报错。
				s = h.lineStart === -1 ? lines.length : (h.lineStart ?? 1);
				e = s;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				s = h.lineStart === -1 ? lines.length : (h.lineStart ?? 1);
				e = h.lineEnd ?? s;
			} else {
				continue;
			}
			for (const prev of replacementSpans) {
				if (!(e < prev.start || s > prev.end)) {
					return {
						ok: false,
						summary: `补丁段存在重叠的行范围：${sec.filePath}（行 ${s}-${e} 与行 ${prev.start}-${prev.end} 发生重叠）。请合并为一个连续的修改块。`,
						results: [],
						error: `Overlapping hunks in ${sec.filePath} (${s}-${e} overlaps with ${prev.start}-${prev.end})`,
					};
				}
			}
			replacementSpans.push({ start: s, end: e });
		}

		// 按行号从大到小排序执行，避免前方修改引起后续行号错位
		const sortedHunks = [...sec.hunks]
			.filter((h) => h.kind !== "remove_file" && h.kind !== "move_file")
			.sort((a, b) => {
				const lineA = a.lineStart === -1 ? lines.length : (a.lineStart ?? 0);
				const lineB = b.lineStart === -1 ? lines.length : (b.lineStart ?? 0);
				return lineB - lineA;
			});

		let linesChangedCount = 0;

		for (const h of sortedHunks) {
			let contentToInsert: string[] = [];

			if (h.kind === "cut_range" || h.kind === "cut_block") {
				contentToInsert = [];
			} else if (h.registerName) {
				contentToInsert = clipboard.get(h.registerName) ?? [];
			} else {
				contentToInsert = h.bodyLines;
			}

			let start = h.lineStart ?? 1;
			if (start === -1) start = lines.length; // $ 尾部锚点

			if (h.kind === "insert_before") {
				const idx = Math.max(0, Math.min(lines.length, start - 1));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (h.kind === "insert_after") {
				const idx = Math.max(0, Math.min(lines.length, start));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				const s = Math.max(1, start);
				const e = Math.min(lines.length, h.lineEnd ?? s);
				const count = Math.max(0, e - s + 1);
				lines.splice(s - 1, count, ...contentToInsert);
				linesChangedCount += Math.max(count, contentToInsert.length);
			}
		}

		const newContent = lines.join(eol) + (hasTrailingNewline ? eol : "");
		if (moveDest) {
			plannedDeletes.add(sec.filePath);
			plannedWrites.set(moveDest, newContent);
			results.push({
				filePath: sec.filePath,
				op: "moved",
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				newPath: moveDest,
				recovered: isRecovered,
			});
		} else {
			plannedWrites.set(sec.filePath, newContent);
			results.push({
				filePath: sec.filePath,
				op: "updated",
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				recovered: isRecovered,
			});
		}
	}

	// ===== 阶段 2: 全部校验通过，统一落盘 =====
	// 先执行所有写入，确保新文件与移动目标成功落盘，避免先删后写异常时永久丢失源文件
	for (const [p, content] of plannedWrites.entries()) {
		write(p, content);
		// 记住新快照（统一采用绝对路径隔离多工作区）
		store.record(resolve(cwd, p), content);
	}
	for (const p of plannedDeletes) {
		if (!plannedWrites.has(p)) {
			remove(p);
		}
	}

	const summaryParts = results.map((r) => {
		if (r.op === "deleted") return `删除 ${r.filePath}`;
		if (r.op === "moved") return `移动 ${r.filePath} -> ${r.newPath}（新哈希 #${r.newHash}）`;
		return `修改 ${r.filePath}（${r.linesChanged} 行变动，新哈希 #${r.newHash}${r.recovered ? "，三方自愈" : ""}）`;
	});

	return {
		ok: true,
		summary: `成功应用补丁：\n${summaryParts.map((s) => "• " + s).join("\n")}`,
		results,
	};
}
