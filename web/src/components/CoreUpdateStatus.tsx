import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiArrowUpCircle, FiRefreshCw, FiX } from "react-icons/fi";
import { appSend } from "../app-globals";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import {
	claimCoreUpdateNotice,
	isCoreUpdateRunning,
	setCoreUpdateState,
	useCoreUpdateState,
} from "../core-update-state";
import type { CoreUpdateState } from "../types";

export function CoreUpdateStatus({
	connected,
	status,
	allowAutoNotice = true,
}: {
	connected: boolean;
	status: string;
	allowAutoNotice?: boolean;
}) {
	const t = useT();
	const state = useCoreUpdateState();
	const [open, setOpen] = useState(false);
	const [requested, setRequested] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const id = useId();
	const running = isCoreUpdateRunning(state);
	const { panelRef, style, measure } = useFloatingPanel({
		open,
		anchor,
		align: "left",
		side: "top",
		onClose: () => setOpen(false),
	});
	useEffect(() => {
		if (
			allowAutoNotice &&
			connected &&
			state?.updateAvailable &&
			state.latestVersion &&
			claimCoreUpdateNotice(state.latestVersion)
		)
			setOpen(true);
	}, [allowAutoNotice, connected, state?.updateAvailable, state?.latestVersion]);
	useEffect(() => {
		setRequested(false);
	}, [state]);
	useEffect(() => {
		if (!requested) return;
		const timer = setTimeout(() => setRequested(false), 10000);
		return () => clearTimeout(timer);
	}, [requested]);
	useEffect(() => {
		if (open) measure();
	});
	// During quiescing/restart the chat socket may not attach. The read-only HTTP
	// status remains available before and after restart, without creating sessions.
	useEffect(() => {
		if (connected) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const abort = new AbortController();
		const poll = async () => {
			try {
				const response = await fetch(withToken(appUrl("/api/core-update")), {
					signal: abort.signal,
					cache: "no-store",
				});
				if (response.ok) {
					const next = (await response.json()) as CoreUpdateState;
					if (!stopped) setCoreUpdateState(next);
				}
			} catch {
				/* Expected while the process is restarting; retain last progress. */
			}
			if (!stopped && (open || running)) timer = setTimeout(poll, 2000);
		};
		void poll();
		return () => {
			stopped = true;
			abort.abort();
			clearTimeout(timer);
		};
	}, [connected, open, running]);

	const phase = state?.job?.phase;
	const connClass = connected ? "ok" : status === "closed" ? "error" : "busy";
	const connLabel = connected ? t("connected") : status === "closed" ? t("reconnecting") : t("connecting");
	const label = running || requested ? t("coreUpdateUpdating") : connLabel;
	const progress = requested
		? t("coreUpdateStarting")
		: phase === "installing"
			? t("coreUpdateInstalling")
			: phase === "restarting"
				? t("coreUpdateRestarting")
				: !connected
					? t("coreUpdateReconnecting")
					: null;
	const check = () => appSend({ type: "check_core_update", force: true });
	return (
		<>
			<button
				ref={anchor}
				type="button"
				className={`status-item status-conn core-update-trigger ${running ? "busy" : connClass}`}
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				aria-haspopup="dialog"
				title={t("coreUpdateTitle")}
				onClick={() => {
					setOpen(!open);
					if (!open && connected && !state?.checkedAt && !state?.checking) check();
				}}
			>
				<span className={`status-dot ${running ? "busy" : connClass}`} />
				<span className="status-conn-label">{label}</span>
				{state?.updateAvailable && !running && (
					<FiArrowUpCircle className="core-update-badge" aria-label={t("coreUpdateAvailable")} />
				)}
			</button>
			{open &&
				createPortal(
					<div
						id={id}
						ref={panelRef}
						style={style}
						className="core-update-popover"
						role="dialog"
						aria-label={t("coreUpdateTitle")}
					>
						<header>
							<strong>{t("coreUpdateTitle")}</strong>
							<button
								type="button"
								className="core-update-close"
								aria-label={t("close")}
								onClick={() => setOpen(false)}
							>
								<FiX />
							</button>
						</header>
						<dl>
							<div>
								<dt>{t("coreUpdateRunningVersion")}:</dt>
								<dd>{state?.currentVersion ?? "—"}</dd>
							</div>
							<div>
								<dt>{t("coreUpdateLatestVersion")}:</dt>
								<dd>{state?.latestVersion ?? "—"}</dd>
							</div>
						</dl>
						{progress && (
							<p className="core-update-progress" role="status">
								{progress}
							</p>
						)}
						{state?.job?.error && <p className="core-update-error">{state.job.error}</p>}
						{state?.checkError && (
							<p className="core-update-error">
								{t("coreUpdateCheckFailed")}: {state.checkError}
							</p>
						)}
						<p className="core-update-checked">
							{t("coreUpdateCheckedAt")}:{" "}
							{state?.checkedAt
								? new Date(state.checkedAt).toLocaleString(undefined, {
										year: "numeric",
										month: "numeric",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
										hour12: false,
									})
								: "—"}
						</p>
						<div className="core-update-actions">
							<button type="button" disabled={!connected || state?.checking || running || requested} onClick={check}>
								<FiRefreshCw />
								{t("coreUpdateCheck")}
							</button>
							<button
								type="button"
								className="primary"
								title={state?.busyReason ?? state?.unsupportedReason}
								disabled={
									!connected ||
									!state?.canUpdate ||
									!state.updateAvailable ||
									!!state.busyReason ||
									running ||
									requested
								}
								onClick={() => {
									setRequested(true);
									appSend({ type: "update_pi_core" });
								}}
							>
								{t("coreUpdateInstall")}
							</button>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
