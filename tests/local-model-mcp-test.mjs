import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
const remote = process.argv.includes("--remote");
const authToken = remote ? process.env.REMOTE_MCP_TOKEN : "test-token-".repeat(4);
const httpMode = remote || process.argv.includes("--http");
const live = remote || process.argv.includes("--live");
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
const requests = [];
const server = createServer(async (req, res) => {
	res.setHeader("Content-Type", "application/json");
	if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
	let raw = "";
	for await (const part of req) raw += part;
	const body = JSON.parse(raw);
	requests.push(body);
	assert.equal(body.model, "test-model");
	const content = body.messages[1].content;
	const text = content[0].text;
	if (text.startsWith("hold")) return;
	if (content[0].text.startsWith("fail")) {
		res.statusCode = 503;
		return res.end("{}");
	}
	sawImage = content.some((c) => c.image_url?.url.startsWith("data:image/png;base64,"));
	res.end(
		JSON.stringify({
			choices: [
				{
					message: {
						content: /EMPTY_FINAL|EMPTY_STOP/.test(text)
							? ""
							: text.includes("PAGED_OUTPUT")
								? "x".repeat(30000)
								: "red 42",
						reasoning_content: "PRIVATE_REASONING_MUST_NOT_BE_FORWARDED",
					},
					finish_reason: text.includes("TRUNCATED_OUTPUT") || text.includes("EMPTY_FINAL") ? "length" : "stop",
				},
			],
			usage: { total_tokens: 10 },
		}),
	);
});
if (!live) await new Promise((r) => server.listen(0, "127.0.0.1", r));
const child = remote
	? null
	: spawn(process.execPath, ["bin/local-model-mcp.mjs", ...(httpMode ? ["--http"] : [])], {
			env: {
				...process.env,
				LOCAL_MCP_PORT: "0",
				LOCAL_MCP_MAX_RECORDS: "32",
				LOCAL_MCP_HOST: "127.0.0.1",
				LOCAL_MCP_TOKEN: "test-token-".repeat(4),
				LOCAL_MODEL_BASE_URL: live ? process.env.LOCAL_MODEL_BASE_URL : `http://127.0.0.1:${server.address().port}/v1`,
				LOCAL_MODEL_ID: live ? process.env.LOCAL_MODEL_ID : "test-model",
			},
			stdio: ["pipe", "pipe", httpMode ? "pipe" : "inherit"],
		});
let httpUrl = remote ? process.env.REMOTE_MCP_URL : undefined;
if (httpMode && !remote) {
	const address = await new Promise((resolve, reject) => {
		child.once("exit", () => reject(new Error("HTTP server exited")));
		createInterface({ input: child.stderr }).once("line", (l) => resolve(JSON.parse(l).listening));
	});
	httpUrl = `http://127.0.0.1:${address.port}/mcp`;
	assert.equal((await fetch(httpUrl, { method: "POST", body: "{}" })).status, 401);
}
let id = 0;
const pending = new Map();
if (child)
	createInterface({ input: child.stdout }).on("line", (l) => {
		const m = JSON.parse(l);
		pending.get(m.id)?.(m.result);
		pending.delete(m.id);
	});
