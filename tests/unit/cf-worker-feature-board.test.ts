/**
 * cf-worker-feature-board 的纯逻辑单测（审计修复：limit 钳制 + CORS 白名单）。
 * 直接 import Worker 模块的默认导出，用最小 D1 桩记录 bind 参数 —— 不起 wrangler，
 * 毫秒级断言 SQL LIMIT 与响应头。
 */
import { describe, expect, it } from "vitest";
import workerModule from "../../cf-worker-feature-board/src/index.js";

const worker = workerModule as unknown as {
	fetch: (request: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;
};

const API = "https://worker.example.com/api/features";

/** 最小 D1 桩：记录每次 bind 的参数（limit 是 GET /api/features 查询的最后一个绑定值）。 */
function makeDb() {
	const binds: unknown[][] = [];
	return {
		binds,
		prepare(_sql: string) {
			return {
				bind(...args: unknown[]) {
					binds.push(args);
					return {
						all: async () => ({ results: [] }),
						first: async () => null,
					};
				},
			};
		},
	};
}

function apiGet(url: string, headers: Record<string, string> = {}) {
	return new Request(url, { headers });
}

describe("GET /api/features limit 钳制", () => {
	it.each([
		[null, 50], // 缺省 → 默认 50
		["abc", 50], // 非数字（NaN）→ 回落 50
		["500", 100], // 超上限 → 钳到 100
		["100", 100], // 上限边界保持
		["7", 7], // 正常值原样
		["0", 1], // 0 → 钳到 1
		["-5", 1], // 负数 → 钳到 1
	])("limit=%s → SQL 绑定 %i", async (raw, expected) => {
		const db = makeDb();
		const url = raw === null ? API : `${API}?limit=${raw}`;
		const res = await worker.fetch(apiGet(url), { DB: db, allowed_origins: "" }, {});
		expect(res.status).toBe(200);
		const lastBind = db.binds.at(-1);
		expect(lastBind).toBeDefined();
		expect(lastBind!.at(-1)).toBe(expected);
	});
});

describe("CORS 白名单（env.allowed_origins）", () => {
	it("白名单内 Origin 回 ACAO（值=该 origin）并带 Vary: Origin", async () => {
		const res = await worker.fetch(
			apiGet(API, { Origin: "https://dev.example.com" }),
			{ DB: makeDb(), allowed_origins: "https://board.example.com, https://dev.example.com" },
			{},
		);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dev.example.com");
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	it("OPTIONS 预检同样走白名单：非白名单 Origin 拿不到 ACAO", async () => {
		const res = await worker.fetch(
			new Request(API, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }),
			{ DB: makeDb(), allowed_origins: "https://board.example.com" },
			{},
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("非白名单 Origin 与不带 Origin（同源/服务器端调用）都不回 ACAO", async () => {
		const env = { DB: makeDb(), allowed_origins: "https://board.example.com" };
		const evil = await worker.fetch(apiGet(API, { Origin: "https://evil.example" }), env, {});
		expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
		const sameOrigin = await worker.fetch(apiGet(API), env, {});
		expect(sameOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("白名单为空（wrangler.toml 默认）= 不支持跨域，任何 Origin 都不回 ACAO", async () => {
		const res = await worker.fetch(
			apiGet(API, { Origin: "https://board.example.com" }),
			{ DB: makeDb(), allowed_origins: "" },
			{},
		);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
