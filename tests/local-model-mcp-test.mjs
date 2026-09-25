import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
const httpMode = process.argv.includes("--http");
const live = process.argv.includes("--live");
const temp = await mkdtemp(join(tmpdir(), "flash-mcp-"));
function chunk(type, data) {
	const b = Buffer.concat([Buffer.from(type), data]);
	let crc = 0xffffffff;
	for (const byte of b) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	const size = Buffer.alloc(4),
		end = Buffer.alloc(4);
	size.writeUInt32BE(data.length);
	end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([size, b, end]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(64);
ihdr.writeUInt32BE(64, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const rows = Buffer.alloc(64 * (1 + 64 * 3));
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) rows[y * 193 + 1 + x * 3] = 255;
const image = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(rows)),
	chunk("IEND", Buffer.alloc(0)),
]);
const imagePath = join(temp, "sample.png");
await writeFile(imagePath, image);
let sawImage = false;
const server = createServer(async (req, res) => {
	res.setHeader("Content-Type", "application/json");
	if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
	let raw = "";
	for await (const part of req) raw += part;
	const body = JSON.parse(raw);
	assert.equal(body.model, "test-model");
	const content = body.messages[1].content;
	if (content[0].text.startsWith("hold")) return;
	if (content[0].text.startsWith("fail")) {
		res.statusCode = 503;
		return res.end("{}");
	}
	sawImage = content.some((c) => c.image_url?.url.startsWith("data:image/png;base64,"));
	res.end(
		JSON.stringify({
			choices: [{ message: { content: "red 42" }, finish_reason: "stop" }],
			usage: { total_tokens: 10 },
		}),
	);
});
if (!live) await new Promise((r) => server.listen(0, "127.0.0.1", r));
const child = spawn(process.execPath, ["bin/local-model-mcp.mjs", ...(httpMode ? ["--http"] : [])], {
	env: {
		...process.env,
		LOCAL_MCP_PORT: "0",
		LOCAL_MCP_HOST: "127.0.0.1",
		LOCAL_MCP_TOKEN: "test-token-".repeat(4),
		LOCAL_MODEL_BASE_URL: live ? process.env.LOCAL_MODEL_BASE_URL : `http://127.0.0.1:${server.address().port}/v1`,
		LOCAL_MODEL_ID: live ? process.env.LOCAL_MODEL_ID : "test-model",
	},
	stdio: ["pipe", "pipe", httpMode ? "pipe" : "inherit"],
});
let httpUrl;
if (httpMode) {
	const address = await new Promise((resolve, reject) => {
		child.once("exit", () => reject(new Error("HTTP server exited")));
		createInterface({ input: child.stderr }).once("line", (l) => resolve(JSON.parse(l).listening));
	});
	httpUrl = `http://127.0.0.1:${address.port}/mcp`;
	assert.equal((await fetch(httpUrl, { method: "POST", body: "{}" })).status, 401);
}
let id = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (l) => {
	const m = JSON.parse(l);
	pending.get(m.id)?.(m.result);
	pending.delete(m.id);
});
function rpc(method, params = {}) {
	if (httpMode)
		return fetch(httpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${"test-token-".repeat(4)}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		})
			.then((r) => r.json())
			.then((r) => r.result);

	return new Promise((resolve, reject) => {
		const n = ++id;
		const timer = setTimeout(() => reject(new Error("RPC timeout")), 60000);
		pending.set(n, (x) => {
			clearTimeout(timer);
			resolve(x);
		});
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
	});
}
async function tool(name, args = {}) {
	const r = await rpc("tools/call", { name, arguments: args });
	assert.ok(!r.isError, r.content?.[0]?.text);
	return JSON.parse(r.content[0].text);
}
async function finish(task) {
	let r;
	for (let i = 0; i < 4; i++) {
		r = await tool("wait_task", { task_id: task.task_id, wait_seconds: 50 });
		if (r.state !== "running") return r;
	}
	throw new Error("Task did not finish");
}
try {
	const init = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	});
	assert.equal(init.serverInfo.name, "flash-next");
	assert.equal((await rpc("tools/list")).tools.length, 4);
	assert.equal((await tool("model_status")).available, true);
	const r = await finish(
		await tool("submit_task", {
			task: "Name the dominant color of the attached image in English, then compute 6 * 7. Reply with just the color and number.",
			...(httpMode
				? { image_data: [`data:image/png;base64,${image.toString("base64")}`] }
				: { image_paths: [imagePath] }),
			max_tokens: 1024,
		}),
	);
	assert.equal(r.state, "completed", r.error);
	assert.match(r.output, /red/i);
	assert.match(r.output, /42/);
	console.log("Real MCP result:", JSON.stringify(r));
	if (!live) {
		assert.ok(sawImage);
		assert.equal(
			(await rpc("tools/call", { name: "submit_task", arguments: { task: "x", model: "other" } })).isError,
			true,
		);
		const a = await tool("submit_task", { task: "hold" }),
			b = await tool("submit_task", { task: "hold" });
		assert.equal((await rpc("tools/call", { name: "submit_task", arguments: { task: "third" } })).isError, true);
		assert.equal((await tool("cancel_task", { task_id: a.task_id })).state, "cancelled");
		assert.equal((await finish(await tool("submit_task", { task: "after cancellation" }))).state, "completed");
		await tool("cancel_task", { task_id: b.task_id });
		assert.equal((await finish(await tool("submit_task", { task: "fail" }))).state, "failed");
		const invalid = await finish(
			await tool("submit_task", { task: "invalid image", image_paths: [join(temp, "missing.png")] }),
		);
		assert.equal(invalid.state, "failed");
	}
	console.log(
		live
			? "PASS live text + vision through MCP"
			: "PASS MCP protocol, images, fixed model, slots, cancellation and failures",
	);
} finally {
	child.kill();
	server.closeAllConnections();
	server.close();
	await rm(temp, { recursive: true, force: true });
}
