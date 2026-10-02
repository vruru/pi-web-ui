/**
 * issue #165 E2E（零网络、自包含、独立临时目录）：
 * 走真实 CLI（node bin/pi-web-ui.mjs）全链路，本地目录源（离线）：
 *
 *   1. --build 自动推断收紧（审计修复）：只有源码（manifest.build 声明、无产物）时，
 *      不加 --build 且非交互（子进程 stdin 非 TTY）→ 跳过构建并警告，装出无产物目录，
 *      退出码 0；显式 --build 照常构建、产物齐全；
 *   2. --no-build：同样源码，装出无产物的目录（不构建），退出码 0；
 *   3. --build + --no-build 同用 → 报错退出（互斥）；
 *   4. 产物已提交的仓库：即使构建脚本必失败，不加 --build 也不跑构建（原样安装）；
 *   5. install --catalog <本地文档>：读文档 → 校验（非法条目丢弃计数）→ 原子写盘
 *      （默认按 id 合并）→ 逐条安装（源码条目配 --build 显式构建）；已安装条目默认跳过，
 *      --force 更新，--replace 整体替换。
 *
 * 构建 fixtures 全离线：install 步用 `node --version`（无依赖可装），command 用
 * node build.mjs 本地生成产物。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../bin/pi-web-ui.mjs");

// The CLI picks zh/en from LC_ALL/LC_MESSAGES/LANG; the assertions below match the Chinese output.
const { LC_ALL: _lcAll, LC_MESSAGES: _lcMessages, ...baseEnv } = process.env;
const ZH_ENV = { ...baseEnv, LANG: "zh_CN.UTF-8" };

function cli(args) {
	const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: ZH_ENV });
	return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function must(cond, msg) {
	if (!cond) throw new Error(msg);
	console.log(`✓ ${msg.split("\n")[0]}`);
}

/** 源码插件 fixture：manifest.build + build.mjs 生成 index.mjs 与 client/entry.mjs。 */
function writeSourceOnly(dir, id) {
	mkdirSync(join(dir, "client"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			id,
			name: `Source ${id}`,
			build: { install: "node --version", command: "node build.mjs", outputs: ["index.mjs", "client/entry.mjs"] },
		}),
	);
	writeFileSync(
		join(dir, "build.mjs"),
		`import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("client", { recursive: true });\nwriteFileSync("index.mjs", "// built ${id}\\n");\nwriteFileSync("client/entry.mjs", "export default {};\\n");\n`,
	);
}

