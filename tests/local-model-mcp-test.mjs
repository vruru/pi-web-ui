import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
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
	if (text.startsWith("hold") || text.includes("HOLD_STAGE")) return;
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
	assert.equal((await rpc("tools/list")).tools.length, 5);
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
	if (live && process.argv.includes("--workflow")) {
		const started = Date.now();
		const roots = [];
		try {
			const four = await Promise.all(
				Array.from({ length: 4 }, (_, i) =>
					tool("submit_task", {
						task: `Concurrency probe ${i + 1}: compute 6 * 7. Reply only with the number.`,
						max_tokens: 1024,
					}).then((t) => {
						roots.push(t.task_id);
						return t;
					}),
				),
			);
			const status = await tool("model_status");
			assert.equal(status.max_concurrent, 4);
			console.log("Live concurrent admission:", JSON.stringify(status));
			for (const t of four) {
				const result = await finish(t);
				assert.equal(result.state, "completed", result.error);
				assert.match(result.output, /42/);
			}
			const candidate = await finish(
				await tool("submit_task", {
					task: "For this workflow transport test, the initial generation stage must reproduce the supplied baseline JavaScript function unchanged in one code block, with no explanation. A later review stage must judge it against the supplied contract and revisions may fix it.",
					context:
						"Contract: uniqueKeepLast(items) removes duplicate numbers, keeping the LAST occurrence and preserving those last occurrences' order. Example [1,2,1,3,2] => [1,3,2]. Baseline: function uniqueKeepLast(items) { return [...new Set(items)]; }",
					max_tokens: 4096,
				}).then((t) => {
					roots.push(t.task_id);
					return t;
				}),
			);
			assert.equal(candidate.state, "completed", candidate.error);
			const review = await finish(
				await tool("submit_task", {
					role: "review",
					parent_task_id: candidate.task_id,
					task: "Review the function against the original behavioral contract. Give a concrete counterexample if incorrect. Do not claim you executed tests. Be concise.",
					max_tokens: 4096,
				}),
			);
			assert.equal(review.state, "completed", review.error);
			const repaired = await finish(
				await tool("submit_task", {
					role: "revise",
					parent_task_id: review.task_id,
					task: "Confirmed defect: Set retains first occurrences; [1,2,1,3,2] yields [1,2,3], expected [1,3,2]. Fix uniqueKeepLast to keep last occurrences. Return only the complete JavaScript function in one code block. No exports, imports, or example calls. The initial baseline-copy instruction applied only to the generation stage.",
					max_tokens: 4096,
				}),
			);
			assert.equal(repaired.state, "completed", repaired.error);
			const code = repaired.output.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/)?.[1];
			assert.ok(code, "Expected a complete JavaScript function");
			for (const [input, expected] of [
				[
					[1, 2, 1, 3, 2],
					[1, 3, 2],
				],
				[[], []],
				[[4, 4, 4], [4]],
				[
					[3, 2, 1],
					[3, 2, 1],
				],
			]) {
				const actual = runInNewContext(
					`${code}\nJSON.stringify(uniqueKeepLast(${JSON.stringify(input)}))`,
					Object.create(null),
					{ timeout: 500 },
				);
				assert.deepEqual(JSON.parse(actual), expected);
			}
			const finalReview = await finish(
				await tool("submit_task", {
					role: "review",
					parent_task_id: repaired.task_id,
					task: "Review this replacement against the keep-last contract. Coordinator actually ran four cases (duplicates, empty, all same, distinct) and all passed. Report only remaining concrete defects; no findings is acceptable.",
					max_tokens: 4096,
				}),
			);
			assert.equal(finalReview.state, "completed", finalReview.error);
			console.log(
				"PASS live reviewed workflow and 4 coordinator-executed cases",
				JSON.stringify({
					elapsed_ms: Date.now() - started,
					repair_attempt: repaired.repair_attempt,
					review: review.output,
					final_review: finalReview.output,
				}),
			);
		} finally {
			for (const task_id of roots) {
				await tool("cancel_task", { task_id });
				await tool("release_task", { task_id });
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
		const rejected = async (args) =>
			assert.equal((await rpc("tools/call", { name: "submit_task", arguments: args })).isError, true);
		const candidate = await submit({
			task: "Implement exact requirements",
			context: "ORIGINAL_CONTRACT",
			image_data: [`data:image/png;base64,${image.toString("base64")}`],
		});
		assert.equal(candidate.role, "generate");
		assert.equal(candidate.root_task_id, candidate.task_id);
		let review = await submit({ task: "Check edge cases", role: "review", parent_task_id: candidate.task_id });
		assert.equal(review.root_task_id, candidate.task_id);
		assert.equal(review.parent_task_id, candidate.task_id);
		assert.equal(review.verification, "not_run");
		let req = requests.at(-1);
		assert.equal(req.messages.length, 2);
		assert.match(req.messages[0].content, /WORKFLOW_ROLE: review/);
		assert.match(req.messages[1].content[0].text, /ORIGINAL_CONTRACT/);
		assert.match(req.messages[1].content[0].text, /red 42/);
		assert.ok(!JSON.stringify(req).includes("PRIVATE_REASONING_MUST_NOT_BE_FORWARDED"));
		assert.equal(req.messages[1].content[1].image_url.url, `data:image/png;base64,${image.toString("base64")}`);
		await rejected({ task: "x", role: "bogus" });
		await rejected({ task: "x", role: "review" });
		await rejected({ task: "x", role: "review", parent_task_id: "absent" });
		await rejected({ task: "x", parent_task_id: candidate.task_id });
		await rejected({ task: "x", role: "review", parent_task_id: review.task_id });
		await rejected({ task: "x", role: "revise", parent_task_id: candidate.task_id });
		for (const extra of [{ context: "" }, { image_paths: [] }, { image_data: [] }])
			await rejected({ task: "x", role: "review", parent_task_id: candidate.task_id, ...extra });
		for (let n = 1; n <= 2; n++) {
			const repaired = await submit({ task: "CONFIRMED_TEST_FAILURE", role: "revise", parent_task_id: review.task_id });
			assert.equal(repaired.repair_attempt, n);
			assert.equal(repaired.root_task_id, candidate.task_id);
			req = requests.at(-1);
			assert.match(req.messages[0].content, /WORKFLOW_ROLE: revise/);
			assert.match(req.messages[1].content[0].text, /CONFIRMED_TEST_FAILURE/);
			assert.match(req.messages[1].content[0].text, /Review Feedback/);
			review = await submit({ task: "Review replacement", role: "review", parent_task_id: repaired.task_id });
			assert.ok(!requests.at(-1).messages[1].content[0].text.includes("Review Feedback"));
		}
		await rejected({ task: "third repair", role: "revise", parent_task_id: review.task_id });
		// Cancelling a child is terminal, prevents descendants and releases its slot.
		const holding = await tool("submit_task", {
			task: "HOLD_STAGE",
			role: "review",
			parent_task_id: candidate.task_id,
		});
		await tool("cancel_task", { task_id: holding.task_id });
		await rejected({ task: "x", role: "revise", parent_task_id: holding.task_id });
		assert.equal((await submit({ task: "after review cancellation" })).state, "completed");
		const truncated = await submit({ task: "TRUNCATED_OUTPUT" });
		assert.equal(truncated.state, "incomplete");
		await rejected({ task: "x", role: "review", parent_task_id: truncated.task_id });
		const empty = await submit({ task: "EMPTY_FINAL" });
		assert.equal(empty.state, "incomplete");
		assert.equal(empty.error_code, "output_limit");
		assert.ok(empty.reasoning_characters > 0);
		assert.ok(empty.elapsed_ms >= 0);
		assert.equal(empty.reasoning, "off");
		assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, false);
		const emptyStop = await submit({ task: "EMPTY_STOP", reasoning: "on" });
		assert.equal(emptyStop.state, "failed");
		assert.equal(emptyStop.error_code, "empty_final");
		assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, true);
		await rejected({ task: "x", reasoning: "invalid" });
		assert.equal(empty.finish_reason, "length");
		assert.equal(empty.usage.total_tokens, 10);
		const paged = await submit({ task: "PAGED_OUTPUT" });
		assert.equal(paged.output.length, 24000);
		assert.equal(paged.next_offset, 24000);
		const tail = await tool("wait_task", { task_id: paged.task_id, offset: paged.next_offset, wait_seconds: 0 });
		assert.equal(tail.output.length, 6000);
		assert.equal(tail.next_offset, null);
		// Repair reservations count even on cancellation, and racing third attempts fail.
		const g = await submit({ task: "root for racing repairs" });
		const v = await submit({ task: "review", role: "review", parent_task_id: g.task_id });
		const repairs = await Promise.all(
			[1, 2].map(() => tool("submit_task", { task: "HOLD_STAGE", role: "revise", parent_task_id: v.task_id })),
		);
		await rejected({ task: "third", role: "revise", parent_task_id: v.task_id });
		assert.equal((await rpc("tools/call", { name: "release_task", arguments: { task_id: v.task_id } })).isError, true);
		for (const repair of repairs) await tool("cancel_task", { task_id: repair.task_id });
		await rejected({ task: "third after cancellation", role: "revise", parent_task_id: v.task_id });
		const released = await tool("release_task", { task_id: v.task_id });
		assert.equal(released.released_records, 4);
		assert.equal((await tool("release_task", { task_id: v.task_id })).released_records, 0);
		await rejected({ task: "review deleted root", role: "review", parent_task_id: g.task_id });
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
		// Existing results survive capacity pressure until explicitly released.
		assert.equal((await tool("wait_task", { task_id: candidate.task_id, wait_seconds: 0 })).output, "red 42");
		await tool("release_task", { task_id: candidate.task_id });
		assert.equal((await submit({ task: "after release" })).state, "completed");
	}
	console.log(
		live
			? "PASS live text + vision through MCP"
			: "PASS MCP protocol, images, fixed model, four slots, role lineage, repair budget, cancellation, truncation and pagination",
	);
} finally {
	child?.kill();
	server.closeAllConnections();
	server.close();
	await rm(temp, { recursive: true, force: true });
}
