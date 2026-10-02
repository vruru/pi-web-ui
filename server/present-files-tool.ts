/**
 * present-files-tool.ts —— AI 主动把文件「展示」给用户（present_files）。
 *
 * 背景：AI 生成截图/图表/录屏/报告/日志后，只能在正文里写一句路径，用户还得
 * 自己去右栏一层层点开；图片、视频更是根本没机会出现在对话里。
 *
 * 做法：注册一个第一方 customTool（与 read 覆盖、edit_soft、conversation_read
 * 同机制）。模型给出路径清单，工具只做**只读探测**——stat + 未知扩展嗅探前
 * 4KB + 文本摘录——把结构化 items 放进 tool result 的 `details`（经
 * serialize.ts 下发浏览器，并随会话文件持久化），前端 ToolCallBlock 把它渲染
 * 成预览卡片：图片/视频/音频内联直接看，文本/markdown/HTML 一键开预览弹窗，
 * 每个条目带「预览 / 本地打开 / 在文件夹中显示 / 下载 / 复制路径」。
 *
 * 本工具**不打开任何窗口、不弹通知**：所有系统级动作都由用户在卡片上点击触发
 * （走既有的 file_open_default / file_reveal 协议，issue #187）。工具本身只读，
 * 能看到的文件与 read 工具完全一致，不新增任何权限。
 *
 * 路径口径与 read 一致（~ / @ / 绝对 / 相对，复用 read-tool 的
 * resolvePathForDirCheck）；回传的 `path` 是线形绝对路径（"C:/…" / "/…"），
 * 前端拿它直接打 /api/file、file_reveal、file_open_default，不受会话 cwd 影响。
 *
 * 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
 * 结果文本走 pick(lang, zh, en, key, vars)，缺表回落英文内联。
 *
 * DSH 引擎无 customTool 注册面（工具来自 shipped preset），本工具只服务 pi 引擎。
 */

import { open, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { resolvePathForDirCheck } from "./read-tool.js";
import { decodeText, isAudioFile, looksLikeText, previewKind } from "./text-sniff.js";
import { PRESENT_FILES_TOOL_NAME } from "./tool-manager.js";

/** 展示文件工具名（唯一登记见 tool-manager.ts；此处导出供 import 方沿用）。 */
export { PRESENT_FILES_TOOL_NAME };

/** 单次展示的条目上限：再多就不是「给你看」而是文件列表了（卡片的纵向预算也有限）。 */
export const MAX_PRESENT_ITEMS = 12;
/** 单条文本摘录字符数上限。 */
export const MAX_EXCERPT_CHARS = 1200;
/** 一次调用里所有摘录的字符总量上限（details 会进快照与转录，必须封顶）。 */
export const MAX_EXCERPT_TOTAL_CHARS = 6000;
/** 摘录只读文件头这么多字节（UTF-8 3 字节/汉字，8KB 足够撑满 1200 字符）。 */
const EXCERPT_READ_BYTES = 8192;
/** 未知扩展名文件的内容嗅探字节数（判断文本还是二进制）。 */
const SNIFF_BYTES = 4096;
/** 摘录/嗅探的体积闸门：超过就不读内容（几十 MB 的日志摘一句没意义）。 */
const MAX_SNIFFABLE_BYTES = 4 * 1024 * 1024;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);

/**
 * 卡片条目的类别。`text`/`markdown`/`html`/`image`/`video`/`audio` 都有对应的
 * 浏览器内查看方式；`binary`/`pdf` 只能下载或本地打开；`dir`/`missing` 是
 * 目录与不存在的路径（各自有专属提示，不当作可预览内容）。
 */
export type PresentKind =
	"image" | "video" | "audio" | "markdown" | "html" | "pdf" | "text" | "binary" | "dir" | "missing";

/** 模型给的条目原文（归一化后）。 */
export interface PresentItemInput {
	/** 模型写的路径（原样保留用于展示）。 */
	path: string;
	/** 条目说明（可选，卡片上显示在文件名旁边）。 */
	caption?: string;
	/** true → 该条目就绪后前端自动打开预览弹窗（受用户偏好开关约束）。 */
	focus?: boolean;
}

