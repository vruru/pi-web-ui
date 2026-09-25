// Integration regression: scheduler takeover remains interactive and tracks the original runtime.
// npm run build:server && node tests/subagent-resume-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8982);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-subagent-resume-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "subagent-resume-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "subagent-resume-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const held = new Map();
let autoResumes = 0;
const textOf = (m) =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((x) => x.text ?? "").join("\n");
const tool = (res, model, name, args) =>
	sse(res, [
		delta(model, {
			tool_calls: [
				{
					index: 0,
					id: `call_${name}_${Date.now()}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		}),
		delta(model, {}, "tool_calls"),
	]);
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const p = JSON.parse(body || "{}");
	const msgs = p.messages ?? [];
	const first = msgs.find((m) => m.role === "user");
	const task = textOf(first ?? {});
	if (task.startsWith("CHILD-")) {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify(delta(p.model, { content: "child working" }))}\n\n`);
		held.set(task, { res, model: p.model });
		return;
	}
	const last = msgs.at(-1);
	const lastText = textOf(last ?? {});

	if (last?.role === "user" && lastText.startsWith("PARENT-"))
		return tool(res, p.model, "subagent_spawn", { prompt: lastText.replace("PARENT-", "CHILD-") });
	if (last?.role === "tool" && lastText.includes("Subagent started")) {
		if (task === "PARENT-WAIT") {
			const runId = lastText.match(/sa-[a-z0-9]+/)?.[0];
			return tool(res, p.model, "subagent_wait_all", { runIds: [runId], timeoutSeconds: 10 });
		}
		return sse(res, [delta(p.model, { content: "WAITING-FOR-CHILD" }), delta(p.model, {}, "stop")]);
	}
	if (lastText.includes("Subagent results are ready.")) autoResumes++;
	sse(res, [
		delta(p.model, {
			content: lastText.includes("Subagent results are ready.") ? "AUTO-INTEGRATED-RESULT" : "NORMAL-FINISHED",
		}),
		delta(p.model, {}, "stop"),
	]);
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

const until = async (fn, label) => {
	for (let i = 0; i < 300; i++) {
		if (fn()) return;
		await sleep(50);
	}
	throw Error(label);
};
const release = (key) => {
	const { res, model } = held.get(key);
	res.write(`data: ${JSON.stringify(delta(model, { content: " CHILD-RESULT" }))}\n\n`);
	res.write(`data: ${JSON.stringify(delta(model, {}, "stop"))}\n\n`);
	res.end("data: [DONE]\n\n");
	held.delete(key);
};
let client;
let other;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	client = new Client(ws, "resume-browser");
	client.send({ type: "hello", clientId: "resume-browser", locale: "en" });
	await client.waitForType("ready");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await client.waitForState((s) => s.model?.id === MODEL_ID);
	client.send({ type: "prompt", text: "PARENT-IDLE" });
	await until(
		() =>
			held.has("CHILD-IDLE") &&
			client.messages.some((m) => JSON.stringify(m).includes("WAITING-FOR-CHILD")) &&
			!client.state.isStreaming,
		"parent should end while child runs",
	);
	const parentId = client.state.conversationId;
	client.send({ type: "new_chat" });
	await client.waitForState((s) => s.conversationId !== parentId);
	const foreground = client.state.conversationId;
	release("CHILD-IDLE");
	await until(() => autoResumes === 1, "idle background parent should automatically resume");
	if (client.state.conversationId !== foreground) throw Error("auto-resume switched foreground");
	client.send({ type: "switch_conversation", id: parentId });
	await client.waitForState((s) => s.conversationId === parentId);
	await until(
		() => client.messages.some((m) => JSON.stringify(m).includes("AUTO-INTEGRATED-RESULT")),
		"parent should integrate result",
	);
	console.log("PASS idle parent auto resumes in background with child result");
	client.send({ type: "new_chat" });
	await client.waitForState((s) => s.conversationId !== parentId);
	client.send({ type: "prompt", text: "PARENT-WAIT" });
	await until(() => held.has("CHILD-WAIT"), "wait child starts");
	release("CHILD-WAIT");
	await until(
		() => client.messages.some((m) => JSON.stringify(m).includes("NORMAL-FINISHED")) && !client.state.isStreaming,
		"wait returns normally",
	);
	await sleep(400);
	if (autoResumes !== 1) throw Error("wait_all result caused duplicate wake");
	console.log("PASS wait_all consumes completion without duplicate automatic turn");
	const previous = client.state.conversationId;
	client.send({ type: "new_chat" });
	await client.waitForState((s) => s.conversationId !== previous);
	client.send({ type: "prompt", text: "PARENT-STOP" });
	await until(() => held.has("CHILD-STOP") && !client.state.isStreaming, "stop child starts");
	client.send({ type: "abort" });
	await sleep(300);
	release("CHILD-STOP");
	await sleep(500);
	if (autoResumes !== 1) throw Error("explicit stop was auto resumed");
	console.log("PASS explicit parent stop suppresses late child wake");
	const stoppedId = client.state.conversationId;
	client.send({ type: "new_chat" });
	await client.waitForState((s) => s.conversationId !== stoppedId);
	client.send({ type: "prompt", text: "PARENT-TRANSFER" });
	await until(
		() =>
			held.has("CHILD-TRANSFER") &&
			client.messages.some((m) => JSON.stringify(m).includes("WAITING-FOR-CHILD")) &&
			!client.state.isStreaming,
		"transfer child starts",
	);
	const transferredId = client.state.conversationId;
	const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r, j) => {
		ws2.once("open", r);
		ws2.once("error", j);
	});
	other = new Client(ws2, "other-browser");
	other.send({ type: "hello", clientId: "other-browser", locale: "en" });
	await other.waitForType("ready");
	other.send({ type: "take_over_conversation", owner: "resume-browser", id: transferredId });
	await other.waitForState((s) => s.messages.some((m) => JSON.stringify(m).includes("PARENT-TRANSFER")));
	release("CHILD-TRANSFER");
	await until(() => autoResumes === 2, "transferred parent resumes");
	await until(
		() => other.messages.some((m) => JSON.stringify(m).includes("AUTO-INTEGRATED-RESULT")),
		"new browser receives integrated result",
	);
	console.log("PASS completion follows transferred parent and child into another browser");
} finally {
	client?.ws.close();
	other?.ws.close();
	for (const { res } of held.values()) res.destroy();
	server.kill("SIGTERM");
	mock.closeAllConnections();
	await new Promise((r) => mock.close(r));
}
