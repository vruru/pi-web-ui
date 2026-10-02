/**
 * Local control socket for the pi-web-ui server.
 *
 * Lets the CLI (and humans) query status and quiesce/unquiesce the server
 * WITHOUT opening a network port or exposing an unauthenticated HTTP
 * endpoint. Only the local OS user can reach it:
 *   - POSIX: a mode-0600 Unix domain socket at <dataDir>/pi-web-ui.sock
 *   - Windows: a named pipe  \\.\pipe\pi-web-ui-<port>
 *
 * Protocol: one JSON object per line.
 *   → {"cmd":"status"}        ← {"ok":true, ...serviceStatus}
 *   → {"cmd":"quiesce"}       ← {"ok":true}
 *   → {"cmd":"unquiesce"}     ← {"ok":true}
 *   → anything else           ← {"ok":false,"error":"..."}
 *
 * Idle connections are closed after a short timeout so a stuck CLI never
 * holds the socket.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentService } from "./agent-service.js";
import type { UiServiceInfo } from "./protocol.js";

/** 探测既有 socket 的超时：活实例对 connect 的响应是内核级的，300ms 足够。 */
const CONTROL_PROBE_TIMEOUT_MS = 300;

/** 控制路径探测：连得上（有活实例在 listen）→ null；失败 → errno
 *  （ECONNREFUSED/ENOENT = 崩溃残留，可安全删除）。超时按「可能是活实例」
 *  保守处理，返回超时码 —— 宁可不删残留也别摘掉正在服务的 socket。 */
function probeControlPath(path: string): Promise<string | null> {
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish("ETIMEDOUT"), CONTROL_PROBE_TIMEOUT_MS);
		sock.once("connect", () => finish(null));
		sock.once("error", (err: NodeJS.ErrnoException) => finish(err.code ?? "EUNKNOWN"));
	});
}

/** 控制 socket 只需服务状态与 quiesce 控制（pi/dsh 引擎都满足）。 */
type ControlService = Pick<AgentService, "serviceStatus" | "quiesce" | "unquiesce">;

/** How long a control connection may sit idle before the server closes it. */
const CONTROL_IDLE_TIMEOUT_MS = 5_000;

/** How long the CLI waits for a reply before giving up. */
const CONTROL_CLIENT_TIMEOUT_MS = 3_000;

/** Socket path (POSIX) or pipe name (Windows). */
export function controlPath(dataDir: string, port: number): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

export interface ControlCommand {
	cmd: "status" | "quiesce" | "unquiesce";
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	/** serviceStatus fields, present on "status". */
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	activeConversations?: number;
	pendingMessages?: number;
	/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 显示启动方式。 */
	service?: UiServiceInfo | null;
}

/** Start the control socket; returns a stop function. */
export function startControlServer(opts: { service: ControlService; dataDir: string; port: number }): () => void {
	const { service, dataDir, port } = opts;
	const path = controlPath(dataDir, port);
	let server: Server;
	// 只有本实例真正 bind 成功才允许 stop 时删 socket 文件：探测发现活实例而
	// listen 失败时，path 上是对方的 socket，删了会让后续客户端全部失联。
	let bound = false;

	if (process.platform === "win32") {
		// Windows named pipe 不落盘（最后一个句柄关闭即消失），不存在崩溃残留
		// 文件可清理；撞上活实例时 listen 直接 EADDRINUSE，走下方统一 error
		// 处理。无需探测。
		server = createServer(handleConnection);
		server.listen(path, () => {
			bound = true;
			console.log(`  control    : ${path}`);
		});
	} else {
		server = createServer(handleConnection);
		// POSIX socket 文件崩溃后会残留，但先探测再删：无条件 rmSync 会把正在
		// 服务的实例（比如被新的 pi-web 抢占前仍在跑的旧实例）的 socket 文件摘
		// 走，新旧实例互相踩。只有连不上的残留（ECONNREFUSED/ENOENT）才删；
		// 探测超时保守当作活实例，让 listen 自己以 EADDRINUSE 失败告警。
		void probeControlPath(path).then((probeErr) => {
			if (probeErr && existsSync(path)) {
				try {
					rmSync(path);
				} catch {
					/* best-effort */
				}
			}
			server.listen(path, () => {
				bound = true;
				try {
					chmodSync(path, 0o600);
				} catch {
					/* best-effort */
				}
				console.log(`  control    : ${path}`);
			});
		});
	}
	// A second instance on the same data dir / port would fail to bind — don't
	// crash the server over it, just log and run without a control socket.
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(`[control] socket ${path} already in use — control socket disabled`);
		} else {
			console.warn(`[control] socket error: ${err.message}`);
		}
	});

	function handleConnection(sock: Socket): void {
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
		}, CONTROL_IDLE_TIMEOUT_MS);
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				timer.refresh();
				let req: ControlCommand;
				try {
					req = JSON.parse(line) as ControlCommand;
				} catch {
					sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
					continue;
				}
				let resp: ControlStatus;
				switch (req.cmd) {
					case "status":
						resp = { ok: true, ...service.serviceStatus() };
						break;
					case "quiesce":
						service.quiesce();
						resp = { ok: true };
						break;
					case "unquiesce":
						service.unquiesce();
						resp = { ok: true };
						break;
					default:
						resp = { ok: false, error: `unknown cmd: ${String((req as { cmd?: unknown }).cmd)}` };
						break;
				}
				sock.write(JSON.stringify(resp) + "\n");
			}
		});
		sock.on("error", () => {
			/* client vanished */
		});
		sock.on("close", () => clearTimeout(timer));
	}

	return () => {
		server.close();
		try {
			if (process.platform !== "win32" && bound && existsSync(path)) rmSync(path);
		} catch {
			/* best-effort */
		}
	};
}

/**
 * CLI-side client: send one command and return the parsed reply (or null if
 * the server is unreachable / timed out).
 */
export function sendControlCommand(
	dataDir: string,
	port: number,
	cmd: ControlCommand["cmd"],
): Promise<ControlStatus | null> {
	const path = controlPath(dataDir, port);
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v: ControlStatus | null): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), CONTROL_CLIENT_TIMEOUT_MS);
		let buf = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ cmd }) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)) as ControlStatus);
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}