function rpc(method, params = {}) {
	if (httpMode)
		return fetch(httpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
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
	const catalog = (await rpc("tools/list")).tools;
	assert.equal(catalog.length, 5);
	const properties = catalog.find((t) => t.name === "submit_task").inputSchema.properties;
	assert.equal(Object.hasOwn(properties, "role"), false);
	assert.equal(Object.hasOwn(properties, "parent_task_id"), false);
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
	if (live) await tool("release_task", { task_id: r.task_id });
	if (live && process.argv.includes("--concurrency")) {
		const tasks = [];
		try {
			const submissions = await Promise.allSettled(
				Array.from({ length: 4 }, (_, i) =>
					tool("submit_task", {
						task: `Concurrency probe ${i + 1}: compute 6 * 7. Reply only with the number.`,
						max_tokens: 1024,
					}).then((task) => tasks.push(task)),
				),
			);
			for (const submission of submissions) if (submission.status === "rejected") throw submission.reason;
			assert.equal((await tool("model_status")).max_concurrent, 4);
			for (const task of tasks) {
				const result = await finish(task);
				assert.equal(result.state, "completed", result.error);
				assert.match(result.output, /42/);
			}
			console.log("PASS four independent live tasks");
		} finally {
			for (const task of tasks) {
				await tool("cancel_task", { task_id: task.task_id });
				await tool("release_task", { task_id: task.task_id });
			}
		}
	}
	if (!live) {
		assert.ok(sawImage);
		assert.equal(
			(await rpc("tools/call", { name: "submit_task", arguments: { task: "x", model: "other" } })).isError,
			true,
		);
		const held = await Promise.all(Array.from({ length: 4 }, () => tool("submit_task", { task: "hold" })));
		assert.equal((await tool("model_status")).running, 4);
		assert.equal((await tool("model_status")).max_concurrent, 4);
		assert.equal((await rpc("tools/call", { name: "submit_task", arguments: { task: "fifth" } })).isError, true);
		assert.equal((await tool("cancel_task", { task_id: held[0].task_id })).state, "cancelled");
		assert.equal((await finish(await tool("submit_task", { task: "after cancellation" }))).state, "completed");
		for (const h of held.slice(1)) await tool("cancel_task", { task_id: h.task_id });
		assert.equal((await finish(await tool("submit_task", { task: "fail" }))).state, "failed");
		const invalid = await finish(
			await tool("submit_task", { task: "invalid image", image_paths: [join(temp, "missing.png")] }),
		);
		assert.equal(invalid.state, "failed");
		const submit = async (args) => finish(await tool("submit_task", args));
		const rejected = async (args, message) => {
			const result = await rpc("tools/call", { name: "submit_task", arguments: args });
			assert.equal(result.isError, true);
			if (message) assert.match(result.content[0].text, message);
		};
		const candidate = await submit({
			task: "Implement exact requirements",
			context: "ORIGINAL_CONTRACT",
			image_data: [`data:image/png;base64,${image.toString("base64")}`],
		});
		for (const key of ["role", "root_task_id", "parent_task_id", "repair_attempt"])
			assert.equal(Object.hasOwn(candidate, key), false);
		assert.equal(candidate.verification, "not_run");
		const req = requests.at(-1);
		assert.equal(req.messages.length, 2);
		assert.match(req.messages[1].content[0].text, /ORIGINAL_CONTRACT/);
		assert.equal(req.messages[1].content[1].image_url.url, `data:image/png;base64,${image.toString("base64")}`);
		for (const role of ["generate", "review", "revise"]) await rejected({ task: "x", role }, /Unknown argument role/);
		await rejected({ task: "x", parent_task_id: candidate.task_id }, /Unknown argument parent_task_id/);
		await submit({ task: "independent next task" });
		const independent = JSON.stringify(requests.at(-1));
		assert.ok(!independent.includes("ORIGINAL_CONTRACT"));
		assert.ok(!independent.includes("image_url"));
		assert.ok(!independent.includes("PRIVATE_REASONING_MUST_NOT_BE_FORWARDED"));
		assert.ok(!independent.includes("WORKFLOW_ROLE"));
		const truncated = await submit({ task: "TRUNCATED_OUTPUT" });
		assert.equal(truncated.state, "incomplete");
		const empty = await submit({ task: "EMPTY_FINAL" });
		assert.equal(empty.state, "incomplete");
		assert.equal(empty.error_code, "output_limit");
		assert.ok(empty.reasoning_characters > 0);
		assert.ok(empty.elapsed_ms >= 0);
		assert.equal(empty.reasoning, "on");
		assert.equal(requests.at(-1).max_tokens, 32768);
		assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, true);
		const emptyStop = await submit({ task: "EMPTY_STOP", reasoning: "off" });
		assert.equal(emptyStop.state, "failed");
		assert.equal(emptyStop.error_code, "empty_final");
		assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, false);
		await submit({ task: "large budget", max_tokens: 65536 });
		assert.equal(requests.at(-1).max_tokens, 65536);
		await rejected({ task: "too large", max_tokens: 65537 });
		await rejected({ task: "x", reasoning: "invalid" });
		assert.equal(empty.finish_reason, "length");
		assert.equal(empty.usage.total_tokens, 10);
		const paged = await submit({ task: "PAGED_OUTPUT" });
		assert.equal(paged.output.length, 24000);
		assert.equal(paged.next_offset, 24000);
		const tail = await tool("wait_task", { task_id: paged.task_id, offset: paged.next_offset, wait_seconds: 0 });
		assert.equal(tail.output.length, 6000);
		assert.equal(tail.next_offset, null);
		// Only the selected terminal record is released; other results remain readable.
		const holding = await tool("submit_task", { task: "hold release probe" });
		assert.equal(
			(await rpc("tools/call", { name: "release_task", arguments: { task_id: holding.task_id } })).isError,
			true,
		);
		await tool("cancel_task", { task_id: holding.task_id });
		const released = await tool("release_task", { task_id: holding.task_id });
		assert.equal(released.released_records, 1);
		assert.equal(released.task_id, holding.task_id);
		assert.equal((await tool("release_task", { task_id: holding.task_id })).released_records, 0);
		assert.equal(
			(await rpc("tools/call", { name: "wait_task", arguments: { task_id: holding.task_id, wait_seconds: 0 } }))
				.isError,
			true,
		);
		assert.equal((await tool("wait_task", { task_id: candidate.task_id, wait_seconds: 0 })).output, "red 42");
		let reachedRetentionLimit = false;
		for (let i = 0; i < 32; i++) {
			const result = await rpc("tools/call", { name: "submit_task", arguments: { task: "retained record" } });
			if (result.isError) {
				assert.match(result.content[0].text, /32 task records retained/);
				reachedRetentionLimit = true;
				break;
			}
			await finish(JSON.parse(result.content[0].text));
		}
		assert.ok(reachedRetentionLimit);
		// A failed task made exactly one backend request; no retry/review calls followed it.
		assert.equal(requests.filter((req) => req.messages[1].content[0].text.startsWith("fail")).length, 1);
		// Existing results survive capacity pressure until explicitly released.
		assert.equal((await tool("wait_task", { task_id: candidate.task_id, wait_seconds: 0 })).output, "red 42");
		await tool("release_task", { task_id: candidate.task_id });
		assert.equal((await submit({ task: "after release" })).state, "completed");
	}
	console.log(
		live
			? "PASS live text + vision through MCP"
			: "PASS MCP protocol, images, fixed model, four slots, independent tasks, legacy-argument rejection, cancellation, retention, truncation and pagination",
	);
} finally {
	child?.kill();
	server.closeAllConnections();
	server.close();
	await rm(temp, { recursive: true, force: true });
}
