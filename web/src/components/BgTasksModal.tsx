import { useEffect, useState } from "react";
import { FiClock, FiLayers, FiPause, FiPlay, FiRefreshCw, FiSquare, FiTerminal, FiTrash2, FiX } from "react-icons/fi";
import type { BgServer, SchedulerTaskView } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { Modal } from "./Modal";

interface BgTasksModalProps {
	servers: BgServer[];
	tasks: SchedulerTaskView[];
	onClose: () => void;
}

/** Relative time for a bg task's `since` stamp (ms epoch). */
function formatSince(since: number, t: ReturnType<typeof useT>): string {
	const ms = Math.max(0, Date.now() - since);
	const min = Math.floor(ms / 60_000);
	if (min < 1) return t("bgTaskJustNow");
	if (min < 60) return t("bgTaskMinutes", { n: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("bgTaskHours", { n: hr });
	return t("bgTaskDays", { n: Math.floor(hr / 24) });
}

/** Background processes/plugins and persisted schedules share this management surface.
 * Schedules remain visible while disabled; pausing future triggers does not abort a live conversation.
 */
export function BgTasksModal({ servers, tasks, onClose }: BgTasksModalProps) {
	const t = useT();
	// Which tasks have their command line expanded (default: one truncated line
	// + hover tooltip; click toggles full wrap so long commands stay readable).
	// 插件任务无 port——用 taskId 作展开键。
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const toggleCmd = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	// Ask the server for a fresh list (it prunes dead entries) on open.
	useEffect(() => {
		appSend({ type: "list_bg_servers" });
		appSend({ type: "schedule_list" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<Modal className="bg-task-modal" onClose={onClose} showCloseButton={false}>
			<div className="bg-task-head">
				<span className="bg-task-title">
					<FiLayers /> {t("bgTasks")}
					{servers.length + tasks.length > 0 && <em className="bg-task-count">{servers.length + tasks.length}</em>}
				</span>
				<button type="button" className="btn" title={t("close")} onClick={onClose}>
					<FiX />
				</button>
			</div>

			{tasks.length > 0 && <p className="bg-task-hint">{t("bgScheduledHint")}</p>}
			{servers.length === 0 && tasks.length === 0 ? (
				<div className="bg-task-empty">
					<FiLayers />
					<span>{t("bgTasksEmpty")}</span>
					<small>{t("bgTasksDesc")}</small>
				</div>
			) : (
				<ul className="bg-task-list">
					{tasks.map((task) => (
						<li
							key={`schedule:${task.id}`}
							data-schedule-id={task.id}
							className={`bg-task-item bg-task-scheduled ${task.enabled ? "" : "off"}`}
						>
							<FiClock className="bg-task-schedule-icon" />
							<div className="bg-task-info">
								<div className="bg-task-line1">
									<strong className="bg-task-schedule-name">{task.name}</strong>
									<span className="bg-task-status">
										{task.enabled ? t("schedulerEnabled") : t("schedulerDisabled")}
									</span>
									{task.running && <span className="bg-task-status">{t("schedulerRunning")}</span>}
								</div>
								<div className="bg-task-line2">
									<span>{task.id}</span>
									<span title={task.cwd}>{task.cwd}</span>
									<span>
										{task.kind === "cron"
											? `cron ${task.spec}`
											: `${t("schedulerKindInterval")} · ${Number(task.spec) / 1000}s`}
									</span>
								</div>
								<div className="bg-task-line2">
									<span>
										{t("schedulerNextFire")}: {task.nextFire ? new Date(task.nextFire).toLocaleString() : "—"}
									</span>
								</div>
								<div className="bg-task-controls">
									<button
										type="button"
										className="btn"
										title={task.enabled ? t("schedulerDisable") : t("schedulerEnable")}
										onClick={() => appSend({ type: "schedule_toggle", id: task.id, enabled: !task.enabled })}
									>
										{task.enabled ? <FiPause /> : <FiPlay />}
										{task.enabled ? t("schedulerDisable") : t("schedulerEnable")}
									</button>
									<button
										type="button"
										className="btn"
										title={t("schedulerRunNow")}
										disabled={task.running}
										onClick={() => appSend({ type: "schedule_run", id: task.id })}
									>
										<FiPlay /> {t("schedulerRunNow")}
									</button>
									<button
										type="button"
										className="btn"
										title={t("schedulerDelete")}
										onClick={() => {
											if (
												window.confirm(`${t("schedulerConfirmDelete", { name: task.name })}\n${t("bgScheduledHint")}`)
											)
												appSend({ type: "schedule_delete", id: task.id });
										}}
									>
										<FiTrash2 /> {t("schedulerDelete")}
									</button>
								</div>
							</div>
						</li>
					))}
					{servers.map((s) => {
						// 插件任务（registerBackgroundTask）没有端口/pid——键与展示按 taskId。
						const isPlugin = !!s.taskId;
						const key = s.taskId ? `plugin:${s.taskId}` : `port:${s.port}`;
						return (
							<li key={key} className="bg-task-item">
								<span className="bg-task-icon" title={isPlugin ? s.plugin : t("bgTaskPort")} />
								<div className="bg-task-info">
									<div className="bg-task-line1">
										{isPlugin ? (
											<span className="bg-task-port" title={s.taskId}>
												🧩 {s.plugin}
											</span>
										) : (
											<span className="bg-task-port">:{s.port}</span>
										)}
										{s.name && <span className="bg-task-name">{s.name}</span>}
									</div>
									<div className="bg-task-line2">
										{!isPlugin && (
											<span>
												{t("bgTaskPid")} {s.pid}
											</span>
										)}
										<span>
											{t("bgTaskSince")} {formatSince(s.since, t)}
										</span>
										{isPlugin && s.status && <span className="bg-task-status">{s.status}</span>}
									</div>
									{s.command && (
										<button
											type="button"
											className={`bg-task-cmd ${expanded.has(key) ? "open" : ""}`}
											title={`${t("bgTaskCommand")}: ${s.command}`}
											onClick={() => toggleCmd(key)}
										>
											<FiTerminal />
											<code>{s.command}</code>
										</button>
									)}
								</div>
								<button
									type="button"
									className="btn bg-task-stop"
									title={t("bgTaskStop")}
									onClick={() =>
										isPlugin
											? appSend({ type: "kill_background_server", taskId: s.taskId })
											: appSend({ type: "kill_background_server", port: s.port })
									}
								>
									<FiSquare />
									<span>{t("bgTaskStop")}</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}

			<div className="bg-task-foot">
				<button
					type="button"
					className="btn"
					title={t("bgTaskRefresh")}
					onClick={() => {
						appSend({ type: "list_bg_servers" });
						appSend({ type: "schedule_list" });
					}}
				>
					<FiRefreshCw />
					<span>{t("bgTaskRefresh")}</span>
				</button>
				{servers.length > 0 && (
					<button
						type="button"
						className="btn bg-task-stopall"
						disabled={servers.length === 0}
						title={t("bgTaskStopProcesses")}
						onClick={() => appSend({ type: "kill_background_servers" })}
					>
						<FiSquare />
						<span>{t("bgTaskStopProcesses")}</span>
					</button>
				)}
			</div>
		</Modal>
	);
}
