import { useState } from "react";
import {
	FiCheckCircle,
	FiClock,
	FiAlertCircle,
	FiCircle,
	FiChevronDown,
	FiChevronUp,
	FiTrash2,
	FiList,
	FiCopy,
	FiCheck,
	FiEdit2,
	FiX,
	FiPlus,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { PlanState, PlanStep, PlanStepStatus } from "../types";

interface PlanBoardProps {
	plan: PlanState | null | undefined;
}

const NEXT_STATUS: Record<PlanStepStatus, PlanStepStatus> = {
	pending: "in_progress",
	in_progress: "done",
	done: "failed",
	failed: "pending",
};

/**
 * 结构化任务计划看板（Plan Mode / Step State Machine）。
 *
 * 吸收主流规划与看板范式（DSH / narumitw / plannotator）：
 * 1. 实时展示任务步骤状态机（pending / in_progress / done / failed）与总体进度；
 * 2. 支持「开始实施」与「✨ 净室执行（Clean Handoff）」双轨落地；
 * 3. 支持在看板上可视化微调/批注：内联编辑步骤、删除步骤、切换状态、新增步骤；
 * 4. 支持一键导出/复制为 Markdown 离线存档。
 */
export function PlanBoard({ plan }: PlanBoardProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const [editDesc, setEditDesc] = useState("");

	if (!plan || !plan.steps || plan.steps.length === 0) {
		return null;
	}

	const steps = plan.steps;
	const doneCount = steps.filter((s) => s.status === "done").length;
	const totalCount = steps.length;
	const percent = Math.round((doneCount / totalCount) * 100);

	const activeStep = steps.find((s) => s.id === plan.activeStepId) ?? steps.find((s) => s.status === "in_progress");

	const handleClearPlan = () => {
		if (window.confirm("确定要清空当前任务计划看板吗？")) {
			appSend({
				type: "plan_update",
				steps: [],
			});
		}
	};

	/** 「开始实施」：关掉服务端只规划闸门，在当前会话直接发起实施轮。 */
	const handleImplement = () => {
		appSend({ type: "set_plan_mode", enabled: false });
		appSend({ type: "prompt", text: t("planImplementRequest") });
	};

	/** 「✨ 净室执行（Clean-session Handoff）」：
	 *  关闭当前计划模式闸门，新起净室会话，并把目标与计划步骤无损交接过去。
	 *  避免长调研探索期的上下文噪音污染与注意力漂移。 */
	const handleCleanHandoff = () => {
		const planSummary = steps
			.map((s, i) => `${i + 1}. ${s.title}${s.description ? ` (${s.description})` : ""}`)
			.join("\n");
		appSend({ type: "set_plan_mode", enabled: false });
		appSend({ type: "new_chat" });
		appSend({ type: "plan_update", steps });
		appSend({
			type: "prompt",
			text: `${t("planCleanHandoffPrompt")}\n\n${planSummary}`,
		});
	};

	/** 导出并复制为 Markdown 文本 */
	const handleExportMarkdown = async () => {
		const lines = [
			`# ${t("planBoardTitle")} (${doneCount}/${totalCount})`,
			"",
			...steps.map((s, idx) => {
				const mark =
					s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "failed" ? "[!]" : "[ ]";
				let line = `${mark} ${idx + 1}. ${s.title}`;
				if (s.description) line += `\n   ${s.description}`;
				return line;
			}),
		];
		try {
			await navigator.clipboard.writeText(lines.join("\n"));
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API failed fallback
		}
	};

	/** 单步内联编辑控制 */
	const startEdit = (step: PlanStep) => {
		setEditingId(step.id);
		setEditTitle(step.title);
		setEditDesc(step.description || "");
	};

	const cancelEdit = () => {
		setEditingId(null);
		setEditTitle("");
		setEditDesc("");
	};

	const saveEdit = (stepId: string) => {
		const trimmedTitle = editTitle.trim();
		if (!trimmedTitle) return;
		const nextSteps = steps.map((s) => {
			if (s.id !== stepId) return s;
			const next: PlanStep = { ...s, title: trimmedTitle };
			if (editDesc.trim()) next.description = editDesc.trim();
			else delete next.description;
			return next;
		});
		appSend({ type: "plan_update", steps: nextSteps });
		setEditingId(null);
	};

	/** 删除步骤 */
	const handleDeleteStep = (stepId: string) => {
		const nextSteps = steps.filter((s) => s.id !== stepId);
		appSend({ type: "plan_update", steps: nextSteps });
	};

	/** 顺时针切换步骤状态 (pending -> in_progress -> done -> failed) */
	const handleCycleStatus = (stepId: string) => {
		const nextSteps = steps.map((s) => (s.id === stepId ? { ...s, status: NEXT_STATUS[s.status] } : s));
		appSend({ type: "plan_update", steps: nextSteps });
	};

	/** 新增步骤 */
	const handleAddStep = () => {
		const newId = `step-${Date.now()}`;
		const newStep: PlanStep = {
			id: newId,
			title: t("planBoardAddStep"),
			status: "pending",
		};
		const nextSteps = [...steps, newStep];
		appSend({ type: "plan_update", steps: nextSteps });
		startEdit(newStep);
	};

	const getStatusBadge = (status: PlanStepStatus, stepId: string) => {
		const badgeContent = (() => {
			switch (status) {
				case "done":
					return (
						<>
							<FiCheckCircle />
							{t("planBoardCompleted")}
						</>
					);
				case "in_progress":
					return (
						<>
							<FiClock />
							{t("planBoardInProgress")}
						</>
					);
				case "failed":
					return (
						<>
							<FiAlertCircle />
							{t("planBoardFailed")}
						</>
					);
				case "pending":
				default:
					return (
						<>
							<FiCircle />
							{t("planBoardPending")}
						</>
					);
			}
		})();

		const color =
			status === "done"
				? "var(--green, #22c55e)"
				: status === "in_progress"
					? "var(--accent, #38bdf8)"
					: status === "failed"
						? "var(--red, #ef4444)"
						: "var(--text-dim, #9aa1b4)";

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					handleCycleStatus(stepId);
				}}
				title="点击切换状态 (pending / in_progress / done / failed)"
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					color,
					fontSize: 12,
					fontWeight: status === "pending" ? 400 : 600,
					background: "none",
					border: "none",
					cursor: "pointer",
					padding: "2px 4px",
					borderRadius: 4,
				}}
			>
				{badgeContent}
			</button>
		);
	};

	return (
		<div
			className="plan-board"
			style={{
				padding: "10px 14px",
				minWidth: 0,
				maxWidth: "100%",
				borderRadius: 8,
				backgroundColor: "var(--bg-elev, #18202f)",
				border: "1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))",
				boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
				fontSize: 13,
			}}
		>
			{/* 顶部概要栏 */}
			<div className="plan-board-head" onClick={() => setExpanded(!expanded)}>
				<div className="plan-board-head-main">
					<FiList className="plan-board-icon" />
					<span className="plan-board-title">{t("planBoardTitle")}</span>
					<span className="plan-board-count">
						{doneCount}/{totalCount} ({percent}%)
					</span>
					{/* 紧凑模式下显示当前进行中步骤 */}
					{!expanded && activeStep && (
						<span className="plan-board-active" title={activeStep.title}>
							{activeStep.title}
						</span>
					)}
				</div>

				<div className="plan-board-actions">
					{/* 净室执行：开辟干净新会话执行 */}
					<button
						type="button"
						className="plan-board-clean-handoff"
						title={t("planCleanHandoffTip")}
						onClick={(e) => {
							e.stopPropagation();
							handleCleanHandoff();
						}}
					>
						{t("planCleanHandoffBtn")}
					</button>

					{/* 实施按钮：在当前会话执行 */}
					<button
						type="button"
						className="plan-board-implement"
						title={t("planImplementTip")}
						onClick={(e) => {
							e.stopPropagation();
							handleImplement();
						}}
					>
						{t("planImplementBtn")}
					</button>

					{/* 复制为 Markdown */}
					<button
						type="button"
						className="plan-board-iconbtn"
						title={copied ? t("planBoardExportSuccess") : t("planBoardExportMarkdown")}
						onClick={(e) => {
							e.stopPropagation();
							void handleExportMarkdown();
						}}
					>
						{copied ? <FiCheck style={{ color: "var(--green, #22c55e)" }} /> : <FiCopy />}
					</button>

					{/* 清空看板 */}
					<button
						type="button"
						className="plan-board-iconbtn"
						title={t("clear")}
						onClick={(e) => {
							e.stopPropagation();
							handleClearPlan();
						}}
					>
						<FiTrash2 />
					</button>

					{/* 展开/折叠 */}
					<button
						type="button"
						className="plan-board-iconbtn"
						title={expanded ? t("collapseSection") : t("expandSection")}
					>
						{expanded ? <FiChevronUp /> : <FiChevronDown />}
					</button>
				</div>
			</div>

			{/* 进度条 */}
			<div
				style={{
					height: 4,
					backgroundColor: "rgba(255, 255, 255, 0.08)",
					borderRadius: 2,
					margin: "8px 0",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						height: "100%",
						width: `${percent}%`,
						backgroundColor: percent === 100 ? "var(--green, #22c55e)" : "var(--accent, #38bdf8)",
						transition: "width 0.3s ease",
					}}
				/>
			</div>

			{/* 展开的完整步骤清单 */}
			{expanded && (
				<div className="plan-board-steps" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
					{steps.map((step, idx) => {
						const isCurrent = step.id === plan.activeStepId || step.status === "in_progress";
						const isEditing = editingId === step.id;

						if (isEditing) {
							return (
								<div
									key={step.id || idx}
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 6,
										padding: "8px 10px",
										borderRadius: 6,
										backgroundColor: "var(--bg-elev2, rgba(0, 0, 0, 0.2))",
										border: "1px solid var(--accent, #38bdf8)",
									}}
								>
									<input
										type="text"
										value={editTitle}
										onChange={(e) => setEditTitle(e.target.value)}
										placeholder={t("planBoardStepTitlePlaceholder")}
										style={{
											width: "100%",
											padding: "4px 8px",
											borderRadius: 4,
											border: "1px solid var(--border-subtle)",
											background: "var(--bg, #0b0f17)",
											color: "var(--text, #f1f5f9)",
											fontSize: 13,
										}}
										autoFocus
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.shiftKey) {
												e.preventDefault();
												saveEdit(step.id);
											} else if (e.key === "Escape") {
												cancelEdit();
											}
										}}
									/>
									<textarea
										rows={2}
										value={editDesc}
										onChange={(e) => setEditDesc(e.target.value)}
										placeholder={t("planBoardStepDescPlaceholder")}
										style={{
											width: "100%",
											padding: "4px 8px",
											borderRadius: 4,
											border: "1px solid var(--border-subtle)",
											background: "var(--bg, #0b0f17)",
											color: "var(--text-dim, #9aa1b4)",
											fontSize: 12,
											resize: "vertical",
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
												e.preventDefault();
												saveEdit(step.id);
											} else if (e.key === "Escape") {
												cancelEdit();
											}
										}}
									/>
									<div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
										<button
											type="button"
											className="plan-board-iconbtn"
											onClick={cancelEdit}
											title={t("cancel")}
											style={{ padding: "3px 8px", fontSize: 12 }}
										>
											<FiX /> {t("cancel")}
										</button>
										<button
											type="button"
											className="plan-board-implement"
											onClick={() => saveEdit(step.id)}
											title={t("confirm")}
											style={{ padding: "3px 10px", fontSize: 12 }}
										>
											<FiCheck /> {t("confirm")}
										</button>
									</div>
								</div>
							);
						}

						return (
							<div
								key={step.id || idx}
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									flexWrap: "wrap",
									rowGap: 4,
									minWidth: 0,
									padding: "6px 10px",
									borderRadius: 6,
									backgroundColor: isCurrent ? "rgba(56, 189, 248, 0.08)" : "var(--bg-elev2, rgba(0, 0, 0, 0.2))",
									border: isCurrent ? "1px solid rgba(56, 189, 248, 0.25)" : "1px solid transparent",
								}}
							>
								<div style={{ flex: "1 1 180px", minWidth: 0, paddingRight: 10 }}>
									<div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
										<span
											style={{
												fontSize: 11,
												fontWeight: 700,
												color: isCurrent ? "var(--accent, #38bdf8)" : "var(--text-dim, #9aa1b4)",
												minWidth: 16,
											}}
										>
											{idx + 1}.
										</span>
										<span
											style={{
												fontWeight: isCurrent ? 600 : 500,
												color: step.status === "done" ? "var(--text-dim, #9aa1b4)" : "var(--text, #f1f5f9)",
												textDecoration: step.status === "done" ? "line-through" : "none",
												minWidth: 0,
												overflowWrap: "anywhere",
												wordBreak: "break-word",
											}}
										>
											{step.title}
										</span>
									</div>
									{step.description && (
										<div
											style={{
												fontSize: 12,
												color: "var(--text-dim, #9aa1b4)",
												marginTop: 2,
												paddingLeft: 22,
												lineHeight: 1.4,
												overflowWrap: "anywhere",
												wordBreak: "break-word",
											}}
										>
											{step.description}
										</div>
									)}
								</div>

								<div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 2 }}>
									{getStatusBadge(step.status, step.id)}
									<button
										type="button"
										className="plan-board-iconbtn"
										title={t("planBoardEditStep")}
										onClick={() => startEdit(step)}
									>
										<FiEdit2 size={12} />
									</button>
									<button
										type="button"
										className="plan-board-iconbtn"
										title={t("planBoardDeleteStep")}
										onClick={() => handleDeleteStep(step.id)}
									>
										<FiTrash2 size={12} />
									</button>
								</div>
							</div>
						);
					})}

					{/* 底部新增步骤按钮 */}
					<button type="button" className="plan-board-add-btn" onClick={handleAddStep}>
						<FiPlus /> {t("planBoardAddStep")}
					</button>
				</div>
			)}
		</div>
	);
}
