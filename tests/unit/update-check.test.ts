/**
 * All-source update check 单测：包枚举（含 scoped/.bin/坏 package.json）、
 * 结果 shape、并发 checkAll 的优雅降级（单个失败不影响整体）、顺序保持。
 * 全程注入 fake fetcher，零网络。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkAll,
	collectTargets,
	compareVersions,
	defaultCheckGitExtension,
	formatGitVersion,
	isGitExtensionCheckEnabled,
	listGitExtensions,
	listInstalledPackages,
	memoizeWithTtl,
	NPM_DEFAULT_REGISTRY,
	parseGitExtensionSource,
	parseNpmrcAuth,
	parseNpmrcRegistry,
	parsePiVersionOutput,
	resolveNpmRegistry,
	type Fetcher,
	type GitCheckFn,
	type LocalPackage,
} from "../../server/update-check.js";

function makeFetcher(latest: Record<string, string>, fail: string[] = []): { fetcher: Fetcher; calls: string[] } {
	const calls: string[] = [];
	const fetcher: Fetcher = async (url) => {
		const name = decodeURIComponent(String(url).split("/").pop() ?? "");
		calls.push(name);
		if (fail.includes(name)) return { ok: false, status: 500, json: async () => ({}) };
		return {
			ok: true,
			status: 200,
			json: async () => ({
				"dist-tags": { latest: latest[name] ?? null },
				time: latest[name] ? { [latest[name]]: "2026-01-01T00:00:00Z" } : {},
			}),
		};
	};
	return { fetcher, calls };
}

describe("compareVersions", () => {
	it("numeric segment compare", () => {
		expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
		expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("0.48.0", "0.48.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});
});

describe("parsePiVersionOutput", () => {
	it("prefers an exact version line (leading v, prerelease kept)", () => {
		expect(parsePiVersionOutput("0.84.4")).toBe("0.84.4");
		expect(parsePiVersionOutput("v0.84.4")).toBe("0.84.4");
		expect(parsePiVersionOutput("  0.85.0-beta.1  \n")).toBe("0.85.0-beta.1");
		expect(parsePiVersionOutput("v0.85.0-beta.1+build.7\n")).toBe("0.85.0-beta.1+build.7");
	});

	it("exact line wins over a misleading preamble", () => {
		expect(parsePiVersionOutput("Update available: 0.85.0\n0.84.4")).toBe("0.84.4");
	});

	it("falls back to the first loose token when no line is exact", () => {
		expect(parsePiVersionOutput("pi version is 0.84.4 (built today)")).toBe("0.84.4");
	});

	it("garbage → null", () => {
		expect(parsePiVersionOutput("")).toBeNull();
		expect(parsePiVersionOutput("no version here")).toBeNull();
	});
});

describe("memoizeWithTtl", () => {
	it("calls through once within the TTL, again after expiry", () => {
		vi.useFakeTimers();
		try {
			let n = 0;
			const fn = vi.fn(() => ++n);
			const memo = memoizeWithTtl(fn, 10_000);
			expect(memo()).toBe(1);
			expect(memo()).toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(10_000);
			expect(memo()).toBe(2);
			expect(fn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caches null results like any other value", () => {
		vi.useFakeTimers();
		try {
			const fn = vi.fn((): string | null => null);
			const memo = memoizeWithTtl(fn, 60_000);
			expect(memo()).toBeNull();
			expect(memo()).toBeNull();
			expect(fn).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("listInstalledPackages", () => {
	let dir: string;
	it("enumerates plain + scoped, skips .bin/dotfiles/broken", () => {
		dir = mkdtempSync(join(tmpdir(), "upd-check-"));
		const root = join(dir, "npm", "node_modules");
		const pkg = (d: string, name: string, version: string) => {
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, "package.json"), JSON.stringify({ name, version }));
		};
		pkg(join(root, "foo"), "foo", "1.0.0");
		pkg(join(root, "@scope", "bar"), "@scope/bar", "2.3.4");
		pkg(join(root, "@scope", "baz"), "@scope/baz", "0.1.0");
		// noise
		mkdirSync(join(root, ".bin"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		mkdirSync(join(root, "@scope", ".staging"), { recursive: true });
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "package.json"), "{not json");
		mkdirSync(join(root, "empty"), { recursive: true }); // no package.json

		const items = listInstalledPackages(dir);
		expect(items).toEqual([
			{ name: "@scope/bar", version: "2.3.4", kind: "package" },
			{ name: "@scope/baz", version: "0.1.0", kind: "package" },
			{ name: "foo", version: "1.0.0", kind: "package" },
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] for a missing agentDir", () => {
		// Self-contained fixture — not coupled to the first test's directory.
		const isolated = mkdtempSync(join(tmpdir(), "upd-check-empty-"));
		try {
			expect(listInstalledPackages(join(isolated, "nope"))).toEqual([]);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});

describe("listInstalledPackages (manifest-driven)", () => {
	const pkgJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};

	it("lists direct deps with installed versions; transitive-only packages excluded", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-manifest-"));
		try {
			pkgJson(join(dir, "npm"), {
				dependencies: { foo: "^1.0.0", "@scope/bar": "~2.0.0" },
			});
			const root = join(dir, "npm", "node_modules");
			pkgJson(join(root, "foo"), { name: "foo", version: "1.2.3" });
			pkgJson(join(root, "@scope", "bar"), {
				name: "@scope/bar",
				version: "2.0.1",
			});
			// transitive dep: present in node_modules but not in the manifest
			pkgJson(join(root, "transitive"), {
				name: "transitive",
				version: "0.5.0",
			});

			expect(listInstalledPackages(dir)).toEqual([
				{ name: "@scope/bar", version: "2.0.1", kind: "package" },
				{ name: "foo", version: "1.2.3", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the raw node_modules walk when the manifest is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-fallback-"));
		try {
			const root = join(dir, "npm", "node_modules");
			pkgJson(join(root, "foo"), { name: "foo", version: "1.0.0" });
			pkgJson(join(root, "extra"), { name: "extra", version: "2.0.0" });
			// no <dir>/npm/package.json at all → old walk behavior
			expect(listInstalledPackages(dir)).toEqual([
				{ name: "extra", version: "2.0.0", kind: "package" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips manifest deps that are not installed (mixed case pins the no-fallback contract)", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-skip-"));
		try {
			pkgJson(join(dir, "npm"), {
				dependencies: { foo: "^1.0.0", ghost: "^1.0.0" },
			});
			// one installed sibling: a mutant that bails to the walk when ANY dep
			// is uninstalled would surface walk-only entries — this pins it
			pkgJson(join(dir, "npm", "node_modules", "foo"), {
				name: "foo",
				version: "1.0.0",
			});
			expect(listInstalledPackages(dir)).toEqual([{ name: "foo", version: "1.0.0", kind: "package" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("collectTargets", () => {
	const pkgJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};
	const makeAgentDir = (
		manifest: Record<string, string> | null,
		installed: Array<[rel: string, name: string, version: string]>,
	) => {
		const dir = mkdtempSync(join(tmpdir(), "upd-targets-"));
		if (manifest) pkgJson(join(dir, "npm"), { dependencies: manifest });
		for (const [rel, name, version] of installed)
			pkgJson(join(dir, "npm", "node_modules", ...rel.split("/")), {
				name,
				version,
			});
		return dir;
	};
	const CORE = "@earendil-works/pi-coding-agent";

	it("probe hit → one pi-core row, positioned webui < core < packages", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => "0.84.4")).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "0.84.4", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("custom distribution excludes public webui updates while keeping core and extensions", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => "1.0.0", { includeWebui: false })).toEqual([
				{ name: CORE, version: "1.0.0", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe miss + no vendored copy → no pi-core row, rest unchanged", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe miss + vendored copy → pi-core row from the vendored version", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [
			["foo", "foo", "1.0.0"],
			[CORE, CORE, "9.9.9"],
		]);
		try {
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "9.9.9", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe wins over vendored copy; manifest row deduped to one pi-core row", () => {
		const dir = makeAgentDir({ foo: "^1.0.0", [CORE]: "^0.84.2" }, [
			["foo", "foo", "1.0.0"],
			[CORE, CORE, "0.84.3"],
		]);
		try {
			const targets = collectTargets(dir, "0.48.0", () => "0.84.4");
			expect(targets[0]).toEqual({
				name: "pi-web-ui",
				version: "0.48.0",
				kind: "webui",
			});
			expect(targets.filter((t) => t.name === CORE)).toEqual([{ name: CORE, version: "0.84.4", kind: "pi-core" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("walk fallback (no manifest) still dedupes the core to one pi-core row", () => {
		const dir = makeAgentDir(null, [
			[CORE, CORE, "0.85.0"],
			["plain", "plain", "1.0.0"],
		]);
		try {
			// probe null → vendored 0.85.0 wins; the raw walk must not re-add CORE
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "0.85.0", kind: "pi-core" },
				{ name: "plain", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkAll", () => {
	it("shapes items, preserves order, degrades failures per-item", async () => {
		const targets: LocalPackage[] = [
			{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
			{ name: "@earendil-works/pi-coding-agent", version: "1.0.0", kind: "pi-core" },
			{ name: "foo", version: "1.0.0", kind: "package" },
			{ name: "flaky", version: "2.0.0", kind: "package" },
		];
		const { fetcher } = makeFetcher(
			{
				"pi-web-ui": "0.49.0",
				"@earendil-works/pi-coding-agent": "1.0.0",
				foo: "0.9.0",
			},
			["flaky"],
		);
		const items = await checkAll(targets, fetcher);
		expect(items.map((i) => i.name)).toEqual(targets.map((t) => t.name));
		const [webui, core, foo, flaky] = items;
		expect(webui).toMatchObject({
			kind: "webui",
			current: "0.48.0",
			latest: "0.49.0",
			upToDate: false,
			latestPublishedAt: "2026-01-01T00:00:00Z",
		});
		expect(core!.upToDate).toBe(true);
		expect(foo).toMatchObject({ upToDate: true, current: "1.0.0", latest: "0.9.0" });
		expect(flaky).toMatchObject({
			latest: null,
			upToDate: false,
		});
		expect(flaky!.error).toContain("500");
		// one failure never rejects the whole list
		expect(items.every((i) => typeof i.current === "string")).toBe(true);
	});

	it("handles missing dist-tags / sparse docs", async () => {
		const fetcher: Fetcher = async () => ({
			ok: true,
			status: 200,
			json: async () => ({}),
		});
		const items = await checkAll([{ name: "ghost", version: "1.0.0", kind: "package" }], fetcher);
		expect(items[0]).toMatchObject({ latest: null, upToDate: true });
	});

	it("uses the configured registry base + auth header (issue #151)", async () => {
		const seen: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
		const fetcher: Fetcher = async (url, init) => {
			seen.push({ url, init });
			return {
				ok: true,
				status: 200,
				json: async () => ({
					"dist-tags": { latest: "9.9.9" },
					time: { "9.9.9": "2026-01-01T00:00:00Z" },
				}),
			};
		};
		await checkAll([{ name: "foo", version: "1.0.0", kind: "package" }], fetcher, undefined, {
			registry: "https://registry.npmmirror.com",
			authHeader: "Bearer sekrit",
		});
		expect(seen[0]!.url).toBe("https://registry.npmmirror.com/foo");
		expect(seen[0]!.init?.headers).toEqual({ authorization: "Bearer sekrit" });
	});
});

describe("npmrc registry resolution (issue #151)", () => {
	it("parseNpmrcRegistry: last registry= wins, quotes/trailing slash cleaned", () => {
		expect(parseNpmrcRegistry("")).toBeNull();
		expect(parseNpmrcRegistry("# comment\n; another\n")).toBeNull();
		expect(
			parseNpmrcRegistry('registry=https://registry.npmjs.org/\nregistry = "https://registry.npmmirror.com/"\n'),
		).toBe("https://registry.npmmirror.com");
		// 非 http(s) 行忽略
		expect(parseNpmrcRegistry("registry=npmjs\n")).toBeNull();
	});

	it("parseNpmrcAuth: matches the registry host, _authToken beats _auth", () => {
		const text =
			"//other.example.com/:_authToken=nope\n" +
			"//registry.npmmirror.com/:_auth=dGVzdA==\n" +
			"//registry.npmmirror.com/:_authToken=sekrit\n";
		expect(parseNpmrcAuth(text, "https://registry.npmmirror.com")).toBe("Bearer sekrit");
		expect(parseNpmrcAuth("//registry.npmmirror.com/:_auth=dGVzdA==\n", "https://registry.npmmirror.com")).toBe(
			"Basic dGVzdA==",
		);
		expect(parseNpmrcAuth("//other.example.com/:_authToken=nope\n", "https://registry.npmmirror.com")).toBeNull();
		expect(parseNpmrcAuth("registry=x\n", "not a url")).toBeNull();
	});

	it("resolveNpmRegistry: missing .npmrc → official default", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-npmrc-missing-"));
		try {
			expect(resolveNpmRegistry(dir)).toEqual({
				registry: NPM_DEFAULT_REGISTRY,
				authHeader: null,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolveNpmRegistry: reads <agentDir>/npm/.npmrc", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-npmrc-"));
		try {
			mkdirSync(join(dir, "npm"), { recursive: true });
			writeFileSync(
				join(dir, "npm", ".npmrc"),
				"registry=https://registry.npmmirror.com/\n//registry.npmmirror.com/:_authToken=sekrit\n",
			);
			expect(resolveNpmRegistry(dir)).toEqual({
				registry: "https://registry.npmmirror.com",
				authHeader: "Bearer sekrit",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sortUpdateItems", () => {
	it("pins webui/pi-core top, outdated before up-to-date, errors last", async () => {
		const { sortUpdateItems } = await import("../../server/update-check.js");
		const items = [
			{ name: "ok-pkg", kind: "package", current: "1.0.0", latest: "1.0.0", latestPublishedAt: null, upToDate: true },
			{
				name: "bad-pkg",
				kind: "package",
				current: "1.0.0",
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: "boom",
			},
			{ name: "old-pkg", kind: "package", current: "1.0.0", latest: "2.0.0", latestPublishedAt: null, upToDate: false },
			{
				name: "@earendil-works/pi-coding-agent",
				kind: "pi-core",
				current: "1.0.0",
				latest: "1.0.0",
				latestPublishedAt: null,
				upToDate: true,
			},
			{
				name: "pi-web-ui",
				kind: "webui",
				current: "0.48.0",
				latest: "0.48.0",
				latestPublishedAt: null,
				upToDate: true,
			},
		] as Parameters<typeof sortUpdateItems>[0];
		expect(sortUpdateItems(items).map((i) => i.name)).toEqual([
			"pi-web-ui",
			"@earendil-works/pi-coding-agent",
			"old-pkg",
			"ok-pkg",
			"bad-pkg",
		]);
	});
});

describe("parseGitExtensionSource (issue #178)", () => {
	it("parses git:-prefixed shorthand", () => {
		expect(parseGitExtensionSource("git:github.com/NVlabs/SoL-Pi")).toEqual({
			host: "github.com",
			path: "NVlabs/SoL-Pi",
			ref: null,
			shorthand: "github.com/NVlabs/SoL-Pi",
			identity: "git:github.com/NVlabs/SoL-Pi",
		});
	});

	it("parses https URLs, strips .git, keeps @ref", () => {
		expect(parseGitExtensionSource("git:https://github.com/acme/widgets.git")).toMatchObject({
			host: "github.com",
			path: "acme/widgets",
			ref: null,
		});
		expect(parseGitExtensionSource("git:github.com/acme/widgets@main")).toMatchObject({
			path: "acme/widgets",
			ref: "main",
		});
		expect(parseGitExtensionSource("https://gitlab.example.com/group/sub/repo")).toMatchObject({
			host: "gitlab.example.com",
			path: "group/sub/repo",
		});
	});

	it("parses scp-like git@ syntax", () => {
		expect(parseGitExtensionSource("git:git@github.com:acme/widgets.git")).toMatchObject({
			host: "github.com",
			path: "acme/widgets",
		});
	});

	it("rejects npm:/local/bare/garbage entries", () => {
		expect(parseGitExtensionSource("npm:pi-lens")).toBeNull();
		expect(parseGitExtensionSource("npm:@scope/pkg@1.2.3")).toBeNull();
		expect(parseGitExtensionSource("./relative/path")).toBeNull();
		expect(parseGitExtensionSource("bare-name")).toBeNull();
		// bare a/b without git: prefix is a local path, not a git source
		expect(parseGitExtensionSource("my-dir/my-ext")).toBeNull();
		expect(parseGitExtensionSource("")).toBeNull();
		expect(parseGitExtensionSource("git:")).toBeNull();
		// single-segment path can never be owner/repo
		expect(parseGitExtensionSource("git:github.com/onlyowner")).toBeNull();
		// path traversal is refused
		expect(parseGitExtensionSource("git:github.com/a/../../evil")).toBeNull();
	});
});

describe("isGitExtensionCheckEnabled (issue #178)", () => {
	it("defaults on; 0/false/no/off disable", () => {
		expect(isGitExtensionCheckEnabled({})).toBe(true);
		expect(isGitExtensionCheckEnabled({ PI_WEB_GIT_EXTENSION_CHECK: "1" })).toBe(true);
		for (const v of ["0", "false", "FALSE", "no", "off", " 0 "]) {
			expect(isGitExtensionCheckEnabled({ PI_WEB_GIT_EXTENSION_CHECK: v }), v).toBe(false);
		}
	});
});

describe("listGitExtensions (issue #178)", () => {
	const writeJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};
	const makeTree = () => {
		const agentDir = mkdtempSync(join(tmpdir(), "upd-git-global-"));
		const projCwd = mkdtempSync(join(tmpdir(), "upd-git-proj-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [
					"npm:pi-x",
					"git:github.com/NVlabs/SoL-Pi",
					"git:github.com/acme/widgets",
					"./local-dir",
					{ source: "git:github.com/acme/object-form" },
				],
			}),
		);
		writeJson(join(agentDir, "git", "github.com", "NVlabs", "SoL-Pi"), { name: "sol-pi", version: "0.1.0" });
		writeJson(join(agentDir, "git", "github.com", "acme", "widgets"), { name: "acme-widgets", version: "2.0.0" });
		// object-form has no clone on disk → row kept with version "?"
		mkdirSync(join(projCwd, ".pi"), { recursive: true });
		writeFileSync(
			join(projCwd, ".pi", "settings.json"),
			JSON.stringify({
				packages: ["git:github.com/NVlabs/SoL-Pi", "git:github.com/acme/proj-only@main"],
			}),
		);
		writeJson(join(projCwd, ".pi", "git", "github.com", "NVlabs", "SoL-Pi"), {
			name: "sol-pi-proj",
			version: "9.9.9",
		});
		writeJson(join(projCwd, ".pi", "git", "github.com", "acme", "proj-only"), {
			name: "proj-only",
			version: "1.0.0",
		});
		return { agentDir, projCwd };
	};

	it("merges global + project, project wins on identity collision", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			const items = listGitExtensions(agentDir, projCwd, {});
			expect(items.map((i) => i.name)).toEqual([
				"acme-widgets",
				"github.com/acme/object-form",
				"proj-only",
				"sol-pi-proj",
			]);
			const solPi = items.find((i) => i.source === "github.com/NVlabs/SoL-Pi")!;
			expect(solPi.version).toBe("9.9.9"); // project clone wins
			expect(solPi.installDir).toBe(join(projCwd, ".pi", "git", "github.com", "NVlabs", "SoL-Pi"));
			expect(solPi.ref).toBeNull();
			const projOnly = items.find((i) => i.name === "proj-only")!;
			expect(projOnly.ref).toBe("main");
			const missing = items.find((i) => i.name === "github.com/acme/object-form")!;
			expect(missing.version).toBe("?");
			expect(missing.installDir).toBe(join(agentDir, "git", "github.com", "acme", "object-form"));
			// npm:/local: entries never leak into the git list
			expect(items.every((i) => i.kind === "git-extension")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("works without a project cwd and with missing settings", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			expect(listGitExtensions(agentDir, undefined, {}).map((i) => i.name)).toEqual([
				"acme-widgets",
				"github.com/acme/object-form",
				"sol-pi",
			]);
			expect(listGitExtensions(join(agentDir, "nope"), join(projCwd, "nope"), {})).toEqual([]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("env switch disables the whole git list", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			expect(listGitExtensions(agentDir, projCwd, { PI_WEB_GIT_EXTENSION_CHECK: "0" })).toEqual([]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("w9: name and version fall back independently, name never empty", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "upd-git-half-"));
		try {
			// Clone with a version but no usable name: version kept, name = shorthand.
			mkdirSync(join(agentDir, "git", "github.com", "acme", "noname"), { recursive: true });
			writeFileSync(
				join(agentDir, "git", "github.com", "acme", "noname", "package.json"),
				JSON.stringify({ version: "1.0.0" }),
			);
			// Clone with a name but no version: name kept, version "?".
			mkdirSync(join(agentDir, "git", "github.com", "acme", "nover"), { recursive: true });
			writeFileSync(
				join(agentDir, "git", "github.com", "acme", "nover", "package.json"),
				JSON.stringify({ name: "acme-nover" }),
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ packages: ["git:github.com/acme/noname", "git:github.com/acme/nover"] }),
			);
			const items = listGitExtensions(agentDir, undefined, {});
			expect(items).toEqual([
				expect.objectContaining({ name: "acme-nover", version: "?" }),
				expect.objectContaining({ name: "github.com/acme/noname", version: "1.0.0" }),
			]);
			expect(items.every((i) => i.name.length > 0)).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("collectTargets with git extensions (issue #178)", () => {
	it("appends git rows after npm packages", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-targets-git-"));
		try {
			mkdirSync(join(dir, "npm"), { recursive: true });
			writeFileSync(join(dir, "npm", "package.json"), JSON.stringify({ dependencies: { foo: "^1.0.0" } }));
			mkdirSync(join(dir, "npm", "node_modules", "foo"), { recursive: true });
			writeFileSync(
				join(dir, "npm", "node_modules", "foo", "package.json"),
				JSON.stringify({ name: "foo", version: "1.0.0" }),
			);
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["git:github.com/NVlabs/SoL-Pi"] }));
			mkdirSync(join(dir, "git", "github.com", "NVlabs", "SoL-Pi"), { recursive: true });
			writeFileSync(
				join(dir, "git", "github.com", "NVlabs", "SoL-Pi", "package.json"),
				JSON.stringify({ name: "sol-pi", version: "0.1.0" }),
			);
			const targets = collectTargets(dir, "0.48.0", () => null, {});
			expect(targets).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: "foo", version: "1.0.0", kind: "package" },
				{
					name: "sol-pi",
					version: "0.1.0",
					kind: "git-extension",
					source: "github.com/NVlabs/SoL-Pi",
					installDir: join(dir, "git", "github.com", "NVlabs", "SoL-Pi"),
					ref: null,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("formatGitVersion", () => {
	it("version + short sha; sha-only without a version", () => {
		expect(formatGitVersion("0.1.0", "a".repeat(40))).toBe(`0.1.0 (${"a".repeat(7)})`);
		expect(formatGitVersion("?", "b".repeat(40))).toBe("b".repeat(7));
		expect(formatGitVersion("", "c".repeat(40))).toBe("c".repeat(7));
	});
});

describe("checkAll git extensions (issue #178)", () => {
	const LOCAL_A = "a".repeat(40);
	const REMOTE_B = "b".repeat(40);
	const SAME_C = "c".repeat(40);
	const gitCheck: GitCheckFn = async (dir: string) => {
		if (dir === "/x") return { localSha: LOCAL_A, remoteSha: REMOTE_B };
		if (dir === "/y") return { localSha: SAME_C, remoteSha: SAME_C };
		throw new Error("clone missing");
	};
	const targets: LocalPackage[] = [
		{ name: "sol-pi", version: "0.1.0", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi", installDir: "/x" },
		{
			name: "up-to-date-ext",
			version: "1.0.0",
			kind: "git-extension",
			source: "github.com/acme/current",
			installDir: "/y",
		},
		{ name: "broken-ext", version: "?", kind: "git-extension", source: "github.com/acme/broken", installDir: "/z" },
	];

	it("sha mismatch → outdated with version(short-sha) on both sides", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items.map((i) => i.name)).toEqual(targets.map((t) => t.name));
		expect(items[0]).toMatchObject({
			kind: "git-extension",
			current: "0.1.0 (aaaaaaa)",
			latest: "0.1.0 (bbbbbbb)",
			upToDate: false,
			source: "github.com/NVlabs/SoL-Pi",
		});
		expect(items[0]!.latestPublishedAt).toBeNull();
	});

	it("equal shas → upToDate, current === latest", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items[1]).toMatchObject({
			kind: "git-extension",
			current: "1.0.0 (ccccccc)",
			latest: "1.0.0 (ccccccc)",
			upToDate: true,
		});
	});

	it("git failure degrades to a per-item error without touching other rows", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items[2]).toMatchObject({ latest: null, upToDate: false, current: "?" });
		expect(items[2]!.error).toContain("clone missing");
		// the npm path still works alongside git rows
		const mixed = await checkAll(
			[...targets.slice(0, 1), { name: "foo", version: "1.0.0", kind: "package" as const }],
			makeFetcher({ foo: "2.0.0" }).fetcher,
			undefined,
			undefined,
			gitCheck,
		);
		expect(mixed[1]).toMatchObject({ kind: "package", latest: "2.0.0", upToDate: false });
	});
});

describe("defaultCheckGitExtension", () => {
	it("is a function (real git covered by manual probe, not unit CI)", () => {
		expect(typeof defaultCheckGitExtension).toBe("function");
	});
});
