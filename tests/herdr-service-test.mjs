// Opt-in local integration: real Herdr + Pi processes, local mock provider, no paid tokens.
// PI_HERDR_EXTENSION must point to the installed pi-herdr-agents index.ts.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";
const ext = process.env.PI_HERDR_EXTENSION;
if (!ext) throw Error("Set PI_HERDR_EXTENSION to the installed Herdr extension");
const root = mkdtempSync(join(tmpdir(), "pi-herdr-smoke-"));
const agent = join(root, "agent"),
	data = join(root, "data"),
	project = join(root, "project");
for (const d of [agent, data, project]) mkdirSync(d);
const port = Number(process.env.PI_HERDR_TEST_PORT || 8991);
let childRequests = 0,
	spawned = false,
	delivery = false;
const mock = createServer(async (req, res) => {
	let text = "";
	for await (const c of req) text += c;
	if (!text) {
		res.writeHead(200).end(JSON.stringify({ data: [] }));
		return;
	}
	const body = JSON.parse(text);
	const msgs = body.messages || [];
	const last = msgs.filter((m) => m.role === "user").at(-1);
	const child = JSON.stringify(last).includes("HERDR_CHILD_PROBE");
	const full = JSON.stringify(msgs);
	if (full.includes("HERDR_CHILD_OK")) delivery = true;
	let delta, finish;
	if (child) {
		childRequests++;
		delta = { content: "HERDR_CHILD_OK" };
		finish = "stop";
	} else if (!spawned) {
		spawned = true;
		delta = {
			tool_calls: [
				{
					index: 0,
					id: "probe_spawn",
					type: "function",
					function: {
						name: "subagent",
						arguments: JSON.stringify({
							name: "connectivity-probe",
							task: "HERDR_CHILD_PROBE: Reply with a short connectivity acknowledgement. Do not call tools.",
						}),
					},
				},
			],
		};
		finish = "tool_calls";
	} else {
		delta = { content: delivery ? "DELIVERY_OK" : "PARENT_WAITING" };
		finish = "stop";
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [d, f] of [
		[delta, null],
		[{}, finish],
	])
		res.write(
			"data: " +
				JSON.stringify({
					id: "probe",
					object: "chat.completion.chunk",
					model: body.model,
					choices: [{ index: 0, delta: d, finish_reason: f }],
				}) +
				"\n\n",
		);
	res.end("data: [DONE]\n\n");
});
await new Promise((r) => mock.listen(port + 1, "127.0.0.1", r));
writeFileSync(
	join(agent, "settings.json"),
	JSON.stringify({ extensions: [ext], defaultProvider: "mock", defaultModel: "probe" }),
);
writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "local-test" } }));
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${port + 1}`,
				apiKey: "local-test",
				models: [
					{ id: "probe", name: "Probe", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 1024 },
				],
			},
		},
	}),
);
const server = spawn(
	process.execPath,
	["bin/herdr-service.mjs", process.execPath, join(process.cwd(), "dist/server/index.js")],
	{
		env: {
			...process.env,
			PI_WEB_HERDR_SESSION: "pi-web-ui-test",
			PI_WEB_PORT: String(port),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: project,
			PI_WEB_DATA_DIR: data,
			PI_CODING_AGENT_DIR: agent,
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
server.stdout.on("data", (x) => process.stdout.write(x));
server.stderr.on("data", (x) => process.stderr.write(x));
class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta" && this.state && this.state.rev === message.baseRev) {
				this.state = {
					...this.state,
					...message.state,
					messages: [...this.state.messages, ...(message.appended ?? [])],
				};
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	seen(type, predicate = () => true) {
		return this.received.filter((m) => m.type === type && predicate(m));
	}
	async waitForState(predicate, timeout = 60000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForType(type, predicate = () => true, timeout = 40000) {
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
		throw new Error(`timeout waiting for ${type}`);
	}
}

let ws;
try {
	for (let n = 0; n < 200; n++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
		} catch {}
		await sleep(100);
	}
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId: "herdr-smoke", locale: "en" });
	await client.waitForType("ready");
	await client.waitForType("snapshot");
	client.send({ type: "set_model", modelId: "mock/probe" });
	await client.waitForState((s) => s.model?.id === "probe");
	client.send({ type: "prompt", text: "Run the local connectivity test." });
	try {
		await client.waitForState((s) => JSON.stringify(s.messages).includes("DELIVERY_OK"), 90000);
	} catch (e) {
		console.log("STATE", JSON.stringify(client.state?.messages));
		throw e;
	}
	assert(childRequests >= 1, "Child Pi reached local provider");
	assert(delivery, "Child result delivered to parent");
	console.log("PASS: Herdr spawn, inherited model, child execution, result delivery");
} finally {
	ws?.close();
	server.kill("SIGTERM");
	await new Promise((r) => {
		server.once("exit", r);
		setTimeout(r, 7000);
	});
	mock.close();
	console.log("Test artifacts:", root);
}
