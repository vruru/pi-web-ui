import { useEffect, useRef, useState } from "react";
import { FiFolder, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";

export interface ProjectPickerProps {
	open: boolean;
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	onCreateProject: (path: string) => void;
}

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
export const MACHINE_ROOT = "@root";

const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

/**
 * 规范拼接工作目录父路径与新建子目录名称。
 * 该函数只负责正斜杠路径连接；服务端负责解析为原生绝对路径。
 */
export function joinProjectPath(parent: string, name: string): string {
	const trimmedName = name.trim();
	const normParent = parent.replace(/\\/g, "/");
	if (normParent.endsWith("/")) {
		return normParent + trimmedName;
	}
	if (/^[A-Za-z]:$/.test(normParent)) {
		return normParent + "/" + trimmedName;
	}
	return normParent + "/" + trimmedName;
}

/** 校验新建项目名称：不能包含分隔符、不能为 . 或 ..、不能唯空。 */
export function isValidProjectName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return true;
}

/** Parent of an absolute "/"-separated path; null at the filesystem root. */
export const parentOf = (p: string): string | null => {
	const s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	if (s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) {
		return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	}
	if (i === 0) return "/";
	const parent = s.slice(0, i);
	return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
};

export function ProjectPicker({
	open,
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	onCreateProject,
}: ProjectPickerProps) {
	const t = useT();
	const [browsePath, setBrowsePath] = useState("");
	const [draft, setDraft] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	const dirs = pathCompletions.filter((c) => c.type === "dir");

	// 从关闭变为打开时初始化状态
	useEffect(() => {
		if (open) {
			const norm = (currentCwd || "").replace(/\\/g, "/");
			setBrowsePath(norm);
			setDraft(norm);
			setShowNew(false);
			setNewName("");
			setError(null);
			setCompIndex(-1);
		}
	}, [open, currentCwd]);

	// 打开后聚焦输入框
	useEffect(() => {
		if (open) {
			const frame = requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
			return () => cancelAnimationFrame(frame);
		}
	}, [open]);

	// 全局 Escape 键监听
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (showNew) {
					setShowNew(false);
					setNewName("");
					setError(null);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [open, showNew, onClose]);

	// 目录浏览请求（60ms 防抖）
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath, open]);

	// 自由路径打字补全（150ms 防抖）
	useEffect(() => {
		if (!open || draft === browsePath) return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(timer);
	}, [draft, browsePath, open]);

	if (!open) return null;

	const commit = (path: string) => {
		const trimmed = path.trim();
		if (!trimmed || trimmed === MACHINE_ROOT) return;
		onSelectDirectory(trimmed);
		onClose();
	};

	const handleCreateProject = () => {
		const trimmed = newName.trim();
		if (!isValidProjectName(trimmed)) {
			setError(t("invalidProjectName"));
			return;
		}
		const fullPath = joinProjectPath(browsePath, trimmed);
		onCreateProject(fullPath);
		setShowNew(false);
		setNewName("");
		setError(null);
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (showNew) {
				setShowNew(false);
				setNewName("");
				setError(null);
			} else {
				onClose();
			}
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			commit(draft);
		} else if (e.key === "Tab") {
			if (dirs.length === 0) return;
			e.preventDefault();
			const idx = compIndex >= 0 ? (compIndex + 1) % dirs.length : 0;
			setCompIndex(idx);
			setDraft(dirs[idx].path);
			setBrowsePath(dirs[idx].path);
		}
	};

	const upPath = parentOf(browsePath);

	const norm = (p: string) => {
		const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:/.test(f) ? f.toLowerCase() : f;
	};
	const cur = norm(browsePath);
	const canAddRoot =
		Boolean(browsePath) &&
		browsePath !== MACHINE_ROOT &&
		cur !== norm(currentCwd) &&
		!workspaceRoots.some((r) => norm(r) === cur);

	return (
		<>
			<div className="status-cwd-backdrop project-picker-backdrop" onClick={onClose} />
			<div className="cwd-picker project-picker" role="dialog" aria-label={t("projectPickerTitle")}>
				<div className="cwd-picker-head">
					<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
						{browsePath === MACHINE_ROOT ? "💻" : <FiFolder />}
						<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
					</span>
					<button
						type="button"
						className="cwd-up"
						disabled={browsePath === MACHINE_ROOT}
						title={t("computer")}
						onClick={() => {
							setBrowsePath(MACHINE_ROOT);
							setDraft(MACHINE_ROOT);
							setCompIndex(-1);
						}}
					>
						💻
					</button>
					<button
						type="button"
						className="cwd-up"
						disabled={!upPath}
						title={t("cwdGoUp")}
						onClick={() => {
							if (upPath) {
								setBrowsePath(upPath);
								setDraft(upPath);
								setCompIndex(-1);
							}
						}}
					>
						↑ {t("cwdGoUp")}
					</button>
					<button
						type="button"
						className="cwd-up"
						disabled={!canAddRoot}
						title={t("addWorkspaceRootHint")}
						onClick={() => {
							if (!canAddRoot) return;
							appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
						}}
					>
						＋ {t("addWorkspaceRoot")}
					</button>
					<button type="button" className="cwd-close" title={t("close")} aria-label={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
				<div className="cwd-picker-row">
					<input
						ref={inputRef}
						className="status-cwd-input cwd-picker-input"
						value={draft}
						placeholder={t("enterPath")}
						spellCheck={false}
						onChange={(e) => {
							setDraft(e.target.value);
							setCompIndex(-1);
						}}
						onKeyDown={onKeyDown}
					/>
					<button
						type="button"
						className="cwd-choose-btn primary"
						title={t("cwdPickCurrent")}
						disabled={browsePath === MACHINE_ROOT}
						onClick={() => commit(browsePath)}
					>
						{t("cwdPickCurrent")}
					</button>
				</div>
				<div className="cwd-list">
					{dirs.length === 0 && <div className="cwd-empty">{t("cwdEmpty")}</div>}
					{dirs.map((d) => (
						<div key={d.path} className="cwd-item">
							<button
								type="button"
								className="cwd-enter"
								title={`${t("cwdEnter")} ${d.path}`}
								onClick={() => {
									setBrowsePath(d.path);
									setDraft(d.path);
									setCompIndex(-1);
								}}
							>
								<FiFolder />
								<span className="cwd-name">{d.name}</span>
							</button>
							<button type="button" className="cwd-choose-btn" title={t("cwdChoose")} onClick={() => commit(d.path)}>
								{t("cwdChoose")}
							</button>
						</div>
					))}
				</div>
				<div className="cwd-picker-foot">
					{showNew ? (
						<div className="cwd-newrow">
							<input
								ref={newInputRef}
								value={newName}
								autoFocus
								spellCheck={false}
								placeholder={t("projectName")}
								onChange={(e) => {
									setNewName(e.target.value);
									if (error) setError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										handleCreateProject();
									} else if (e.key === "Escape") {
										e.stopPropagation();
										setShowNew(false);
										setNewName("");
										setError(null);
									}
								}}
							/>
							<button type="button" className="cwd-choose-btn primary" onClick={handleCreateProject}>
								{t("createAndOpenProject")}
							</button>
							<button
								type="button"
								className="cwd-choose-btn"
								onClick={() => {
									setShowNew(false);
									setNewName("");
									setError(null);
								}}
							>
								{t("cwdCancel")}
							</button>
						</div>
					) : (
						<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
							＋ {t("newProject")}
						</button>
					)}
					{error && (
						<div className="project-picker-error" style={{ color: "var(--red)", fontSize: "11px", marginTop: "4px" }}>
							{error}
						</div>
					)}
				</div>
			</div>
		</>
	);
}
