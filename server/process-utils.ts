/**
 * process-utils — 跨平台进程工具：监听端口快照、进程树查杀、进程名查询。
 * 后台任务面板（bgServers）用它们检测/停止 agent 在后台拉起的服务。
 * 从 agent-service.ts 抽出，行为保持不变。全平台 best-effort：失败静默。
 */

/**
 * Snapshot currently LISTENING TCP ports → owning pid. Windows: netstat;
 * POSIX: lsof. Used to detect servers the agent started in the background
 * (the bash tool itself exits, leaving e.g. `npm run dev &` listening).
 */
export async function snapshotListeningPorts(): Promise<Map<number, number>> {
	const m = new Map<number, number>();
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 8000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				// TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 12345
				if (p.length >= 5 && p[0] === "TCP" && p[3] === "LISTENING") {
					const port = Number(p[1].split(":").pop());
					const pid = Number(p[4]);
					if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
				}
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeout: 8000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/).slice(1)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 9) {
					// NAME column tail: "*:5173 (LISTEN)" or "[::1]:5173 (LISTEN)"
					const mm = (p[p.length - 1] ?? "").match(/(\d+)\)?\s*$/);
					const port = mm ? Number(mm[1]) : NaN;
					const pid = Number(p[1]);
					if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
				}
			}
		}
	} catch {
		// best effort — snapshot failure just means no tracking this round
	}
	return m;
}

/**
 * Snapshot every process's parent pid → Map<pid, ppid>. Windows: one
 * PowerShell CIM pass (avoids spawning PowerShell once per pid); POSIX:
 * one `ps -Ao pid=,ppid=` pass. Returns undefined when the whole query
 * fails — callers should treat that as "cannot verify, stay conservative".
 */
export async function snapshotProcessParents(): Promise<Map<number, number> | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		const m = new Map<number, number>();
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId):$($_.ParentProcessId)" }',
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const [pid, ppid] = line.trim().split(":").map(Number);
				if (Number.isFinite(pid) && Number.isFinite(ppid)) m.set(pid, ppid);
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("ps", ["-Ao", "pid=,ppid="], { timeout: 5000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 2) {
					const pid = Number(p[0]);
					const ppid = Number(p[1]);
					if (Number.isFinite(pid) && Number.isFinite(ppid)) m.set(pid, ppid);
				}
			}
		}
		return m;
	} catch {
		return undefined;
	}
}

/** Kill a pid and its whole process tree (cross-platform).
 *
 * The returned promise is only meaningful on Windows, where taskkill is itself
 * asynchronous. Existing callers may continue to ignore it for best-effort
 * background cleanup; callers that own a deadline can await completion. */
export async function killPidTree(pid: number): Promise<void> {
	// pid 下界防护：pid<=1（init / Windows System 级 pid）或自身 pid 绝不能杀 ——
	// POSIX 的 -pid 是进程组语义，误传 0/1/自身 pid 会杀掉整组无辜进程甚至本进程。
	if (!(pid > 1 && pid !== process.pid)) return;
	try {
		if (process.platform === "win32") {
			const { spawn } = await import("node:child_process");
			await new Promise<void>((resolve) => {
				const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.once("error", () => resolve());
				killer.once("close", () => resolve());
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
}

/** Best-effort full command line of a pid (PowerShell CIM on win32 — wmic is
 *  gone on recent Win11 builds; ps -o command= on POSIX). Returns undefined
 *  when the process is gone or the lookup fails. */
export async function lookupProcessCommandLine(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			// CIM query is slower (~1s) than tasklist but this is a one-shot
			// best-effort probe fired once per detected background server.
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			const line = out.trim();
			return line || undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const line = out.trim();
		return line || undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort process name for a pid (tasklist on win32, ps on POSIX).
 *  Returns undefined when the process is gone or the lookup fails. */
export async function lookupProcessName(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"tasklist",
					["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
					{ windowsHide: true, timeout: 4000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			// CSV: "node.exe","12345",...
			const m = out.match(/"([^"]+)"/);
			return m ? m[1] : undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const name = out.trim();
		return name || undefined;
	} catch {
		return undefined;
	}
}