function main() {
	const root = mkdtempSync(join(tmpdir(), "plugin-catalog-cli-"));
	const dataDir = join(root, "data");
	try {
		// —— 1. 自动推断收紧：非交互（无 TTY）不加 --build → 跳过构建并警告 ——
		const src1 = join(root, "src1");
		writeSourceOnly(src1, "auto1");
		let r = cli(["install", src1, "--data-dir", dataDir]);
		must(r.status === 0, `1. 源码插件不加 flag 仍安装成功 (exit=${r.status}): ${r.out.slice(0, 200)}`);
		must(/未授权执行/.test(r.out), "1. 输出警告构建命令未授权执行");
		must(!existsSync(join(dataDir, "plugins", "auto1", "index.mjs")), "1. 确实没有构建产物");
		// 显式 --build 行为不变：构建执行、产物齐全
		r = cli(["install", src1, "--build", "--force", "--data-dir", dataDir]);
		must(r.status === 0, `1b. 显式 --build 照常构建安装 (exit=${r.status}): ${r.out.slice(0, 200)}`);
		must(
			readFileSync(join(dataDir, "plugins", "auto1", "index.mjs"), "utf8") === "// built auto1\n",
			"1b. 构建产物落盘",
		);
		must(existsSync(join(dataDir, "plugins", "auto1", "client", "entry.mjs")), "1b. client 产物落盘");

		// —— 2. --no-build：装出无产物目录 ——
		const src2 = join(root, "src2");
		writeSourceOnly(src2, "nobuild");
		r = cli(["install", src2, "--no-build", "--data-dir", dataDir]);
		must(r.status === 0, `2. --no-build 安装成功不构建 (exit=${r.status})`);
		must(/跳过构建/.test(r.out), "2. 输出说明跳过了构建");
		must(!existsSync(join(dataDir, "plugins", "nobuild", "index.mjs")), "2. 确实没有产物");

		// —— 3. 互斥 ——
		r = cli(["install", src2, "--build", "--no-build", "--data-dir", dataDir]);
		must(r.status !== 0 && /不能同时用/.test(r.out), "3. --build + --no-build 互斥报错");

		// —— 4. 产物已提交：必失败的构建脚本也不跑 ——
		const src4 = join(root, "src4");
		mkdirSync(join(src4, "client"), { recursive: true });
		writeFileSync(join(src4, "manifest.json"), JSON.stringify({ id: "plain", build: { command: "node nope.mjs" } }));
		writeFileSync(join(src4, "index.mjs"), "// committed\n");
		writeFileSync(join(src4, "client", "entry.mjs"), "export default {};\n");
		r = cli(["install", src4, "--data-dir", dataDir]);
		must(r.status === 0, "4. 产物齐全时不触发构建（坏构建脚本也没跑）");
		must(!/源码构建/.test(r.out), "4. 输出里没有构建字样");

		// —— 5. --catalog：本地文档，2 合法（1 源码+1 普通）+ 1 非法 ——
		const src5 = join(root, "src5");
		writeSourceOnly(src5, "catbuilt");
		const src6 = join(root, "src6");
		mkdirSync(join(src6, "client"), { recursive: true });
		writeFileSync(join(src6, "manifest.json"), JSON.stringify({ id: "catplain" }));
		writeFileSync(join(src6, "index.mjs"), "// plain\n");
		const doc = {
			entries: [
				{ id: "catbuilt", name: "Cat Built", source: src5 },
				{ id: "catplain", name: "Cat Plain", source: src6 },
				{ id: "bad entry!!", source: "not a source at all!!!" },
			],
		};
		const docPath = join(root, "catalog.json");
		writeFileSync(docPath, JSON.stringify(doc));
		// 目录里的源码条目同样受授权把关：显式 --build 让 catbuilt 构建出产物。
		r = cli(["install", "--catalog", docPath, "--build", "--data-dir", dataDir]);
		must(r.status === 0, `5. --catalog 同步+安装成功 (exit=${r.status}): ${r.out.slice(-300)}`);
		must(/丢弃 1 条非法/.test(r.out), "5. 非法条目被丢弃并计数");
		must(/2 成功/.test(r.out), "5. 两条合法全部安装成功");
		const written = JSON.parse(readFileSync(join(dataDir, "plugin-catalog.json"), "utf8"));
		must(Array.isArray(written.entries) && written.entries.some((e) => e.id === "catbuilt"), "5. 可安装列表原子写盘");
		must(
			readFileSync(join(dataDir, "plugins", "catbuilt", "index.mjs"), "utf8") === "// built catbuilt\n",
			"5. 目录里的源码条目随 --build 显式构建",
		);

		// —— 6. 已安装默认跳过；--force 更新；--replace 整体替换 ——
		r = cli(["install", "--catalog", docPath, "--data-dir", dataDir]);
		must(r.status === 0 && /2 跳过/.test(r.out), "6. 重跑默认跳过已安装条目");
		writeFileSync(join(src6, "index.mjs"), "// plain v2\n");
		r = cli(["install", "--catalog", docPath, "--force", "--data-dir", dataDir]);
		must(
			r.status === 0 && readFileSync(join(dataDir, "plugins", "catplain", "index.mjs"), "utf8") === "// plain v2\n",
			"6. --force 把已安装条目更新到新版",
		);
		const doc2 = { entries: [{ id: "only", name: "Only", source: src6 }] };
		const doc2Path = join(root, "catalog2.json");
		writeFileSync(doc2Path, JSON.stringify(doc2));
		r = cli(["install", "--catalog", doc2Path, "--replace", "--force", "--data-dir", dataDir]);
		const written2 = JSON.parse(readFileSync(join(dataDir, "plugin-catalog.json"), "utf8"));
		must(
			r.status === 0 && written2.entries.length === 1 && written2.entries[0].id === "only",
			"6. --replace 整体替换列表（旧条目不再保留）",
		);

		console.log("all ok");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main();
