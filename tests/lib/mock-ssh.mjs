/**
 * 内嵌 SSH mock 远端 —— 用 ssh2 自带的 Server 在进程内起一个假 SSH 服务。
 *
 * 供编辑器插件（vscode-editor，含 Remote-SSH）的协议/UI 测试使用（零外部依赖、离线可跑）：
 * - 认证：用户名 tester / 密码 secret123，其余拒绝
 * - shell：欢迎横幅 welcome-to-mock + 按行回显（输入 foo\r → echo:foo）
 * - exec：
 *     echo xxx   → 输出 xxx、退出码 0
 *     fail*      → stderr "boom"、退出码 7
 *     pwd        → /home/test
 * - sftp：内存文件系统（见 dirs/files 导出），支持 REALPATH/STAT/OPENDIR/
 *   READDIR/OPEN/READ/WRITE/CLOSE/MKDIR/REMOVE/RMDIR/RENAME
 */
import { join } from "node:path";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const SFTP = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 };

/** ssh2 运行时依赖子集（离线拷贝用；cpu-features/nan 可选，缺省走纯 JS） */
const SSH2_PKGS = ["ssh2", "asn1", "bcrypt-pbkdf", "safer-buffer", "tweetnacl"];

/**
 * 给临时插件目录准备 ssh2 依赖：
 * 1. 离线优先——从本地构建目录（plugins/vscode-editor/node_modules）拷贝；
 * 2. 本地没有（如 CI）→ 回退 npm install（需要网络）。
 */
export function ensurePluginSsh2Dep(plugDst, devPlugDir) {
	for (const pkg of SSH2_PKGS) {
		const src = join(devPlugDir, "node_modules", pkg);
		if (existsSync(src)) {
			cpSync(src, join(plugDst, "node_modules", pkg), { recursive: true });
		}
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		console.log("[mock-ssh] 本地无 ssh2 依赖，回退 npm install…");
		// 临时目录算 project-scoped 安装（--prefix），而 `npm run test:smoke` 会把
		// npm_config_* 注入子进程 env：其中的 allow-scripts 在 project-scoped 安装里是
		// 硬报错 EALLOWSCRIPTS，于是本测试在冒烟聚合（经 npm run 启动）下假失败、单跑
		// 又正常。两手都做：① 项目级 .npmrc 按 npm 官方指引声明 allowScripts；
		// ② 抹掉继承来的 npm_config_* / NPM_CONFIG_*，让这次安装与调用者的 npm 上下文无关。
		writeFileSync(join(plugDst, ".npmrc"), "allow-scripts=ssh2,cpu-features\naudit=false\nfund=false\n");
		const env = { ...process.env };
		for (const k of Object.keys(env)) {
			if (/^npm_?config_/i.test(k)) delete env[k];
		}
		execFileSync("npm", ["install", "--prefix", plugDst, "ssh2@latest", "--no-audit", "--no-fund"], {
			stdio: "inherit",
			timeout: 180_000,
			shell: process.platform === "win32",
			env,
		});
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		throw new Error("ssh2 依赖准备失败（拷贝与 npm install 均未成功）");
	}
}

export const dirs = {
	"/": ["home"],
	"/home": ["test"],
	"/home/test": ["a.txt", "sub", "big.bin"],
	"/home/test/sub": [],
};
export const files = {
	"/home/test/a.txt": Buffer.from("hello ssh\n第二行\n", "utf8"),
	"/home/test/big.bin": Buffer.from([0x00, 0x01, 0x02, 0x00]),
};

/** 构造 ustar 目录条目（512B 头 + 结束块），供模拟 tar -czf - */
function tarDirEntry(name) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000755\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write("00000000000\0", 124); // 目录 size = 0
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148); // checksum 先置空格
	h[156] = 0x35; // '5' 目录
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, Buffer.alloc(1024)]); // 数据区 + 两块结束
}

/** 构造 ustar 文件条目（头 + 内容补齐到 512 + 尾部结束块） */
function tarFileEntry(name, content) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148);
	h[156] = 0x30; // '0' 普通文件
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

/**
 * 启动 mock SSH 服务。
 * @param {string} pluginDir 含 node_modules/ssh2 的插件目录（复用同一份依赖）
 * @param {number} port 监听端口
 * @returns {Promise<{close(): void}>}
 */
