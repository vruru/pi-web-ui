// Reproducible branch-decision benchmark against the real PluginGrantsStore.
// Run: CLM_RANK_URL=... FLASH_URL=... node --import tsx tests/clm-branch-trial.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PluginGrantsStore } from "../server/plugin-grants.ts";

const sourcePath = fileURLToPath(new URL("../server/plugin-grants.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const fixtures = [
	{ id: "has-empty", grants: {}, call: ["has", "alpha", "/tmp/demo"] },
	{ id: "has-exact", grants: { alpha: ["/tmp/demo"] }, call: ["has", "alpha", "/tmp/demo"] },
	{ id: "has-child", grants: { alpha: ["/tmp/demo"] }, call: ["has", "alpha", "/tmp/demo/src"] },
	{ id: "has-parent", grants: { alpha: ["/tmp/demo/src"] }, call: ["has", "alpha", "/tmp/demo"] },
	{ id: "has-prefix", grants: { alpha: ["/tmp/demo"] }, call: ["has", "alpha", "/tmp/democracy"] },
	{ id: "has-other-plugin", grants: { alpha: ["/tmp/demo"] }, call: ["has", "beta", "/tmp/demo"] },
	{ id: "has-invalid-id", grants: { alpha: ["/tmp/demo"] }, call: ["has", "../alpha", "/tmp/demo"] },
	{ id: "has-relative", grants: { alpha: ["/tmp/demo"] }, call: ["has", "alpha", "demo/src"] },
	{ id: "has-dotdot", grants: { alpha: ["/tmp/demo"] }, call: ["has", "alpha", "/tmp/demo/../outside"] },
	{ id: "has-trailing-slash", grants: { alpha: ["/tmp/demo/"] }, call: ["has", "alpha", "/tmp/demo/src/"] },
	{
		id: "has-sanitized-bad-entry",
		grants: { alpha: ["relative", 42, "/tmp/demo"] },
		call: ["has", "alpha", "/tmp/demo"],
	},
	{ id: "grant-new", grants: {}, call: ["grant", "alpha", "/tmp/demo"] },
	{ id: "grant-duplicate", grants: { alpha: ["/tmp/demo"] }, call: ["grant", "alpha", "/tmp/demo/"] },
	{ id: "grant-child-despite-parent", grants: { alpha: ["/tmp/demo"] }, call: ["grant", "alpha", "/tmp/demo/src"] },
	{ id: "grant-other-plugin", grants: { alpha: ["/tmp/demo"] }, call: ["grant", "beta", "/tmp/demo"] },
	{ id: "grant-invalid-id", grants: {}, call: ["grant", "bad/id", "/tmp/demo"] },
	{ id: "grant-relative", grants: {}, call: ["grant", "alpha", "demo"] },
	{ id: "grant-nul", grants: {}, call: ["grant", "alpha", "/tmp/de\u0000mo"] },
	{ id: "revoke-empty", grants: {}, call: ["revoke"] },
	{ id: "revoke-all", grants: { alpha: ["/tmp/a", "/tmp/b"], beta: ["/tmp/c"] }, call: ["revoke"] },
	{ id: "revoke-one-plugin", grants: { alpha: ["/tmp/a", "/tmp/b"], beta: ["/tmp/c"] }, call: ["revoke", "alpha"] },
	{ id: "revoke-missing-plugin", grants: { alpha: ["/tmp/a"] }, call: ["revoke", "beta"] },
	{ id: "revoke-exact", grants: { alpha: ["/tmp/a", "/tmp/a/sub"] }, call: ["revoke", "alpha", "/tmp/a"] },
	{
		id: "revoke-not-descendants",
		grants: { alpha: ["/tmp/a", "/tmp/a/sub", "/tmp/a/sub/deep"] },
		call: ["revoke", "alpha", "/tmp/a"],
	},
	{ id: "revoke-path-prefix", grants: { alpha: ["/tmp/a", "/tmp/ab"] }, call: ["revoke", "alpha", "/tmp/a"] },
	{ id: "revoke-relative", grants: { alpha: ["/tmp/a"] }, call: ["revoke", "alpha", "tmp/a"] },
	{ id: "revoke-invalid-id", grants: { alpha: ["/tmp/a"] }, call: ["revoke", "bad/id"] },
	{ id: "revoke-normalized", grants: { alpha: ["/tmp/a/"] }, call: ["revoke", "alpha", "/tmp/a"] },
];

function actual(row) {
	const dir = mkdtempSync(join(tmpdir(), "clm-branch-"));
	try {
		writeFileSync(join(dir, "plugin-grants.json"), JSON.stringify({ grants: row.grants }));
		const store = new PluginGrantsStore(dir);
		const [method, ...args] = row.call;
		const start = performance.now();
		const value = store[method](...args);
		return { value, ms: performance.now() - start };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function options(row) {
	if (row.call[0] === "has") return ["Return true: access is authorized", "Return false: access is not authorized"];
	if (row.call[0] === "grant") return ["Return true: a new grant is stored", "Return false: no new grant is stored"];
	return [0, 1, 2, 3].map((n) => `Return ${n}: ${n} grant entries removed`);
}

const cases = fixtures.map((row) => {
	const result = actual(row);
	const answers = options(row);
	const gold = row.call[0] === "revoke" ? Number(result.value) : result.value ? 0 : 1;
	return { ...row, answers, gold, oracleMs: result.ms };
});

const code =
	process.env.BRANCH_CODE_MODE === "stripped"
		? source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "")
				.trim()
		: source;
const context = (row) =>
	`The following is real TypeScript code. Predict the return value of the final method call. The initial plugin-grants.json content is exactly {"grants": ...}; no other operations occur.\n\n${code}\n\nInitial grants: ${JSON.stringify(row.grants)}\nCall: ${JSON.stringify(row.call)}`;
const question = "What does the call return? Follow the source code exactly.";
const percentile = (values, p) => {
	const a = [...values].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
};

async function clm(row) {
	const start = performance.now();
	const response = await fetch(process.env.CLM_RANK_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ context: context(row), question, answers: row.answers }),
	});
	if (!response.ok) throw new Error(`CLM ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const body = await response.json();
	return {
		choice: row.answers.indexOf(body.ranked?.[0]?.candidate),
		ms: Math.round(performance.now() - start),
		probability: body.ranked?.[0]?.prob,
	};
}

async function flash(row) {
	const start = performance.now();
	const response = await fetch(process.env.FLASH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: process.env.FLASH_MODEL ?? "pennyroyal",
			stream: false,
			max_tokens: Number(process.env.FLASH_MAX_TOKENS ?? 1024),
			messages: [
				{
					role: "system",
					content:
						"Use the given code to predict the call return value. Answer with only one zero-based option index, no explanation.",
				},
				{
					role: "user",
					content: `${context(row)}\n\n${question}\n${row.answers.map((x, i) => `${i}: ${x}`).join("\n")}`,
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`Flash ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const body = await response.json();
	const content = body.choices?.[0]?.message?.content?.trim() ?? "";
	return {
		choice: /^\d+$/.test(content) ? Number(content) : -1,
		ms: Math.round(performance.now() - start),
		raw: content.slice(0, 100),
	};
}

