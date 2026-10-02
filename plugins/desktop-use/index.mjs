/**
 * desktop-use/index.mjs — Windows 桌面控制插件（纯服务端插件，无 client/ 视图）。
 *
 * 思路（用户定稿）：不截图。元素定位走 Windows 自带的 UI Automation
 * （ps/uia.ps1 枚举控件名/类型/矩形，模型按 id 选），输入走 nut-js
 * （@nut-tree-fork/nut-js，模型点矩形中心），PowerShell SendInput 兜底。
 *
 * 依赖装卸（用户定稿）：
 * - 安装插件只拷文件（含 package.json，不含 node_modules，见 CLI 的
 *   PLUGIN_COPY_FILTER）；真正的 `npm install` 由本文件的 ensureDeps 在
 *   activate 后台自动跑（db-client 同款：目录锁 + npm-cli 直调 + 看门狗 +
 *   host.notify 进度，见下方）。装好前工具报“安装中稍后”，不静默失败。
 * - 卸载 = 整目录 rm（CLI uninstall），node_modules 在插件目录里，一起消失。
 *
 * 安全：读（desktop_elements/window-list）与写（click/type/key/focus）分工具，
 * 写工具各自可在设置 → 插件工具里单独关闭；promptGuidelines 要求模型先查后点、
 * 高危动作（关闭/删除/提交/付款）先向用户确认。id 必须来自 90 秒内的 dump，
 * 防止窗口挪走后点错地方。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PS_DIR = join(PLUGIN_DIR, "ps");
const UIA_PS1 = join(PS_DIR, "uia.ps1");
const INPUT_PS1 = join(PS_DIR, "input.ps1");
const SHOT_PS1 = join(PS_DIR, "screenshot.ps1");

/** 运行时输入依赖（主用后端；PowerShell 兜底零依赖）。 */
const DEPS = ["@nut-tree-fork/nut-js@^4.2.6"];
const INSTALL_LOCK = ".pi-deps-lock";
const LOCK_STALE_MS = 15 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const UIA_TIMEOUT_MS = 45_000;
const INPUT_TIMEOUT_MS = 20_000;
/** dump 保鲜期：窗口会挪走/重绘，过期 id 不给点。 */
const DUMP_TTL_MS = 90_000;
/** 正文里的元素行数上限（dump 本身可存更多，防 token 爆炸）。 */
const LIST_TEXT_CAP = 150;

const WIN_ONLY_ZH = "desktop-use 只支持 Windows（当前系统不是 win32）。";
const WIN_ONLY_EN = "desktop-use is Windows-only (this host is not win32).";

// ---------------------------------------------------------------------------
// 解码：powershell.exe 按系统代码页输出（中文系统多为 GBK），ConvertTo-Json
// 又不一定转义 CJK——严格 UTF-8 失败就按 GBK 解，再不行 latin1（与 text-sniff
// 的 decodeText 同策略）。
// ---------------------------------------------------------------------------
function decode(buf) {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("gbk").decode(bytes);
		} catch {
			return bytes.toString("latin1");
		}
	}
}

function runPs(script, args = [], { timeout = UIA_TIMEOUT_MS, signal } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
			{ encoding: "buffer", timeout, windowsHide: true, signal },
			(err, stdout, stderr) => {
				if (err) {
					const tail = decode(stderr).trim().slice(-500);
					reject(
						new Error(`powershell ${script.split(/[\\/]/).pop()} 失败：${err.message}${tail ? `（${tail}）` : ""}`),
					);
					return;
				}
				const text = decode(stdout);
				const start = text.indexOf("{");
				if (start < 0) {
					reject(new Error(`powershell 无 JSON 输出：${text.slice(0, 300)}`));
					return;
				}
				try {
					resolve(JSON.parse(text.slice(start)));
				} catch (e) {
					reject(new Error(`powershell 输出不是合法 JSON：${e.message}`));
				}
			},
		);
	});
}

function psArgs(obj) {
	const out = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === "") continue;
		out.push(`-${k}`, String(v));
	}
	return out;
}

// ---------------------------------------------------------------------------
// nut-js 键名按运行时实际枚举匹配（fork 各版 Key 命名可能漂移，不硬编码猜）。
// ---------------------------------------------------------------------------
function buildNutKeyMap(Key) {
	const names = Object.keys(Key ?? {});
	const find = (...cands) => {
		for (const c of cands) {
			const hit = names.find((n) => n.toLowerCase() === c);
			if (hit) return Key[hit];
		}
		return undefined;
	};
	return {
		enter: find("enter", "return"),
		tab: find("tab"),
		esc: find("escape", "esc"),
		space: find("space"),
		backspace: find("backspace"),
		delete: find("delete"),
		up: find("up", "arrowup"),
		down: find("down", "arrowdown"),
		left: find("left", "arrowleft"),
		right: find("right", "arrowright"),
		home: find("home"),
		end: find("end"),
		pgup: find("pageup", "pgup"),
		pgdn: find("pagedown", "pgdn"),
		ctrl: find("leftcontrol", "control", "ctrl", "leftctrl"),
		alt: find("leftalt", "alt"),
		shift: find("leftshift", "shift"),
		win: find("leftwin", "leftsuper", "leftmeta", "win", "super", "meta", "command"),
		f: (n) => find(`f${n}`),
		letter: (ch) => find(ch.toLowerCase(), ch.toUpperCase()),
		digit: (ch) => find(ch),
	};
}

