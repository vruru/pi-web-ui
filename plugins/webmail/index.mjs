/**
 * webmail 服务端入口 —— 真实可用的 IMAP/SMTP 邮件管理插件。
 *
 * 能力：
 *  - 收件：IMAP（imapflow）列出/搜索/阅读/标记/删除邮件
 *  - 发件：SMTP（nodemailer）
 *  - 新邮件通知：周期轮询 INBOX 未读，新增即 host.notify + 推给插件视图
 *  - AI 工具：常驻经 host.registerAgentTool 注册
 *    mail_list / mail_read / mail_search / mail_send / mail_manage / mail_folders。
 *
 * 凭据存 <dataDir>/plugins/webmail/config.json（本机明文，与 pi auth.json 同级安全模型）。
 * 依赖 imapflow/mailparser/nodemailer 不随包分发：首次激活尝试自动 npm 安装，
 * 失败时视图里会出现「安装依赖」按钮手动触发。
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const CONFIG_FILE = "config.json";
/** 阅读正文上限（字符），防超大 HTML 撑爆上下文。 */
const BODY_LIMIT = 16000;
/** 搜索时最多拉取的信封数量。 */
const SEARCH_SCAN = 1000;

const DEFAULT_CONFIG = {
	imap: { host: "", port: 993, tls: true, user: "", pass: "" },
	smtp: {
		host: "",
		port: 465,
		tls: true,
		user: "",
		pass: "",
		from: "",
	},
	pollSec: 60,
	notifyEnabled: true,
};

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