if (process.argv.includes("--prompt")) {
	console.log(
		`Read the following real TypeScript code and predict each call's return value. Give exactly one JSON array of ${cases.length} zero-based option indices in order, with no explanation. Do not run code or use tools.\n\n${code}\n\n${cases.map((row, i) => `${i + 1}. Initial grants: ${JSON.stringify(row.grants)}; call: ${JSON.stringify(row.call)}; options: ${JSON.stringify(row.answers)}`).join("\n")}`,
	);
} else if (process.argv.includes("--oracle")) {
	console.log(
		JSON.stringify(
			{
				count: cases.length,
				p50Ms: percentile(
					cases.map((row) => row.oracleMs),
					0.5,
				),
				p95Ms: percentile(
					cases.map((row) => row.oracleMs),
					0.95,
				),
				cases: cases.map((row) => ({ id: row.id, gold: row.gold, ms: row.oracleMs })),
			},
			null,
			2,
		),
	);
} else {
	if (!process.env.CLM_RANK_URL && !process.env.FLASH_URL) throw new Error("Set CLM_RANK_URL and/or FLASH_URL");
	const runs = [];
	for (const row of cases) {
		const result = { id: row.id, gold: row.gold };
		if (process.env.CLM_RANK_URL) result.clm = await clm(row);
		if (process.env.FLASH_URL) result.flash = await flash(row);
		runs.push(result);
	}
	const metrics = {};
	for (const model of ["clm", "flash"]) {
		if (!runs[0][model]) continue;
		metrics[model] = {
			correct: runs.filter((r) => r[model].choice === r.gold).length,
			count: runs.length,
			p50Ms: percentile(
				runs.map((r) => r[model].ms),
				0.5,
			),
			p95Ms: percentile(
				runs.map((r) => r[model].ms),
				0.95,
			),
		};
	}
	console.log(
		JSON.stringify(
			{
				source: "server/plugin-grants.ts",
				codeMode: process.env.BRANCH_CODE_MODE ?? "full",
				sourceLines: source.split("\n").length,
				ifCount: (source.match(/\bif\s*\(/g) ?? []).length,
				metrics,
				runs,
			},
			null,
			2,
		),
	);
}
