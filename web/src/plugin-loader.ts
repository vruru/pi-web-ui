/**
 * 插件视图加载器：把 <dataDir>/plugins/<id>/client/entry.mjs 动态加载进页面。
 *
 * 插件客户端模块的约定（ESM，默认导出）：
 *   export default {
 *     // 挂载到宿主给的 DOM 容器；返回清理函数（可选），切走/卸载时调用。
 *     mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void)
 *   }
 *
 * 与主应用的通信只有两条窄通道（不共享 React 实例，插件可用任何技术栈）：
 *   ctx.send(payload)   → WS 上行 {type:"plugin_message", pluginId, payload}
 *   ctx.onData(cb)      ← WS 下行 plugin_data（按 pluginId 过滤后回调）
 *
 * plugin_data 的分发走 window CustomEvent（同主题切换的事件模式），
 * use-chat 收到消息后 emitPluginData，这里订阅并按插件扇出。
 */
import type { UiPluginInfo } from "./types";
import { appUrl } from "./base-url";
import { withPluginScopeAsync } from "./plugin-host";

export interface PluginViewContext {
	pluginId: string;
	/** 上行一条消息给插件的服务端入口（index.mjs 的 onMessage 处理器）。 */
	send: (payload: unknown) => void;
	/** 订阅服务端广播；返回取消订阅函数。 */
	onData: (cb: (payload: unknown) => void) => () => void;
}

/** 上下文传给插件 fenced-code renderer（与视图 mount 的窄通道同一套）。 */
export interface FenceRenderContext {
	pluginId: string;
	/** 上行一条消息给插件的服务端入口（index.mjs 的 onMessage 处理器）。 */
	send: (payload: unknown) => void;
	/** 订阅服务端广播；返回取消订阅函数。 */
	onData: (cb: (payload: unknown) => void) => () => void;
}

/** 插件把 ```lang 围栏渲染成自定义 DOM 的工厂函数。返回 null 表示不渲染
 *  （回退普通代码块）。可以是任意技术栈——主应用只负责把返回的 DOM 挂进
 *  消息流，不共享 React 实例。 */
export type FenceRenderer = (code: string, ctx: FenceRenderContext) => HTMLElement | null | Promise<HTMLElement | null>;

export interface PluginFile {
	path: string;
	name: string;
}

export interface PluginFileHandlerContext extends PluginViewContext {
	file: PluginFile;
	/** 同源插件 API 基址（已包含应用子路径前缀）。 */
	apiUrl: (path: string, params?: Record<string, string | number | boolean | undefined>) => string;
}

export interface PluginFileHandler {
	/** 数组形态声明时用于和 manifest handler id 对应。对象形态可省略。 */
	id?: string;
	mount(container: HTMLElement, file: PluginFile, ctx: PluginFileHandlerContext): void | (() => void);
}

export interface PluginFileHandlerModule {
	fileHandlers?: PluginFileHandler[] | Record<string, PluginFileHandler>;
}

export interface PluginViewModule extends PluginFileHandlerModule {
	mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void);
	/** 可选：fenced-code 渲染器（manifest "renderers" 声明的语言）。 */
	renderers?: Record<string, FenceRenderer>;
}

export interface LoadedPluginView {
	info: UiPluginInfo;
	module: PluginViewModule;
}

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

/** use-chat 调用：把服务端 plugin_data 消息转成分发事件。 */
export function emitPluginData(pluginId: string, payload: unknown): void {
	window.dispatchEvent(new CustomEvent(PLUGIN_DATA_EVENT, { detail: { pluginId, payload } }));
}

function subscribeAll(cb: (pluginId: string, payload: unknown) => void): () => void {
	const handler = (e: Event) => {
		const d = (e as CustomEvent).detail as {
			pluginId: string;
			payload: unknown;
		};
		cb(d.pluginId, d.payload);
	};
	window.addEventListener(PLUGIN_DATA_EVENT, handler);
	return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
}

// ---- 已加载视图注册表（模块级单例；React 只是通过订阅读它） -----------------

const loaded = new Map<string, LoadedPluginView>();
/** 只跑顶层代码、没有视图的常驻 bundle（manifest `preload: true`）：不进视图注册表
 *  （没有 tab 可渲染），但「已加载」这件事要记住 —— 否则顶栏动作每点一次就重新
 *  import 一遍，还会被当成加载失败的坏插件。 */
const preloaded = new Set<string>();
const listeners = new Set<(views: LoadedPluginView[]) => void>();
/** 加载失败的 id——同一 epoch 内不再重试（避免坏 bundle 无限刷错误）；
 *  目录清单变化/服务端重载（epoch 变）后自动清空，给修复后的插件重试机会。 */
const failed = new Set<string>();
/** issue #225：失败集合的订阅（切到没加载出来的视图时给明确状态，不再静默空白）。 */
const failedListeners = new Set<(ids: string[]) => void>();
/** 上次加载用的服务端重载纪元；变化时丢弃全部已加载视图（bundle URL 带 ?e=
 *  强制浏览器重新拉取）。 */
