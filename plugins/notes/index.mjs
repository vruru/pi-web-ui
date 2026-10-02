/**
 * notes 服务端入口 —— 笔记 / 待办 / 提醒的**唯一事实源**。
 *
 * 分工：
 *   - 数据落 `<dataDir>/notes/store.json`（原子写：临时文件 + rename）。**不放插件目录**：
 *     `install --force` 更新插件会整目录替换，用户数据必须活在外面（与 legado-web 同口径）。
 *   - 提醒的定时**交给宿主** `host.schedule(cron, fn, { persistent: true })`：5 字段 cron、
 *     服务重启自动重建 + 漏跑补一次，且自动出现在顶栏「后台任务」面板 —— 自己写 setTimeout
 *     在重启后必丢。
 *   - 到点只做两件事：把提醒扔进「待送达队列」+ 库版本号 +1。**怎么提示人是浏览器的事**
 *     （站内通知条/桌面通知/提示音/浮窗，见 client/entry.mjs）—— 服务端进程没有窗口，
 *     `host.notify` 只对当时在线的页面有效，浏览器关着就等于没提示。
 *   - 浏览器侧只走 HTTP 路由（`/plugins-api/notes/*`，见 client/data.mjs 的说明）：
 *     `GET /store` 取快照、`GET /wait` 长轮询等变化、`POST /op` 改数据、`GET /export` 导出。
 *   - 5 个 AI 工具（notes_list / notes_add / notes_update / notes_todo / notes_reminder）
 *     让 agent 自己记东西；3 个斜杠命令（/note /todo /remind）供用户手动快速捕获。
 *
 * 纯逻辑全在 client/store.mjs 与 client/cron.mjs（服务端 import 同一份文件）——
 * 服务端与浏览器对「一条提醒该什么时候响」不可能有第二种解释。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as S from "./client/store.mjs";
import { isSupportedEvery, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, parseCron } from "./client/cron.mjs";

/** 长轮询挂住的最长时间（毫秒）。太短 = 请求风暴，太长 = 关服务时要等它。 */
const WAIT_MS = 25_000;
/** 同时挂着的长轮询上限（超过就立刻回，客户端会马上再问，不会积压连接）。 */
const MAX_WAITERS = 40;

