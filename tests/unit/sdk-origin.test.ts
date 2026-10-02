/**
 * sdk-origin 单测（issue #260）：
 * 复刻「全局安装 + 自带副本」的目录布局，验证按 Node 的解析顺序列出副本、
 * 以及「被遮蔽的副本更新时给出提示」。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, isBundledInUse, sdkCopies, sdkOriginNote } from "../../server/sdk-origin.js";

const PKG = "@earendil-works/pi-coding-agent";
const roots: string[] = [];

/** 造一个副本：<dir>/node_modules/@earendil-works/pi-coding-agent/package.json */
function putCopy(dir: string, version: string): void {
	const pkgDir = join(dir, "node_modules", PKG);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version }));
}

function makeTree(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-origin-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("sdkCopies：按 Node 的解析顺序列出可被加载的副本", () => {
	it("嵌套副本排在祖先副本之前（嵌套赢 = issue #260 的根因）", () => {
		// <root>/node_modules/...            ← 全局根那份（用户升的）
		// <root>/pi-web-ui/node_modules/...  ← pi-web-ui 自带那份（实际生效）
		const root = makeTree();
		putCopy(root, "0.86.1");
		const app = join(root, "pi-web-ui");
		putCopy(app, "0.85.1");
		const entry = join(app, "dist", "server", "index.js");
		mkdirSync(join(app, "dist", "server"), { recursive: true });
		writeFileSync(entry, "");

		const copies = sdkCopies(entry);
		expect(copies.map((c) => c.version)).toEqual(["0.85.1", "0.86.1"]);
		expect(copies[0].path).toContain(join("pi-web-ui", "node_modules"));
		expect(copies[1].path).toBe(join(root, "node_modules", PKG, "package.json"));
	});

	it("只有一份时返回一份（独立安装、没有全局副本）", () => {
		const root = makeTree();
		const app = join(root, "app");
		putCopy(app, "0.86.1");
		const entry = join(app, "dist", "server", "index.js");
		mkdirSync(join(app, "dist", "server"), { recursive: true });
		writeFileSync(entry, "");

		expect(sdkCopies(entry).map((c) => c.version)).toEqual(["0.86.1"]);
	});

	it("一份都没有时返回空数组（不抛错）", () => {
		const root = makeTree();
		const entry = join(root, "dist", "server", "index.js");
		mkdirSync(join(root, "dist", "server"), { recursive: true });
		writeFileSync(entry, "");
		expect(sdkCopies(entry)).toEqual([]);
	});

	it("坏 JSON 只跳过那一份，不影响其它候选", () => {
		const root = makeTree();
		putCopy(root, "0.86.1");
		const app = join(root, "app");
		const badDir = join(app, "node_modules", PKG);
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "package.json"), "{ not json");
		const entry = join(app, "dist", "server", "index.js");
		mkdirSync(join(app, "dist", "server"), { recursive: true });
		writeFileSync(entry, "");

		expect(sdkCopies(entry).map((c) => c.version)).toEqual(["0.86.1"]);
	});
});

describe("compareVersions", () => {
	it("按数字段比较，缺位当 0", () => {
		expect(compareVersions("0.86.1", "0.85.1")).toBe(1);
		expect(compareVersions("0.85.1", "0.86.1")).toBe(-1);
		expect(compareVersions("0.86.1", "0.86.1")).toBe(0);
		expect(compareVersions("0.86", "0.86.0")).toBe(0);
		expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
	});
});

describe("sdkOriginNote：只在「被遮蔽的副本更新」时提示", () => {
	it("被遮蔽的副本更新 → 给提示", () => {
		const note = sdkOriginNote(
			[
				{ path: "a", version: "0.85.1" },
				{ path: "b", version: "0.86.1" },
			],
			"0.85.1",
		);
		expect(note).toContain("0.86.1");
		expect(note).toContain("bundled");
	});

	it("被遮蔽的副本更旧或相同 → 不提示（没什么可提醒的）", () => {
		expect(
			sdkOriginNote(
				[
					{ path: "a", version: "0.86.1" },
					{ path: "b", version: "0.85.1" },
				],
				"0.86.1",
			),
		).toBeNull();
		expect(
			sdkOriginNote(
				[
					{ path: "a", version: "0.86.1" },
					{ path: "b", version: "0.86.1" },
				],
				"0.86.1",
			),
		).toBeNull();
		expect(sdkOriginNote([{ path: "a", version: "0.86.1" }], "0.86.1")).toBeNull();
	});
});

describe("isBundledInUse (issue #321)", () => {
	it("running == copies[0] → 自带在用；跟随祖先副本 → 不是；copies 为空 → 按自带算", () => {
		expect(
			isBundledInUse(
				[
					{ path: "a", version: "0.87.1" },
					{ path: "b", version: "0.86.1" },
				],
				"0.87.1",
			),
		).toBe(true);
		expect(
			isBundledInUse(
				[
					{ path: "a", version: "0.86.1" },
					{ path: "b", version: "0.95.0" },
				],
				"0.95.0",
			),
		).toBe(false);
		expect(isBundledInUse([], "0.87.1")).toBe(true);
	});
});

describe("isBundledInUse：同版本时按实际加载路径判断（显式 PI_WEB_SDK=global）", () => {
	const copies = [
		{
			path: "/prefix/lib/node_modules/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/package.json",
			version: "1.0.0",
		},
		{ path: "/global/lib/node_modules/@earendil-works/pi-coding-agent/package.json", version: "1.0.0" },
	];
	it("加载的是祖先那份 → 不是自带；加载的是嵌套那份 → 自带", () => {
		expect(
			isBundledInUse(copies, "1.0.0", "/global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
		).toBe(false);
		expect(
			isBundledInUse(
				copies,
				"1.0.0",
				"file:///prefix/lib/node_modules/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
			),
		).toBe(true);
	});
	it("不给入口时沿用版本号判据", () => {
		expect(isBundledInUse(copies, "1.0.0")).toBe(true);
	});
});

describe("bundled SDK release pin", () => {
	it("declares exactly the SDK version tested by the repository lock", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
		const version = lock.packages["node_modules/@earendil-works/pi-coding-agent"].version;
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(version);
		expect(lock.packages[""].dependencies["@earendil-works/pi-coding-agent"]).toBe(version);
	});
});