let lastEpoch = -1;

function snapshot(): LoadedPluginView[] {
	return [...loaded.values()];
}

function notify(): void {
	const snap = snapshot();
	for (const l of listeners) l(snap);
}

function notifyFailed(): void {
	const snap = [...failed];
	for (const l of failedListeners) l(snap);
}

/** 订阅加载失败的插件视图 id（立即回调一次当前快照）。 */
export function subscribePluginLoadFailed(cb: (ids: string[]) => void): () => void {
	failedListeners.add(cb);
	cb([...failed]);
	return () => failedListeners.delete(cb);
}

/** 重试加载一个失败过的插件视图：清掉本 epoch 的失败标记后重拉 bundle
 *  （修好文件/重装后不用等服务端重载）。成功与否都会刷新两个注册表。 */
export async function retryPluginViewLoad(p: UiPluginInfo, epoch: number): Promise<boolean> {
	failed.delete(p.id);
	retrySalt.set(p.id, (retrySalt.get(p.id) ?? 0) + 1);
	notifyFailed();
	const ok = await loadOne(p, epoch);
	notify();
	return ok;
}

/** 订阅当前已加载的插件视图（立即回调一次当前快照）。 */
export function subscribeLoadedPluginViews(cb: (views: LoadedPluginView[]) => void): () => void {
	listeners.add(cb);
	cb(snapshot());
	return () => listeners.delete(cb);
}

/**
 * 把目录清单里应显示的插件同步到注册表：
 * - epoch 变化（服务端 plugins_reload）→ 丢弃全部旧 bundle，用 ?e= 重拉
 * - 清单中消失/被禁用的插件 → 移除已加载视图（React 随之卸载并调 cleanup）
 * - 新出现且未失败过的 → 动态 import
 */
/**
 * 加载单个插件的 client bundle 进注册表（幂等）。
 *
 * 作用域：import 期间用 withPluginScopeAsync 把 pluginId 设为「当前插件」——插件
 * bundle 顶层代码调用 host.onTopbarAction(name, fn) 时，处理器就绑到它自己名下
 * （issue #146 的顶栏动作就是靠这条路径接管的）。多个插件并发加载时的作用域串行由
 * 下面的 createScopedImporter 保证（issue #268）。
 */
/** 重试计数（pluginId → 次数）：ESM 模块表会缓存求值失败，同一 URL 重 import
 *  照样 reject —— 重试必须换 URL（`&r=<n>` 服务端忽略，只为击穿模块缓存）。 */
const retrySalt = new Map<string, number>();

/** 插件 client bundle 的浏览器 URL（?e= 纪元击穿 + &r= 重试盐；服务端忽略多余 query）。 */
export function pluginEntryUrl(pluginId: string, epoch: number): string {
	const salt = retrySalt.get(pluginId) ?? 0;
	return appUrl(`/plugins/${encodeURIComponent(pluginId)}/client/entry.mjs?e=${epoch}${salt > 0 ? `&r=${salt}` : ""}`);
}

/**
 * 把「设插件作用域 + import」串成一个**串行闸门**。
 *
 * 为什么必须串行（issue #268）：作用域是 plugin-host.ts 的**模块级** `pluginScope`，
 * 而本文件的同步循环用 `Promise.all` 并发加载各插件 bundle。两个 bundle 的求值交错时，
 * 后启动的那个 loadOne 会把全局作用域改成自己的 id —— 前一个插件在模块顶层 / 异步回调
 * （如 notes 插件的 `whenBridge(...)`）里调 `host.onUiAction("notes:toggle")` 时读到的
 * 就是**别人**的 id，注册键从 `notes:notes:toggle` 变成 `<别的插件>:notes:toggle`；
 * 宿生派发时 `notes:notes:toggle` 与裸名都查不到 → kind="action" 的条目一点就弹
 * 「插件没有接管这个动作」。
 *
 * bundle 都走本机 HTTP，串行的代价是几百 ms 量级（只在首屏预加载 / 手动点开时各一次）；
 * 也可以只把「求值」串行、把请求并行，但那需要先把模块拉进缓存再 import，复杂度不值。
 *
 * 导出仅为可单测 —— 实际调用点用下面那个实例（URL 运行时才知道，必须动态 import）。
 */
export function createScopedImporter(importFn: (url: string) => Promise<unknown>) {
	let gate: Promise<unknown> = Promise.resolve();
	return (pluginId: string, url: string): Promise<unknown> => {
		const run = gate.then(() => withPluginScopeAsync(pluginId, () => importFn(url)));
		// 闸门自身不能因为一个插件加载失败就卡住后面的插件（失败照常从 run 抛出）。
		gate = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/** 本模块实际使用的导入器（动态 import；Vite 不要试图打包运行时 URL）。 */
const importPluginBundle = createScopedImporter((url) => import(/* @vite-ignore */ url));

export async function loadPluginBundleModule(p: UiPluginInfo, epoch: number): Promise<PluginFileHandlerModule | null> {
	if (!p.hasClient || p.error) return null;
	try {
		const mod = (await importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))) as {
			default?: PluginFileHandlerModule;
		};
		return mod.default ?? null;
	} catch (err) {
		console.error(`[plugin:${p.id}] 客户端 bundle 加载失败:`, err);
		return null;
	}
}

