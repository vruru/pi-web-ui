/**
 * 插件目录同步（server/plugin-catalog-sync.ts + plugin-catalog.ts 的同步纯函数）单测（issue #148）：
 * 文档形状校验、非法条目跳过、原子写盘的 merge/replace、失败不覆盖有效目录、
 * 可选安装（走正常安装器）与 afterWrite 重载回调。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSyncPayload, writeCustomCatalog } from "../../server/plugin-catalog.js";
import { syncPluginCatalog } from "../../server/plugin-catalog-sync.js";
import type { PluginInstaller, PluginJobSpec } from "../../server/plugin-installer.js";

let dir: string;
let custom: string;
let pluginsDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-catalog-sync-"));
	custom = join(dir, "plugin-catalog.json");
	pluginsDir = join(dir, "plugins");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ENTRY = { id: "third-party", source: "someone/repo", name: "第三方" };

/** 记录调用、按脚本返回结果的假安装器（只用到 run）。 */
function fakeInstaller(script?: (spec: PluginJobSpec) => { ok: boolean; error?: string }) {
	const calls: PluginJobSpec[] = [];
	const installer = {
		run: async (spec: PluginJobSpec) => {
			calls.push(spec);
			const r = script?.(spec) ?? { ok: true };
			return { ...r, output: "" };
		},
	} as unknown as PluginInstaller;
	return { installer, calls };
}

describe("normalizeSyncPayload", () => {
	it("接受数组与 { entries: [...] } 两种形状", () => {
		expect(normalizeSyncPayload([ENTRY])).toEqual({
			entries: [expect.objectContaining({ id: "third-party" })],
			skipped: 0,
		});
		expect(normalizeSyncPayload({ entries: [ENTRY] })).toEqual({
			entries: [expect.objectContaining({ id: "third-party" })],
			skipped: 0,
		});
	});

	it("形状不对直接报错（调用方据此不写盘）", () => {
		expect(normalizeSyncPayload({ foo: 1 })).toHaveProperty("error");
		expect(normalizeSyncPayload("nope")).toHaveProperty("error");
		expect(normalizeSyncPayload(null)).toHaveProperty("error");
	});

	it("非法条目丢弃并计数（与市场添加同一套校验）", () => {
		const r = normalizeSyncPayload([ENTRY, { id: "local", source: "/etc/passwd" }, { name: "无 source" }, 42]);
		if ("error" in r) throw new Error("不应报错");
		expect(r.entries.map((e) => e.id)).toEqual(["third-party"]);
		expect(r.skipped).toBe(3);
	});
});

describe("writeCustomCatalog", () => {
	it("默认 merge：文档没提到的旧条目保留，同 id 覆盖", () => {
		writeFileSync(
			custom,
			JSON.stringify({
				entries: [
					{ id: "keep", source: "a/b" },
					{ id: "third-party", source: "old/old" },
				],
			}),
		);
		const payload = normalizeSyncPayload([ENTRY]);
		if ("error" in payload) throw new Error("不应报错");
		writeCustomCatalog(custom, payload.entries, false);
		const written = JSON.parse(readFileSync(custom, "utf8")) as { entries: { id: string; source: string }[] };
		expect(written.entries.map((e) => e.id).sort()).toEqual(["keep", "third-party"]);
		expect(written.entries.find((e) => e.id === "third-party")?.source).toBe("someone/repo");
	});

	it("replace=true：整体替换（文档即真相）", () => {
		writeFileSync(custom, JSON.stringify({ entries: [{ id: "keep", source: "a/b" }] }));
		const payload = normalizeSyncPayload([ENTRY]);
		if ("error" in payload) throw new Error("不应报错");
		writeCustomCatalog(custom, payload.entries, true);
		const written = JSON.parse(readFileSync(custom, "utf8")) as { entries: { id: string }[] };
		expect(written.entries.map((e) => e.id)).toEqual(["third-party"]);
	});

	it("只写白名单字段（远端文档里的其它键不落盘）", () => {
		const payload = normalizeSyncPayload([{ ...ENTRY, evil: "x", __proto__: { y: 1 } }]);
		if ("error" in payload) throw new Error("不应报错");
		writeCustomCatalog(custom, payload.entries, true);
		const raw = readFileSync(custom, "utf8");
		expect(raw).not.toContain("evil");
	});
});

describe("syncPluginCatalog", () => {
	it("本地文件来源：写盘后只刷新目录，不重载插件", async () => {
		const src = join(dir, "remote.json");
		writeFileSync(src, JSON.stringify({ entries: [ENTRY, { id: "bad", source: ".." }] }));
		const { installer, calls } = fakeInstaller();
		const afterWrites: boolean[] = [];
		const res = await syncPluginCatalog(
			src,
			{},
			{
				customCatalogPath: custom,
				pluginsDir,
				installer,
				afterWrite: async (pluginsChanged) => {
					afterWrites.push(pluginsChanged);
				},
			},
		);
		expect(res.ok).toBe(true);
		expect(res.installed).toBeUndefined();
		expect(afterWrites).toEqual([false]);
		expect(calls).toHaveLength(0);
		const written = JSON.parse(readFileSync(custom, "utf8")) as { entries: { id: string }[] };
		expect(written.entries.map((e) => e.id)).toEqual(["third-party"]);
	});

	it("坏 JSON / 读不到文件：一个字节都不写盘（旧目录保持有效）", async () => {
		writeFileSync(custom, JSON.stringify({ entries: [{ id: "keep", source: "a/b" }] }));
		const before = readFileSync(custom, "utf8");
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not json");
		const { installer } = fakeInstaller();
		const deps = { customCatalogPath: custom, pluginsDir, installer, afterWrite: async () => {} };
		const r1 = await syncPluginCatalog(bad, {}, deps);
		expect(r1.ok).toBe(false);
		expect(r1.error).toBeTruthy();
		const r2 = await syncPluginCatalog(join(dir, "missing.json"), {}, deps);
		expect(r2.ok).toBe(false);
		const r3 = await syncPluginCatalog("relative/path.json", {}, deps);
		expect(r3.ok).toBe(false);
		expect(readFileSync(custom, "utf8")).toBe(before);
	});

	it("install:true：未装的走 install、已装的走 update，失败逐条记录（不中断整批）", async () => {
		const src = join(dir, "remote.json");
		writeFileSync(src, JSON.stringify([ENTRY, { id: "installed-already", source: "other/repo" }]));
		// 已装：目录存在
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(pluginsDir, "installed-already"), { recursive: true });
		const { installer, calls } = fakeInstaller((spec) =>
			spec.id === "third-party" ? { ok: false, error: "clone failed" } : { ok: true },
		);
		const afterWrites: boolean[] = [];
		const res = await syncPluginCatalog(
			src,
			{ install: true },
			{
				customCatalogPath: custom,
				pluginsDir,
				installer,
				afterWrite: async (pluginsChanged) => {
					afterWrites.push(pluginsChanged);
				},
			},
		);
		expect(res.ok).toBe(true);
		expect(res.installed).toEqual([
			{ id: "third-party", ok: false, error: "clone failed" },
			{ id: "installed-already", ok: true },
		]);
		expect(calls.map((c) => [c.id, c.action])).toEqual([
			["third-party", "install"],
			["installed-already", "update"],
		]);
		// 写盘只刷新目录；安装完成才重载插件
		expect(afterWrites).toEqual([false, true]);
		expect(existsSync(custom)).toBe(true);
	});
});
