// Real SDK queue delivery with a local multimodal provider; no paid tokens.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";

const root = mkdtempSync(join(tmpdir(), "pi-queue-attachments-"));
const agent = join(root, "agent"),
	data = join(root, "data"),
	project = join(root, "project");
for (const d of [agent, data, project]) mkdirSync(d);
const port = 9011;
const requests = [];
let releaseFirst;
const gate = new Promise((resolve) => {
	releaseFirst = resolve;
});
const mock = createServer(async (req, res) => {
	let text = "";
	for await (const c of req) text += c;
	if (!text) {
		res.writeHead(200).end(JSON.stringify({ data: [] }));
		return;
	}
	const body = JSON.parse(text);
	requests.push(body);
	if (requests.length === 1) await gate;
	const delta = { content: "QUEUE_RESPONSE_" + requests.length };
	const finish = "stop";
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
	JSON.stringify({ extensions: [], defaultProvider: "mock", defaultModel: "probe" }),
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
					{
						id: "probe",
						name: "Probe",
						input: ["text", "image"],
						reasoning: false,
						contextWindow: 32000,
						maxTokens: 1024,
					},
				],
			},
		},
	}),
);
const server = spawn(
	process.execPath,
	[
		"--import",
		process.env.PI_QUEUE_SDK_HOOK || join(process.cwd(), "dist/server/resolve-global-sdk.js"),
		join(process.cwd(), "dist/server/index.js"),
	],
	{
		env: {
			...process.env,
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
	client.send({ type: "prompt", text: "initial" });
	for (let n = 0; n < 100 && !requests.length; n++) await sleep(50);
	assert.equal(requests.length, 1);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvN0AAAAASUVORK5CYII=";
	writeFileSync(join(project, "fixture.txt"), "QUEUED_FILE_SENTINEL");
	const attachments = [
		{ path: "pixel.png", imageData: png, mimeType: "image/png", name: "pixel.png" },
		{ path: "fixture.txt", mode: "inline" },
		{
			path: "",
			fileData: Buffer.from("UPLOADED_FILE_SENTINEL").toString("base64"),
			name: "upload.txt",
			mimeType: "text/plain",
		},
	];
	client.send({ type: "prompt", text: "REMOVE_ME", queue: true });
	await client.waitForState((s) => s.queue.followUp.length === 1);
	client.send({ type: "prompt", text: "FOLLOW_WITH_ATTACHMENTS", queue: true, attachments });
	await client.waitForState((s) => s.queue.followUp.length === 2);
	client.send({ type: "prompt", text: "STEER_WITH_ATTACHMENTS", attachments });
	await client.waitForState((s) => s.queue.steering.length === 1);
	client.send({ type: "queue_remove", kind: "followUp", text: "REMOVE_ME", index: 0 });
	await client.waitForState((s) => s.queue.followUp.length === 1);
	releaseFirst();
	await client.waitForState((s) => JSON.stringify(s.messages).includes("QUEUE_RESPONSE_3"));
	for (const marker of ["FOLLOW_WITH_ATTACHMENTS", "STEER_WITH_ATTACHMENTS"]) {
		const delivered = requests
			.flatMap((r) => r.messages)
			.find((m) => m.role === "user" && JSON.stringify(m.content).includes(marker));
		assert(delivered, marker + " delivered");
		assert(JSON.stringify(delivered.content).includes("QUEUED_FILE_SENTINEL"), marker + " file content");
		assert(JSON.stringify(delivered.content).includes("UPLOADED_FILE_SENTINEL"), marker + " uploaded file content");
		assert(
			delivered.content.some((c) => c.type === "image_url" && c.image_url.url.includes(png)),
			marker + " actual image bytes",
		);
	}
	assert(!JSON.stringify(requests).includes("REMOVE_ME"), "removed message never sent");
	console.log("PASS: steer and followUp deliver images and files, including queue rebuild after removal");
} finally {
	releaseFirst();
	ws?.close();
	server.kill("SIGTERM");
	await new Promise((r) => {
		server.once("exit", r);
		setTimeout(r, 7000);
	});
	mock.close();
	console.log("Test artifacts:", root);
}