async function loadOne(p: UiPluginInfo, epoch: number): Promise<boolean> {
	try {
		// @vite-ignore：URL 运行时才知道，Vite 不要试图打包它。
		// ?e=<epoch> 作为缓存击穿参数：服务端 reload 后 URL 变化，浏览器才会真正重新
		// 执行改过的 bundle。appUrl 补上应用根前缀：nginx 子路径反代（页面在 /pi/）时
		// 插件 bundle 必须请求 /pi/plugins/... 才能被转发规则命中。
		const mod = (await importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))) as {
			default?: PluginViewModule;
		};
		const m = mod.default;
		if (m && typeof m.mount === "function") {
			loaded.set(p.id, { info: p, module: m });
			return true;
		}
		// 无视图的常驻插件（manifest preload）：顶层代码已经跑完，这就是它的全部约定
		// —— 没有 mount 不算失败（它本来就没有 tab 可挂）。
		if (p.preload) {
			preloaded.add(p.id);
			return true;
		}
		failed.add(p.id);
		notifyFailed();
		console.error(`[plugin:${p.id}] entry.mjs 缺少 default.mount`);
		return false;
	} catch (err) {
		failed.add(p.id);
		notifyFailed();
		console.error(`[plugin:${p.id}] 客户端加载失败:`, err);
		return false;
	}
}

/**
 * 按需加载一个插件的 client bundle（顶栏动作可能来自一个还没被任何视图加载过的
 * 插件：view:false 的纯 renderer 插件、或用户从没点开过它的 tab）。
 * 同一 epoch 内加载失败过就直接返回 false（不重复报错、不无限重试）。
 */
export async function ensurePluginViewLoaded(p: UiPluginInfo, epoch: number): Promise<boolean> {
	if (loaded.has(p.id) || preloaded.has(p.id)) return true;
	if (failed.has(p.id) || !p.hasClient) return false;
	const ok = await loadOne(p, epoch);
	notify();
	return ok;
}

/**
 * 把目录清单里应显示的插件同步到注册表：
 * - epoch 变化（服务端 plugins_reload）→ 丢弃全部旧 bundle，用 ?e= 重拉
 * - 清单中消失/被禁用的插件 → 移除已加载视图（React 随之卸载并调 cleanup）
 * - 新出现且未失败过的 → 动态 import
 */
export async function syncPluginViews(plugins: UiPluginInfo[], epoch: number): Promise<void> {
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		loaded.clear();
		preloaded.clear();
		failed.clear();
		retrySalt.clear();
		notifyFailed();
	}
	// 清掉清单里不再存在的（被删目录 / 设置面板禁用 / 报错）——包括 failed 记录，
	// 让重新安装的同名插件可以再次尝试。
	const active = new Set(plugins.map((p) => p.id));
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...loaded.keys()]) {
		if (!active.has(id)) loaded.delete(id);
	}
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...preloaded]) {
		if (!active.has(id)) preloaded.delete(id);
	}
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...failed]) {
		if (!active.has(id)) failed.delete(id);
	}
	notifyFailed();
	await Promise.all(
		plugins
			// view:false 的纯 renderer 插件不进视图注册表——它们只在消息里命中
			// ```lang 围栏时才按需懒加载（见 plugin-fence.ts），避免打进主包。
			// 例外：manifest `preload: true` 的插件**每次进页都要跑顶层代码**（常驻浮窗、
			// 提醒轮询、快捷键…），即使它没有视图 tab 也在这里预加载。
			.filter(
				(p) =>
					p.hasClient &&
					(p.view !== false || p.preload) &&
					!p.error &&
					!loaded.has(p.id) &&
					!preloaded.has(p.id) &&
					!failed.has(p.id),
			)
			.map((p) => loadOne(p, epoch)),
	);
	notify();
}

/** 当前服务端重载纪元（顶栏动作按需加载插件 bundle 时要用同一个 ?e=）。 */
export function currentPluginEpoch(): number {
	return lastEpoch;
}

/** 组装传给插件 mount() 的上下文（send 由 App 注入真正的 ws 发送函数）。 */
export function makePluginContext(
	pluginId: string,
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void,
): PluginViewContext {
	return {
		pluginId,
		send: (payload) => send({ type: "plugin_message", pluginId, payload }),
		onData: (cb) =>
			subscribeAll((pid, payload) => {
				if (pid === pluginId) cb(payload);
			}),
	};
}
