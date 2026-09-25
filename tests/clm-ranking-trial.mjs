// Read-only CLM evaluation with fixed, synthetic decision cases. No code is executed by models.
import { performance } from "node:perf_hooks";

const cases = [
	{
		id: "max-negative",
		state:
			"function max(xs) { let m = 0; for (const x of xs) if (x > m) m = x; return m; } Input is nonempty and all numbers may be negative.",
		question: "Choose the correct fix.",
		answers: ["Initialize m to xs[0].", "Keep m initialized to 0.", "Reverse the loop direction."],
		gold: 0,
	},
	{
		id: "http-401",
		state: "A request returns HTTP 401 Unauthorized after a token expired. The server is otherwise healthy.",
		question: "What should be checked first?",
		answers: [
			"Increase CSS z-index.",
			"Refresh or replace the expired authentication token.",
			"Enlarge the database disk.",
		],
		gold: 1,
	},
	{
		id: "merge-conflict",
		state: "Git reports a merge conflict in one source file. Both branches contain useful edits.",
		question: "Choose the safest next action.",
		answers: [
			"Force push the current branch.",
			"Delete the repository.",
			"Inspect both versions and resolve the conflict.",
		],
		gold: 2,
	},
	{
		id: "todo-search",
		state: "Find every occurrence of TODO in source files without changing files.",
		question: "Which tool action fits?",
		answers: ["Run a recursive text search.", "Delete source files.", "Restart the web server."],
		gold: 0,
	},
	{
		id: "disk-full",
		state: "A write fails with ENOSPC and the filesystem is 100% full.",
		question: "What is the relevant first investigation?",
		answers: ["Change the page font.", "Inspect filesystem usage and large files.", "Rotate the API key."],
		gold: 1,
	},
	{
		id: "cert-expired",
		state: "The HTTPS client rejects the site because its TLS certificate has expired.",
		question: "Select the relevant fix.",
		answers: ["Increase Redis memory.", "Rename the database table.", "Renew and deploy the certificate."],
		gold: 2,
	},
	{
		id: "missing-table",
		state: "The application log says SQLite error: no such table: invoices.",
		question: "Where should investigation start?",
		answers: [
			"Check schema and migrations for the invoices table.",
			"Increase image resolution.",
			"Reset browser zoom.",
		],
		gold: 0,
	},
	{
		id: "permission-denied",
		state: "A process gets EACCES when it opens a protected directory.",
		question: "What is the relevant check?",
		answers: [
			"Change the CSS theme.",
			"Inspect effective user and directory permissions.",
			"Disable HTTP compression.",
		],
		gold: 1,
	},
	{
		id: "billing-zh",
		state: "客户说账单被重复扣款，要求核对退款。",
		question: "应先交给哪个团队？",
		answers: ["前端样式组", "显卡驱动组", "账单与退款组"],
		gold: 2,
	},
	{
		id: "dns-zh",
		state: "域名查询返回 NXDOMAIN，但直接访问服务器 IP 可以连接。",
		question: "先检查什么？",
		answers: ["域名解析记录与权威 DNS。", "网页按钮颜色。", "Python 缩进。"],
		gold: 0,
	},
	{
		id: "sum-negative",
		state:
			"A sum function uses `total += x` for each integer x in xs, but a suggested patch changes it to `total -= x`.",
		question: "Which candidate preserves summation?",
		answers: ["Use total -= x.", "Keep total += x.", "Replace x with its string length."],
		gold: 1,
	},
	{
		id: "readonly-status",
		state: "A reviewer needs to see modified Git files but must not change the worktree.",
		question: "Which action?",
		answers: ["git reset --hard", "git clean -fd", "git status --short"],
		gold: 2,
	},
];
const clmUrl = process.env.CLM_RANK_URL;
if (!clmUrl) throw new Error("Set CLM_RANK_URL");
async function rank(row) {
	const start = performance.now();
	const response = await fetch(clmUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(process.env.CLM_API_KEY ? { Authorization: `Bearer ${process.env.CLM_API_KEY}` } : {}),
		},
		body: JSON.stringify({ context: row.state, question: row.question, answers: row.answers }),
	});
	if (!response.ok) throw new Error(`CLM HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	const body = await response.json();
	const choice = body.ranked?.[0]?.candidate;
	return {
		selected: row.answers.indexOf(choice),
		latencyMs: Math.round(performance.now() - start),
		serverLatencyMs: Number(response.headers.get("x-clm-latency-ms")),
		confidence: body.ranked?.[0]?.prob,
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
			max_tokens: 256,
			messages: [
				{
					role: "system",
					content: "You select exactly one action. Reply with only its zero-based integer index. No explanation.",
				},
				{
					role: "user",
					content: `State: ${row.state}\nQuestion: ${row.question}\nOptions:\n${row.answers.map((x, i) => `${i}: ${x}`).join("\n")}`,
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`Flash HTTP ${response.status}`);
	const body = await response.json();
	const answer = body.choices?.[0]?.message?.content?.trim() ?? "";
	const match = answer.match(/^([0-9]+)$/);
	return {
		selected: match ? Number(match[1]) : -1,
		latencyMs: Math.round(performance.now() - start),
		raw: match ? undefined : answer.slice(0, 120),
	};
}
const percentile = (values, p) => {
	const a = [...values].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
};
const runs = [];
for (const row of cases) runs.push({ id: row.id, gold: row.gold, clmCold: await rank(row) });
for (let i = 0; i < cases.length; i++) runs[i].clmWarm = await rank(cases[i]);
if (process.env.FLASH_URL) for (let i = 0; i < cases.length; i++) runs[i].flash = await flash(cases[i]);
const metric = (k) => ({
	correct: runs.filter((r) => r[k].selected === r.gold).length,
	count: runs.length,
	p50Ms: percentile(
		runs.map((r) => r[k].latencyMs),
		0.5,
	),
	p95Ms: percentile(
		runs.map((r) => r[k].latencyMs),
		0.95,
	),
});
console.log(
	JSON.stringify(
		{
			model: "clm-latest",
			disclaimer: "Small synthetic smoke set, not Jev benchmark or proof of production accuracy.",
			metrics: {
				clmCold: metric("clmCold"),
				clmWarm: metric("clmWarm"),
				...(process.env.FLASH_URL ? { flash: metric("flash") } : {}),
			},
			cases: runs,
		},
		null,
		2,
	),
);