export async function startMockSsh(pluginDir, port) {
	const { createRequire } = await import("node:module");
	const { generateKeyPairSync } = await import("node:crypto");
	const req = createRequire(join(pluginDir, "package.json"));
	const { Server } = req("ssh2");
	// RSA PKCS#1 PEM（ed25519 只能导出 PKCS#8，ssh2 的 parseKey 不认）
	const HOST_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
		type: "pkcs1",
		format: "pem",
	});

	let handleSeq = 0;
	const handles = new Map(); // handleStr → 句柄记录

	function bindSftp(sftp) {
		sftp.on("REALPATH", (id, path) => {
			sftp.name(id, [{ filename: path || "/" }]);
		});
		sftp.on("STAT", (id, path) => {
			if (dirs[path]) return sftp.attrs(id, { mode: 0o040755, size: 4096 });
			if (files[path]) return sftp.attrs(id, { mode: 0o100644, size: files[path].length });
			sftp.status(id, 2);
		});
		sftp.on("OPENDIR", (id, path) => {
			if (!dirs[path]) return sftp.status(id, 2);
			const h = Buffer.from(`d${handleSeq++}`);
			handles.set(h.toString(), { kind: "dir", path, readAll: false });
			sftp.handle(id, h);
		});
		sftp.on("READDIR", (id, handleBuf) => {
			const key = handleBuf.toString();
			const h = handles.get(key);
			if (!h) return sftp.status(id, 4);
			if (h.readAll) {
				handles.delete(key);
				return sftp.status(id, 1); // EOF
			}
			h.readAll = true;
			sftp.name(
				id,
				dirs[h.path].map((n) => ({
					filename: n,
					longname: `-rw-r--r-- 1 u u 0 ${n}`,
					attrs: {
						mode: dirs[`${h.path}/${n}`] ? 0o040755 : 0o100644,
						size: files[`${h.path}/${n}`]?.length ?? 0,
					},
				})),
			);
		});
		sftp.on("OPEN", (id, path, flags) => {
			if (flags & SFTP.READ && !(flags & (SFTP.WRITE | SFTP.CREAT | SFTP.TRUNC))) {
				if (!files[path]) return sftp.status(id, 2);
				const h = Buffer.from(`f${handleSeq++}`);
				handles.set(h.toString(), { kind: "file", path });
				return sftp.handle(id, h);
			}
			// 写路径：TRUNC 或新文件从空开始，否则续写已有内容
			const h = Buffer.from(`f${handleSeq++}`);
			handles.set(h.toString(), {
				kind: "file",
				write: true,
				path,
				buf: !files[path] || flags & SFTP.TRUNC ? Buffer.alloc(0) : Buffer.from(files[path]),
			});
			sftp.handle(id, h);
		});
		sftp.on("READ", (id, handleBuf, offset, len) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.path) return sftp.status(id, 4);
			const buf = files[h.path];
			if (!buf) return sftp.status(id, 2);
			const slice = buf.subarray(offset, offset + len);
			if (!slice.length) return sftp.status(id, 1); // EOF
			sftp.data(id, slice);
		});
		sftp.on("WRITE", (id, handleBuf, offset, data) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.write) return sftp.status(id, 4);
			if (offset + data.length > h.buf.length) {
				const nb = Buffer.alloc(offset + data.length);
				h.buf.copy(nb, 0);
				h.buf = nb;
			}
			data.copy(h.buf, offset);
			sftp.status(id, 0);
		});
		sftp.on("CLOSE", (id, handleBuf) => {
			const h = handles.get(handleBuf.toString());
			if (h?.write) files[h.path] = Buffer.from(h.buf);
			handles.delete(handleBuf.toString());
			sftp.status(id, 0);
		});
		sftp.on("MKDIR", (id, path) => {
			if (dirs[path]) return sftp.status(id, 4);
			dirs[path] = [];
			const idx = path.lastIndexOf("/");
			dirs[idx <= 0 ? "/" : path.slice(0, idx)].push(path.slice(idx + 1));
			sftp.status(id, 0);
		});
		sftp.on("REMOVE", (id, path) => {
			if (!files[path]) return sftp.status(id, 2);
			delete files[path];
			const idx = path.lastIndexOf("/");
			const parent = dirs[idx <= 0 ? "/" : path.slice(0, idx)];
			if (parent) parent.splice(parent.indexOf(path.slice(idx + 1)), 1);
			sftp.status(id, 0);
		});
		sftp.on("RMDIR", (id, path) => {
			if (!dirs[path]?.length) {
				delete dirs[path];
				const idx = path.lastIndexOf("/");
				const parent = dirs[idx <= 0 ? "/" : path.slice(0, idx)];
				if (parent) parent.splice(parent.indexOf(path.slice(idx + 1)), 1);
				return sftp.status(id, 0);
			}
			sftp.status(id, 4); // 目录非空或不存在
		});
		sftp.on("RENAME", (id, src, dst) => {
			if (files[src]) {
				files[dst] = files[src];
				delete files[src];
			} else if (dirs[src]) {
				dirs[dst] = dirs[src];
				delete dirs[src];
			} else return sftp.status(id, 2);
			const i = src.lastIndexOf("/");
			const p1 = dirs[i <= 0 ? "/" : src.slice(0, i)];
			if (p1) p1.splice(p1.indexOf(src.slice(i + 1)), 1);
			const j = dst.lastIndexOf("/");
			const p2 = dirs[j <= 0 ? "/" : dst.slice(0, j)];
			if (p2) p2.push(dst.slice(j + 1));
			sftp.status(id, 0);
		});
	}

	return new Promise((resolve, reject) => {
		let srv;
		try {
			srv = new Server({ hostKeys: [HOST_KEY] }, (client) => {
				client.on("error", () => {}); // 客户端断开等 socket 错误不炸测试进程
				client.on("authentication", (ctx) => {
					if (ctx.username === "tester" && ctx.password === "secret123") return ctx.accept();
					ctx.reject();
				});
				client.on("ready", () => {
					client.on("session", (accept) => {
						const session = accept();
						session.once("pty", (accept2) => accept2?.());
						session.once("shell", (accept2) => {
							const stream = accept2();
							stream.write("welcome-to-mock\r\n");
							let buf = "";
							stream.on("data", (d) => {
								buf += d.toString();
								while (buf.includes("\r")) {
									const line = buf.slice(0, buf.indexOf("\r")).trim();
									buf = buf.slice(buf.indexOf("\r") + 1);
									if (line) stream.write(`echo:${line}\r\n`);
								}
							});
						});
						session.once("exec", (accept2, reject2, info) => {
							const stream = accept2();
							const cmd = info.command ?? "";
							// 模拟远端 tar -czf -（编辑器插件「下载文件夹到电脑」用）：内存文件系统 → ustar → gzip
							const tarM = cmd.match(/^cd '(.*)' && tar -czf - '(.*)'$/);
							if (tarM) {
								const base = (tarM[1] === "/" ? "" : tarM[1]) + "/" + tarM[2];
								const parts = [tarDirEntry(tarM[2])];
								for (const d of Object.keys(dirs)) {
									if (d.startsWith(base + "/")) parts.push(tarFileEntry(d.slice(base.length + 1), Buffer.alloc(0)));
								}
								for (const [p, content] of Object.entries(files)) {
									if (p.startsWith(base + "/")) parts.push(tarFileEntry(p.slice(base.length + 1), content));
								}
								stream.write(gzipSync(Buffer.concat(parts)));
								stream.exit(0);
								stream.end();
								return;
							}
							if (cmd.startsWith("echo ")) {
								stream.write(cmd.slice(5).replace(/^["']|["']$/g, "") + "\n");
								stream.exit(0);
							} else if (cmd.startsWith("fail")) {
								stream.stderr.write("boom\n");
								stream.exit(7);
							} else if (cmd === "pwd") {
								stream.write("/home/test\n");
								stream.exit(0);
							} else {
								stream.exit(127);
							}
							stream.end();
						});
						session.once("sftp", (accept2) => bindSftp(accept2()));
					});
				});
			});
			srv.on("error", reject);
			srv.listen(port, "127.0.0.1", () =>
				resolve({
					close() {
						try {
							srv.close();
						} catch {}
					},
				}),
			);
		} catch (err) {
			reject(err);
		}
	});
}
