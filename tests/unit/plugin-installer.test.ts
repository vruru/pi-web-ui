/**
 * 插件后台作业（server/plugin-installer.ts）单测：argv 构造与安全校验、忙/托管拒绝、
 * 输出行回传与 done 回执、非零退出码的失败回执、取消。
 *
 * 用一个假的「pkgRoot/bin/pi-web-ui.mjs」当 CLI：测试不联网、不碰真实插件目录。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginInstaller, buildPluginJobArgs, confirmPluginInstall } from "../../server/plugin-installer.js";
import type { ServerMessage } from "../../server/protocol.js";

let root: string;

function makeFakeCli(body: string): string {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi-web-ui.mjs"), body);
	return root;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-plugin-job-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("buildPluginJobArgs", () => {
	const dataDir = "/data";

	it("install / update / uninstall 的参数与 --build / --no-build", () => {
		expect(buildPluginJobArgs({ jobId: "j", action: "install", id: "webmail", source: "o/r" }, dataDir)).toEqual({
			args: ["install", "o/r", "--name", "webmail", "--data-dir", dataDir],
		});
		expect(
			buildPluginJobArgs({ jobId: "j", action: "update", id: "webmail", source: "o/r/sub", build: true }, dataDir),
		).toEqual({
			args: ["install", "o/r/sub", "--name", "webmail", "--data-dir", dataDir, "--force", "--build"],
		});
		expect(
			buildPluginJobArgs({ jobId: "j", action: "install", id: "webmail", source: "o/r", noBuild: true }, dataDir),
		).toEqual({
			args: ["install", "o/r", "--name", "webmail", "--data-dir", dataDir, "--no-build"],
		});
		expect(buildPluginJobArgs({ jobId: "j", action: "uninstall", id: "webmail" }, dataDir)).toEqual({
			args: ["uninstall", "webmail", "--data-dir", dataDir],
		});
	});

	it("--build 与 --no-build 互斥（issue #165）", () => {
		expect(
			buildPluginJobArgs(
				{ jobId: "j", action: "install", id: "webmail", source: "o/r", build: true, noBuild: true },
				dataDir,
			),
		).toHaveProperty("error");
	});

	it("非法 id / 非远程来源被拒（本地路径只走 CLI）", () => {
		expect(buildPluginJobArgs({ jobId: "j", action: "install", id: "../evil", source: "o/r" }, dataDir)).toHaveProperty(
			"error",
		);
		expect(
			buildPluginJobArgs({ jobId: "j", action: "install", id: "ok", source: "/etc/passwd" }, dataDir),
		).toHaveProperty("error");
		expect(buildPluginJobArgs({ jobId: "j", action: "install", id: "ok", source: "onerepo" }, dataDir)).toHaveProperty(
			"error",
		);
	});
});

describe("PluginInstaller", () => {
	it("成功作业：回传 log 行 + done(ok, 输出尾部)", async () => {
		const pkgRoot = makeFakeCli(`console.log("cloning…");console.log("installed webmail");process.exit(0);`);
		const installer = new PluginInstaller({ dataDir: join(root, "data"), pkgRoot, managed: false });
		const msgs: ServerMessage[] = [];
		const res = await new Promise<{ ok: boolean; output: string }>((resolve) => {
			const started = installer.start(
				{ jobId: "j1", action: "install", id: "webmail", source: "o/r" },
				{
					emit: (m) => msgs.push(m),
					done: (ok, info) => resolve({ ok, output: info.output }),
				},
			);
			expect(started.ok).toBe(true);
		});
		expect(res.ok).toBe(true);
		expect(res.output).toContain("installed webmail");
		const phases = msgs.filter((m) => m.type === "plugin_job").map((m) => (m.type === "plugin_job" ? m.phase : ""));
		expect(phases[0]).toBe("start");
		expect(phases.at(-1)).toBe("done");
		expect(msgs.some((m) => m.type === "plugin_job" && m.phase === "log" && m.line === "cloning…")).toBe(true);
		// 作业结束后空闲
		expect(installer.busyJobId).toBeNull();
	});

	it("失败作业：非零退出码 → ok:false，输出仍回传", async () => {
		const pkgRoot = makeFakeCli(`console.error("boom");process.exit(2);`);
		const installer = new PluginInstaller({ dataDir: join(root, "data"), pkgRoot, managed: false });
		const res = await new Promise<{ ok: boolean; error?: string; output: string }>((resolve) => {
			installer.start(
				{ jobId: "j2", action: "install", id: "webmail", source: "o/r" },
				{ emit: () => {}, done: (ok, info) => resolve({ ok, error: info.error, output: info.output }) },
			);
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("exit code 2");
		expect(res.output).toContain("boom");
	});

	it("同一时刻只跑一个作业：第二个被拒（busy）", async () => {
		// 这个 CLI 等到被取消才退出（给第二个请求留出窗口）。
		const pkgRoot = makeFakeCli(`setTimeout(() => process.exit(0), 30000);`);
		const installer = new PluginInstaller({ dataDir: join(root, "data"), pkgRoot, managed: false });
		const first = new Promise<void>((resolve) => {
			installer.start(
				{ jobId: "busy1", action: "install", id: "webmail", source: "o/r" },
				{ emit: () => {}, done: () => resolve() },
			);
		});
		// 等它真的起来
		await new Promise((r) => setTimeout(r, 500));
		expect(installer.busyJobId).toBe("busy1");
		const second = installer.start(
			{ jobId: "busy2", action: "install", id: "other", source: "o/r" },
			{ emit: () => {}, done: () => {} },
		);
		expect(second.ok).toBe(false);
		expect(typeof second.error).toBe("string");
		// 取消第一个，收尾（避免测试进程被 30s 定时器拖着）
		expect(installer.cancel("busy1")).toBe(true);
		await first;
		expect(installer.busyJobId).toBeNull();
	});

	it("托管实例（PI_WEB_MANAGED）直接拒绝", () => {
		const pkgRoot = makeFakeCli(`process.exit(0);`);
		const installer = new PluginInstaller({ dataDir: join(root, "data"), pkgRoot, managed: true });
		const res = installer.start(
			{ jobId: "j3", action: "install", id: "webmail", source: "o/r" },
			{ emit: () => {}, done: () => {} },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("PI_WEB_MANAGED");
	});

	it("CLI 缺失时明确报错", () => {
		const installer = new PluginInstaller({ dataDir: join(root, "data"), pkgRoot: join(root, "nope"), managed: false });
		const res = installer.start(
			{ jobId: "j4", action: "install", id: "webmail", source: "o/r" },
			{ emit: () => {}, done: () => {} },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("pi-web-ui");
	});

	it("run() 同步等待：解析为最终结果（目录同步的自动安装用）", async () => {
		const pkgRoot = makeFakeCli(`console.log("ok");process.exit(0);`);
		const dataDir = join(root, "data");
		const installer = new PluginInstaller({ dataDir, pkgRoot, managed: false });
		const res = await installer.run({
			jobId: "catalog-sync:webmail",
			action: "install",
			id: "webmail",
			source: "o/r",
		});
		expect(res.ok).toBe(true);
		expect(res.output).toContain("ok");
	});
});

describe("环境隔离", () => {
	it("fake CLI 会收到 PI_WEB_DATA_DIR（子进程环境）", async () => {
		const dataDir = join(root, "data");
		const pkgRoot = makeFakeCli(
			`import { writeFileSync } from "node:fs";writeFileSync(process.argv[2] ?? "x", String(process.env.PI_WEB_DATA_DIR ?? ""));process.exit(0);`,
		);
		// argv[2] 是 install 子命令——改把环境写到一个固定路径里更直接
		const probe = join(root, "probe.txt");
		writeFileSync(
			join(pkgRoot, "bin", "pi-web-ui.mjs"),
			`import { writeFileSync } from "node:fs";writeFileSync(${JSON.stringify(probe)}, String(process.env.PI_WEB_DATA_DIR ?? ""));process.exit(0);`,
		);
		const installer = new PluginInstaller({ dataDir, pkgRoot, managed: false });
		await installer.run({ jobId: "env", action: "install", id: "webmail", source: "o/r" });
		expect(readFileSync(probe, "utf8")).toBe(dataDir);
	});
});

describe("confirmPluginInstall", () => {
	it("已有授权时直接放行，不触发弹窗", async () => {
		let asked = false;
		const ok = await confirmPluginInstall([{ id: "foo", source: "o/r" }], {
			permGrants: {
				has: (id, fam, s) => id === "plugin-installer" && fam === "net" && s?.host === "github.com",
				grant: () => {},
			},
			permissionRequester: async () => {
				asked = true;
				return { ok: true };
			},
		});
		expect(ok).toBe(true);
		expect(asked).toBe(false);
	});

	it("用户拒绝或超时：返回 false 且不写入授权表", async () => {
		let granted = false;
		const ok = await confirmPluginInstall([{ id: "foo", source: "o/r" }], {
			permGrants: {
				has: () => false,
				grant: () => {
					granted = true;
				},
			},
			permissionRequester: async () => ({ ok: false, remember: false }),
		});
		expect(ok).toBe(false);
		expect(granted).toBe(false);
	});

	it("用户允许一次：返回 true 但不持久化", async () => {
		let granted = false;
		const ok = await confirmPluginInstall([{ id: "foo", source: "o/r" }], {
			permGrants: {
				has: () => false,
				grant: () => {
					granted = true;
				},
			},
			permissionRequester: async () => ({ ok: true, remember: false }),
		});
		expect(ok).toBe(true);
		expect(granted).toBe(false);
	});

	it("用户选择「记住并允许」：写入 permGrants 并触发 onGrantsChanged 通知", async () => {
		let grantedData: { pluginId: string; family: string; opts?: unknown } | null = null;
		let notified = false;
		const ok = await confirmPluginInstall([{ id: "foo", source: "o/r" }], {
			permGrants: {
				has: () => false,
				grant: (pluginId, family, opts) => {
					grantedData = { pluginId, family, opts };
				},
			},
			permissionRequester: async () => ({ ok: true, remember: true }),
			onGrantsChanged: () => {
				notified = true;
			},
		});
		expect(ok).toBe(true);
		expect(notified).toBe(true);
		expect(grantedData).toMatchObject({
			pluginId: "plugin-installer",
			family: "net",
			opts: {
				hosts: ["github.com"],
				remember: true,
			},
		});
	});
});