async function loadConfig(dir) {
	const raw = join(dir, CONFIG_FILE);
	if (!existsSync(raw)) return structuredClone(DEFAULT_CONFIG);
	try {
		const parsed = JSON.parse(await readFile(raw, "utf8"));
		return {
			...structuredClone(DEFAULT_CONFIG),
			...parsed,
			imap: { ...DEFAULT_CONFIG.imap, ...parsed.imap },
			smtp: { ...DEFAULT_CONFIG.smtp, ...parsed.smtp },
		};
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

async function saveConfig(dir, cfg) {
	await writeFile(join(dir, CONFIG_FILE), JSON.stringify(cfg, null, "\t"), "utf8");
}

/** 找到能用的 npm CLI：优先 require 解析 npm 包内的 cli.js（免 shell），退回 PATH。 */
function resolveNpmCli() {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {
		return null;
	}
}

export default {
	activate(host) {
		const st = {
			config: null,
			client: null,
			/** IMAP 操作互斥链（ImapFlow 连接上操作必须串行）。 */
			chain: Promise.resolve(),
			pollTimer: null,
			pollBusy: false,
			lastUnseenUids: new Set(),
			firstPollDone: false,
			deps: { imapflow: null, mailparser: null, nodemailer: null },
			depsOk: false,
			depsInstalling: false,
			status: "未配置",
			lastCheckAt: 0,
			unseenTotal: 0,
			toolUnregister: null,
			/** registerBackgroundTask 的句柄（后台任务面板里的邮件轮询）。 */
			bgTask: null,
		};

		// ------------------------------------------------------------------
		// 配置与状态
		// ------------------------------------------------------------------
		// 机密存储：密码优先走宿主 host.secrets（AES-256-GCM 加密）；旧版宿主无此
		// 设施、或写入失败（目录只读 / 磁盘满）时回退旧的明文 config.json 行为。
		// 关键不变式：密码只要没确认存进机密，就绝不从内存/配置文件里抹掉——
		// 否则会出现“保存后密码消失、IMAP 报 No password configured”。
		const sec = host.secrets;
		/** 机密写入是否降级到明文（只提示一次，不刷屏）。 */
		let secretsDegradedWarned = false;

		/** 写机密并回读校验：宿主的 set() 写盘失败时只记日志不抛错，
		 *  只有回读到相同值才能确认真的存住了。失败返回 false → 调用方保留明文。 */
		function storeSecret(name, value) {
			if (!sec?.set || !value) return false;
			try {
				sec.set(name, String(value));
				return sec.get?.(name) === String(value);
			} catch (err) {
				host.log(`机密写入失败 ${name}:`, err?.message ?? err);
				return false;
			}
		}

		/** 机密不可用时提醒一次：密码仍会保存，但是明文存在 config.json。 */
		function warnSecretsDegraded() {
			if (secretsDegradedWarned) return;
			secretsDegradedWarned = true;
			host.log("加密存储不可用，密码以明文保存在 config.json");
			host.notify(
				"warning",
				"📬 邮件插件：加密存储不可用，密码已以明文保存在 config.json（功能不受影响）",
				"Webmail: encrypted storage unavailable — the password was saved as plain text in config.json (functionality unaffected)",
			);
		}

		/** 从 config.json 读非敏感字段后：把历史明文密码迁入机密（确认成功才从
		 *  文件里剥离），再用机密回填内存副本（内存需要真实密码供 IMAP/SMTP 连接）。 */
		async function loadConfigSecure() {
			const cfg = await loadConfig(host.dir);
			if (sec?.set) {
				let migrated = false;
				for (const [sect, secretName] of [
					["imap", "imap_pass"],
					["smtp", "smtp_pass"],
				]) {
					const legacy = cfg?.[sect]?.pass;
					if (!legacy) continue;
					// 校验通过才能剥离明文，否则迁移会把唯一的密码删掉。
					if (storeSecret(secretName, legacy)) {
						cfg[sect].pass = "";
						migrated = true;
					} else {
						warnSecretsDegraded();
					}
				}
				if (migrated) {
					try {
						await saveConfig(host.dir, cfg);
					} catch {} // 剥离后的干净配置回写
					host.log("已将明文密码迁移到加密存储");
				}
			}
			return rehydrate(cfg);
		}

		/** 用已存机密补齐内存副本（不动用户刚输入的新值）。 */
		function rehydrate(cfg) {
			if (!sec?.get || !cfg) return cfg;
			const ip = sec.get("imap_pass");
			const sp = sec.get("smtp_pass");
			if (ip !== undefined && !cfg.imap.pass) cfg.imap.pass = ip;
			if (sp !== undefined && !cfg.smtp.pass) cfg.smtp.pass = sp;
			return cfg;
		}

		function publicState() {
			const c = st.config;
			return {
				configured: Boolean(c?.imap?.host && c?.imap?.user),
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				status: st.status,
				unseen: st.unseenTotal,
				lastCheckAt: st.lastCheckAt,
				notifyEnabled: c?.notifyEnabled !== false && Boolean(c?.imap?.host),
				// 脱敏后的配置回显（密码不回传，只报是否存在）
				config: {
					imap: {
						host: c?.imap?.host ?? "",
						port: c?.imap?.port ?? 993,
						tls: c?.imap?.tls !== false,
						user: c?.imap?.user ?? "",
						hasPass: Boolean(c?.imap?.pass),
					},
					smtp: {
						host: c?.smtp?.host ?? "",
						port: c?.smtp?.port ?? 465,
						tls: c?.smtp?.tls !== false,
						user: c?.smtp?.user ?? "",
						from: c?.smtp?.from ?? "",
						hasPass: Boolean(c?.smtp?.pass),
					},
					pollSec: c?.pollSec ?? 60,
					notifyEnabled: c?.notifyEnabled !== false,
				},
			};
		}
		function broadcastState() {
			host.broadcast({ kind: "state", state: publicState() });
		}

		async function applyConfig(next) {
			// 1) 密码语义：留空(undefined/"") = 沿用已存（内存 → 机密）；有值 = 更新。
			next.imap.pass = next.imap.pass || st.config?.imap?.pass || sec?.get?.("imap_pass") || "";
			next.smtp.pass = next.smtp.pass || st.config?.smtp?.pass || sec?.get?.("smtp_pass") || "";
			// 2) 落盘副本：确认写进机密的密码才从 config.json 剥离；机密不可用/写失败
			//    时保留明文（旧宿主行为）——宁可明文，不能丢密码。
			const onDisk = structuredClone(next);
			let degraded = false;
			for (const [sect, secretName] of [
				["imap", "imap_pass"],
				["smtp", "smtp_pass"],
			]) {
				if (!next[sect].pass) continue;
				if (storeSecret(secretName, next[sect].pass)) onDisk[sect].pass = "";
				else degraded = true;
			}
			if (degraded && sec?.set) warnSecretsDegraded();
			// 3) 内存副本始终持有真实密码（IMAP/SMTP 连接靠它）。
			st.config = next;
			await saveConfig(host.dir, onDisk);
			if (!st.depsOk && next.imap?.host) installDeps(true); // 刚配置好账号但缺依赖 → 自动补装
			restartPoller();
			await refreshAiTools();
			broadcastState();
		}

		// ------------------------------------------------------------------
		// 依赖加载 / 自动安装
		// ------------------------------------------------------------------
		async function loadDeps() {
			for (const name of ["imapflow", "mailparser", "nodemailer"]) {
				try {
					st.deps[name] = await import(name);
				} catch (err) {
					host.log(`依赖 ${name} 未就绪:`, err?.message ?? err);
					st.deps[name] = null;
				}
			}
			st.depsOk = ["imapflow", "mailparser"].every((n) => st.deps[n]);
			if (!st.depsOk || !st.deps.nodemailer) host.log("提示：在设置里点「安装依赖」完成安装");
			return st.depsOk;
		}

		function installDeps(auto = false) {
			if (st.depsInstalling) return;
			st.depsInstalling = true;
			host.log(`installing deps: imapflow / mailparser / nodemailer${auto ? " (auto)" : ""}`);
			if (!auto) host.notify("info", "📬 邮件插件：开始安装依赖…");
			host.notify("info", "📬 邮件插件：开始安装依赖（imapflow / mailparser / nodemailer）…");
			const pkgs = ["imapflow@latest", "mailparser@latest", "nodemailer@latest"];
			const npmCli = resolveNpmCli();
			const child = npmCli
				? spawn(process.execPath, [npmCli, "--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
					})
				: spawn("npm", ["--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
						shell: process.platform === "win32", // win 下 npm 是 .cmd，必须 shell
					});
			st.installChild = child;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			let done = false;
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (st.installChild === child) st.installChild = null;
				if (ok) {
					await loadDeps();
					restartPoller(); // 依赖就绪后启动轮询
					await refreshAiTools();
				}
				host.notify(
					ok ? "success" : "error",
					ok
						? "📬 邮件插件依赖安装完成"
						: `📬 邮件插件依赖安装失败（${why}）——请在插件目录手动执行 npm install，或在设置面板重试「安装依赖」`,
				);
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// IMAP 基础设施：互斥串行 + 惰性连接
		// ------------------------------------------------------------------
		function serialized(fn) {
			const run = st.chain.then(
				() => fn(),
				() => fn(),
			);
			st.chain = run.then(
				() => {},
				() => {},
			);
			return run;
		}

		function dropClient(why) {
			const c = st.client;
			st.client = null;
			if (c) {
				try {
					c.close();
				} catch {
					/* already dead */
				}
			}
			if (why) host.log("连接断开:", why);
		}

		async function ensureClient() {
			const c = st.config?.imap;
			if (!st.deps.imapflow) throw new Error("依赖未安装：请在设置面板点「安装依赖」");
			if (!c?.host || !c?.user) throw new Error("尚未配置 IMAP 账号");
			if (st.client?.usable) return st.client;
			dropClient();
			const { ImapFlow } = st.deps.imapflow;
			const client = new ImapFlow({
				host: c.host,
				port: Number(c.port) || 993,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
				logger: false,
			});
			client.on("error", (err) => dropClient(err?.message));
			await client.connect();
			st.client = client;
			st.status = "已连接";
			return client;
		}

		/** 打开 folder 并执行 fn（fn 内可用 client 的 mailbox 级 API），结束后释放锁。 */
		async function withMailbox(folder, fn) {
			const client = await ensureClient();
			const lock = await client.getMailboxLock(folder || "INBOX");
			try {
				return await fn(client);
			} finally {
				lock.release();
			}
		}

		function envFrom(envelope) {
			const addr = envelope?.from?.[0];
			return addr ? addr.address : "";
		}
		function envName(envelope) {
			const addr = envelope?.from?.[0];
			return addr?.name || "";
		}
		function summarize(msg) {
			return {
				uid: msg.uid,
				from: envFrom(msg.envelope),
				fromName: envName(msg.envelope),
				to: (msg.envelope?.to ?? []).map((a) => a.address).join(", "),
				subject: msg.envelope?.subject || "(无主题)",
				date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : "",
				seen: Boolean(msg.flags?.has("\\Seen")),
				size: msg.size ?? 0,
			};
		}

		// ------------------------------------------------------------------
		// 邮件操作（UI 与 AI 工具共用同一套实现）
		// ------------------------------------------------------------------
		async function listMails({ folder = "INBOX", limit = 30, unseenOnly = false } = {}) {
			return withMailbox(folder, async (client) => {
				const box = client.mailbox;
				const total = box?.exists ?? 0;
				if (total === 0) return [];
				const start = Math.max(1, total - Math.min(Number(limit) || 30, 200) + 1);
				const out = [];
				const range = `${start}:*`;
				for await (const msg of client.fetch(range, {
					envelope: true,
					flags: true,
					size: true,
				})) {
					if (unseenOnly && msg.flags?.has("\\Seen")) continue;
					out.push(summarize(msg));
				}
				out.sort((a, b) => new Date(b.date) - new Date(a.date));
				return out;
			});
		}

		async function searchMails({ query, folder = "INBOX", limit = 20 } = {}) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) return [];
			// 客户端过滤信封（subject/from/to），避开各家 IMAP SEARCH 方言差异
			const pool = await listMails({ folder, limit: SEARCH_SCAN });
			return pool
				.filter((m) => [m.subject, m.from, m.fromName, m.to].some((s) => String(s).toLowerCase().includes(q)))
				.slice(0, Math.min(Number(limit) || 20, 50));
		}

		async function readMail({ folder = "INBOX", uid } = {}) {
			if (!uid) throw new Error("缺少 uid");
			return withMailbox(folder, async (client) => {
				// 注意：第三个参数 {uid:true} 才表示按 UID 取信——放查询参数里
				// 会被当成序号，导致“列表能看、点开未找到”（UID > 邮件总数时必现）。
				const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
				if (!msg || !msg.source) throw new Error(`未找到 uid=${uid}`);
				const meta = summarize(msg);
				const raw = msg.source;
				const { simpleParser } = st.deps.mailparser;
				const parsed = await simpleParser(raw);
				const text =
					parsed.text ||
					String(parsed.html ?? "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim();
				return {
					...meta,
					text: text.slice(0, BODY_LIMIT),
					truncated: text.length > BODY_LIMIT,
					hasAttachments: (parsed.attachments ?? []).length > 0,
				};
			});
		}

		async function markMails({ folder = "INBOX", uids, seen = true } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { changed: 0 };
			return withMailbox(folder, async (client) => {
				let changed = 0;
				const flag = "\\Seen";
				for (const uid of list) {
					const ok = seen
						? await client.messageFlagsAdd(uid, [flag], { uid: true })
						: await client.messageFlagsRemove(uid, [flag], { uid: true });
					if (ok) changed++;
				}
				return { changed };
			});
		}

		async function deleteMails({ folder = "INBOX", uids } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { deleted: 0 };
			return withMailbox(folder, async (client) => {
				// 有废纸篓就移过去（可恢复），没有才硬删
				let trash = null;
				for await (const f of client.list()) {
					if (f.specialUse === "\\Trash" || /^(trash|deleted|deleted messages|已删除)/i.test(f.path)) {
						trash = f.path;
						break;
					}
				}
				let moved = 0;
				for (const uid of list) {
					const ok = trash
						? await client.messageMove(uid, trash, { uid: true })
						: await client.messageDelete(uid, { uid: true });
					if (ok) moved++;
				}
				return { deleted: moved, trash };
			});
		}

		async function sendMail({ to, cc, subject, body } = {}) {
			const nd = st.deps.nodemailer;
			if (!nd) throw new Error("依赖未安装：请在设置面板点「安装依赖」");
			const c = st.config?.smtp;
			if (!c?.host || !c?.user) throw new Error("尚未配置 SMTP 账号");
			const transport = nd.createTransport({
				host: c.host,
				port: Number(c.port) || 465,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
			});
			const info = await transport.sendMail({
				from: c.from || c.user,
				to: String(to ?? ""),
				cc: cc ? String(cc) : undefined,
				subject: String(subject ?? "(无主题)"),
				text: String(body ?? ""),
			});
			return { messageId: info.messageId, accepted: info.accepted };
		}

		async function countUnseen() {
			return withMailbox("INBOX", async (client) => ({
				uids: (await client.search({ seen: false }, { uid: true })) ?? [],
			}));
		}

		// ------------------------------------------------------------------
		// 新邮件轮询通知
		// ------------------------------------------------------------------
		async function pollOnce() {
			if (!st.config?.imap?.host || !st.depsOk || st.pollBusy) return;
			st.pollBusy = true;
			try {
				const { uids } = await countUnseen();
				st.lastCheckAt = Date.now();
				const fresh = uids.filter((u) => !st.lastUnseenUids.has(u));
				st.unseenTotal = uids.length;
				if (st.firstPollDone && fresh.length > 0) {
					let subjects = [];
					try {
						const summaries = await listMails({ folder: "INBOX", limit: 10 });
						subjects = summaries
							.filter((m) => fresh.includes(m.uid))
							.slice(0, 3)
							.map((m) => `${m.fromName || m.from}: ${m.subject}`);
					} catch {
						/* 拿不到主题就只报数量 */
					}
					if (st.config.notifyEnabled !== false) {
						host.notify("info", `📬 ${fresh.length} 封新邮件${subjects.length ? ` — ${subjects.join(" · ")}` : ""}`);
					}
					host.broadcast({
						kind: "new-mail",
						count: fresh.length,
						unseen: uids.length,
						subjects,
					});
				}
				st.firstPollDone = true;
				st.lastUnseenUids = new Set(uids);
				st.status = "已连接";
			} catch (err) {
				st.status = `连接失败：${err?.message ?? err}`;
				dropClient();
			} finally {
				st.pollBusy = false;
				broadcastState();
			}
		}

		function restartPoller() {
			if (st.pollTimer) clearInterval(st.pollTimer);
			st.pollTimer = null;
			st.lastUnseenUids.clear();
			st.firstPollDone = false;
			const sec = Math.max(15, Math.floor(Number(st.config?.pollSec) || 60));
			if (st.config?.imap?.host && st.depsOk) {
				st.pollTimer = setInterval(() => void serialized(pollOnce), sec * 1000);
				void serialized(pollOnce); // 立即来一轮
				// 常驻任务进「后台任务」面板：可见 + 可一键停止轮询。
				if (st.bgTask) st.bgTask.update({ label: "📬 邮件轮询", status: `每 ${sec}s` });
				else {
					st.bgTask = host.registerBackgroundTask?.({
						id: "mail-poll",
						label: "📬 邮件轮询",
						status: `每 ${sec}s`,
						stop: () => {
							if (st.pollTimer) clearInterval(st.pollTimer);
							st.pollTimer = null;
							host.log("polling stopped from background panel");
						},
					});
				}
			} else {
				// 未配置/依赖未就绪：不轮询，任务移出面板（若有）。
				st.bgTask?.unregister?.();
				st.bgTask = null;
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// AI 工具注册（常驻，插件内无开关）
		// ------------------------------------------------------------------
		const FOLDER_PARAM = {
			type: "string",
			description: "Mailbox folder path, default INBOX",
		};

		function aiTools() {
			return [
				{
					name: "mail_list",
					label: "列出新邮件",
					description:
						"List summaries of recent emails (sender/subject/date/read status). Use it when the user asks to check mail or look at the inbox.",
					parameters: {
						type: "object",
						properties: {
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "Number of results, default 30, max 200" },
							unseen_only: { type: "boolean", description: "Only unread mail, default false" },
						},
					},
					execute: async (_id, args) => {
						const mails = await listMails(args);
						if (mails.length === 0) return "邮箱为空（或没有未读）。";
						return mails
							.map(
								(m) =>
									`#${m.uid}${m.seen ? "" : " [未读]"} ${m.date.slice(0, 16).replace("T", " ")} ${m.fromName || m.from} — ${m.subject}`,
							)
							.join("\n");
					},
				},
				{
					name: "mail_read",
					label: "读一封邮件",
					description: "Read the full body of one email by uid (plain text, truncated when very long).",
					parameters: {
						type: "object",
						properties: {
							uid: { type: "number", description: "#id returned by mail_list" },
							folder: FOLDER_PARAM,
						},
						required: ["uid"],
					},
					execute: async (_id, args) => {
						const m = await readMail(args);
						return [
							`主题: ${m.subject}`,
							`发件人: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
							`日期: ${m.date}`,
							m.hasAttachments ? "(含附件)" : "",
							"",
							m.text + (m.truncated ? "\n…(截断)" : ""),
						]
							.filter(Boolean)
							.join("\n");
					},
				},
				{
					name: "mail_search",
					label: "搜索邮件",
					description: "Search recent emails by keyword (matches subject/sender/recipients).",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Keyword" },
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "Number of results, default 20" },
						},
						required: ["query"],
					},
					execute: async (_id, args) => {
						const mails = await searchMails(args);
						if (mails.length === 0) return `没有匹配 “${args.query}” 的邮件。`;
						return mails
							.map(
								(m) =>
									`#${m.uid}${m.seen ? "" : " [未读]"} ${m.date.slice(0, 16).replace("T", " ")} ${m.fromName || m.from} — ${m.subject}`,
							)
							.join("\n");
					},
				},
				{
					name: "mail_send",
					label: "发送邮件",
					description: "Send a plain-text email via the configured SMTP.",
					promptGuidelines: ["Confirm recipient/subject/body with the user once before sending."],
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "Recipient email address" },
							cc: { type: "string", description: "CC (optional)" },
							subject: { type: "string", description: "Subject" },
							body: { type: "string", description: "Body (plain text)" },
						},
						required: ["to", "body"],
					},
					execute: async (_id, args) => {
						const r = await sendMail(args);
						return `已发送至 ${(r.accepted ?? []).join(", ")}`;
					},
				},
				{
					name: "mail_manage",
					label: "管理邮件状态",
					description: 'Batch-mark mail as read/unread or delete it. action is "seen" | "unseen" | "delete".',
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["seen", "unseen", "delete"],
								description: "Operation type",
							},
							uids: { type: "array", items: { type: "number" }, description: "List of mail uids" },
							folder: FOLDER_PARAM,
						},
						required: ["action", "uids"],
					},
					execute: async (_id, args) => {
						if (args.action === "delete") {
							const r = await deleteMails(args);
							return `已删除 ${r.deleted} 封${r.trash ? `（移入 ${r.trash}）` : ""}`;
						}
						const r = await markMails({ ...args, seen: args.action === "seen" });
						return `已更新 ${r.changed} 封邮件状态`;
					},
				},
				{
					name: "mail_folders",
					label: "列出文件夹",
					description: "List all mailbox folder paths (inbox/archive/trash etc.).",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						return withMailbox("INBOX", async (client) => {
							const out = [];
							for await (const f of client.list()) {
								out.push(`${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}`);
							}
							return out.join("\n");
						});
					},
				},
			];
		}

		async function refreshAiTools() {
			st.toolUnregister?.();
			st.toolUnregister = null;
			if (st.depsOk) {
				const offs = aiTools().map((t) => host.registerAgentTool(t));
				st.toolUnregister = () => offs.forEach((off) => off());
				host.log("AI 邮箱工具已开启");
			}
		}

		// ------------------------------------------------------------------
		// 视图消息协议
		// ------------------------------------------------------------------
		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "get_state":
					if (from) host.sendTo(from, { kind: "state", state: publicState() });
					else broadcastState();
					break;
				case "save_config":
					void (async () => {
						try {
							await applyConfig({
								...structuredClone(DEFAULT_CONFIG),
								...msg.config,
								imap: { ...DEFAULT_CONFIG.imap, ...msg.config?.imap },
								smtp: { ...DEFAULT_CONFIG.smtp, ...msg.config?.smtp },
							});
							host.sendTo(from, { kind: "result", ok: true, action: "save_config" });
							host.notify("info", "📬 邮箱配置已保存并生效");
						} catch (err) {
							host.sendTo(from, {
								kind: "result",
								ok: false,
								action: "save_config",
								error: err?.message ?? String(err),
							});
						}
					})();
					break;
				case "install_deps":
					installDeps();
					break;
				case "list":
					void serialized(() => listMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => {
							st.status = err?.message ?? String(err);
							broadcastState();
						});
					break;
				case "read":
					void serialized(() => readMail(msg))
						.then((mail) => host.broadcast({ kind: "mail", mail }))
						.catch((err) => host.notify("error", `📬 读取失败：${err?.message ?? err}`));
					break;
				case "search":
					void serialized(() => searchMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => host.notify("error", `📬 搜索失败：${err?.message ?? err}`));
					break;
				case "mark":
					void serialized(() => markMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "mark", ...r }))
						.catch((err) => host.notify("error", `📬 标记失败：${err?.message ?? err}`));
					break;
				case "delete":
					void serialized(() => deleteMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "delete", ...r }))
						.catch((err) => host.notify("error", `📬 删除失败：${err?.message ?? err}`));
					break;
				case "send":
					void sendMail(msg)
						.then(() => {
							host.notify("info", `📬 已发送给 ${msg.to}`);
							host.broadcast({ kind: "result", ok: true, action: "send" });
						})
						.catch((err) => host.notify("error", `📬 发送失败：${err?.message ?? err}`));
					break;
				default:
					host.log("unknown action:", msg.action);
			}
		});

		// ------------------------------------------------------------------
		// 启动
		// ------------------------------------------------------------------
		void (async () => {
			try {
				st.config = await loadConfigSecure();
				await loadDeps();
				if (!st.depsOk) installDeps(true); // 缺依赖就自动装，不等配置保存
				await refreshAiTools();
				restartPoller();
				broadcastState();
				host.log("activated", st.depsOk ? "(依赖就绪)" : "(装依赖中)");
			} catch (err) {
				host.log("activation failed:", err);
			}
		})();

		// 新客户端接入时主动推送完整状态（服务端唯一事实源）；
		// host.onAttach 在旧版宿主上不存在——可选链兼容，客户端拉取仍作兑底
		const offAttach = host.onAttach?.((clientId) => {
			host.sendTo(clientId, { kind: "state", state: publicState() });
		});

		return () => {
			offMsg();
			try {
				offAttach?.();
			} catch {}
			st.toolUnregister?.();
			try {
				st.bgTask?.unregister?.();
			} catch {}
			if (st.pollTimer) clearInterval(st.pollTimer);
			try {
				st.installChild?.kill(); // 进行中的依赖安装一并终止，不残留写手
			} catch {
				/* already gone */
			}
			dropClient();
			host.log("deactivated");
		};
	},
};
