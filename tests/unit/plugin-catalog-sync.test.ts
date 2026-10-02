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
				workspaceRoot: dir,
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
		const deps = { customCatalogPath: custom, pluginsDir, installer, workspaceRoot: dir, afterWrite: async () => {} };
		const r1 = await syncPluginCatalog(bad, {}, deps);
		expect(r1.ok).toBe(false);
		expect(r1.error).toBeTruthy();
		const r2 = await syncPluginCatalog(join(dir, "missing.json"), {}, deps);
		expect(r2.ok).toBe(false);
		const r3 = await syncPluginCatalog("relative/path.json", {}, deps);
		expect(r3.ok).toBe(false);
		expect(readFileSync(custom, "utf8")).toBe(before);
	});

	it("本地来源的「读不到」与「坏 JSON」错误统一（不构成文件探测 oracle）", async () => {
		const { installer } = fakeInstaller();
		const deps = { customCatalogPath: custom, pluginsDir, installer, workspaceRoot: dir, afterWrite: async () => {} };
		const r1 = await syncPluginCatalog(join(dir, "missing.json"), {}, deps);
		writeFileSync(join(dir, "bad.json"), "{ not json");
		const r2 = await syncPluginCatalog(join(dir, "bad.json"), {}, deps);
		const r3 = await syncPluginCatalog(join(dir, "..", "outside.json"), {}, deps); // 越出工作区
		expect(r1.ok).toBe(false);
		expect(r2.ok).toBe(false);
		expect(r3.ok).toBe(false);
		expect(r1.error).toBe(r2.error);
		expect(r1.error).toBe(r3.error);
	});

	it("工作区之外的本地路径一律拒绝（未传 workspaceRoot 同样拒绝）", async () => {
		const outside = join(tmpdir(), `outside-${Date.now()}.json`);
		writeFileSync(outside, JSON.stringify({ entries: [ENTRY] }));
		try {
			const { installer } = fakeInstaller();
			const deps = { customCatalogPath: custom, pluginsDir, installer, workspaceRoot: dir, afterWrite: async () => {} };
			const r1 = await syncPluginCatalog(outside, {}, deps);
			expect(r1.ok).toBe(false);
			// 未接入 workspaceRoot（无头/调用方没配）：本地路径 fail-closed
			const r2 = await syncPluginCatalog(
				outside,
				{},
				{
					customCatalogPath: custom,
					pluginsDir,
					installer,
					afterWrite: async () => {},
				},
			);
			expect(r2.ok).toBe(false);
			expect(existsSync(custom)).toBe(false);
		} finally {
			rmSync(outside, { force: true });
		}
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
				workspaceRoot: dir,
				afterWrite: async (pluginsChanged) => {
					afterWrites.push(pluginsChanged);
				},
				// 安装确认门放行（本条测的是安装批处理本身，门的行为在下面两条单测）
				confirmInstall: async () => true,
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

	it("install:true 无确认设施（无头）→ 只写目录不安装（fail-closed）", async () => {
		const src = join(dir, "remote.json");
		writeFileSync(src, JSON.stringify([ENTRY]));
		const { installer, calls } = fakeInstaller();
		let afterWrites = 0;
		const res = await syncPluginCatalog(
			src,
			{ install: true },
			{
				customCatalogPath: custom,
				pluginsDir,
				installer,
				workspaceRoot: dir,
				afterWrite: async () => {
					afterWrites += 1;
				},
			},
		);
		expect(res.ok).toBe(true);
		expect(res.installRefused).toBe(true);
		expect(res.installed).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(afterWrites).toBe(1); // 写盘后一次；安装后的重载没有发生
		expect(JSON.parse(readFileSync(custom, "utf8"))).toMatchObject({ entries: [{ id: "third-party" }] });
	});

	it("install:true 用户拒绝 → 只写目录不安装；同意 → 正常安装", async () => {
		const src = join(dir, "remote.json");
		writeFileSync(src, JSON.stringify([ENTRY]));
		// 拒绝
		const refused = fakeInstaller();
		const r1 = await syncPluginCatalog(
			src,
			{ install: true },
			{
				customCatalogPath: custom,
				pluginsDir,
				installer: refused.installer,
				workspaceRoot: dir,
				afterWrite: async () => {},
				confirmInstall: async () => false,
			},
		);
		expect(r1.installRefused).toBe(true);
		expect(refused.calls).toHaveLength(0);
		// 同意
		const accepted = fakeInstaller();
		const r2 = await syncPluginCatalog(
			src,
			{ install: true },
			{
				customCatalogPath: custom,
				pluginsDir,
				installer: accepted.installer,
				workspaceRoot: dir,
				afterWrite: async () => {},
				confirmInstall: async (items) => {
					expect(items).toEqual([{ id: "third-party", source: "someone/repo" }]);
					return true;
				},
			},
		);
		expect(r2.installRefused).toBeUndefined();
		expect(accepted.calls.map((c) => c.action)).toEqual(["install"]);
	});
});
