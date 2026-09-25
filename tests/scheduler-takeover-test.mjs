// Integration regression: scheduler takeover remains interactive and tracks the original runtime.
// npm run build:server && node tests/scheduler-takeover-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8965);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-scheduler-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "scheduler-takeover-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "scheduler-takeover-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
let hold = true;
let heldResponse;
let scheduledFollowup = false;
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }),
		);
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	if (hold && JSON.stringify(payload.messages).includes("SCHEDULER-HELD")) {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(`data: ${JSON.stringify(delta(payload.model, { content: "SCHEDULER-STARTED" }))}\n\n`);
		heldResponse = res;
		return;
	}
	if (!scheduledFollowup && JSON.stringify(payload.messages).includes("CREATE-FOLLOWUP-SCHEDULE")) {
		scheduledFollowup = true;
		sse(res, [
			delta(payload.model, {
				tool_calls: [
					{
						index: 0,
						id: "call_schedule_followup",
						type: "function",
						function: {
							name: "schedule_task",
							arguments: JSON.stringify({
								schedule: "in 1h",
								prompt: "FOLLOWUP-TASK",
								label: "Followup after takeover",
								recurring: true,
							}),
						},
					},
				],
			}),
			delta(payload.model, {}, "tool_calls"),
		]);
		return;
	}
	sse(res, [delta(payload.model, { content: "SCHEDULER-CONTINUED" }), delta(payload.model, {}, "stop")]);
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.elsewhere = [];
		this.tasks = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "scheduler_tasks") {
				this.tasks = message.tasks;
			} else if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...(message.appended ?? [])];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let clientA;
let clientB;
try {
	await waitForPort(PORT);

	const openClient = async (clientId) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
		await c.waitForState((s) => s.model?.id === MODEL_ID);
		return c;
	};

	clientA = await openClient("scheduler-takeover-browser");
	clientA.send({ type: "prompt", text: "Keep browser conversation occupied" });
	const wait = async (label, predicate, timeout = 30000) => {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			if (predicate()) return;
			await sleep(50);
		}
		throw new Error(`Timeout: ${label}; notices=${JSON.stringify(clientA.notices())}`);
	};
	const text = () =>
		clientA.messages
			.flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).map((b) => b.text ?? "")))
			.join("\n");
	await wait("initial browser answer", () => text().includes("SCHEDULER-CONTINUED") && !clientA.state.isStreaming);
	const originalBrowserId = clientA.state.conversationId;
	const originalFile = clientA.conversations.find((c) => c.id === originalBrowserId)?.sessionFile;
	const taskId = "takeover-regression";
	const task = () => clientA.tasks.find((t) => t.id === taskId);
	clientA.send({
		type: "schedule_save",
		task: {
			id: taskId,
			name: "Takeover regression",
			cwd: workdir,
			kind: "interval",
			spec: "3600000",
			prompt: "SCHEDULER-HELD",
			model: `mock/${MODEL_ID}`,
			enabled: true,
		},
	});
	await wait("task saved", () => !!task());
	clientA.send({ type: "schedule_run", id: taskId });
	await wait(
		"headless stream started",
		() =>
			heldResponse &&
			task()?.running &&
			clientA.elsewhere.some((r) => r.owner === `scheduler:${taskId}` && r.isStreaming),
	);
	const row = clientA.elsewhere.find((r) => r.owner === `scheduler:${taskId}`);
	check("headless task starts with colliding conversation ID", row.convId === originalBrowserId);
	clientA.send({ type: "take_over_conversation", owner: row.owner, id: row.convId });
	await wait(
		"takeover succeeds",
		() =>
			clientA.state.conversationId !== originalBrowserId &&
			clientA.state.isStreaming &&
			text().includes("SCHEDULER-HELD"),
	);
	const movedId = clientA.state.conversationId;
	check("browser receives held live conversation with remapped ID", movedId !== row.convId);
	await wait(
		"task binding follows moved conversation",
		() => task()?.conversationId === movedId && !!task()?.sessionFile,
	);
	const movedFile = task().sessionFile;
	check(
		"scheduler binding retains transferred session file",
		clientA.conversations.find((c) => c.id === movedId)?.sessionFile === movedFile,
	);
	// Source now has a blank replacement. A source-active snapshot must not mark
	// the held runtime finished on the scheduler's two-second polling cycle.
	await sleep(2700);
	clientA.send({ type: "schedule_list" });
	await sleep(150);
	check("scheduler stays running after source replacement", task()?.running === true && task()?.lastRun === null);
	clientA.send({ type: "schedule_toggle", id: taskId, enabled: false });
	await wait("pause schedule", () => task()?.enabled === false);
	check("pause prevents future triggers without blocking current controls", task()?.running === true);
	hold = false;
	clientA.send({ type: "abort" });
	await wait(
		"abort transferred run",
		() => clientA.state.isStreaming === false && task()?.running === false && !!task()?.lastRun,
		20000,
	);
	check("completion history uses transferred ID", task().lastRun.conversationId === movedId);
	check("paused task keeps stable binding", task().sessionFile === movedFile && task().enabled === false);
	clientA.send({ type: "prompt", text: "Continue after takeover" });
	await wait(
		"continue in transferred conversation",
		() =>
			text().includes("Continue after takeover") &&
			text().includes("SCHEDULER-CONTINUED") &&
			!clientA.state.isStreaming,
	);
	check("browser can continue same transferred session", clientA.state.conversationId === movedId);
	clientA.send({ type: "prompt", text: "CREATE-FOLLOWUP-SCHEDULE" });
	await wait("new scheduled task after takeover", () =>
		clientA.tasks.some((t) => t.name === "Followup after takeover"),
	);
	const followup = clientA.tasks.find((t) => t.name === "Followup after takeover");
	check("schedule_task after takeover binds new owner ID", followup.conversationId === movedId);
	check("schedule_task after takeover binds original runtime session file", followup.sessionFile === movedFile);
	clientA.send({ type: "schedule_toggle", id: followup.id, enabled: false });
	await wait("pause test followup", () => clientA.tasks.find((t) => t.id === followup.id)?.enabled === false);

	check(
		"original browser transcript preserved on disk",
		!!originalFile && readFileSync(originalFile, "utf8").includes("Keep browser conversation occupied"),
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	server.kill();
	heldResponse?.destroy();
	mock.closeAllConnections();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
}
process.exit(failures === 0 ? 0 : 1);