export default {
	activate(host) {
		const st = {
			dead: false,
			nut: null, // { mouse, keyboard, Button, keyMap } | null
			depsOk: false,
			depsInstalling: false,
			depsFailed: "",
			probeError: "",
			lastProbeAt: 0,
			installer: null,
			dumps: new Map(), // dumpKey -> { at, byId: Map(id -> {x,y,w,h,name,hwnd?}) }
			shotSeq: 0,
			shots: new Map(), // shotKey -> { at, winX, winY, winW, winH, imgW, imgH }
			dumpSeq: 0,
			offs: [],
		};
		const isWin = process.platform === "win32";

		const requireWin = () => {
			if (!isWin) throw new Error(`${WIN_ONLY_ZH} / ${WIN_ONLY_EN}`);
		};

		// ---- 依赖自安装（db-client 同款：目录锁 + npm-cli 直调 + 看门狗） ----
		const req = createRequire(join(PLUGIN_DIR, "index.mjs"));

		async function probeNut() {
			st.lastProbeAt = Date.now();
			try {
				const mod = await import("@nut-tree-fork/nut-js");
				if (!mod?.mouse || !mod?.keyboard) {
					st.probeError = "模块缺 mouse/keyboard 导出";
					st.nut = null;
					return false;
				}
				st.nut = {
					mouse: mod.mouse,
					keyboard: mod.keyboard,
					Button: mod.Button,
					Point: mod.Point,
					keyMap: buildNutKeyMap(mod.Key),
				};
				return true;
			} catch (e) {
				st.probeError = String(e?.message ?? e).slice(0, 300);
				st.nut = null;
				return false;
			}
		}

		function installLocked() {
			try {
				const meta = JSON.parse(readFileSync(join(host.dir, INSTALL_LOCK), "utf8")) ?? {};
				const at = Number(meta.at ?? 0);
				if (!Number.isFinite(at) || Date.now() - at >= LOCK_STALE_MS) return false;
				// 锁新鲜时再看持有者还活着没：进程已死（崩溃/被杀）=  stale 锁，直接回收，
				// 否则一次被杀的安装会挡住后面 15 分钟的重试。
				const pid = Number(meta.pid ?? 0);
				if (Number.isFinite(pid) && pid > 0) {
					try {
						process.kill(pid, 0);
						return true; // 还活着：真有人在装
					} catch {
						try {
							rmSync(join(host.dir, INSTALL_LOCK), { force: true });
						} catch {
							/* ignore */
						}
						host.log("info", "desktop-use: 回收 stale 安装锁（持有进程已死）");
						return false;
					}
				}
				return true;
			} catch {
				return false;
			}
		}

		function resolveNpmCli() {
			try {
				return req.resolve("npm/bin/npm-cli.js");
			} catch {
				/* 插件不依赖 npm 包，常走下面 */
			}
			try {
				const cands = [
					join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
					join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
				];
				for (const c of cands) if (existsSync(c)) return c;
			} catch {
				/* ignore */
			}
			return null;
		}

		function ensureDeps(auto = true) {
			if (!isWin || st.depsOk || st.depsInstalling || st.installer) return;
			if (installLocked()) {
				host.log("info", "desktop-use: 另有安装任务持有锁，跳过本次自安装");
				return;
			}
			st.depsInstalling = true;
			host.log("info", `desktop-use: 安装输入依赖 ${DEPS.join(" ")}${auto ? "（自动）" : ""}`);
			host.notify("info", "🖱️ 桌面控制：正在安装输入依赖（首次约需 1～3 分钟）…");
			try {
				writeFileSync(join(host.dir, INSTALL_LOCK), JSON.stringify({ at: Date.now(), pid: process.pid }));
			} catch {
				/* 锁写失败也不挡安装 */
			}
			const finish = async (ok, why) => {
				// 锁清理永远执行（deactivate 杀安装后进程可能直接退出，不清理就剩 stale 锁）
				try {
					rmSync(join(host.dir, INSTALL_LOCK), { force: true });
				} catch {
					/* ignore */
				}
				if (st.dead) return;
				if (ok) {
					// npm 刚退出时文件可能还被占用/被杀软扫着，立即探活可能误杀：等两轮再判
					st.depsOk = await probeNut();
					for (const wait of [3000, 8000]) {
						if (st.depsOk || st.dead) break;
						await new Promise((r) => setTimeout(r, wait));
						if (!st.dead) st.depsOk = await probeNut();
					}
					if (!st.depsOk) {
						ok = false;
						why = `npm 安装成功，但加载验证失败（${st.probeError || "未知原因"}）`;
					}
				}
				st.depsInstalling = false;
				st.installer = null;
				host.notify(
					ok ? "success" : "error",
					ok
						? "🖱️ 桌面控制输入依赖安装完成（nut-js 主用 + PowerShell 兜底）"
						: `🖱️ 桌面控制输入依赖安装失败（${why}）——已自动降级为 PowerShell 兜底输入；也可手动在插件目录执行：npm install ${DEPS.join(" ")}`,
				);
				if (!ok) st.depsFailed = String(why || "unknown");
			};
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", ...DEPS, "--omit=dev", "--no-audit", "--no-fund"];
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
				: spawn("npm", args, { stdio: ["ignore", "ignore", "pipe"], shell: true });
			st.installer = child;
			const timer = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, 5000).unref?.();
				finish(false, "安装超时");
			}, INSTALL_TIMEOUT_MS);
			timer.unref?.();
			let errTail = "";
			child.stderr?.on("data", (d) => {
				errTail = (errTail + d.toString()).slice(-800);
			});
			let done = false;
			const once = (ok, why) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				const lastErr = errTail.split(/\r?\n/).filter(Boolean).pop() ?? "";
				finish(ok, why + (lastErr ? `：${lastErr}` : ""));
			};
			child.on("error", (err) => once(false, err.message));
			child.on("exit", (code, signal) => once(code === 0, signal ? `npm 被终止（${signal}）` : `npm exit ${code}`));
		}

		// ---- 输入后端：nut-js 主用，PowerShell 兜底 ----
		const needWinPs = () => {
			requireWin();
			if (!existsSync(UIA_PS1) || !existsSync(INPUT_PS1)) {
				throw new Error("桌面控制的 PowerShell 脚本缺失（ps/*.ps1），请重装插件。");
			}
		};

		/** 有 nut 且就绪 → true；安装中 → 抛“稍后”；失败/缺失 → false（走兜底）。 */
		function nutReadyOrThrow() {
			if (st.nut) return true;
			if (st.depsInstalling) {
				throw new Error("输入依赖正在安装（约 1～3 分钟），稍后重试；只读的元素查询（desktop_elements）不受影响。");
			}
			// 自愈：上次探活失败超过 60 秒就后台重探一次（npm 刚装完时的瞬时锁/杀软扫描会导致误判，
			// 重启后模块其实已经可用，不必重装也不必重启服务）
			if (!st.depsOk && Date.now() - st.lastProbeAt > 60_000) {
				probeNut().then((ok2) => {
					if (ok2 && !st.dead) {
						st.depsOk = true;
						st.depsFailed = "";
						host.log("info", "desktop-use: 后台重探成功，nut-js 已就绪");
						host.notify("success", "🖱️ 桌面控制输入依赖已就绪（后台重探成功）");
					}
				});
			}
			return false;
		}

		async function psInput(op, fields = {}, signal) {
			needWinPs();
			const r = await runPs(INPUT_PS1, psArgs({ Op: op, ...fields }), {
				timeout: INPUT_TIMEOUT_MS,
				signal,
			});
			if (!r?.ok) throw new Error(`输入兜底失败：${r?.error ?? "unknown"}`);
			return r;
		}

		async function doClick(x, y, { button = "left", double = false } = {}, signal) {
			if (nutReadyOrThrow() && st.nut) {
				const { mouse, Button, Point } = st.nut;
				try {
					if (Point) await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
					else if (mouse.move) await mouse.move({ x, y });
					const b =
						String(button) === "right" ? Button?.RIGHT : String(button) === "middle" ? Button?.MIDDLE : Button?.LEFT;
					if (double && typeof mouse.doubleClick === "function") {
						await mouse.doubleClick(b);
					} else if (typeof mouse.click === "function") {
						await mouse.click(b);
						if (double) await mouse.click(b);
					} else if (String(button) === "right" && typeof mouse.rightClick === "function") {
						await mouse.rightClick();
						if (double) await mouse.rightClick();
					} else if (typeof mouse.leftClick === "function") {
						await mouse.leftClick();
						if (double) await mouse.leftClick();
					} else {
						throw new Error("nut mouse 无可用点击方法");
					}
					return { backend: "nut", x: Math.round(x), y: Math.round(y), button, double };
				} catch (e) {
					host.log("warn", `desktop-use: nut 点击失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			await psInput("click", { X: Math.round(x), Y: Math.round(y), Button: button, Double: double ? 1 : 0 }, signal);
			return { backend: "powershell", x: Math.round(x), y: Math.round(y), button, double };
		}

		function parseKeys(input) {
			const raw = Array.isArray(input) ? input.join("+") : String(input ?? "");
			const parts = raw
				.split("+")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			if (parts.length === 0) throw new Error('keys 为空（如 "enter" / "ctrl+c" / "alt+F4" / "win+r"）。');
			return parts;
		}

		async function doKey(parts, signal) {
			if (nutReadyOrThrow() && st.nut) {
				const { keyboard, keyMap } = st.nut;
				try {
					const mods = [];
					let main = null;
					for (const p of parts) {
						if (["ctrl", "alt", "shift", "win"].includes(p)) {
							const k = keyMap[p];
							if (k === undefined) throw new Error(`nut 无 ${p} 键`);
							mods.push(k);
						} else main = p;
					}
					const toKey = (p) => {
						if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) return keyMap.f(Number(p.slice(1)));
						if (p.length === 1) return /^[a-z]$/.test(p) ? keyMap.letter(p) : keyMap.digit(p);
						return keyMap[p];
					};
					if (main === null) {
						for (const m of mods) await keyboard.pressKey(m);
					} else {
						const k = toKey(main);
						if (k === undefined) throw new Error(`nut 无 ${main} 键`);
						await keyboard.pressKey(...mods, k);
					}
					return { backend: "nut", keys: parts.join("+") };
				} catch (e) {
					host.log("warn", `desktop-use: nut 按键失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			await psInput("key", { Keys: parts.join("+") }, signal);
			return { backend: "powershell", keys: parts.join("+") };
		}

		const isAscii = (s) => /^[\x20-\x7E\r\n\t]*$/.test(s ?? "");

		async function doType(text, signal) {
			if (typeof text !== "string" || text.length === 0) throw new Error("text 为空。");
			if (text.length > 2000) throw new Error("单次输入限 2000 字符（分多次调）。");
			// 中文/emoji 走剪贴板粘贴（SendInput 发不出 CJK；调用前须已聚焦目标）
			if (!isAscii(text)) {
				await psInput("paste", { Text: text }, signal);
				return { backend: "powershell-paste", chars: text.length };
			}
			if (nutReadyOrThrow() && st.nut) {
				try {
					await st.nut.keyboard.type(text);
					return { backend: "nut", chars: text.length };
				} catch (e) {
					host.log("warn", `desktop-use: nut 输入失败，切 PowerShell 兜底：${e?.message ?? e}`);
				}
			}
			await psInput("paste", { Text: text }, signal);
			return { backend: "powershell-paste", chars: text.length };
		}

		// ---- dump 缓存：id 只在 90 秒内有效 ----
		function rememberShot(info) {
			const key = `s${++st.shotSeq}`;
			st.shots.set(key, { at: Date.now(), ...info });
			if (st.shots.size > 8) st.shots.delete(st.shots.keys().next().value);
			return key;
		}
		function rememberDump(nodes) {
			const key = `d${++st.dumpSeq}`;
			const byId = new Map();
			for (const n of nodes) {
				if (n?.id && n?.rect) {
					const rec = {
						x: n.rect.x + n.rect.w / 2,
						y: n.rect.y + n.rect.h / 2,
						name: n.name ?? "",
					};
					if (n.hwnd) rec.hwnd = n.hwnd;
					byId.set(n.id, rec);
				}
			}
			st.dumps.set(key, { at: Date.now(), byId });
			if (st.dumps.size > 8) {
				const first = st.dumps.keys().next().value;
				st.dumps.delete(first);
			}
			return key;
		}

		function resolvePoint({ dump, id, x, y, shot, text }) {
			// 截图坐标优先：shot 快照 + 图内像素/文字匹配 → 屏幕坐标（自绘界面唯一可靠的点法）
			if (shot !== undefined && shot !== null && String(shot) !== "") {
				const s = st.shots.get(String(shot));
				if (!s) throw new Error("没有这张截图：先调 desktop_screenshot，再用它返回的 shot + 图内坐标或文字点。");
				if (Date.now() - s.at > DUMP_TTL_MS) throw new Error("截图已过期（>90s，窗口可能挪走）：重截一张再点。");

				let imgX = x;
				let imgY = y;
				let viaText = "";

				// 如果指定了 text，优先从 OCR 结果匹配文字坐标
				if (text !== undefined && text !== null && String(text).trim() !== "") {
					const q = String(text).trim();
					const ocrList = s.ocr ?? [];
					if (ocrList.length === 0) {
						throw new Error(`截图 ${shot} 中未识别到文字或 OCR 未启用，请改传图内像素坐标 x+y。`);
					}
					const qNoSpace = q.replace(/\s+/g, "").toLowerCase();
					// 匹配优先级：精确匹配 > 去除空格精确匹配 > 包含匹配 > 忽略大小写包含
					let hit = ocrList.find((it) => it.text === q);
					if (!hit) hit = ocrList.find((it) => it.text.replace(/\s+/g, "").toLowerCase() === qNoSpace);
					if (!hit) hit = ocrList.find((it) => it.text.toLowerCase().includes(q.toLowerCase()));
					if (!hit) hit = ocrList.find((it) => q.toLowerCase().includes(it.text.toLowerCase()));
					if (!hit) {
						const cands = ocrList
							.slice(0, 10)
							.map((it) => `「${it.text}」`)
							.join("、");
						throw new Error(
							`截图 ${shot} 的 OCR 结果中未找到文字「${q}」（图内文字如：${cands}${ocrList.length > 10 ? " 等" : ""}），请传 x+y 像素坐标或换关键词。`,
						);
					}
					imgX = hit.cx;
					imgY = hit.cy;
					viaText = `OCR文字「${hit.text}」中心(${hit.cx},${hit.cy}) `;
				}

				if (typeof imgX !== "number" || typeof imgY !== "number") {
					throw new Error("shot 模式要给图内像素坐标 x+y，或传 text 按文字定位（左上角为原点）。");
				}
				const sx = Math.round(s.winX + (imgX * s.winW) / s.imgW);
				const sy = Math.round(s.winY + (imgY * s.winH) / s.imgH);
				return { x: sx, y: sy, via: `截图 ${shot} ${viaText}图内(${imgX},${imgY})→屏幕(${sx},${sy})` };
			}
			if (id !== undefined && id !== null && String(id) !== "") {
				const d = dump ? st.dumps.get(String(dump)) : [...st.dumps.values()].pop();
				if (!d) throw new Error("没有可用的元素快照：先调 desktop_elements 查一遍，再用它返回的 dump+id 点。");
				if (Date.now() - d.at > DUMP_TTL_MS) {
					throw new Error("元素快照已过期（>90s，窗口可能挪走/重绘）：重调 desktop_elements 再点。");
				}
				const hit = d.byId.get(String(id));
				if (!hit) throw new Error(`快照里没有 id=${id}：用 desktop_elements 返回的 id，不要猜。`);
				return { x: hit.x, y: hit.y, via: `id ${id}（${hit.name || "未命名"}）` };
			}
			if (typeof x === "number" && typeof y === "number") {
				return { x, y, via: "raw 屏幕坐标（非快照元素，点错风险自负）" };
			}
			throw new Error("给 shot+x+y（截图点，自绘界面用）或 dump+id（UIA 元素）或 x+y 屏幕坐标。");
		}

		const fmtNodes = (nodes) =>
			nodes
				.slice(0, LIST_TEXT_CAP)
				.map((n) => {
					const r = n.rect;
					const label = n.name ? `「${n.name}」` : "(未命名)";
					const owner = n.proc ? ` <${n.proc}${n.cls ? `:${n.cls}` : ""}>` : "";
					return `- id=${n.id} [${n.type}] ${label}${owner} @(${r.x},${r.y},${r.w}x${r.h})`;
				})
				.join("\n");

		const GUIDELINES = [
			"Query with desktop_elements first, then click/type using the returned dump+id: never guess coordinates, never reuse ids older than 90 seconds",
			"Self-drawn UIs (WeChat/QQ/games: elements returns empty shells) use the screenshot flow: desktop_screenshot auto-OCRs text with exact coords — pass text='...' or (cx, cy) to desktop_click, no coordinate guessing",
			"Typing into self-drawn UIs: WeChat/QQ input boxes are focused when the window is active — prefer desktop_window(focus) + desktop_type(text) (clipboard paste); to click-focus the input, pass shot+click_text or shot+x+y+text in one call",
			"Across turns / after user confirmation the foreground always switches to the browser: before any key/type, first desktop_window(action='focus') to bring the target app forward (e.g. before Enter to send)",
			"For irreversible actions (close/delete/submit/pay/send message), confirm the target with the user in one sentence before acting",
			"Click one element at a time; verify with desktop_elements or desktop_screenshot after each click, no rapid-fire; see docs/app-playbook.md for common app patterns",
		];

		// ---- 工具注册 ----
		const tools = [
			{
				name: "desktop_elements",
				label: "查桌面元素",
				description:
					"List Windows controls without screenshots (UI Automation): returns element id/type/name/rect. Call this before any click/type and locate targets with the returned dump+id.",
				promptSnippet: "desktop_elements — list desktop controls without screenshots (query before click)",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						scope: {
							type: "string",
							enum: ["foreground", "desktop", "window"],
							description:
								"foreground = current foreground window (default); desktop = whole desktop (top-level windows only); window = find by title/process.",
						},
						title: {
							type: "string",
							description:
								"Window title substring when scope=window (unreliable for apps with volatile titles; prefer process).",
						},
						process: {
							type: "string",
							description:
								"Process name substring when scope=window (e.g. Weixin / WeChat / chrome). Use this for apps whose title changes every launch (e.g. WeChat).",
						},
						query: { type: "string", description: "Filter by name/type/AutomationId (e.g. the address bar)." },
						max_nodes: { type: "number", description: "Max nodes returned (default 200, cap 800)." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					const scope = ["foreground", "desktop", "window"].includes(p.scope) ? p.scope : "foreground";
					const maxNodes = Math.min(800, Math.max(10, Math.floor(Number(p.max_nodes) || 200)));
					const r = await runPs(
						UIA_PS1,
						psArgs({
							Scope: scope,
							Title: p.title ?? "",
							Process: p.process ?? "",
							Query: p.query ?? "",
							MaxNodes: maxNodes,
							// Chromium 系控件嵌套深（地址栏常在 8 层左右），默认 8 层；desktop 只取顶层窗口
							MaxDepth: scope === "desktop" ? 1 : 8,
						}),
						{ signal },
					);
					if (!r?.ok) throw new Error(`元素枚举失败：${r?.error ?? "unknown"}`);
					const dump = rememberDump(r.nodes ?? []);
					const head =
						`快照 ${dump}（${r.count} 个元素${r.truncated ? "，已截断" : ""}，90 秒内有效，root=${r.root ?? "?"}）：\n` +
						fmtNodes(r.nodes ?? []);
					return {
						content: [{ type: "text", text: head }],
						details: { dump, count: r.count, truncated: !!r.truncated },
					};
				},
			},
			{
				name: "desktop_click",
				label: "点桌面元素",
				description:
					"Click: (1) screenshot flow for self-drawn UIs — pass shot + in-image pixel x/y, or shot + text to click by recognized OCR text (auto-centered); (2) dump+id (UIA element center); (3) raw screen x/y (discouraged).",
				promptSnippet: "desktop_click — click by screenshot coords/text or element id",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						shot: {
							type: "string",
							description: "Screenshot key returned by desktop_screenshot (screenshot flow; use with x+y or text).",
						},
						text: {
							type: "string",
							description:
								"Optional: click by text on the screenshot (requires shot; auto-matches the OCR text center — no coordinate guessing).",
						},
						dump: { type: "string", description: "Snapshot key returned by desktop_elements." },
						id: { type: "string", description: "Element id (e.g. 0.2.1)." },
						x: {
							type: "number",
							description: "shot mode = in-image pixel X (omit when text given); raw screen X when no shot/id.",
						},
						y: {
							type: "number",
							description: "shot mode = in-image pixel Y (omit when text given); raw screen Y when no shot/id.",
						},
						button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left." },
						double: { type: "boolean", description: "Double-click, default false." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					const pt = resolvePoint(p);
					const r = await doClick(pt.x, pt.y, { button: p.button ?? "left", double: p.double === true }, signal);
					return `已点击 ${pt.via} @(${r.x},${r.y}) [${r.backend}]。`;
				},
			},
			{
				name: "desktop_screenshot",
				label: "窗口截图",
				description:
					"Screenshot a window (PrintWindow, works even when occluded): returns image + window top-left screen coords + scale + OCR text with in-image pixel coords; the live mouse cursor is drawn into the image with its coords. Find the target in the image, then pass in-image {x,y} to desktop_click (with shot), or shot+text to click by text — the way to drive self-drawn UIs (WeChat/QQ/games).",
				promptSnippet: "desktop_screenshot — window screenshot + OCR text + mouse position",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						dump: {
							type: "string",
							description: "Optional: desktop_elements snapshot key (with id to target that exact window).",
						},
						id: { type: "string", description: "Optional: window id from the snapshot (the type=Window entry)." },
						title: {
							type: "string",
							description: "Window title substring (unreliable for volatile titles; prefer process or dump+id).",
						},
						process: { type: "string", description: "Process name substring (e.g. Weixin / msedge)." },
						max_width: {
							type: "number",
							description: "Max delivered image width in px (default 1280; smaller saves tokens, coords still scale).",
						},
						ocr: {
							type: "boolean",
							description:
								"Auto OCR of in-image text and coords (default true); returns precise pixel coords and center for each text.",
						},
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					let hwnd = 0;
					if (p.id !== undefined && String(p.id) !== "") {
						const d = p.dump ? st.dumps.get(String(p.dump)) : [...st.dumps.values()].pop();
						const hit = d?.byId.get(String(p.id));
						if (hit?.hwnd) hwnd = hit.hwnd;
						else
							throw new Error(
								"该 id 没有窗口句柄（只有 type=Window 的节点能截图）：用窗口那条的 id，或改传 process/title。",
							);
					}
					const maxWidth = Math.min(1920, Math.max(320, Math.floor(Number(p.max_width) || 1280)));
					const ocrEnabled = p.ocr !== false ? 1 : 0;
					const outFile = join(tmpdir(), `desktop-use-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
					const args = hwnd
						? { Hwnd: hwnd, MaxWidth: maxWidth, Out: outFile, Ocr: ocrEnabled }
						: { Title: p.title ?? "", Process: p.process ?? "", MaxWidth: maxWidth, Out: outFile, Ocr: ocrEnabled };
					let r;
					try {
						r = await runPs(SHOT_PS1, psArgs(args), { timeout: 60000, signal });
					} finally {
						if (!r?.out) {
							try {
								rmSync(outFile, { force: true });
							} catch {}
						}
					}
					if (!r?.ok) throw new Error(`截图失败：${r?.error ?? "unknown"}`);
					if (r.blank)
						throw new Error(
							`截出来是空白（窗口最小化/被保护？）：先 desktop_window focus 到前台再截。窗口左上角=(${r.x},${r.y})，${r.hint ?? ""}`,
						);
					let png;
					try {
						png = readFileSync(r.out);
					} finally {
						try {
							rmSync(r.out, { force: true });
						} catch {}
					}
					if (!png || png.length < 1000) throw new Error("截图文件异常（太小），重试一次。");
					const ocrList = Array.isArray(r.ocr) ? r.ocr : [];
					const key = rememberShot({
						winX: r.x,
						winY: r.y,
						winW: r.w,
						winH: r.h,
						imgW: r.imgW,
						imgH: r.imgH,
						ocr: ocrList,
					});
					let cursorLine = "鼠标光标在窗口外（cursor outside window），图里看不到指针。";
					if (r.cursorInWin) {
						const drawNote = r.cursorDrawn
							? "已画进图里"
							: r.cursorMarker
								? "指针正隐藏（打字中），已用红圈标记位置"
								: "在窗口内但绘制失败，以坐标为准";
						cursorLine = `鼠标光标（${drawNote}）：图内坐标=(${r.cursorImgX},${r.cursorImgY})，屏幕坐标=(${r.cursorX},${r.cursorY})——可据此确认上次点击落点；文本插入符（输入框竖线）是闪烁的，截图时可能正好熄灭，以鼠标位置+输入框聚焦态为准。`;
					}
					let ocrSection = "";
					if (ocrList.length > 0) {
						const showCount = 80;
						const lines = ocrList
							.slice(0, showCount)
							.map(
								(item) =>
									`- 「${item.text}」 @(${item.x},${item.y},${item.w}x${item.h}) → 中心 (${item.cx},${item.cy})`,
							);
						const more =
							ocrList.length > showCount
								? `\n...（还有 ${ocrList.length - showCount} 处文字省略，完整见 details.ocr）`
								: "";
						ocrSection = `\n图内文字定位（OCR，共 ${ocrList.length} 处）：\n${lines.join("\n")}${more}\n`;
					}
					const caption =
						`窗口截图 ${key}（${r.method}）：窗口左上角屏幕坐标=(${r.x},${r.y})，窗口${r.w}x${r.h}，下发图${r.imgW}x${r.imgH}。\n` +
						`Screenshot ${key} (${r.method}): window top-left=(${r.x},${r.y}), window ${r.w}x${r.h}, image ${r.imgW}x${r.imgH}.\n` +
						`${cursorLine}\n` +
						`${ocrSection}` +
						`在图里找目标，把图内像素坐标 {x,y} 传给 desktop_click（shot=${key}），换算：屏幕=( ${r.x}+x*${r.w}/${r.imgW}, ${r.y}+y*${r.h}/${r.imgH} )。\n` +
						`也可直接按文字点击：desktop_click 传 shot=${key} + text="文字内容"（自动对齐 OCR 中心点，无需猜坐标）。截图 90 秒内有效。`;
					return {
						content: [
							{ type: "text", text: caption },
							{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
						],
						details: {
							shot: key,
							x: r.x,
							y: r.y,
							w: r.w,
							h: r.h,
							imgW: r.imgW,
							imgH: r.imgH,
							method: r.method,
							cursorDrawn: !!r.cursorDrawn,
							cursorMarker: !!r.cursorMarker,
							cursorInWin: !!r.cursorInWin,
							cursorX: r.cursorX,
							cursorY: r.cursorY,
							cursorImgX: r.cursorImgX,
							cursorImgY: r.cursorImgY,
							ocr: ocrList,
						},
					};
				},
			},
			{
				name: "desktop_type",
				label: "向桌面输入",
				description:
					"Type into an input: English via keyboard, Chinese/emoji via clipboard paste. Pass shot+x+y, shot+click_text (self-drawn UIs) or dump+id to auto-click and focus first, avoiding lost input from cross-turn focus loss. 2000 chars max per call.",
				promptSnippet: "desktop_type — type/paste text (can click-focus first)",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "Text to type." },
						click_text: {
							type: "string",
							description:
								"Optional: first click-focus by text on the screenshot (requires shot; auto-matches the OCR text center).",
						},
						shot: {
							type: "string",
							description:
								"Optional: screenshot key from desktop_screenshot (recommended for self-drawn UIs; use with x+y or click_text to click-focus first).",
						},
						dump: { type: "string", description: "Optional: snapshot key to click an id first for focus." },
						id: { type: "string", description: "Optional: element id (clicked first, then types)." },
						x: {
							type: "number",
							description: "shot mode = in-image pixel X (omit when click_text given); raw screen X when no shot/id.",
						},
						y: {
							type: "number",
							description: "shot mode = in-image pixel Y (omit when click_text given); raw screen Y when no shot/id.",
						},
					},
					required: ["text"],
				},
				async execute(_id, params, signal) {
					requireWin();
					const p = params ?? {};
					let via = "";
					if (
						p.shot !== undefined ||
						p.id !== undefined ||
						(typeof p.x === "number" && typeof p.y === "number") ||
						p.click_text !== undefined
					) {
						const pt = resolvePoint({ ...p, text: p.click_text });
						via = `，已先聚焦 ${pt.via}`;
						await doClick(pt.x, pt.y, {}, signal);
						await new Promise((r) => setTimeout(r, 250));
					}
					const r = await doType(String(p.text ?? ""), signal);
					return `已输入 ${r.chars} 字 [${r.backend}]${via}。`;
				},
			},
			{
				name: "desktop_key",
				label: "按键/快捷键",
				description: 'Press a key or combo: keys like "enter" / "esc" / "tab" / "ctrl+c" / "alt+F4" / "win+r" / "F5".',
				promptSnippet: "desktop_key — press keys/shortcuts",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						keys: { type: "string", description: 'Keys, e.g. "enter" / "ctrl+c" / "alt+F4".' },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					const parts = parseKeys(params?.keys);
					const r = await doKey(parts, signal);
					return `已按键 ${r.keys} [${r.backend}]。`;
				},
			},
			{
				name: "desktop_window",
				label: "窗口列表/聚焦",
				description:
					"List top-level windows (action=list) or bring one to the foreground (action=focus + title substring). Focus the app before operating on it, then desktop_elements.",
				promptSnippet: "desktop_window — list/focus windows",
				promptGuidelines: GUIDELINES,
				parameters: {
					type: "object",
					properties: {
						action: { type: "string", enum: ["list", "focus"], description: "list or focus." },
						title: { type: "string", description: "Window title substring for focus." },
					},
				},
				async execute(_id, params, signal) {
					requireWin();
					needWinPs();
					const p = params ?? {};
					if (p.action === "focus") {
						if (!p.title) throw new Error("focus 需要 title（窗口标题子串）。");
						const r = await runPs(INPUT_PS1, psArgs({ Op: "focus", Title: p.title }), {
							timeout: INPUT_TIMEOUT_MS,
							signal,
						});
						if (!r?.ok) throw new Error(`聚焦失败：${r?.error ?? "unknown"}`);
						await new Promise((r2) => setTimeout(r2, 400));
						return `已聚焦：${r.title}`;
					}
					const r = await runPs(UIA_PS1, psArgs({ Scope: "desktop", MaxNodes: 120, MaxDepth: 1 }), { signal });
					if (!r?.ok) throw new Error(`窗口枚举失败：${r?.error ?? "unknown"}`);
					const wins = (r.nodes ?? []).filter((n) => n.type === "Window" && n.name);
					if (wins.length === 0) return "没有可见顶层窗口。";
					return (
						`顶层窗口（${wins.length}，标题易变的认进程名）：\n` +
						wins
							.map((w) => `- 「${w.name}」${w.proc ? ` (${w.proc}.exe${w.cls ? ` / ${w.cls}` : ""})` : ""}`)
							.join("\n")
					);
				},
			},
		];

		for (const t of tools) {
			try {
				const off = host.registerAgentTool(t);
				st.offs.push(off);
			} catch (e) {
				host.log("error", `desktop-use: 注册工具 ${t.name} 失败：${e?.message ?? e}`);
			}
		}

		// 探活 nut；缺失则后台自安装（不挡 activate，工具调用时看状态）
		probeNut().then((ok) => {
			if (st.dead) return;
			if (ok) {
				st.depsOk = true;
				host.log("info", "desktop-use: 输入依赖就绪（nut-js）");
			} else {
				ensureDeps(true);
			}
		});

		return {
			deactivate() {
				st.dead = true;
				st.dumps.clear();
				try {
					st.installer?.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				for (const off of st.offs) {
					try {
						off?.();
					} catch {
						/* ignore */
					}
				}
			},
		};
	},
};