export default {
	activate(host) {
		// ------------------------------------------------------------ 落盘
		const dir = join(host.dataDir, "notes");
		const file = join(dir, "store.json");
		let readonly = false; // 隔离失败时进只读（宁可不写，也不能拿空库盖掉用户数据）
		// Markdown 镜像的状态（声明必须在 activate 顶部：queueMirror 在启动时就可能被调到）
		const MIRROR_INDEX = ".pi-notes-mirror.json";
		let mirrorTimer = null;
		let mirrorRunning = false;
		let mirrorQueued = false;
		let mirrorDenied = false;
		let store = load(); // 注意：load() 里会写 readonly，声明必须在调用之前（否则 TDZ）

		function load() {
			try {
				return S.normalizeStore(JSON.parse(readFileSync(file, "utf8")));
			} catch (err) {
				if (existsSync(file)) {
					// 读得出来但坏掉（手改坏 / 半截写 / 别的版本写过）→ 先把它挪走再当空库起，
					// 否则下面那次 persist() 会把用户的全部数据用空库盖掉、且没有备份。
					const quarantine = `${file}.corrupt-${Date.now()}`;
					try {
						renameSync(file, quarantine);
						host.log(
							"error",
							`笔记库解析失败，原文件已隔离为 ${quarantine}，本次以空库启动：`,
							err instanceof Error ? err.message : String(err),
						);
					} catch (e2) {
						// 隔离都失败就**不要**落盘（persist() 会覆盖），只在内存里跑本次会话
						host.log(
							"error",
							"笔记库解析失败且隔离失败，本次不写盘以免覆盖：",
							e2 instanceof Error ? e2.message : String(e2),
						);
						readonly = true;
					}
				}
				return S.emptyStore();
			}
		}

		function persist() {
			if (readonly) return;
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${file}.tmp.${process.pid}`;
				writeFileSync(tmp, JSON.stringify(store, null, "\t"), "utf8");
				renameSync(tmp, file);
			} catch (err) {
				host.log("error", "写入笔记库失败：", err instanceof Error ? err.message : String(err));
			}
		}

		/** 一次真正的改动：版本号 +1 → 落盘 → 唤醒所有长轮询 → 重建近处定时。 */
		function commitChange() {
			S.touch(store);
			persist();
			flushWaiters();
			refreshNearTimers();
			queueMirror("change");
		}

		// ------------------------------------------------------------ 长轮询
		const waiters = new Set();

		function snapshotPayload() {
			// `next` 是服务端算好的「下次触发时刻」（客户端照它显示，不自己拿浏览器时区重算）；
			// 库里已经存着 nextDue，这里只是把它摘出来（过期但没响的也照发 —— 那是「欠一次」，
			// 下一秒扫描就会补上，界面不该显示成「不会触发」）。
			const next = {};
			for (const rem of store.reminders) {
				if (!rem.enabled || !rem.nextDue) continue;
				const ms = new Date(rem.nextDue).getTime();
				if (Number.isFinite(ms)) next[rem.id] = new Date(ms).toISOString();
			}
			return { ok: true, store, next, now: Date.now() };
		}

		function respond(waiter) {
			try {
				clearTimeout(waiter.timer);
				waiter.res.json(snapshotPayload());
			} catch {
				/* 连接已断 */
			}
		}

		function flushWaiters() {
			for (const w of [...waiters]) {
				if (w.rev !== store.meta.rev) {
					waiters.delete(w);
					respond(w);
				}
			}
		}

		function closeAllWaiters() {
			for (const w of [...waiters]) {
				waiters.delete(w);
				try {
					clearTimeout(w.timer);
					w.res.json({ ok: true, unchanged: true, store, now: Date.now() });
				} catch {
					/* ignore */
				}
			}
		}

		// ------------------------------------------------------------ 提醒定时
		// 只有一个定时器：每分钟扫一遍库（持久声明，重启自动重建 + 漏跑补一次）。
		//
		// 为什么不给每条提醒挂一个 host.schedule：宿主用 `setTimeout(next - now)` 引爆，
		// 而 Node 的 setTimeout 延迟超过 2^31-1ms（≈24.8 天）会**溢出成 1ms**；同时宿主的
		// nextCronFire 在「一年内找不到」时回一个 366 天后的哨兵值。于是
		// `{type:"monthly", dom:31}`（下次 42 天）或 `0 9 1 1 *`（明年）这种完全合法的提醒
		// 会让宿主陷入「1ms 后再触发 → 插件写盘 + 广播 → 再排下一次」的死循环（实测复现：
		// TimeoutOverflowWarning + 每秒上千次触发）。自己算「该响的时刻」（reminder.nextDue，
		// 持久化在库里）就不吃这个窗口限制，顺带拿到「停机期间错过的那一次下次启动补上」。
		const nearTimers = new Map();
		const SWEEP_ID = "sweep";
		const SWEEP_SPEC = "* * * * *";
		/** 近处精确定时的窗口（毫秒）：更远的交给每分钟的扫描，免得定时器数量随提醒数增长。 */
		const NEAR_WINDOW_MS = 120_000;

		/** 按当前库重建近处精确定时（2 分钟内要响的、以及已经到点还没响的）。 */
		function refreshNearTimers() {
			for (const [, t] of nearTimers) clearTimeout(t);
			nearTimers.clear();
			const now = Date.now();
			for (const rem of store.reminders) {
				if (!rem.enabled || !rem.nextDue) continue;
				const due = new Date(rem.nextDue).getTime();
				if (!Number.isFinite(due)) continue;
				const delta = due - now;
				if (delta > NEAR_WINDOW_MS) continue;
				nearTimers.set(
					rem.id,
					setTimeout(
						() => {
							nearTimers.delete(rem.id);
							fire(rem.id);
						},
						Math.max(0, delta) + 50,
					),
				);
			}
		}

		/**
		 * 每分钟兜底扫描：所有「该响却还没响」的提醒（服务停机期间错过的也在内）。
		 * 一次性提醒响完自停；重复提醒响完把 nextDue 推到下一跳；「稍后提醒」响完还原原档。
		 */
		function sweep() {
			const now = Date.now();
			let changed = false;
			for (const rem of [...store.reminders]) {
				if (!rem.enabled || !rem.nextDue) continue;
				const due = new Date(rem.nextDue).getTime();
				if (!Number.isFinite(due) || due > now) continue;
				const res = S.markFired(store, rem.id, now);
				if (res.ok) {
					host.log("info", `提醒到点：${res.item.text}`);
					changed = true;
				}
			}
			if (changed) commitChange();
		}

		function fire(id) {
			// 已经在别处响过的（扫描与近处定时撞上）不再重复推一次
			const cur = S.findReminder(store, id);
			if (!cur || !cur.enabled || !cur.nextDue) return;
			if (new Date(cur.nextDue).getTime() > Date.now() + 1000) return; // 还没到点
			const res = S.markFired(store, id);
			if (!res.ok) return;
			host.log("info", `提醒到点：${res.item.text}`);
			commitChange();
		}

		// ------------------------------------------------------------ 操作
		/**
		 * 执行一个操作（HTTP 路由与 AI 工具、斜杠命令共用同一入口）。
		 * 返回 { ok, result?, error? }；真正改动过数据时调用方负责 commitChange()。
		 */
		function runOp(op, payload = {}) {
			switch (String(op ?? "")) {
				case "note.save":
					return wrap(S.saveNote(store, payload.item ?? payload));
				case "note.remove":
					return S.removeNote(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("note");
				case "todo.save":
					return wrap(S.saveTodo(store, payload.item ?? payload));
				case "todo.remove":
					return S.removeTodo(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("todo");
				case "todo.toggle":
					return wrap(S.toggleTodo(store, payload.id));
				case "todo.clearDone": {
					const before = store.todos.length;
					store.todos = store.todos.filter((t) => !t.done);
					return { ok: true, result: { ok: true, removed: before - store.todos.length } };
				}
				case "reminder.save":
					return wrap(S.saveReminder(store, payload.item ?? payload));
				case "reminder.remove":
					return S.removeReminder(store, payload.id) ? { ok: true, result: { ok: true } } : notFound("reminder");
				case "reminder.snooze":
					return wrap(S.snoozeReminder(store, payload.id, payload.minutes));
				case "reminder.ack": {
					const n = S.ackPending(store, payload.ids);
					return { ok: true, result: { ok: true, acked: n }, changed: n > 0 };
				}
				case "store.import": {
					// 先校验再动备份：否则一次垃圾导入会先把唯一一份备份覆盖成当前库，
					// 紧接着导入失败 —— 等于把唯一的退路也烧了
					const candidate = S.normalizeStore(payload.store);
					if (!candidate.notes.length && !candidate.todos.length && !candidate.reminders.length) {
						return { ok: false, error: "文件里没有可导入的条目" };
					}
					const backup = `${file}.bak`;
					try {
						writeFileSync(backup, JSON.stringify(store, null, "\t"), "utf8");
					} catch {
						/* 备份失败不阻断导入（用户自己点的操作，失败要说明） */
					}
					const res = S.importStore(store, payload.store, payload.mode === "replace" ? "replace" : "merge");
					if (!res.ok) return { ok: false, error: res.error ?? "import failed" };
					S.ensureNextDue(store, Date.now()); // 导进来的提醒要算出各自的下次时刻
					return { ok: true, result: { ok: true, added: res.added, updated: res.updated, skipped: res.skipped ?? 0 } };
				}
				default:
					return { ok: false, error: `unknown op: ${op}` };
			}
		}

		function wrap(res) {
			if (!res || res.ok !== true) return { ok: false, error: res?.error ?? "operation failed" };
			return { ok: true, result: { ok: true, item: res.item } };
		}

		function notFound(kind) {
			return { ok: false, error: `${kind} not found` };
		}

		/** 跑一个操作并处理落盘/唤醒（op 里声明过 changed=false 的不重复落盘）。
		 *  提醒的定时触发由每分钟 cron 巡检（host.schedule）负责，commitChange
		 *  不接收任何「是否重建定时」参数——refreshNearTimers 只是近处的快速路径。 */
		function apply(op, payload) {
			const out = runOp(op, payload);
			const changed = out.changed ?? out.ok;
			if (out.ok && changed) commitChange();
			return out;
		}

		// ------------------------------------------------------------ HTTP 路由
		const offs = [];
		const route = (method, path, handler) => {
			offs.push(
				host.route(method, path, (req, res) => {
					try {
						handler(req, res);
					} catch (err) {
						host.log("error", `http ${method} ${path} 失败：`, err instanceof Error ? err.message : String(err));
						if (!res.headersSent)
							res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
					}
				}),
			);
		};

		route("GET", "/store", (_req, res) => res.json(snapshotPayload()));

		route("GET", "/wait", (req, res) => {
			const rev = Number(req.query?.rev);
			if (waiters.size >= MAX_WAITERS) {
				// 挂着的长轮询太多（多标签页/多设备）：立刻回，但让客户端等一下再来 ——
				// 不然多出来的每个标签页都会变成一条自旋请求流，服务端每轮都要序列化整个库
				res.json({ ...snapshotPayload(), retryAfterMs: 2000 });
				return;
			}
			if (!Number.isFinite(rev) || rev !== store.meta.rev) {
				res.json(snapshotPayload());
				return;
			}
			const waiter = { res, rev, timer: null };
			waiter.timer = setTimeout(() => {
				// 空转超时回**真快照**（带 next）：以前回 `next: {}` 会把客户端手里的
				// 权威「下次触发」抹掉，界面上时间开始按浏览器时区乱算
				waiters.delete(waiter);
				respond(waiter);
			}, WAIT_MS);
			// 连接断了（用户关页/切网络）要立刻摘掉，否则定时器白挂着
			req.on?.("close", () => {
				waiters.delete(waiter);
				clearTimeout(waiter.timer);
			});
			waiters.add(waiter);
		});

		route("POST", "/op", (req, res) => {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const out = apply(body.op, body);
			// 顺序要紧：snapshotPayload() 自带 `ok: true`，写在后面会把失败操作的 ok 覆盖成 true
			// （客户端就永远看不到「保存失败」，只会静默什么都没发生）
			res.json({ ...snapshotPayload(), ok: out.ok, error: out.error, result: out.result });
		});

		route("GET", "/export", (req, res) => {
			const format = String(req.query?.format ?? "json") === "md" ? "md" : "json";
			const stamp = S.nowStamp().replace(/[:T]/g, "-");
			if (format === "md") {
				res.setHeader("Content-Type", "text/markdown; charset=utf-8");
				res.setHeader("Content-Disposition", `attachment; filename="notes-${stamp}.md"`);
				res.send(S.toMarkdown(store));
				return;
			}
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.setHeader("Content-Disposition", `attachment; filename="notes-backup-${stamp}.json"`);
			res.send(JSON.stringify(store, null, "\t"));
		});

		// ------------------------------------------------------------ 启动
		if (!existsSync(file)) persist(); // 只在文件确实不存在时建（坏文件已在 load() 里隔离）
		S.ensureNextDue(store, Date.now()); // 老数据/刚导入的提醒补上「下次该响的时刻」
		// 每分钟的兜底扫描：声明持久，服务重启后自动重建（漏跑的那一次也能补）
		let offSweep = () => {};
		try {
			offSweep = host.schedule(SWEEP_SPEC, () => sweep(), {
				persistent: true,
				id: SWEEP_ID,
				label: "⏰ 笔记提醒巡检",
				catchUp: "once",
			});
		} catch (err) {
			// 宿主对非法 cron/id 是抛错；一条定时排不上不该把整插件的路由/工具/命令全带走
			host.log(
				"error",
				"每分钟巡检排不上，提醒不会自动触发（其它功能照常）：",
				err instanceof Error ? err.message : String(err),
			);
		}
		// 启动就扫一次：停机期间到点的提醒立刻补送（不必等下一个整分钟）
		sweep();
		refreshNearTimers();
		queueMirror("startup", 1500);
		host.log(
			"info",
			`笔记库就绪：${store.notes.length} 篇笔记 / ${store.todos.length} 条待办 / ${store.reminders.length} 条提醒`,
		);

		// ------------------------------------------------------------ AI 工具
		const toolOffs = [
			host.registerAgentTool({
				name: "notes_list",
				label: "读笔记/待办/提醒",
				promptGuidelines: [
					"When the user asks what's on their plate today or what's coming up, call notes_list (kind=agenda) first and answer from it instead of making the user look for themselves.",
					"Before editing or deleting an item, get its id via notes_list (ids are the input to notes_update / notes_todo / notes_reminder).",
				],
				description:
					"List notes, todos and reminders from the user's personal notes store (this machine). Use it whenever the user asks what is on their plate, or before editing an item to learn its id. Returns compact lines with the id needed by notes_update / notes_todo / notes_reminder.",
				promptSnippet:
					"notes_list — list the user's notes/todos/reminders with ids (kind=agenda = what is due today and upcoming)",
				parameters: {
					type: "object",
					properties: {
						kind: {
							type: "string",
							enum: ["all", "agenda", "note", "todo", "reminder"],
							description:
								"all = every collection; agenda = what is due now (overdue + today + next 7 days + reminders in the next 14 days); note/todo/reminder = one collection only.",
						},
						query: { type: "string", description: "Case-insensitive substring filter over text/title/body/tags." },
						tag: { type: "string", description: "Only items carrying this tag." },
						include_done: { type: "boolean", description: "Include completed todos (default false)." },
						limit: { type: "number", description: "Max rows per collection (default 30, max 200)." },
					},
				},
				async execute(_id, params) {
					return listText(params);
				},
			}),
			host.registerAgentTool({
				name: "notes_add",
				label: "新建笔记",
				promptGuidelines: [
					"When the user says 'note this down', 'remember this', or asks to save a memo/idea/meeting note, call notes_add instead of just restating it in the reply.",
					"Distinguish the three: a piece of information → notes_add; something to do → notes_todo; a timed alert → notes_reminder.",
				],
				description:
					"Save a note (Markdown body) into the user's personal notes store. Use it for 'note this down', meeting minutes, ideas, or anything the user dictates worth keeping.",
				promptSnippet:
					"notes_add — save a note (memo/idea/meeting minutes); to-dos go to notes_todo, timed alerts to notes_reminder",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "Short title (defaults to the first body line)." },
						body: { type: "string", description: "Markdown body." },
						tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
					},
				},
				async execute(_id, params) {
					const out = apply("note.save", {
						item: { title: params.title, body: params.body, tags: params.tags },
					});
					if (!out.ok) return `保存失败：${out.error}`;
					return `已记下笔记「${out.result.item.title}」（id ${out.result.item.id}）`;
				},
			}),
			host.registerAgentTool({
				name: "notes_update",
				label: "改/删笔记",
				promptGuidelines: [
					"When the user wants to change or delete a note, find its id with notes_list first, then call notes_update (pass delete:true to remove).",
				],
				description:
					"Update or delete an existing note by id. `append` adds text to the end of the body (handy for appending a log). Get ids from notes_list.",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "Note id from notes_list." },
						title: { type: "string" },
						body: { type: "string", description: "Replace the whole body." },
						append: { type: "string", description: "Append this text to the body (after body, if both given)." },
						tags: { type: "array", items: { type: "string" } },
						pinned: { type: "boolean" },
						delete: { type: "boolean", description: "Delete the note instead of updating it." },
					},
				},
				async execute(_id, params) {
					const id = String(params.id ?? "").trim();
					if (!id) return "缺少 id（先用 notes_list 查）";
					if (params.delete === true) {
						const out = apply("note.remove", { id });
						return out.ok ? `已删除笔记 ${id}` : `删除失败：${out.error}`;
					}
					const note = S.findNote(store, id);
					if (!note) return `找不到笔记 ${id}`;
					const patch = { id };
					if (params.title !== undefined) patch.title = params.title;
					if (params.body !== undefined) patch.body = params.body;
					if (params.append !== undefined)
						patch.body = `${note.body}${note.body.endsWith("\n") || !note.body ? "" : "\n"}${params.append}`;
					if (params.tags !== undefined) patch.tags = params.tags;
					if (params.pinned !== undefined) patch.pinned = params.pinned;
					const out = apply("note.save", { item: patch });
					return out.ok ? `已更新笔记「${out.result.item.title}」` : `更新失败：${out.error}`;
				},
			}),
			host.registerAgentTool({
				name: "notes_todo",
				label: "待办",
				promptGuidelines: [
					"Use notes_todo when the user wants to remember an action item ('I need to… later', 'don't forget…'); action can be omitted (defaults to add).",
					"With a specific time: 'when should this be done' → notes_todo's due; 'remind me at a time' → notes_reminder instead.",
				],
				description:
					"Add / update / complete / delete todos in the user's personal list. Use it for action items the user wants to remember (especially with a due date), not for things you can just finish yourself right now.",
				promptSnippet: "notes_todo — the user's todo list (add/update/toggle/delete)",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["add", "update", "done", "undone", "remove", "clear_done"],
							description: "What to do. Optional: no action + no id = add; no action + id = update.",
						},
						id: { type: "string", description: "Todo id (required except for add/clear_done)." },
						text: { type: "string" },
						due: {
							type: "string",
							description: "Due time: 'YYYY-MM-DD HH:MM', 'YYYY-MM-DD' or ISO 8601 (empty string clears it).",
						},
						priority: { type: "number", description: "0 normal … 3 urgent." },
						repeat: {
							type: "string",
							enum: ["none", "daily", "weekly", "monthly"],
							description: "Repeating todo: ticking it advances the due date instead of completing it.",
						},
						tags: { type: "array", items: { type: "string" } },
					},
					required: [],
				},
				async execute(_id, params) {
					// action 可省：给了 id 就是改，没给 id 就是新建（模型少填一个字段就少一次失败）
					const action =
						String(params.action ?? "").toLowerCase() || (String(params.id ?? "").trim() ? "update" : "add");
					const common = {};
					if (params.text !== undefined) common.text = params.text;
					if (params.priority !== undefined) common.priority = params.priority;
					if (params.repeat !== undefined) common.repeat = params.repeat;
					if (params.tags !== undefined) common.tags = params.tags;
					if (action === "add") {
						const out = apply("todo.save", { item: { ...common, due: toStampOrNull(params.due) } });
						return out.ok ? `已加入待办：${describeTodo(out.result.item)}` : `添加失败：${out.error}`;
					}
					if (action === "clear_done") {
						const out = apply("todo.clearDone", {});
						return out.ok ? `已清除 ${out.result.removed} 条已完成待办` : `失败：${out.error}`;
					}
					const id = String(params.id ?? "").trim();
					if (!id) return "缺少 id（先用 notes_list 查待办）";
					if (action === "remove") {
						const out = apply("todo.remove", { id });
						return out.ok ? `已删除待办 ${id}` : `删除失败：${out.error}`;
					}
					if (action === "done" || action === "undone") {
						const todo = S.findTodo(store, id);
						if (!todo) return `找不到待办 ${id}`;
						if (todo.done === (action === "done")) return `待办 ${id} 已经是该状态`;
						const out = apply("todo.toggle", { id });
						if (!out.ok) return `失败：${out.error}`;
						return out.result.item.done === false && todo.repeat !== "none"
							? `重复待办已推进到下一次：${describeTodo(out.result.item)}`
							: `${action === "done" ? "已完成" : "已重新打开"}：${describeTodo(out.result.item)}`;
					}
					const patch = { id, ...common };
					if (params.due !== undefined) patch.due = toStampOrNull(params.due);
					const out = apply("todo.save", { item: patch });
					return out.ok ? `已更新待办：${describeTodo(out.result.item)}` : `更新失败：${out.error}`;
				},
			}),
			host.registerAgentTool({
				name: "notes_reminder",
				label: "提醒",
				promptGuidelines: [
					"Use notes_reminder when the user gives a specific time ('tomorrow 9am', 'daily at 9', 'Fridays 18:00') — it fires a toast/desktop notification in the user's browser.",
					"Prefer the simple forms: at / daily_at / weekly_at + weekdays / monthly_at + day_of_month / every_minutes; don't jump straight to raw cron.",
					"Reminders only wake the user up; for the AI to do work on schedule (write reports, run scripts), use the built-in schedule_task tool instead of a notes reminder.",
				],
				description:
					"Manage scheduled reminders (they fire on the SERVER's local clock and show up as a toast/desktop notification in the user's browser; nothing is fired while no browser is open — those are delivered on next open). Prefer the simple forms (at / daily_at / weekly_at / monthly_at / every_minutes) over raw cron.",
				promptSnippet: "notes_reminder — remind the user at a given time (one-off/daily/weekly/monthly/interval)",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["add", "update", "remove", "snooze"],
							description: "What to do. Optional: no action + no id = add; no action + id = update.",
						},
						id: { type: "string", description: "Reminder id (except for add)." },
						text: { type: "string", description: "What to remind about." },
						at: { type: "string", description: "One-off time: 'YYYY-MM-DD HH:MM' or ISO 8601." },
						daily_at: { type: "string", description: "Daily at 'HH:MM'." },
						weekly_at: { type: "string", description: "Time 'HH:MM' for weekdays given in weekdays." },
						weekdays: {
							type: "array",
							items: { type: "string" },
							description: "Weekdays for weekly_at: mon..sun (or numbers 0=Sun..6=Sat).",
						},
						monthly_at: { type: "string", description: "Time 'HH:MM' on day_of_month." },
						day_of_month: { type: "number", description: "1-31 for monthly_at (default 1)." },
						every_minutes: { type: "number", description: "Repeat every N minutes (1-1440)." },
						cron: { type: "string", description: "Raw 5-field cron (min hour dom month dow), server local time." },
						enabled: { type: "boolean" },
						minutes: { type: "number", description: "For action=snooze: delay in minutes (default 10)." },
						note_id: { type: "string", description: "Optional note this reminder belongs to." },
						todo_id: { type: "string", description: "Optional todo this reminder belongs to." },
					},
					required: [],
				},
				async execute(_id, params) {
					// action 可省：给了 id 就是改，没给 id 就是新建
					const action =
						String(params.action ?? "").toLowerCase() || (String(params.id ?? "").trim() ? "update" : "add");
					const id = String(params.id ?? "").trim();
					if (action === "remove") {
						if (!id) return "缺少 id";
						const out = apply("reminder.remove", { id });
						return out.ok ? `已删除提醒 ${id}` : `删除失败：${out.error}`;
					}
					if (action === "snooze") {
						if (!id) return "缺少 id";
						const out = apply("reminder.snooze", { id, minutes: params.minutes ?? 10 });
						return out.ok ? `已推迟：${describeReminder(out.result.item)}` : `失败：${out.error}`;
					}
					const built = buildSchedule(params);
					if (built.error) return built.error;
					// 可运行性判定 = 能不能算出「下一次到点时刻」（与调度器同一口径）。
					// 例如 cron `0 0 31 2 *`（2 月没有 31 号）排不出 → 拒绝，别存成「设好了但不会响」。
					if (
						built.schedule &&
						S.nextDueStamp({ enabled: true, schedule: built.schedule }, Date.now(), "now") === null
					) {
						return "这个时间排不出可运行的定时（例如 2 月 31 日这种永远不存在的日期），请换一个档位";
					}
					if (action === "add") {
						if (!String(params.text ?? "").trim()) return "提醒内容不能为空";
						if (!built.schedule)
							return "缺少时间：用 at / daily_at / weekly_at / monthly_at / every_minutes / cron 之一";
						const out = apply("reminder.save", {
							item: {
								text: params.text,
								schedule: built.schedule,
								noteId: params.note_id,
								todoId: params.todo_id,
							},
						});
						return out.ok ? `已设提醒：${describeReminder(out.result.item)}` : `设置失败：${out.error}`;
					}
					if (!id) return "缺少 id（先用 notes_list 查提醒）";
					const patch = { id };
					if (params.text !== undefined) patch.text = params.text;
					if (built.schedule) patch.schedule = built.schedule;
					if (params.enabled !== undefined) patch.enabled = params.enabled;
					if (params.note_id !== undefined) patch.noteId = params.note_id;
					if (params.todo_id !== undefined) patch.todoId = params.todo_id;
					const out = apply("reminder.save", { item: patch });
					return out.ok ? `已更新提醒：${describeReminder(out.result.item)}` : `更新失败：${out.error}`;
				},
			}),
		];

		// ------------------------------------------------------------ Markdown 镜像（可选）
		// 用户在设置面板（manifest.settings）里开开关 + 填目录后，每次改动把库镜像成
		// Markdown 文件写进那个目录 —— 给 Obsidian / git / 其它编辑器用。
		//
		// 三条纪律：
		//   1. **只动自己写过的文件**：目录里留一份索引（.pi-notes-mirror.json）记着我们写过
		//      哪些文件；清理只删索引里的，绝不碰用户目录里的其它东西。
		//   2. 目录在工作区外要**用户点头**：host.fs.requestAccess 弹一次确认（授权持久），
		//      被拒就停手并记日志，不反复弹。
		//   3. 单飞 + 防抖：一次跑完再跑下一次，手快也不会写半截。

		/** 文件名安全化：去掉路径分隔符/Windows 保留字符/控制字符，长度封顶（唯一性靠 id 后缀）。 */
		function safeName(text, fallback = "note") {
			// 反斜杠用 charCode 点出来：源码里写转义容易被各种补丁/编辑器通道吃掉（已踩过）
			const BACKSLASH = String.fromCharCode(92);
			const BAD = new Set(["/", ":", "*", "?", '"', "<", ">", "|", BACKSLASH]);
			let cleaned = "";
			for (const ch of String(text ?? "")) {
				cleaned += ch.codePointAt(0) < 32 || BAD.has(ch) ? " " : ch;
			}
			cleaned = cleaned
				.replace(/\s+/g, " ")
				.replace(/^[. ]+|[. ]+$/g, "")
				.trim()
				.slice(0, 60);
			return cleaned || fallback;
		}

		function noteFile(note) {
			return `${safeName(note.title, "note")}-${note.id.slice(-6)}.md`;
		}

		/** 一条笔记 → Markdown（front-matter 存 id/标签/时间，正文原样）。 */
		function noteMarkdown(note) {
			const title = note.title.replace(/[\r\n]+/g, " ");
			const fm = [
				"---",
				`id: ${note.id}`,
				`title: ${title}`,
				`tags: [${note.tags.join(", ")}]`,
				`pinned: ${note.pinned}`,
				`created: ${note.createdAt}`,
				`updated: ${note.updatedAt}`,
				"---",
				"",
			].join("\n");
			return `${fm}# ${title}\n\n${note.body.trim()}\n`;
		}

		function todosMarkdown() {
			const lines = [`# 待办（${store.todos.filter((t) => !t.done).length} 项未完成）`, ""];
			for (const todo of store.todos) {
				const bits = [];
				if (todo.due) bits.push(`截止 ${todo.due.replace("T", " ")}`);
				if (todo.priority) bits.push(`优先级 ${todo.priority}`);
				if (todo.repeat !== "none") bits.push(`重复 ${todo.repeat}`);
				if (todo.tags.length) bits.push(todo.tags.map((x) => `#${x}`).join(" "));
				lines.push(`- [${todo.done ? "x" : " "}] ${todo.text}${bits.length ? `  _(${bits.join(" · ")})_` : ""}`);
			}
			lines.push("");
			return lines.join("\n");
		}

		function remindersMarkdown() {
			const lines = ["# 提醒", ""];
			for (const rem of store.reminders) {
				const next = S.reminderFireAt(rem);
				lines.push(
					`- ${rem.enabled ? "🔔" : "🔕"} ${rem.text} — ${scheduleParts(rem.schedule)}` +
						(next ? `（下次 ${new Date(next).toLocaleString()}）` : rem.enabled ? "" : "（已停用）"),
				);
			}
			lines.push("");
			return lines.join("\n");
		}

		/** 目录是否可用（必要时向用户要一次授权）。 */
		async function ensureMirrorDir(dir) {
			try {
				const granted = (host.fs.authorizedDirs?.() ?? []).some((d) => d === dir);
				if (!granted) {
					if (mirrorDenied) return false;
					const ok = await host.fs.requestAccess(dir, "把笔记镜像成 Markdown 文件到这个目录");
					if (!ok) {
						mirrorDenied = true; // 拒过一次就不反复烦用户（改设置或重启后再试）
						host.log("warn", `镜像目录未授权，已暂停镜像：${dir}`);
						host.notify("warning", `笔记镜像需要目录授权：${dir}`);
						return false;
					}
				}
				await host.fs.mkdirPath(dir);
				return true;
			} catch (err) {
				host.log("warn", "镜像目录不可用：", err instanceof Error ? err.message : String(err));
				return false;
			}
		}

		/** 真的同步一次（单飞）：写笔记 + 两个汇总，清理自己写过但已不存在的文件。 */
		async function mirrorOnce(reason) {
			const settings = host.getSettings?.() ?? {};
			if (settings.mirrorEnabled !== true) return;
			const dir = String(settings.mirrorDir ?? "").trim();
			if (!dir || !isAbsolute(dir)) {
				host.log("warn", "镜像目录必须是绝对路径：", JSON.stringify(dir));
				return;
			}
			if (mirrorRunning) {
				mirrorQueued = true;
				return;
			}
			mirrorRunning = true;
			try {
				if (!(await ensureMirrorDir(dir))) return;
				const wanted = new Map();
				for (const note of store.notes) wanted.set(noteFile(note), noteMarkdown(note));
				wanted.set("_todos.md", todosMarkdown());
				wanted.set("_reminders.md", remindersMarkdown());

				// 上一轮写过的文件（索引读不到就当作「什么都不知道」，一个都不删）
				let previous = [];
				try {
					const parsed = JSON.parse(await host.fs.readTextPath(join(dir, MIRROR_INDEX)));
					if (Array.isArray(parsed?.files)) previous = parsed.files.filter((x) => typeof x === "string");
				} catch {
					previous = [];
				}

				let written = 0;
				for (const [name, text] of wanted) {
					try {
						await host.fs.writePath(join(dir, name), text);
						written++;
					} catch (err) {
						host.log("warn", `镜像写入失败 ${name}：`, err instanceof Error ? err.message : String(err));
					}
				}
				let removed = 0;
				for (const name of previous) {
					if (wanted.has(name)) continue;
					try {
						await host.fs.removePath(join(dir, name));
						removed++;
					} catch {
						/* 文件可能已被用户自己删掉：不算错 */
					}
				}
				await host.fs.writePath(
					join(dir, MIRROR_INDEX),
					JSON.stringify({ v: 1, at: new Date().toISOString(), files: [...wanted.keys()] }, null, "\t"),
				);
				host.log(
					"info",
					`镜像同步完成（${reason}）：写 ${written} 个${removed ? `，清理 ${removed} 个` : ""} → ${dir}`,
				);
			} catch (err) {
				host.log("warn", "镜像同步失败：", err instanceof Error ? err.message : String(err));
			} finally {
				mirrorRunning = false;
				if (mirrorQueued) {
					mirrorQueued = false;
					void mirrorOnce("queued");
				}
			}
		}

		/** 防抖排队（改动密集时只跑最后那一次）。未开启直接跳过，零开销。 */
		function queueMirror(reason, delayMs = 3000) {
			if ((host.getSettings?.() ?? {}).mirrorEnabled !== true) return;
			if (mirrorTimer) clearTimeout(mirrorTimer);
			mirrorTimer = setTimeout(() => {
				mirrorTimer = null;
				void mirrorOnce(reason);
			}, delayMs);
			mirrorTimer.unref?.();
		}

		// 设置面板里改了开关/目录 → 按新配置同步一次（用户点完保存就想看到结果）
		const offSettings = host.onSettingsChanged?.(() => {
			mirrorDenied = false;
			queueMirror("settings", 200);
		});

		// ------------------------------------------------------------ 斜杠命令（零 token 的手动捕获）
		const cmdOffs = [
			host.registerCommand({
				name: "note",
				description: "存一条笔记",
				descriptionEn: "Save a note",
				argumentHint: "<正文>",
				argumentHintEn: "<text>",
				run(args) {
					const text = String(args ?? "").trim();
					if (!text) return "用法：/note 内容（第一行当标题）";
					const [first, ...rest] = text.split("\n");
					const out = apply("note.save", { item: { title: first.slice(0, 120), body: rest.join("\n") } });
					return out.ok ? `📌 已记到笔记：${out.result.item.title}` : `失败：${out.error}`;
				},
			}),
			host.registerCommand({
				name: "todo",
				description: "加一条待办（支持「明天 18:00」「#标签」「!!」）",
				descriptionEn: "Add a todo (understands “tomorrow 18:00”, “#tag”, “!!”)",
				argumentHint: "<内容>",
				argumentHintEn: "<text>",
				run(args) {
					const raw = String(args ?? "").trim();
					if (!raw) return "用法：/todo 交周报 明天 18:00 #工作 !!";
					const parsed = S.parseQuickTodo(raw);
					if (!parsed.text) return "没读懂这条待办，试试：/todo 交周报 明天 18:00";
					const out = apply("todo.save", {
						item: { text: parsed.text, due: parsed.due, priority: parsed.priority, tags: parsed.tags },
					});
					return out.ok ? `✅ 已加入待办：${describeTodo(out.result.item)}` : `失败：${out.error}`;
				},
			}),
			host.registerCommand({
				name: "notes-mirror",
				description: "立即把笔记镜像成 Markdown（需先在设置里开启并填目录）",
				descriptionEn: "Mirror notes to Markdown now (enable it in settings first)",
				run: async () => {
					const settings = host.getSettings?.() ?? {};
					if (settings.mirrorEnabled !== true || !String(settings.mirrorDir ?? "").trim()) {
						return "还没开启镜像：设置 → 界面插件 → 笔记 里勾选并填一个绝对目录";
					}
					mirrorDenied = false;
					await mirrorOnce("manual");
					return `已同步到 ${String(settings.mirrorDir).trim()}`;
				},
			}),
			host.registerCommand({
				name: "remind",
				description: "设提醒（如「每天 9:00 吃药」「每周五 18:00 复盘」「每30分钟 起身」）",
				descriptionEn: "Set a reminder (“every day 9:00 …”, “every friday 18:00 …”, “every 30 min …”)",
				argumentHint: "<时间 + 内容>",
				argumentHintEn: "<when + what>",
				run(args) {
					const raw = String(args ?? "").trim();
					if (!raw) return "用法：/remind 每天 9:00 吃药";
					const parsed = S.parseQuickReminder(raw);
					if (!parsed) return "没读懂时间，试试：/remind 每天 9:00 吃药 / 每30分钟 起身 / 明天 21:00 交作业";
					const out = apply("reminder.save", { item: { text: parsed.text, schedule: parsed.schedule } });
					return out.ok ? `⏰ 已设提醒：${describeReminder(out.result.item)}` : `失败：${out.error}`;
				},
			}),
		];

		// ------------------------------------------------------------ 辅助
		function toStampOrNull(raw) {
			const s = String(raw ?? "").trim();
			if (!s) return null;
			const normalized = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(s) ? s.replace(" ", "T") : s;
			const ms = new Date(normalized).getTime();
			if (!Number.isFinite(ms)) return null;
			return S.nowStamp(ms);
		}

		/** 工具/命令参数 → schedule（认不出回 { error } 让人（模型）自己改）。 */
		function buildSchedule(params) {
			// 空字符串按「没给」算（模型常给 at: ""）；一个时间字段都没给 = 不改时间（update 用）
			const given = (v) => v !== undefined && v !== null && String(v).trim() !== "";
			if (!["at", "daily_at", "weekly_at", "monthly_at", "cron", "every_minutes"].some((k) => given(params[k]))) {
				return {};
			}
			if (params.every_minutes !== undefined) {
				const minutes = Number(params.every_minutes);
				if (!isSupportedEvery(minutes)) {
					return { error: `every_minutes 需在 ${MIN_EVERY_MINUTES}..${MAX_EVERY_MINUTES} 分钟之间（7 天）` };
				}
				return { schedule: { type: "every", minutes } };
			}
			if (params.cron !== undefined) {
				const spec = String(params.cron).trim().replace(/\s+/g, " ");
				if (!parseCron(spec)) return { error: `cron 表达式不合法：${spec}（需要 5 段：分 时 日 月 周）` };
				return { schedule: { type: "cron", spec } };
			}
			const timeOf = (raw) => {
				const m = /(\d{1,2})[:：](\d{1,2})/.exec(String(raw ?? ""));
				if (!m) return null;
				const h = Number(m[1]);
				const mi = Number(m[2]);
				return h <= 23 && mi <= 59 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
			};
			if (params.daily_at !== undefined) {
				const time = timeOf(params.daily_at);
				return time ? { schedule: { type: "daily", time } } : { error: `daily_at 需要 HH:MM：${params.daily_at}` };
			}
			if (params.weekly_at !== undefined) {
				const time = timeOf(params.weekly_at);
				if (!time) return { error: `weekly_at 需要 HH:MM：${params.weekly_at}` };
				const byName = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
				const dow = (Array.isArray(params.weekdays) ? params.weekdays : [])
					.map((x) => {
						const s = String(x).trim().toLowerCase();
						if (s in byName) return byName[s];
						const n = Number(s);
						return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
					})
					.filter((x) => x !== null);
				return dow.length
					? { schedule: { type: "weekly", time, dow } }
					: { error: 'weekly_at 需要 weekdays（如 ["mon","fri"]）' };
			}
			if (params.monthly_at !== undefined) {
				const time = timeOf(params.monthly_at);
				if (!time) return { error: `monthly_at 需要 HH:MM：${params.monthly_at}` };
				const dom = Number(params.day_of_month ?? 1);
				if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { error: "day_of_month 需在 1..31" };
				return { schedule: { type: "monthly", time, dom } };
			}
			const stamp = toStampOrNull(params.at);
			if (!stamp) return { error: `at 解析不出时间：${params.at}（用 'YYYY-MM-DD HH:MM'）` };
			if (new Date(stamp).getTime() < Date.now() - 60_000) {
				return { error: "at 已经是过去的时间（补跑只发生在服务重启时，请给未来的时间）" };
			}
			return { schedule: { type: "once", at: stamp } };
		}

		function describeTodo(todo) {
			const bits = [];
			if (todo.due) bits.push(`截止 ${todo.due.replace("T", " ")}`);
			if (todo.priority) bits.push(`优先级 ${todo.priority}`);
			if (todo.repeat !== "none") bits.push(`重复 ${todo.repeat}`);
			if (todo.tags.length) bits.push(todo.tags.map((x) => `#${x}`).join(" "));
			return `${todo.done ? "[x]" : "[ ]"} ${todo.text}${bits.length ? `（${bits.join(" · ")}）` : ""}（id ${todo.id}）`;
		}

		function describeReminder(rem) {
			const parts = scheduleParts(rem.schedule);
			const next = S.reminderFireAt(rem);
			const when = next ? `，下次 ${new Date(next).toLocaleString()}` : rem.enabled ? "" : "（已停用）";
			return `${rem.text} · ${parts}${when}（id ${rem.id}）`;
		}

		function everyText(minutes) {
			const n = Number(minutes);
			if (n % 1440 === 0) return `每 ${n / 1440} 天`;
			if (n >= 60 && n % 60 === 0) return `每 ${n / 60} 小时`;
			if (n >= 60) return `每 ${Math.floor(n / 60)} 小时 ${n % 60} 分`;
			return `每 ${n} 分钟`;
		}

		function scheduleParts(schedule) {
			const s = S.normalizeSchedule(schedule);
			if (!s) return "无效时间";
			const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
			switch (s.type) {
				case "once":
					return `一次性 ${s.at.replace("T", " ")}`;
				case "daily":
					return `每天 ${s.time}`;
				case "weekly":
					return `每周 ${s.dow.map((d) => week[d]).join("")} ${s.time}`;
				case "monthly":
					return `每月 ${s.dom} 日 ${s.time}`;
				case "every":
					return everyText(s.minutes);
				case "cron":
					return `cron ${s.spec}`;
				default:
					return "无效时间";
			}
		}

		function listText(params) {
			const kind = String(params.kind ?? "all");
			const limit = Math.min(200, Math.max(1, Number(params.limit) || 30));
			const includeDone = params.include_done === true;
			const query = params.query === undefined ? "" : String(params.query);
			const tag = params.tag === undefined ? "" : String(params.tag);
			const lines = [];
			// agenda：用户问「今天要做什么」时最该看的一屏 —— 逾期待办 + 今天 + 未来 7 天
			// + 接下来 14 天的提醒（一次性提醒有过期未响的也算「欠着」）。
			if (kind === "agenda") {
				const now = Date.now();
				const endToday = new Date(
					new Date(now).getFullYear(),
					new Date(now).getMonth(),
					new Date(now).getDate() + 1,
				).getTime();
				const week = now + 7 * 86400000;
				const overdue = [];
				const today = [];
				const upcoming = [];
				const later = [];
				for (const todo of store.todos) {
					if (todo.done) continue;
					if (!todo.due) {
						later.push(todo);
						continue;
					}
					const ms = new Date(todo.due).getTime();
					if (!Number.isFinite(ms)) continue;
					if (ms < now) overdue.push(todo);
					else if (ms < endToday) today.push(todo);
					else if (ms <= week) upcoming.push(todo);
					else later.push(todo);
				}
				const section = (title, items) => {
					lines.push(`## ${title}（${items.length}）`);
					lines.push(...(items.length ? items.slice(0, limit).map((t) => `- ${describeTodo(t)}`) : ["（无）"]));
					lines.push("");
				};
				section("逾期未完成", overdue);
				section("今天到期", today);
				section("未来 7 天", upcoming);
				section("没有截止时间", later);
				const rems = [];
				for (const rem of store.reminders) {
					if (!rem.enabled) continue;
					const ms = S.reminderFireAt(rem);
					if (ms !== null && ms <= now + 14 * 86400000) rems.push({ rem, ms });
				}
				rems.sort((a, b) => a.ms - b.ms);
				lines.push(`## 接下来的提醒（${rems.length}）`);
				lines.push(
					...(rems.length
						? rems.slice(0, limit).map(({ rem, ms }) => `- ${new Date(ms).toLocaleString()}  ${describeReminder(rem)}`)
						: [`（无）`]),
				);
				return lines.join("\n");
			}
			if (kind === "all" || kind === "todo") {
				const todos = S.searchItems(store, { tab: "todo", query, tag, includeDone }).slice(0, limit);
				lines.push(`## 待办（未完成 ${store.todos.filter((t) => !t.done).length} / 共 ${store.todos.length}）`);
				lines.push(...(todos.length ? todos.map((t) => `- ${describeTodo(t)}`) : ["（无）"]));
			}
			if (kind === "all" || kind === "note") {
				const notes = S.searchItems(store, { tab: "note", query, tag }).slice(0, limit);
				lines.push("", `## 笔记（${store.notes.length}）`);
				lines.push(
					...(notes.length
						? notes.map(
								(n) =>
									`- ${n.pinned ? "📌 " : ""}${n.title}（id ${n.id}${n.tags.length ? ` · ${n.tags.map((x) => `#${x}`).join(" ")}` : ""} · ${n.updatedAt.replace("T", " ")}）\n  ${firstLine(n.body)}`,
							)
						: ["（无）"]),
				);
			}
			if (kind === "all" || kind === "reminder") {
				const rems = S.searchItems(store, { tab: "reminder", query, tag }).slice(0, limit);
				lines.push(
					"",
					`## 提醒（启用 ${store.reminders.filter((r) => r.enabled).length} / 共 ${store.reminders.length}）`,
				);
				lines.push(
					...(rems.length ? rems.map((r) => `- ${r.enabled ? "🔔" : "🔕"} ${describeReminder(r)}`) : ["（无）"]),
				);
			}
			if (!lines.length) return "（库里没有匹配的条目）";
			return lines.join("\n");
		}

		function firstLine(body) {
			const line = String(body ?? "")
				.split("\n")
				.map((x) => x.trim())
				.filter(Boolean)[0];
			return line ? line.slice(0, 120) : "（空）";
		}

		// ------------------------------------------------------------ 卸载
		return () => {
			closeAllWaiters();
			for (const [, t] of nearTimers) clearTimeout(t);
			nearTimers.clear();
			try {
				offSweep?.();
			} catch {
				/* ignore */
			}
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			if (mirrorTimer) clearTimeout(mirrorTimer);
			for (const off of [...toolOffs, ...cmdOffs, ...offs]) {
				try {
					off?.();
				} catch {
					/* ignore */
				}
			}
			persist();
		};
	},
};