/** 探测后的条目（进 tool result details，前端据此渲染卡片）。 */
export interface PresentItem extends PresentItemInput {
	/** 文件名（basename）。 */
	name: string;
	/** 线形绝对路径（"C:/…" / "/…"）：前端 API/协议调用统一用它。 */
	abs: string;
	kind: PresentKind;
	/** 文件字节数（目录/缺失时缺省）。 */
	size?: number;
	/** 修改时间（epoch ms）。 */
	mtime?: number;
	/** 文本类文件的开头摘录（卡片直接显示，省一次点击）。 */
	excerpt?: string;
	/** 摘录被截断（还有更多内容）。 */
	excerptTruncated?: boolean;
}

/** 工具回传的 details（前端卡片的数据面）。 */
export interface PresentDetails {
	title?: string;
	note?: string;
	items: PresentItem[];
}

/**
 * 归一化模型给的 items：非数组/元素缺 path 一律丢弃；trim + 反斜杠折成正斜杠
 * （Windows 模型常写 "a\b\c.png"）；按归一化后的路径去重；最多 MAX_PRESENT_ITEMS 条。
 */
export function normalizePresentItems(raw: unknown, max = MAX_PRESENT_ITEMS): PresentItemInput[] {
	if (!Array.isArray(raw)) return [];
	const out: PresentItemInput[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry === "string") {
			const path = normPath(entry);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			out.push({ path });
		} else if (entry && typeof entry === "object") {
			const e = entry as { path?: unknown; caption?: unknown; focus?: unknown };
			if (typeof e.path !== "string") continue;
			const path = normPath(e.path);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			const item: PresentItemInput = { path };
			if (typeof e.caption === "string" && e.caption.trim()) item.caption = e.caption.trim();
			if (e.focus === true) item.focus = true;
			out.push(item);
		}
		if (out.length >= max) break;
	}
	return out;
}

/** trim + 反斜杠折成正斜杠（列上是 wire 口径：Windows 路径在协议里一律 "/"）+ 去掉
 *  结尾斜杠（保留 posix 根 "/" 与盘符根 "C:/")，与 files-service 的 normWirePath 同语义。 */
export function normPath(p: string): string {
	const w = String(p ?? "")
		.trim()
		.replace(/\\/g, "/");
	if (w === "/" || w === "") return w;
	if (w.endsWith("/")) {
		const trimmed = w.replace(/\/+$/, "");
		// "C:/" → 保留盘符根形式（去尾斜杠会变成 "C:"，语义不同）。
		return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
	}
	return w;
}

/** 原生绝对路径 → 线形绝对路径（协议/前端统一口径）。 */
export function toWirePath(abs: string): string {
	return sep === "/" ? abs : abs.split(sep).join("/");
}

/**
 * 按文件名判类（纯函数，无 I/O）：markdown/html/pdf/audio 先认，其余借
 * text-sniff 的 previewKind 认图片/视频/文本；未知扩展（含 exe/zip/无扩展名的
 * 二进制）归 "binary"，由调用方按需读文件头嗅探成文本。
 */
export function classifyPresentKind(name: string): PresentKind {
	const ext = extname(name).toLowerCase().replace(/^\./, "");
	if (MARKDOWN_EXTS.has(ext)) return "markdown";
	if (HTML_EXTS.has(ext)) return "html";
	if (ext === "pdf") return "pdf";
	if (isAudioFile(name)) return "audio";
	const base = previewKind(name);
	if (base === "image") return "image";
	if (base === "video") return "video";
	if (base === "text") return "text";
	return "binary";
}

/** 该类别是否值得读文件头（二进制/未知扩展 → 嗅探成文本；其余按扩展名已定）。 */
export function shouldSniff(kind: PresentKind): boolean {
	return kind === "binary";
}

/** 该类别是否带文本摘录（图片/视频/音频/二进制不读内容）。 */
export function hasExcerpt(kind: PresentKind): boolean {
	return kind === "text" || kind === "markdown" || kind === "html";
}

