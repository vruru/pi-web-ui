/**
 * Goal mode × fork subagent policy, end to end with a local mock model (no network).
 *
 * The goal executor is spawned through the subagent channel, and the fork wakes a parent
 * conversation when its subagents finish. GoalService already prompts the reviewer (the
 * main conversation) itself, so an executor turn end must not add a second wake-up.
 *
 * Deterministic script: round 1 review fails, round 2 passes. Checks:
 *   - one executor conversation serves both rounds (never re-spawned, never cleaned up);
 *   - exactly one review prompt per round reaches the main conversation's model;
 *   - no "subagent-completion" wake-up is ever sent;
 *   - round 2 hands the review feedback to the same executor;
 *   - core-update admission reports busy while the goal runs and clears afterwards.
 *
 * Run: node tests/goal-executor-policy-test.mjs (ports 9031/9032; needs `npm run build:server`)
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";

const root = mkdtempSync(join(tmpdir(), "pi-goal-executor-policy-"));
const agent = join(root, "agent"),
	data = join(root, "data"),
	project = join(root, "project");
for (const d of [agent, data, project]) mkdirSync(d);
const port = Number(process.argv[2] || 9031);

const GOAL = "GOAL_POLICY_SENTINEL: add a line to notes.txt";
/** Model requests, classified by the newest user message: review prompts ask for a verdict,
 *  executor round prompts carry the round header; the rest are the main conversation's
 *  own round/outcome notes. */
const reviews = [];
const executions = [];
const others = [];
let holdFirstExecution;
const firstExecutionGate = new Promise((resolve) => {
	holdFirstExecution = resolve;
});
const lastUserText = (body) => {
	const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};
const mock = createServer(async (req, res) => {
	let text = "";
	for await (const c of req) text += c;
	if (!text) {
		res.writeHead(200).end(JSON.stringify({ data: [] }));
		return;
	}
	const body = JSON.parse(text);
	const prompt = lastUserText(body);
	let reply = "ok";
	if (prompt.includes("verdict")) {
		reviews.push(body);
		reply =
			reviews.length === 1
				? '{"verdict":"fail","feedback":"ROUND1_FEEDBACK_SENTINEL"}'
				: '{"verdict":"pass","feedback":"all good"}';
	} else if (prompt.includes("[Goal · round")) {
		executions.push(body);
		if (executions.length === 1) await firstExecutionGate;
		reply = `EXECUTOR_REPORT_${executions.length}`;
	} else {
		others.push(body);
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [d, f] of [
		[{ content: reply }, null],
		[{}, "stop"],
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
					{ id: "probe", name: "Probe", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 1024 },
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
			PI_WEB_CORE_UPDATE_CHECK: "off",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
		},
		stdio: ["ignore", "ignore", "pipe"],
	},
);
server.stderr.on("data", (x) => process.stderr.write(x));

const goalStatuses = [];
const executorIds = new Set();
let state = null;
const waitUntil = async (predicate, what, timeout = 60000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (predicate()) return;
		await sleep(50);
	}
	throw new Error("timeout waiting for " + what);
};
const coreUpdate = async () => (await fetch(`http://127.0.0.1:${port}/api/core-update`)).json();

let ws;
try {
	for (let n = 0; n < 200; n++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
		} catch {}
		await sleep(100);
	}
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "snapshot") state = m.state;
		else if (m.type === "snapshot_delta" && state && state.rev === m.baseRev)
			state = { ...state, ...m.state, messages: [...state.messages, ...(m.appended ?? [])] };
		else if (m.type === "goal_status") {
			goalStatuses.push(m.status);
			const id = m.status.roles?.executor?.convId;
			if (id) executorIds.add(id);
		}
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "goal-policy", locale: "en" }));
	await waitUntil(() => state?.model?.id === "probe", "main conversation with the mock model");
	assert.equal((await coreUpdate()).busyReason, undefined, "no goal: core update not busy");

	ws.send(JSON.stringify({ type: "set_goal", goal: GOAL, maxRounds: 3, locked: true }));
	await waitUntil(() => executions.length === 1, "executor round 1 reaches the model");
	assert.ok((await coreUpdate()).busyReason, "goal running: core update reports busy");
	holdFirstExecution();

	await waitUntil(() => goalStatuses.some((s) => s.verdict === "pass"), "goal passes in round 2", 90000);
	await sleep(1500); // any late wake-up would arrive within the 100 ms resume timer

	if (process.env.GOAL_POLICY_DEBUG) {
		for (const [kind, list] of Object.entries({ executions, reviews, others }))
			for (const body of list) console.log(kind, "|", lastUserText(body).slice(0, 220).replaceAll("\n", " "));
	}
	assert.equal(executorIds.size, 1, "one executor conversation serves both rounds");
	assert.equal(executions.length, 2, "executor ran exactly two rounds");
	assert.ok(
		JSON.stringify(executions[1].messages).includes("ROUND1_FEEDBACK_SENTINEL"),
		"round 2 hands the review feedback to the executor",
	);
	assert.ok(
		JSON.stringify(executions[1].messages).includes("EXECUTOR_REPORT_1"),
		"round 2 runs in the same executor conversation (its round 1 reply is in context)",
	);
	assert.equal(reviews.length, 2, "exactly one review prompt per round");
	assert.ok(JSON.stringify(reviews[0].messages).includes("EXECUTOR_REPORT_1"), "review 1 sees the executor report");
	const everything = JSON.stringify([...reviews, ...executions, ...others]);
	assert.ok(!everything.includes("Subagent results are ready"), "no subagent-completion wake-up reached a model");
	assert.ok(
		!JSON.stringify(state.messages).includes("subagent-completion"),
		"no subagent-completion card in the main conversation",
	);
	assert.ok(Math.max(...goalStatuses.map((s) => s.round ?? 0)) >= 2, "goal reached round 2");
	for (let n = 0; n < 40 && (await coreUpdate()).busyReason; n++) await sleep(250);
	assert.equal((await coreUpdate()).busyReason, undefined, "goal finished: core update no longer busy");
	console.log("PASS: goal executor reused across two rounds, one review per round, no duplicate wake-up");
} finally {
	holdFirstExecution();
	ws?.close();
	server.kill("SIGTERM");
	await new Promise((r) => {
		server.once("exit", r);
		setTimeout(r, 7000);
	});
	mock.close();
	console.log("Test artifacts:", root);
}
