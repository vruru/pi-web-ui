import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
	FiCheck,
	FiCode,
	FiCornerDownLeft,
	FiEdit3,
	FiEye,
	FiLink,
	FiMaximize,
	FiMinimize,
	FiSave,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import type { FileContent } from "../types";
import type { UiSlotEntry } from "../ui-slots";
import { Markdown } from "./Markdown";
import { renderMergedToolbar } from "../slot-toolbar";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";
import { appSend } from "../app-globals";

/** Cap rendered lines so a pathological file can't freeze the modal. */
const MAX_PREVIEW_LINES = 5000;

export interface PreviewFile {
	path: string;
	name: string;
}

interface FilePreviewProps {
	file: PreviewFile;
	/** Latest file content from the server (path-matched inside the modal). */
	content: FileContent | null;
	/** Add the selected line range as a "lines" attachment to the chat input. */
	onAddLines: (path: string, name: string, start: number, end: number) => void;
	/** Attach the whole file as a path reference like the row buttons. */
	onAttach: (path: string, name: string, mode: "reference") => void;
	onClose: () => void;
	/** 文件预览工具条（file.preview.toolbar 槽位：纯插件新增位，无条目时不渲染）。 */
	uiFilePreviewToolbar?: UiSlotEntry[];
	/** 工具条动作分发（交回 App 给贡献它的插件）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}

/** 1-based inclusive line range. */
interface Range {
	start: number;
	end: number;
}

export function FilePreview({
	file,
	content,
	onAddLines,
	onAttach,
	onClose,
	uiFilePreviewToolbar,
	onUiAction,
}: FilePreviewProps) {
	const t = useT();
	const [loaded, setLoaded] = useState<FileContent | null>(null);
	const [loading, setLoading] = useState(false);
	const [sel, setSel] = useState<Range | null>(null);
	const [dragging, setDragging] = useState(false);
	const [added, setAdded] = useState(false);
	// Editing is deliberately opt-in for every newly opened file.
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Markdown files open in rendered view; raw source remains one click away.
	const [markdownPreview, setMarkdownPreview] = useState(true);
	// Same for HTML files: sandboxed iframe render by default, source on toggle.
	const [htmlPreview, setHtmlPreview] = useState(true);
	// HTML preview script gate: off by default (pure static render). Turning it
	// on is an explicit per-file opt-in — resets on file switch, never persisted.
	const [allowJs, setAllowJs] = useState(false);
	const editViewRef = useRef(false);
	// Word wrap for the text preview (default on).
	const [wrap, setWrap] = useState(true);
	// Fullscreen fills the whole viewport; zoom scales the preview body
	// (font-size for code/editor/hex, CSS zoom for the rendered markdown).
	const [fullscreen, setFullscreen] = useState(false);
	const [zoom, setZoom] = useState(100);
	const anchorRef = useRef(0);
	const draggingRef = useRef(false);
	const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 保存回执（审查 #1）：write_file 发出后进入 saving 态，服务端保存成功会
	// 立即对该路径重读并推回 file_content（见 server/files-service.ts writeFile），
	// content prop 更新即确认；5s 未确认按「结果未知」处理。
	const [saving, setSaving] = useState(false);
	const [saveUnknown, setSaveUnknown] = useState(false);
	// effect 里只看 ref（saving 不进 deps，避免旧 content 触发假确认）。
	const savingRef = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 卸载时清掉未触发的定时器（审查 #5）：added 提示与保存超时都不该再回调 setState。
	useEffect(
		() => () => {
			if (addedTimer.current) clearTimeout(addedTimer.current);
			if (saveTimer.current) clearTimeout(saveTimer.current);
		},
		[],
	);

	// Request content on open / file change (mount included).
	useEffect(() => {
		setLoading(true);
		setLoaded(null);
		setSel(null);
		setEditing(false);
		setDraft("");
		setMarkdownPreview(true);
		setHtmlPreview(true);
		setAllowJs(false);
		editViewRef.current = false;
		// 换文件：放弃上一个文件未确认的保存等待（回包会被 path 校验丢弃）。
		savingRef.current = false;
		setSaving(false);
		setSaveUnknown(false);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		appSend({ type: "read_file", path: file.path });
	}, [file.path]);

	// Accept responses only for the file currently shown (stale responses for
	// previously previewed files are ignored).
	useEffect(() => {
		if (content && content.path === file.path) {
			setLoaded(content);
			if (!editing) setDraft(content.text);
			setLoading(false);
			// 保存确认（审查 #1）：该路径的重读回包到达 → 按已确认内容退出编辑态。
			// saving 走 ref：它不在 deps 里，同一次 content 变化不会因 saving 翻转重跑。
			if (savingRef.current) {
				savingRef.current = false;
				if (saveTimer.current) clearTimeout(saveTimer.current);
				setSaving(false);
				setSaveUnknown(false);
				setEditing(false);
				setDraft(content.text);
				if (editViewRef.current) {
					if (isMarkdownFile(file.name)) setMarkdownPreview(true);
					if (isHtmlFile(file.name)) setHtmlPreview(true);
				}
				setSel(null);
			}
		}
	}, [content, editing, file.path]);

	// Escape closes; Ctrl/Cmd+A selects everything in the preview.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				handleClose();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && editing) {
				e.preventDefault();
				saveEditing();
				return;
			}
			const target = e.target as HTMLElement | null;
			const typing =
				target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing) {
				e.preventDefault();
				selectAll();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, loaded, editing, draft]);

	// End drag selection on mouseup anywhere.
	useEffect(() => {
		const up = () => {
			draggingRef.current = false;
			setDragging(false);
		};
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);

	const lines = useMemo(() => {
		if (!loaded) return [];
		const parts = loaded.text.split("\n");
		// Trailing newline → empty phantom line; drop it so line numbers match
		// what the server counts.
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		return parts.slice(0, MAX_PREVIEW_LINES);
	}, [loaded]);

	const lineCount = loaded?.lines ?? 0;
	const truncatedLines = lineCount > MAX_PREVIEW_LINES;

	const selectLine = (line: number, extend: boolean) => {
		if (extend) {
			const anchor = anchorRef.current > 0 ? anchorRef.current : line;
			setSel({
				start: Math.min(anchor, line),
				end: Math.max(anchor, line),
			});
		} else {
			anchorRef.current = line;
			setSel({ start: line, end: line });
		}
	};

	const selectAll = () => {
		if (lines.length === 0) return;
		anchorRef.current = 1;
		setSel({ start: 1, end: lines.length });
	};

	const addToChat = () => {
		if (!sel) return;
		onAddLines(file.path, file.name, sel.start, sel.end);
		setAdded(true);
		if (addedTimer.current) clearTimeout(addedTimer.current);
		addedTimer.current = setTimeout(() => setAdded(false), 1400);
	};

	const canEdit =
		loaded !== null && loaded.kind === "text" && !loaded.binary && !loaded.truncated && !isOfficeFile(file.name);

	const cancelEditing = () => {
		// 取消编辑同时放弃未确认的保存等待（若服务端实际写成功，回包到达时
		// savingRef 已退出，只会静默刷新正文）。
		savingRef.current = false;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		setSaving(false);
		setSaveUnknown(false);
		setDraft(loaded?.text ?? "");
		setEditing(false);
		if (editViewRef.current) {
			if (isMarkdownFile(file.name)) setMarkdownPreview(true);
			if (isHtmlFile(file.name)) setHtmlPreview(true);
		}
	};

	const toggleEditing = () => {
		if (editing) {
			if (draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
				return;
			}
			cancelEditing();
			return;
		}
		if (!canEdit || !loaded) return;
		editViewRef.current = (isMarkdownFile(file.name) && markdownPreview) || (isHtmlFile(file.name) && htmlPreview);
		if (isMarkdownFile(file.name)) setMarkdownPreview(false);
		if (isHtmlFile(file.name)) setHtmlPreview(false);
		setSel(null);
		setDraft(loaded.text);
		setEditing(true);
	};

	const saveEditing = () => {
		if (!editing || !loaded || !canEdit) return;
		if (!appSend({ type: "write_file", path: file.path, text: draft })) return;
		// 审查 #1：发出即进入 saving（不再「发出即关编辑态」）。编辑器保持打开，
		// 等该路径重读回包确认（见 content effect）；5s 未确认提示结果未知。
		savingRef.current = true;
		setSaveUnknown(false);
		setSaving(true);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			// 超时未确认：退出 saving，留在编辑态让用户重试或取消（输入不丢）。
			savingRef.current = false;
			setSaving(false);
			setSaveUnknown(true);
		}, 5000);
	};

	const handleClose = () => {
		if (editing && draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
			return;
		}
		onClose();
	};

	const setZoomLevel = (next: number) => {
		setZoom(Math.min(200, Math.max(50, next)));
	};

	const selCount = sel ? sel.end - sel.start + 1 : 0;
	const isBinary = loaded?.binary ?? false;
	const truncated = loaded?.truncated ?? false;
	// Preview category from the server ("text" while loading). Media kinds are
	// streamed over the /api/file HTTP endpoint; "none" is never previewable.
	const kind = loaded?.kind ?? "text";
	const isMarkdown = isMarkdownFile(file.name) || isOfficeFile(file.name);
	const isHtml = isHtmlFile(file.name);
	const showMarkdown = isMarkdown && markdownPreview && !editing && kind === "text" && !isBinary;
	const showHtml = isHtml && htmlPreview && !editing && kind === "text" && !isBinary;
	/** 头栏宿主节点（key = file.preview.toolbar 条目 id；显隐与顺序由槽位决定，
	 *  文件类型条件（md/html/文本/缩放）仍各自保留 —— 布局隐藏是用户意图，类型条件是内容能力）。 */
	const fpHostNodes: Record<string, ReactNode> = {
		"host:fp-md":
			isMarkdown && kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach markdown ${markdownPreview ? "on" : ""}`}
					data-tip={markdownPreview ? t("showMarkdownSource") : t("showMarkdownPreview")}
					disabled={editing}
					onClick={() => setMarkdownPreview((value) => !value)}
				>
					{markdownPreview ? <FiEye /> : <FiCode />}
				</button>
			) : null,
		"host:fp-html":
			isHtml && kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach html ${htmlPreview ? "on" : ""}`}
					data-tip={htmlPreview ? t("showHtmlSource") : t("showHtmlPreview")}
					disabled={editing}
					onClick={() => setHtmlPreview((value) => !value)}
				>
					{htmlPreview ? <FiCode /> : <FiEye />}
				</button>
			) : null,
		"host:fp-edit":
			kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach edit ${editing ? "on" : ""}`}
					data-tip={truncated ? t("fileEditTruncated") : editing ? t("exitEditFile") : t("editFile")}
					disabled={!canEdit && !editing}
					onClick={toggleEditing}
				>
					<FiEdit3 />
				</button>
			) : null,
		"host:fp-wrap":
			kind === "text" && !isBinary && !showMarkdown && !showHtml ? (
				<button
					type="button"
					className={`fp-attach wrap ${wrap ? "on" : ""}`}
					data-tip={wrap ? t("disableWrap") : t("enableWrap")}
					onClick={() => setWrap((w) => !w)}
				>
					<FiCornerDownLeft />
				</button>
			) : null,
		"host:fp-zoom":
			kind === "text" && loaded ? (
				<span className="fp-zoom">
					<button
						type="button"
						className="fp-attach zoom-out"
						data-tip={t("zoomOut")}
						disabled={zoom <= 50}
						onClick={() => setZoomLevel(zoom - 10)}
					>
						<FiZoomOut />
					</button>
					<button type="button" className="fp-zoom-val" title={t("resetZoom")} onClick={() => setZoom(100)}>
						{zoom}%
					</button>
					<button
						type="button"
						className="fp-attach zoom-in"
						data-tip={t("zoomIn")}
						disabled={zoom >= 200}
						onClick={() => setZoomLevel(zoom + 10)}
					>
						<FiZoomIn />
					</button>
				</span>
			) : null,
		"host:fp-ref": (
			<button
				type="button"
				className="fp-attach ref"
				data-tip={t("referenceTip")}
				onClick={() => onAttach(file.path, file.name, "reference")}
			>
				<FiLink />
			</button>
		),
		"host:fp-full": (
			<button
				type="button"
				className={`fp-attach full ${fullscreen ? "on" : ""}`}
				data-tip={fullscreen ? t("exitFullscreen") : t("fullscreen")}
				onClick={() => setFullscreen((f) => !f)}
			>
				{fullscreen ? <FiMinimize /> : <FiMaximize />}
			</button>
		),
		"host:fp-close": null,
	};
	/** 头栏顺序：接线时（App 传全量）宿主+插件按槽位顺序交错；未接线回落旧硬编码顺序。关闭按钮统一固定在头栏最右侧，不占工具条流动位。 */
	const fpEntries: UiSlotEntry[] =
		uiFilePreviewToolbar === undefined
			? [
					"host:fp-md",
					"host:fp-html",
					"host:fp-edit",
					"host:fp-wrap",
					"host:fp-zoom",
					"host:fp-ref",
					"host:fp-full",
				].map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiFilePreviewToolbar.filter((e) => !e.hidden && e.id !== "host:fp-close");
	// /api/file resolves against the requesting client's workspace (the opened
	// project), not the server's startup cwd — pass clientId so they can differ.
	const mediaUrl = (p: string) =>
		withToken(appUrl(`/api/file?clientId=${encodeURIComponent(getClientId())}&path=${encodeURIComponent(p)}`));
	// HTML render URL: directory-mapped /api/preview so the page's RELATIVE
	// subresources (<link href="../web/src/styles.css">, ./app.js, images…)
	// resolve against the file's own directory. ?allowJs=1 lifts the script
	// block (server CSP + iframe sandbox switch together).
	const htmlUrl = (p: string) => {
		const segs = p
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		// Machine browsing sends absolute wire paths ("C:/..." / "/...");
		// workspace-relative paths never start with "/" or a drive letter.
		const abs = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("/");
		const base = abs ? `/api/preview/__abs__/${segs}` : `/api/preview/${segs}`;
		return withToken(appUrl(`${base}?clientId=${encodeURIComponent(getClientId())}${allowJs ? "&allowJs=1" : ""}`));
	};

	return (
		<div
			className={`fp-overlay ${fullscreen ? "fullscreen" : ""}`}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
		>
			<div className={`fp ${fullscreen ? "fullscreen" : ""}`} style={{ "--fp-zoom": zoom / 100 } as CSSProperties}>
				<div className="fp-head">
					<span className="fp-name" title={file.path}>
						{file.name}
					</span>
					<span className="fp-path">{file.path}</span>
					<span className="fp-meta">
						{loaded && kind === "text" && !isBinary && t("fileLines", { n: lineCount })}
						{loaded && ` · ${formatSize(loaded.size)}`}
					</span>
					<span className="fp-head-actions">
						{/* 宿主 chrome + 插件条目按槽位顺序交错（显隐/顺序走布局页，类型条件见 fpHostNodes）。 */}
						{renderMergedToolbar(fpEntries, fpHostNodes, onUiAction)}
					</span>
					<button type="button" className="fp-close" title={t("close")} aria-label={t("close")} onClick={handleClose}>
						<FiX />
					</button>
				</div>

				{truncated && kind === "text" && !isBinary && (
					<div className="fp-notice">
						{isOfficeFile(file.name) ? t("previewLinesTruncated", { n: lines.length }) : t("previewTruncated")}
					</div>
				)}

				{loading && !loaded && <div className="fp-empty">{t("loading")}</div>}

				{!loading && kind === "none" && !isBinary && <div className="fp-empty">{t("previewNotSupported")}</div>}

				{!loading && kind === "image" && (
					<div className="fp-media-wrap">
						<img className="fp-media" src={mediaUrl(file.path)} alt={file.name} />
					</div>
				)}

				{!loading && kind === "video" && (
					<div className="fp-media-wrap">
						<video className="fp-media" src={mediaUrl(file.path)} controls preload="metadata" />
					</div>
				)}

				{!loading && showHtml && loaded && (
					<div className="fp-html">
						<div className="fp-html-bar">
							<span className="fp-html-hint" title={t(allowJs ? "htmlJsOnTip" : "htmlJsOffTip")}>
								{allowJs ? t("htmlJsOn") : t("htmlJsOff")}
							</span>
							<button
								type="button"
								className={`fp-html-js ${allowJs ? "on" : ""}`}
								data-tip={allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
								onClick={() => setAllowJs((v) => !v)}
							>
								{allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
							</button>
						</div>
						<iframe
							// key forces a reload when the gate flips (script blocking is
							// decided at document load — toggling attributes alone reuses
							// the already-parsed page).
							key={allowJs ? "js" : "nojs"}
							className="fp-html-frame"
							src={htmlUrl(file.path)}
							title={file.name}
							// No allow-same-origin, ever: even with scripts on, the page
							// runs in an opaque origin — no access to our DOM, cookies,
							// storage; forms and top-navigation stay blocked too.
							sandbox={allowJs ? "allow-scripts" : ""}
							referrerPolicy="no-referrer"
						/>
					</div>
				)}

				{!loading && showMarkdown && loaded && (
					<div className={isOfficeFile(file.name) ? "fp-markdown msg-text fp-office" : "fp-markdown msg-text"}>
						<div className="fp-markdown-zoom">
							<Markdown text={loaded.text} />
						</div>
					</div>
				)}

				{!loading && isBinary && kind !== "image" && kind !== "video" && loaded && (
					<div className="fp-hex-wrap">
						<div className="fp-notice">
							{t("binaryFile")}
							{loaded.truncated && t("binaryHexTruncated")}
						</div>
						<pre className="fp-hex">{loaded.text}</pre>
					</div>
				)}

				{!loading && editing && kind === "text" && !isBinary && loaded && (
					<>
						<textarea
							className={`fp-editor ${wrap ? "" : "no-wrap"}`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							wrap={wrap ? "soft" : "off"}
							spellCheck={false}
							autoFocus
						/>
						{saveUnknown && (
							<div className="fp-notice" role="alert">
								{t("saveResultUnknown")}
							</div>
						)}
					</>
				)}

				{!loading &&
					!showMarkdown &&
					!showHtml &&
					!editing &&
					kind === "text" &&
					!isBinary &&
					loaded &&
					lines.length === 0 && <div className="fp-empty">{t("emptyFile")}</div>}

				{!loading && !showMarkdown && !showHtml && !editing && kind === "text" && !isBinary && lines.length > 0 && (
					<div
						className={`fp-code ${dragging ? "dragging" : ""} ${wrap ? "" : "no-wrap"}`}
						onMouseDown={(e) => {
							// Block native text selection so click/drag maps to line ranges.
							if (e.button === 0) e.preventDefault();
						}}
					>
						{lines.map((text, i) => {
							const n = i + 1;
							const active = sel !== null && n >= sel.start && n <= sel.end;
							return (
								<div
									key={n}
									className={`fp-line ${active ? "sel" : ""}`}
									onMouseDown={(e) => {
										if (e.button !== 0) return;
										selectLine(n, e.shiftKey);
										draggingRef.current = true;
										setDragging(true);
									}}
									onMouseEnter={() => {
										if (draggingRef.current) selectLine(n, true);
									}}
								>
									<span className="fp-num">{n}</span>
									<span className="fp-code-text">{text}</span>
								</div>
							);
						})}
						{truncatedLines && (
							<div className="fp-lines-note">{t("previewLinesTruncated", { n: MAX_PREVIEW_LINES })}</div>
						)}
					</div>
				)}

				<div className="fp-foot">
					{editing ? (
						<>
							<span className="fp-hint">{t("editFile")}</span>
							<div className="fp-actions">
								<button type="button" className="btn" onClick={toggleEditing}>
									{t("cancel")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={saving || draft === (loaded?.text ?? "")}
									onClick={saveEditing}
								>
									<FiSave /> {t("saveFile")}
								</button>
							</div>
						</>
					) : (
						!showMarkdown &&
						!showHtml &&
						kind === "text" && (
							<>
								<span className="fp-hint">
									{sel
										? t("selectedRange", {
												n: selCount,
												start: sel.start,
												end: sel.end,
											})
										: t("selectLinesHint")}
								</span>
								<div className="fp-actions">
									<button type="button" className="btn" disabled={lines.length === 0} onClick={selectAll}>
										{t("selectAll")}
									</button>
									<button type="button" className="btn" disabled={!sel} onClick={() => setSel(null)}>
										{t("clearSelection")}
									</button>
									<button type="button" className="btn primary" disabled={!sel || isBinary} onClick={addToChat}>
										{added ? <FiCheck /> : null}
										{added ? t("addedToChat") : t("addToChat")}
									</button>
								</div>
							</>
						)
					)}
				</div>
			</div>
		</div>
	);
}

function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Office 文档：服务端已转成 Markdown 文本下发，这里按 Markdown 渲染即可随处可看。 */
function isOfficeFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".docx") || lower.endsWith(".xlsx") || lower.endsWith(".xlsm");
}

function isHtmlFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