/** 人类可读体积（工具结果文本与卡片提示共用口径）。 */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n < 1024) return `${Math.round(n)} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 读文件头（关不上就返回 null：读不到内容不算错误，卡片照样出）。 */
async function readHead(abs: string, bytes: number): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(abs, "r");
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead);
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface PresentFilesToolOptions {
	/** 行为开关（每次调用实时读取）：关 → 抛错并提示用户已关闭该工具。 */
	enabled?: () => boolean;
	/** 服务端语言取值器（每次调用时读取，默认英文，issue #91）。 */
	getLang?: () => ServerLang;
}

/** 摘录预算：跨条目共享（每条最多 MAX_EXCERPT_CHARS，总量 MAX_EXCERPT_TOTAL_CHARS）。 */
interface ExcerptBudget {
	left: number;
}

/** 给一条文本类条目补上摘录（预算耗尽或文件过大则跳过）。`native` = 原生绝对路径。 */
async function attachExcerpt(item: PresentItem, budget: ExcerptBudget, native: string): Promise<void> {
	if (!hasExcerpt(item.kind) || item.size === undefined || item.size === 0) return;
	if (item.size > MAX_SNIFFABLE_BYTES || budget.left <= 0) return;
	const head = await readHead(native, EXCERPT_READ_BYTES);
	if (!head || head.length === 0) return;
	const text = decodeText(head).replace(/\u0000+$/, "");
	if (!text) return;
	const cap = Math.min(MAX_EXCERPT_CHARS, budget.left);
	const clipped = text.length > cap;
	const excerpt = clipped ? text.slice(0, cap) : text;
	item.excerpt = excerpt;
	item.excerptTruncated = clipped || item.size > head.length;
	budget.left -= excerpt.length;
}

/** 逐条探测：stat → 判类 → （未知扩展）嗅探 → 摘录。 */
export async function probePresentItem(
	raw: PresentItemInput,
	cwd: string,
	budget: ExcerptBudget,
): Promise<PresentItem> {
	const native = resolvePathForDirCheck(raw.path, cwd);
	const abs = toWirePath(native);
	const name = basename(native) || raw.path;
	const base: PresentItem = { ...raw, name, abs, kind: "missing" };
	const st = await stat(native).catch(() => null);
	if (!st) return base;
	if (st.isDirectory()) return { ...base, kind: "dir", mtime: st.mtimeMs };
	if (!st.isFile()) return base;
	let kind = classifyPresentKind(name);
	if (shouldSniff(kind) && st.size > 0 && st.size <= MAX_SNIFFABLE_BYTES) {
		const head = await readHead(native, SNIFF_BYTES);
		if (head && head.length > 0 && looksLikeText(head)) kind = "text";
	}
	const item: PresentItem = { ...base, kind, size: st.size, mtime: st.mtimeMs };
	await attachExcerpt(item, budget, native);
	return item;
}

/** 工具结果里给模型的正文：哪些展示了、哪些没找到、卡片上能做什么。 */
export function buildPresentResultText(items: PresentItem[], lang: ServerLang, title?: string): string {
	const shown = items.filter((i) => i.kind !== "missing");
	const missing = items.filter((i) => i.kind === "missing");
	const lines: string[] = [];
	const head = pick(
		lang,
		`已把 ${shown.length} 个文件作为预览卡片展示给用户${title ? `（${title}）` : ""}：`,
		`Presented ${shown.length} file(s) to the user as preview cards${title ? ` (${title})` : ""}:`,
		"present.files.result.head",
		{ n: shown.length, title: title ?? "" },
	);
	lines.push(head);
	for (const [i, it] of shown.entries()) {
		const meta =
			it.kind === "dir"
				? pick(lang, "目录", "directory", "present.files.result.kindDir")
				: [it.kind, it.size !== undefined ? formatBytes(it.size) : ""].filter(Boolean).join(", ");
		const caption = it.caption ? ` — ${it.caption}` : "";
		lines.push(`${i + 1}. ${it.path} (${meta})${caption}`);
	}
	if (missing.length > 0) {
		lines.push(
			pick(
				lang,
				`未展示（路径不存在或不可读）：${missing.map((m) => m.path).join("、")}`,
				`Not shown (path missing or unreadable): ${missing.map((m) => m.path).join(", ")}`,
				"present.files.result.missing",
				{ paths: missing.map((m) => m.path).join(", ") },
			),
		);
	}
	lines.push(
		pick(
			lang,
			"用户在卡片上可以直接看图/播放、打开预览、在本机打开、在文件管理器中显示、下载或复制路径；不要再把文件内容贴一遍。",
			"The user can view/play media, open the preview dialog, open the file locally, reveal it in the file manager, download it or copy its path from the card — do not paste the file contents again.",
			"present.files.result.tail",
		),
	);
	return lines.join("\n");
}

/** 空结果/全部缺失时的错误文案（模型看到 error 才会改策略）。 */
function missingAllError(lang: ServerLang, paths: string[]): string {
	return pick(
		lang,
		`这些路径都不存在或不可读，没有任何卡片展示出去：${paths.join("、")}`,
		`None of these paths exist or are readable, nothing was shown: ${paths.join(", ")}`,
		"present.files.result.allMissing",
		{ paths: paths.join(", ") },
	);
}

/**
 * present_files 工具定义。cwd 仅供创建时固定；执行时优先 ctx.cwd（会话工作区）。
 */
export function makePresentFilesTool(fallbackCwd: string, options: PresentFilesToolOptions = {}): ToolDefinition {
	const enabled = options.enabled ?? ((): boolean => true);
	const getLang = options.getLang ?? ((): ServerLang => "en");
	return defineTool({
		name: PRESENT_FILES_TOOL_NAME,
		label: "Show files to the user",
		description:
			"Show files to the user as preview cards in the chat: images/videos/audio inline, text/markdown/HTML in a preview dialog; each card can open locally, reveal in file manager, download, or copy path. " +
			"Use whenever the user should LOOK at an artifact you produced or changed (screenshot, chart, diagram, video/audio, report, log, build output). " +
			"Give workspace-relative paths (max 12 items); `title`/`note` show above the cards, `caption` next to the file name, `focus: true` opens that item in the preview dialog immediately. " +
			"Do not use for files you merely read while reasoning, and do not repeat file contents in your reply.",
		promptSnippet: "show images/videos/text files to the user as preview cards",
		promptGuidelines: [
			"After producing something visual or user-facing (screenshot, chart, video, report, log, build output), call present_files so the user can actually see it instead of only printing the path",
			"Do not call present_files for ordinary source edits the user did not ask to see, and never call it twice for the same file in one turn",
		],
		parameters: Type.Object({
			title: Type.Optional(
				Type.String({
					description: "Optional card title shown above the file cards (short, e.g. 'Q3 revenue chart').",
				}),
			),
			note: Type.Optional(
				Type.String({
					description:
						"Optional one-line note above the cards (markdown, e.g. what changed / which one to look at first).",
				}),
			),
			items: Type.Array(
				Type.Object({
					path: Type.String({ description: "File path (workspace-relative like 'docs/chart.png', or absolute)." }),
					caption: Type.Optional(Type.String({ description: "Optional short caption shown next to the file name." })),
					focus: Type.Optional(
						Type.Boolean({
							description:
								"true → the client opens this item in the preview dialog immediately (use for the one file that matters most).",
						}),
					),
				}),
				{ description: `Files to show (1-${MAX_PRESENT_ITEMS}).` },
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const lang = getLang();
			if (!enabled()) {
				throw new Error(
					pick(
						lang,
						"用户的设置里关闭了 present_files 工具。",
						"The user disabled the present_files tool in settings.",
						"present.files.result.disabled",
					),
				);
			}
			const p = params as { title?: unknown; note?: unknown; items?: unknown };
			const items = normalizePresentItems(p.items);
			if (items.length === 0) {
				throw new Error(
					pick(
						lang,
						"present_files 至少需要一个带 path 的条目。",
						"present_files needs at least one item with a path.",
						"present.files.result.noItems",
					),
				);
			}
			const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : fallbackCwd;
			const budget: ExcerptBudget = { left: MAX_EXCERPT_TOTAL_CHARS };
			const probed: PresentItem[] = [];
			for (const item of items) {
				if (signal?.aborted) throw new Error("aborted");
				probed.push(await probePresentItem(item, cwd, budget));
			}
			if (probed.every((i) => i.kind === "missing")) {
				throw new Error(
					missingAllError(
						lang,
						probed.map((i) => i.path),
					),
				);
			}
			const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
			const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined;
			const details: PresentDetails = { items: probed };
			if (title) details.title = title;
			if (note) details.note = note;
			return {
				content: [{ type: "text" as const, text: buildPresentResultText(probed, lang, title) }],
				details,
			};
		},
	}) as unknown as ToolDefinition;
}
