/// <reference lib="dom" />
/**
 * 插件宿主动作桥（`window.__piWebUiHost`）。
 *
 * 插件的 client bundle 是运行时动态 import 的裸 ESM，**不能 import 应用内部模块**，
 * 但它有时需要主应用配合做动作（切视图、新建对话并把一段话作为用户消息发出去 ——
 * 例如 legado-web 插件的「AI 修复源」按钮）。这些动作走 window 上的单例：
 *
 *   window.__piWebUiHost = {
 *     version: 6,
 *     setView("chat" | "terminal" | "git" | `plugin:<id>`),
 *     startChat({ prompt, newChat?, cwd?, model? }) → boolean   // 已受理，动作在后台串行完成
 *     models.list() → PluginHostModelInfo[]           // 已配置的模型目录（issue #188）
 *     openSession({ cwd? | folders? | roots?, prompt?, newChat? }) → Promise<{ok, sessionId?, error?}>
 *     sessions: { list(), open(id) }                    // 会话列表 / 打开（宿主 API v2）
 *     compose({ text?, attachments? }) → boolean        // 放进输入框草稿，等用户自己发
 *     reloadCatalog(source, { install?, replace? }) → Promise<{ok, error?, entries?, installed?}>
 *     onUiAction(name, handler) → () => void            // 接管 UI 条目的动作（host.ui 框架）
 *     pageCall({ op, args?, target?, timeoutMs? }) → Promise<{ok, result?, error?}>
 *   }
 *
 * openSession 与 startChat 的差别：startChat 是「已受理」的短形式（向后兼容），
 * openSession 是它的可等待版本 —— 会做**目录授权**（不在最近项目里、也没授权过的
 * 目录先弹确认）、等 cwd/新对话真正就绪、回 sessionId，失败给结构化原因（issue #146）。
 * folders/roots 可给多个：第一个当 cwd，其余当**额外工作区根**（宿主侧多根：AI 仍只在
 * cwd 里干活，文件树与插件受支持路径可跨这些根），每个目录都要过授权确认这一关。
 *
 * reloadCatalog 是受支持的插件市场目录同步（issue #148）：不再依赖私有的浏览器事件
 * 与可见终端，服务端校验/原子写/可选安装后回执。
 *
 * pageCall 是「AI 操作页面」的通道：服务端把模型的动作（`page_request`）推过来，这里转给
 * **浏览器扩展**（page-picker 注入在页面主世界的 `window.__piBridge`），再把结果回给服务端。
 * 它不抛错，而是返回 `{ok:false,error}` —— 这个错误要原样写进工具结果里让模型看到。
 *
 * startChat 与 compose 是两条不同的路：前者“直接开一个新对话把话发出去”（脚本化），
 * 后者“把内容放进输入框草稿让用户补一句再发”（人在环中）—— 元素拾取这类需要用户
 * 补充描述的场景走 compose（见 composer-bridge.ts）。
 *
 * 时序坑：服务端的 `new_chat` 是异步的（`void cs.newChat()`），紧接着发 `prompt` 会落到
 * **旧对话**里（activeId 要等 runtime 建好才切）。所以这里串行等待：先等 cwd 切过去、
 * 再等对话变成空白（新对话就绪或本来就是空白对话），最后才发 prompt。
 *
 * 与 app-globals 的分工：那边放「状态 + 唯一的全局发送器」，这里放需要 React 侧
 * 注入实现（setView/chat 快照）的**跨边界动作**，两者都不吃快照流。
 */

import type { AppSend } from "./app-globals";
import { composeToComposer, isComposerReady, type ComposerPayload } from "./composer-bridge";
import { isDesktopShell } from "./desktop";
import type { UiPluginCatalogEntry } from "./types";
import { randomUuid } from "./uuid";

export const PLUGIN_HOST_GLOBAL = "__piWebUiHost";
/** 宿主 API 版本：插件可用它判断宿主能力（> 本值表示宿主更新）。
 *  2 = 新增 `compose()`（注入输入框草稿）。
 *  3 = 新增 `pageCall()`（把模型的动作转给浏览器扩展，见 plugin-host 注释）。
 *  4 = 新增 `reloadCatalog()`（市场目录同步，issue #148）、`openSession()`
 *      （带目录授权的新会话，issue #146）与 `onTopbarAction()`（顶栏动作接管）。
 *  5 = 顶栏动作升级为通用 UI 动作 `onUiAction()`（slot 框架：顶栏/底栏/输入框/
 *      消息/右键菜单/设置页都能接管），`onTopbarAction` 保留为别名。
 *  6 = 新增 `sessions.list()/open()`（会话列表与打开）与 `openSession()` 的多根
 *      工作区（folders/roots 多目录 = cwd + 额外工作区根，issue #146 完整版）。
 *  7 = 新增 `dom.anchors()`（特权 DOM 插件的稳定挂载点：app/topbar/composer，
 *      见 `data-pi-anchor`；bundle 本身与页同源，document 原生可用，anchors 只是
 *      跨版本稳定的查询入口）。
 *  8 = 新增 `dialogs`（select/confirm/input，见 PluginHostDeps 的 dialogConfirm/
 *      select/input 注入）+ `notifyAction`（带动作的轻量通知）+ `shortcuts`
 *      （内存快捷键注册表）+ `searchProviders`（全局搜索提供者注册表）+
 *      `onTheme/onLocale/onViewChange`（主题/语言/视图订阅，App 经 emit* 触发）。
 *  9 = 新增 `composerProviders`（`@` 提及提供者注册表：ChatInput 的 `@` 浮层
 *      与 `/` 选择器共用一个浮层，按 kind 换内容）。
 *  10 = 新增 `openModal/closeModal`（`modal.dialog` 槽位：插件把 kind="view" 的条目
 *      按需弹成弹窗，同一时刻只开一个；Esc/点遮罩/✕ 关闭）。
 *  11 = 新增 `models.list()`（已配置的模型目录，issue #188）与
 *      `startChat/openSession` 的 `model` 选项（canonical `provider/model`：
 *      newChat 时先建新对话再切到该模型，不动旧对话的模型；非法 id 直接拒绝）。 */
export const PLUGIN_HOST_API_VERSION = 11;

export interface PluginHostModelInfo {
	/** canonical 模型 id（`provider/model`，与 set_model 的 modelId 同口径）。 */
	id: string;
	provider: string;
	name?: string;
	vision?: boolean;
	reasoning?: boolean;
}

export interface PluginHostStartChatOptions {
	/** 要作为用户消息发出的文本（必填，空串直接拒绝）。 */
	prompt: string;
	/** 是否先新开一个对话，默认 true。 */
	newChat?: boolean;
	/** 新对话的工作目录（不给 = 不动；切目录失败时服务端会自己提示，流程继续）。 */
	cwd?: string;
	/** 新对话要用的模型（canonical `provider/model`，须在 models.list() 里；
	 *  非法 id 直接拒绝（startChat 回 false），不建对话、不动旧对话的模型。
	 *  newChat 时：先建新对话、再把**新对话**切到该模型（旧对话的模型不动）；
	 *  newChat=false 时：把当前对话切到该模型再发 prompt。不给 = 沿用当前行为。 */
	model?: string;
}

/** 注入输入框草稿的内容（见 composer-bridge.ts 的 ComposerPayload）。 */
export type PluginHostComposeOptions = ComposerPayload;

/** 打开一个「绑定到某个项目目录」的会话（issue #146）。 */
export interface PluginHostOpenSessionOptions {
	/** 新会话的工作目录（绝对路径）。与 folders/roots 二选一（同时给 = cwd 优先，
	 *  其余目录当作额外工作区根）。 */
	cwd?: string;
	/** 工作区目录列表（绝对路径）：第一个当 cwd，其余当**额外工作区根**（宿主侧多根）。 */
	folders?: string[];
	/** 额外工作区根（绝对路径，与 folders 同义；两个字段都给了就合并去重）。 */
	roots?: string[];
	/** 会话就绪后作为用户消息发出的文本（可选）。 */
	prompt?: string;
	/** 是否新开一个对话（默认 true；false = 在当前对话里切目录）。 */
	newChat?: boolean;
	/** 新对话要用的模型（canonical `provider/model`，须在 models.list() 里；
	 *  非法时整个 openSession 回 {ok:false}，不建对话、不动旧对话的模型）。 */
	model?: string;
}

/** 一个可供插件打开的会话（运行中的对话或历史会话）。 */
export interface PluginHostSessionInfo {
	/** 稳定 id：运行中的对话是 conversationId；历史会话是 session 文件路径。 */
	id: string;
	title: string;
	/** 该会话所属的工作目录（绝对路径）。 */
	cwd: string;
	/** "running" = 本客户端已打开的对话（switchConversation）；
	 *  "history" = 磁盘上的历史会话（switchSession）。 */
	kind: "running" | "history";
	/** 是否正在跑（运行中的对话才有意义）。 */
	isStreaming?: boolean;
}

/** 会话 API（host.sessions，宿主 API v2）：列表 + 打开。 */
export interface PluginHostSessionsApi {
	/** 可打开的会话列表（本客户端运行中的对话 + 当前项目的历史会话）。 */
	list(): PluginHostSessionInfo[];
	/** 打开一个会话（id 来自 list()）；与 openSession 同样带目录授权/切换等前置动作。 */
	open(id: string): Promise<PluginHostOpenSessionResult>;
}

/** `{ok:true, sessionId}` 或 `{ok:false, error}`（错误原文回给插件，可用于提示用户）。 */
export type PluginHostOpenSessionResult = { ok: true; sessionId?: string } | { ok: false; error: string };

/** 目录同步选项（host.reloadCatalog 的第二个参数）。 */
export interface PluginHostReloadCatalogOptions {
	/** 顺手把条目安装/更新一遍（已装 = 更新，未装 = 安装）。 */
	install?: boolean;
	/** 整体替换用户自定义列表（默认合并/按 id upsert）。 */
	replace?: boolean;
}

export type PluginHostReloadCatalogResult =
	| { ok: true; entries?: UiPluginCatalogEntry[]; installed?: { id: string; ok: boolean; error?: string }[] }
	| { ok: false; error: string };

/** 顶栏条目的点击处理器（插件注册；itemId = manifest 里声明的条目 id）。
 *  kind="select" 的切换回传第二个参数 value（选中的 options value）；其余 kind 只传 itemId。 */
export type PluginTopbarActionHandler = (
	itemId: string,
	value?: string,
	/** 右键菜单（contextmenu.*）点过来的目标：{ id: wire 路径, kind: file/dir/list…, label }；非菜单触发时缺席。 */
	target?: { id: string; kind?: string; label?: string },
) => void;

/** 特权 DOM 插件的稳定挂载点（`data-pi-anchor`，跨版本保持；宿主只保证这三个存在）。 */
export interface PluginHostDomAnchors {
	/** 应用根（挂全局浮层/样式用；position:fixed 定位相对视口即可，不必真挂这里）。 */
	app: Element | null;
	/** 顶栏容器。 */
	topbar: Element | null;
	/** 输入框容器。 */
	composer: Element | null;
}

/** 授权确认弹窗（宿主渲染；插件只拿到 Promise<boolean>）。 */
export interface PluginHostConfirmOptions {
	/** 插件想打开会话/访问的工作目录（绝对路径）。 */
	path: string;
}

/** 插件对话框的一个选项（host.dialogs.select 用，对齐扩展 ui.select）。 */
export interface PluginHostDialogSelectOption {
	label: string;
	description?: string;
}

/** host.dialogs.select 的入参。 */
export interface PluginHostDialogSelectOptions {
	title: string;
	options: PluginHostDialogSelectOption[];
	multi?: boolean;
}

/** host.dialogs.confirm 的入参。 */
export interface PluginHostDialogConfirmOptions {
	title: string;
	detail?: string;
}

/** host.dialogs.input 的入参。 */
export interface PluginHostDialogInputOptions {
	title: string;
	placeholder?: string;
	initial?: string;
}

/** notifyAction 上的一个动作按钮。resolve 时回的是用户点的 id。 */
export interface PluginHostNotifyActionItem {
	id: string;
	label: string;
}

/** host.notifyAction 的入参。 */
export interface PluginHostNotifyActionOptions {
	text: string;
	actions: PluginHostNotifyActionItem[];
}

/** 全局搜索的一条命中（host.searchProviders 注册的 provider 返回它）。 */
export interface PluginHostSearchResultItem {
	title: string;
	hint?: string;
	action: string;
}

/** 一个全局搜索提供者（id 全局唯一，同 id 后注册的覆盖前面的）。 */
export interface PluginHostSearchProvider {
	id: string;
	label: string;
	search: (q: string) => Promise<PluginHostSearchResultItem[]>;
}

/** searchProviders.list() 返回的轻量信息（不含 search 函数本身）。 */
export interface PluginHostSearchProviderInfo {
	id: string;
	label: string;
}

/** `@` 提及项可带的路径附件（点选后经宿主追加到输入框附件 chips）。 */
export interface PluginHostComposerAttachment {
	path: string;
	name?: string;
	mode?: "inline" | "reference" | "lines";
	lines?: { start: number; end: number };
}

/** `@` 提及的一条命中：选中后把 text 写进光标处并追加 attachments。 */
export interface PluginHostComposerHit {
	title: string;
	hint?: string;
	/** 写进输入框的文本（缺省 = title）。 */
	text?: string;
	attachments?: PluginHostComposerAttachment[];
}

/** 一个 `@` 提及提供者（id 全局唯一，同 id 后注册的覆盖前面的）。 */
export interface PluginHostComposerProvider {
	id: string;
	label: string;
	search: (q: string) => Promise<PluginHostComposerHit[]>;
}

/** composerProviders.list() 返回的轻量信息（不含 search 函数本身）。 */
export interface PluginHostComposerProviderInfo {
	id: string;
	label: string;
}

/** 主题/语言/视图变化的订阅回调。 */
export type PluginHostThemeHandler = (name: string) => void;
export type PluginHostLocaleHandler = (locale: string) => void;
export type PluginHostViewHandler = (view: string) => void;
/** 快捷键触发回调（无参；keydown 事件本身不透给插件）。 */
export type PluginHostShortcutHandler = () => void;

export interface PluginHostApi {
	version: number;
	/** 切主视图（"chat" | "terminal" | "git" | `plugin:<id>`）。 */
	setView(view: string): void;
	/** 新建对话（可选切工作目录 + 可选定模型）并把 prompt 作为用户消息发出去。
	 *  返回「已受理」；完整流程在后台串行完成（每步都有超时，超时也照发，不静默丢消息）。
	 *  model 非法时直接回 false（不建对话、不动旧对话的模型）。 */
	startChat(opts: PluginHostStartChatOptions): boolean;
	/** 已配置的模型目录（issue #188）：给插件做真实的模型选择器用。
	 *  id 是 canonical `provider/model`（与 startChat/openSession 的 model 同口径）。 */
	models: {
		list(): PluginHostModelInfo[];
		/** 当前对话选中的模型 id（canonical `provider/model`，如 "openai-codex/gpt-5"；未选/无为 null）。 */
		active(): string | null;
		/** 监听模型切换事件（切换成功时立即通知插件）。返回取消函数。 */
		onChange(handler: (modelId: string | null) => void): () => void;
	};
	/** 把内容放进**输入框草稿**（用户补一句话再自己发），返回是否受理。
	 *  与 startChat 的差别：不要求连接就绪（草稿是本地状态，断线也能先攒着），
	 *  但输入框还没挂载时返回 false；内容全空也返回 false。 */
	compose(opts: PluginHostComposeOptions): boolean;
	/** 打开一个绑定到指定项目目录的会话（可等待、带目录授权、回 sessionId）。
	 *  folders/roots 可给多个：第一个当 cwd，其余当额外工作区根（宿主侧多根）。 */
	openSession(opts: PluginHostOpenSessionOptions): Promise<PluginHostOpenSessionResult>;
	/** 会话列表 / 打开（宿主 API v2）。只给「本客户端现在能打开的东西」，不编造。 */
	sessions: PluginHostSessionsApi;
	/** 同步插件市场目录（受支持路径，service 端原子写 + 可选安装 + 重载）。 */
	reloadCatalog(source: string, options?: PluginHostReloadCatalogOptions): Promise<PluginHostReloadCatalogResult>;
	/** 接管 UI 条目的动作（manifest "ui" 里那条目声明的 `action`，或 host.ui.register
	 *  运行时注册的）：用户点击该条目时宿主回调到这里。返回取消注册函数。
	 *  建议 action 名带插件前缀（`<pluginId>:<name>`）避免撞名。 */
	onUiAction(name: string, handler: PluginTopbarActionHandler): () => void;
	/** 打开一个 `modal.dialog` 槽位的条目（全局 id `<pluginId>:<itemId>`；
	 *  不给 id 时打不开（返回 false），宿主不知道“是谁”在问。
	 *  被用户隐藏（布局页勾掉）的条目同样打不开 —— 用户的隐藏就是不想看见。
	 *  同一时刻只开一个：已开着时先关旧的再开新的，返回 true。 */
	openModal(id: string): boolean;
	/** 关掉当前打开的弹窗（没开着时同样返回 true，无害）。 */
	closeModal(): boolean;
	/** 旧名（= onUiAction）：最初只有顶栏动作时的写法，保留兼容。 */
	onTopbarAction(name: string, handler: PluginTopbarActionHandler): () => void;
	/** 让浏览器扩展操作**被授权的页面**（AI 操作页面的通道）。
	 *  永远 resolve：失败原因放在 `{ok:false,error}` 里回给模型，不抛给调用方。 */
	pageCall(opts: PluginHostPageCallOptions): Promise<PluginHostPageResult>;
	/** 特权 DOM 插件的稳定挂载点（需 manifest 声明 `dom` 能力并经用户授权；
	 *  未授权时 bundle 根本下发不下来（403），调到这里说明已授权）。 */
	dom: {
		anchors(): PluginHostDomAnchors;
	};
	/** 插件对话框（宿主 API v8：select/confirm/input）。
	 *  无注入 / 注入失败时静默回退（confirm 走 window.confirm，select/input
	 *  直接回 ok:false），绝不抛错、不挡旧流程。 */
	dialogs: {
		select(opts: PluginHostDialogSelectOptions): Promise<{ ok: boolean; selected?: string[]; error?: string }>;
		confirm(opts: PluginHostDialogConfirmOptions): Promise<boolean>;
		input(opts: PluginHostDialogInputOptions): Promise<{ ok: boolean; value?: string }>;
	};
	/** 带动作的轻量通知（宿主 API v8）：resolve 用户点的 action id；
	 *  无交互 / 无注入时 resolve null（未注入时先发一个 toast 回退信号）。 */
	notifyAction(opts: PluginHostNotifyActionOptions): Promise<string | null>;
	/** 键盘快捷键（宿主 API v8）：内存注册 + 全局 keydown。输入框聚焦时不触发
	 *  （防劫持打字）；key 形如 "ctrl+shift+k"（大小写不敏感）。返回取消函数。 */
	shortcuts: {
		register(shortcut: string, handler: PluginHostShortcutHandler): () => void;
	};
	/** 全局搜索提供者（宿主 API v8）：纯内存注册表。GlobalSearchModal 如需接入
	 *  可调 list() 枚举，本模块只管注册与列出。 */
	searchProviders: {
		register(provider: PluginHostSearchProvider): () => void;
		list(): PluginHostSearchProviderInfo[];
	};
	/** `@` 提及提供者（宿主 API v9）：纯内存注册表。ChatInput 的 `@` 浮层与
	 *  `/` 选择器共用一个浮层（kind 区分内容），本模块只管注册与列出。 */
	composerProviders: {
		register(provider: PluginHostComposerProvider): () => void;
		list(): PluginHostComposerProviderInfo[];
	};
	/** 主题 / 语言 / 视图变化订阅（宿主 API v8）：App 侧经 emitPluginHostTheme /
	 *  emitPluginHostLocale / emitPluginHostView 触发，这里只做订阅与分发。 */
	onTheme(handler: PluginHostThemeHandler): () => void;
	onLocale(handler: PluginHostLocaleHandler): () => void;
	onViewChange(handler: PluginHostViewHandler): () => void;
}

/** 模型想执行的一个页面动作（op 词表在扩展侧，服务端只透传）。 */
export interface PluginHostPageCallOptions {
	op: string;
	args?: Record<string, unknown>;
	/** 目标页面 origin（有多个已授权页面时必填）。 */
	target?: string;
	timeoutMs?: number;
}

/** `{ok:true,result}` 或 `{ok:false,error}` —— 后者会变成模型看到的失败原因。 */
export type PluginHostPageResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** 扩展注入到页面主世界的桥（只用到 call 这一个方法）。 */
interface PageBridgeLike {
	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

export interface PluginHostDeps {
	/** 全局发送器（app-globals 的 appSend）。 */
	send: AppSend;
	/** 连接是否可用（WS 开着 + 已有快照）。false 时 startChat 直接拒绝。 */
	isReady: () => boolean;
	setView: (view: string) => void;
	/** 当前工作目录（快照里的）。 */
	getCwd: () => string;
	/** 当前项目的额外工作区根（快照里的；空数组 = 单根）。 */
	getWorkspaceRoots: () => string[];
	/** 已配置的模型目录（快照外的 models 状态；缺省 = 空目录，model 选项一律拒绝）。 */
	listModels?: () => PluginHostModelInfo[];
	/** 当前对话的模型 id（canonical `provider/model`；快照里的 state.model.id）。 */
	getCurrentModelId?: () => string | null;
	/** 可打开的会话（host.sessions.list）：本客户端运行中的对话 + 当前项目历史会话。 */
	listSessions: () => PluginHostSessionInfo[];
	/** 当前活动对话 id（还没快照时为 null）。 */
	getConversationId: () => string | null;
	/** 当前对话是否还是空白（没有消息 = 它就是「新对话」，new_chat 不会换 id）。 */
	isConversationBlank: () => boolean;
	/** 轮询间隔 / 单步超时（测试可调小）。 */
	pollMs?: number;
	timeoutMs?: number;
	/** 等扩展注入页面桥的窗口（默认 3000ms；测试调小，免得为了一个「没插桥」的分支等三秒）。 */
	bridgeWaitMs?: number;
	/** 用户「最近项目」列表：已在其中的目录视为用户已知，开会话时不再弹授权确认。 */
	listProjects?: () => string[];
	/** 本浏览器已授权给插件的目录（localStorage 持久化）。 */
	grantedPaths?: () => string[];
	/** 记录一次目录授权。 */
	grantPath?: (path: string) => void;
	/** 请用户确认「插件想在这个目录开会话」（宿主渲染弹窗）。缺省 = 拒绝。 */
	confirm?: (opts: PluginHostConfirmOptions) => Promise<boolean>;
	/** 插件确认框的宿主实现（dialogs.confirm 用；缺省走 window.confirm 回退）。
	 *  注：`confirm` 这个名字已被上面的目录授权占用，故确认框的注入叫
	 *  `dialogConfirm`；三者（dialogConfirm/select/input）都绝不抛错。 */
	dialogConfirm?: (opts: PluginHostDialogConfirmOptions) => Promise<boolean>;
	/** 插件选择框的宿主实现（dialogs.select 用；缺省直接回 ok:false）。 */
	select?: (opts: PluginHostDialogSelectOptions) => Promise<{ ok: boolean; selected?: string[]; error?: string }>;
	/** 插件输入框的宿主实现（dialogs.input 用；缺省直接回 ok:false）。 */
	input?: (opts: PluginHostDialogInputOptions) => Promise<{ ok: boolean; value?: string }>;
	/** 带动作通知的宿主实现（notifyAction 用；未注入时回退为 toast 信号并 resolve null）。 */
	notifyAction?: (opts: PluginHostNotifyActionOptions) => Promise<string | null>;
	/** 按需加载某插件的客户端 bundle（顶栏动作可能来自还没加载过的插件）。 */
	loadPluginBundle?: (pluginId: string) => Promise<boolean>;
	/** 打开一个 `modal.dialog` 槽位的条目（全局 id `plugin:item`；缺省/非法/被隐藏返回 false）。 */
	openModal?: (id: string) => boolean;
	/** 关掉当前打开的弹窗（没开着也无害）。 */
	closeModal?: () => void;
	/** 目录同步的等待超时（默认 180s —— 带 install 的同步会跑真实安装）。 */
	catalogTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等扩展把页面桥装上（MAIN world 注入是异步的，页面刚加载时可能还没有）。
 *
 * 为什么不一口气等很久：桥不在通常意味着**扩展没装 / 没启用 / 本页地址没绑**，那是配置问题，
 * 等再久也不会变好。给一个短窗口（默认 3s）盖住「刚刷新完」这一种情况即可。 */
async function waitForPageBridge(timeoutMs = 3000): Promise<PageBridgeLike | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const bridge = (window as unknown as { __piBridge?: PageBridgeLike }).__piBridge;
		if (bridge && typeof bridge.call === "function") return bridge;
		if (Date.now() >= deadline) return null;
		await sleep(100);
	}
}

export function createPluginHostApi(deps: PluginHostDeps): PluginHostApi {
	const pollMs = Math.max(1, Number(deps.pollMs ?? 100));
	const timeoutMs = Math.max(pollMs, Number(deps.timeoutMs ?? 8000));

	/** 轮询等条件成立；超时返回 false（调用方继续，不静默放弃）。 */
	const waitFor = async (ok: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (ok()) return true;
			if (Date.now() >= deadline) return ok();
			await sleep(pollMs);
		}
	};

	const listModels = (): PluginHostModelInfo[] => {
		try {
			const raw = deps.listModels?.() ?? [];
			return Array.isArray(raw) ? [...raw] : [];
		} catch {
			return [];
		}
	};

	/** model 是否在已配置目录里（空串 = 没给，不校验）。 */
	const isKnownModel = (model: string): boolean => {
		if (!model) return true;
		try {
			return listModels().some((m) => m && m.id === model);
		} catch {
			return false;
		}
	};

	/** 把当前（新）对话切到指定模型：发 set_model 后等快照里的 model.id 落定。
	 *  超时也继续（不静默丢 prompt，与 cwd/new_chat 同哲学）。 */
	const applyModel = async (model: string): Promise<void> => {
		if (!model) return;
		deps.send({ type: "set_model", modelId: model });
		if (typeof deps.getCurrentModelId === "function") {
			await waitFor(() => deps.getCurrentModelId?.() === model);
		}
	};

	const run = async (prompt: string, opts: PluginHostStartChatOptions): Promise<void> => {
		const cwd = String(opts.cwd ?? "").trim();
		if (cwd && deps.getCwd() !== cwd) {
			deps.send({ type: "set_cwd", path: cwd });
			await waitFor(() => deps.getCwd() === cwd);
		}
		if (opts.newChat !== false) {
			const before = deps.getConversationId();
			deps.send({ type: "new_chat" });
			// 新对话换上（id 变）/ 本来就是空白对话，两者都算就绪
			await waitFor(() => deps.getConversationId() !== before || deps.isConversationBlank());
		}
		const model = String(opts.model ?? "").trim();
		if (model) await applyModel(model);
		deps.send({ type: "prompt", text: prompt });
	};

	return {
		version: PLUGIN_HOST_API_VERSION,
		setView(view) {
			const v = String(view ?? "").trim();
			if (v) deps.setView(v);
		},
		startChat(opts) {
			const prompt = String(opts?.prompt ?? "").trim();
			if (!prompt) return false;
			if (!deps.isReady()) return false;
			const model = String(opts?.model ?? "").trim();
			// 非法模型直接拒绝：不发任何消息，不建对话、不动旧对话的模型。
			if (model && !isKnownModel(model)) return false;
			void run(prompt, opts ?? { prompt }).catch(() => {
				/* 发送失败已有各自的上层提示，这里不抛到调用方 */
			});
			return true;
		},
		models: {
			list: () => listModels(),
			active: () => deps.getCurrentModelId?.() ?? null,
			onChange: (handler: (modelId: string | null) => void) => onModelChange(handler),
		},
		compose(opts) {
			if (!isComposerReady()) return false;
			return composeToComposer({
				text: typeof opts?.text === "string" ? opts.text : undefined,
				attachments: Array.isArray(opts?.attachments) ? opts.attachments : undefined,
			});
		},
		openModal(id) {
			const target = String(id ?? "").trim();
			if (!target || typeof deps.openModal !== "function") return false;
			try {
				return deps.openModal(target);
			} catch {
				return false;
			}
		},
		closeModal() {
			if (typeof deps.closeModal !== "function") return true;
			try {
				deps.closeModal();
			} catch {
				/* 关弹窗失败不抛到插件，幂等语义：调了就当关了 */
			}
			return true;
		},
		async openSession(opts) {
			const folders = Array.isArray(opts?.folders)
				? opts.folders.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
				: [];
			const extra = Array.isArray(opts?.roots)
				? opts.roots.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
				: [];
			// cwd 优先；没给就用 folders/roots 的第一个。剩下的目录当**额外工作区根**
			// （宿主侧多根：AI 仍只在 cwd 里干活，文件树/插件受支持路径可跨这些根）。
			const explicit = String(opts?.cwd ?? "").trim();
			const all = [...new Set([...folders, ...extra])];
			const target = explicit || all[0] || "";
			if (!target) return { ok: false, error: "openSession 需要 cwd / folders / roots（绝对路径）" };
			if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
			const roots = all.filter((p) => p !== target).slice(0, 7);
			// 目录授权（issue #146 的硬性要求）：最近项目里的 = 用户自己用过的，
			// 已授权过的（localStorage）= 以前确认过；其余都要用户当场点头。
			// **额外根也要过这一关** —— 成了工作区根就意味着插件阅读它们不必再授权，
			// 不能让插件拿 roots 当侧门。
			const known = new Set([...(deps.listProjects?.() ?? []), ...(deps.grantedPaths?.() ?? [])]);
			for (const p of [target, ...roots]) {
				if (known.has(p)) continue;
				const approved = deps.confirm ? await deps.confirm({ path: p }).catch(() => false) : false;
				if (!approved) return { ok: false, error: `用户拒绝了该目录的访问：${p}` };
				deps.grantPath?.(p);
			}
			if (deps.getCwd() !== target) {
				deps.send({ type: "set_cwd", path: target });
				const arrived = await waitFor(() => deps.getCwd() === target);
				if (!arrived) return { ok: false, error: `切换工作目录失败或超时：${target}` };
			}
			// 根在切项目**之后**写（服务端按项目存根，切 cwd 会换成目标项目自己那套）。
			if (roots.length > 0 || deps.getWorkspaceRoots().length > 0) {
				deps.send({ type: "set_workspace_roots", roots });
			}
			let sessionId = deps.getConversationId() ?? undefined;
			if (opts?.newChat !== false) {
				const before = sessionId;
				deps.send({ type: "new_chat" });
				await waitFor(() => deps.getConversationId() !== before || deps.isConversationBlank());
				sessionId = deps.getConversationId() ?? undefined;
			}
			const model = String(opts?.model ?? "").trim();
			if (model) {
				if (!isKnownModel(model)) return { ok: false, error: `未知模型：${model}（先调 models.list() 取可用列表）` };
				await applyModel(model);
				sessionId = deps.getConversationId() ?? sessionId;
			}
			const prompt = String(opts?.prompt ?? "").trim();
			if (prompt) deps.send({ type: "prompt", text: prompt });
			return { ok: true, ...(sessionId ? { sessionId } : {}) };
		},
		sessions: {
			list: () => deps.listSessions(),
			async open(id) {
				const targetId = String(id ?? "").trim();
				if (!targetId) return { ok: false, error: "sessions.open 需要一个会话 id（先调 list）" };
				if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
				const info = deps.listSessions().find((s) => s.id === targetId);
				if (!info) return { ok: false, error: `找不到会话：${targetId}` };
				// 跨项目的历史会话：先切工作目录（服务端的 session 列表是按 cwd 扫的），
				// 否则 switch_session 找不到目标文件。跑着的对话自带 cwd，切它就会连带切项目。
				if (info.cwd && info.cwd !== deps.getCwd()) {
					const known = new Set([...(deps.listProjects?.() ?? []), ...(deps.grantedPaths?.() ?? [])]);
					if (!known.has(info.cwd)) {
						const approved = deps.confirm ? await deps.confirm({ path: info.cwd }).catch(() => false) : false;
						if (!approved) return { ok: false, error: `用户拒绝了该目录的访问：${info.cwd}` };
						deps.grantPath?.(info.cwd);
					}
					deps.send({ type: "set_cwd", path: info.cwd });
					const arrived = await waitFor(() => deps.getCwd() === info.cwd);
					if (!arrived) return { ok: false, error: `切换工作目录失败或超时：${info.cwd}` };
				}
				const before = deps.getConversationId();
				if (info.kind === "running") deps.send({ type: "switch_conversation", id: info.id });
				else deps.send({ type: "switch_session", path: info.id });
				const switched = await waitFor(() => deps.getConversationId() !== before);
				if (!switched) return { ok: false, error: `切换会话超时：${info.title}` };
				return { ok: true, sessionId: deps.getConversationId() ?? undefined };
			},
		},
		async reloadCatalog(source, options) {
			const src = String(source ?? "").trim();
			if (!src) return { ok: false, error: "reloadCatalog 需要一个目录来源（http(s) URL 或本地文件路径）" };
			if (!deps.isReady()) return { ok: false, error: "尚未连接到服务器（还没有快照）" };
			const requestId = randomUuid();
			return new Promise<PluginHostReloadCatalogResult>((resolve) => {
				const timer = setTimeout(
					() => {
						pendingCatalogSync.delete(requestId);
						resolve({ ok: false, error: "目录同步超时（服务端未在等待窗口内回执）" });
					},
					Math.max(1000, Number(deps.catalogTimeoutMs ?? 180_000)),
				);
				pendingCatalogSync.set(requestId, (result) => {
					clearTimeout(timer);
					resolve(result);
				});
				deps.send({
					type: "plugin_catalog_sync",
					requestId,
					source: src,
					...(options?.install ? { install: true } : {}),
					...(options?.replace ? { replace: true } : {}),
				});
			});
		},
		onUiAction(name, handler) {
			return registerPluginTopbarAction(pluginScope, String(name ?? "").trim(), handler);
		},
		onTopbarAction(name, handler) {
			return registerPluginTopbarAction(pluginScope, String(name ?? "").trim(), handler);
		},
		async pageCall(opts) {
			const op = String(opts?.op ?? "").trim();
			if (!op) return { ok: false, error: "pageCall 需要一个动作名（op）" };
			// 桌面壳里没有 Chrome 扩展运行时，window.__piBridge 永远不会出现 ——
			// 别让模型干等 3 秒桥超时，直接告诉它换路（改用网页版）。
			if (isDesktopShell()) {
				return {
					ok: false,
					error:
						"桌面版（Electron 外壳）不支持 browser_page：窗口里没有 Chrome 扩展运行时。请让用户改用系统浏览器打开同一个 pi-web-ui 地址（网页版）再试。/ The desktop app cannot run browser_page (no Chrome extension runtime); ask the user to open the same pi-web-ui address in a regular browser instead.",
				};
			}
			const bridge = await waitForPageBridge(deps.bridgeWaitMs ?? 3000);
			if (!bridge) {
				return {
					ok: false,
					error: "浏览器扩展的页面桥没就绪：确认已安装并启用 page-picker 扩展、本页地址已绑定，然后刷新本页",
				};
			}
			try {
				const result = await bridge.call({
					op,
					...(opts.args === undefined ? {} : { args: opts.args }),
					...(opts.target ? { to: opts.target } : {}),
					...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
				});
				return result === undefined ? { ok: true } : { ok: true, result };
			} catch (err) {
				// 桥把对端/准入的失败原因包在 Error.message 里（见扩展的 bridge-page.ts）
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
		dom: {
			anchors() {
				const q = (name: string): Element | null => {
					try {
						return document.querySelector(`[data-pi-anchor="${name}"]`);
					} catch {
						return null;
					}
				};
				return { app: q("app"), topbar: q("topbar"), composer: q("composer") };
			},
		},
		dialogs: {
			async select(opts) {
				try {
					const inject = deps.select;
					if (typeof inject !== "function") return { ok: false };
					const rawOptions = Array.isArray(opts?.options) ? opts.options : [];
					const res = await inject({
						title: String(opts?.title ?? ""),
						options: rawOptions
							.filter(
								(o: unknown): o is PluginHostDialogSelectOption =>
									typeof o === "object" && o !== null && typeof (o as { label?: unknown }).label === "string",
							)
							.map((o) => ({
								label: String(o.label),
								...(typeof o.description === "string" ? { description: o.description } : {}),
							})),
						...(opts?.multi ? { multi: true } : {}),
					});
					if (!res || typeof res !== "object" || res.ok !== true) {
						const error =
							res && typeof res === "object" && typeof (res as { error?: unknown }).error === "string"
								? { error: (res as { error: string }).error }
								: {};
						return { ok: false, ...error };
					}
					const selected = Array.isArray(res.selected)
						? res.selected.filter((s): s is string => typeof s === "string")
						: [];
					return { ok: true, selected };
				} catch {
					return { ok: false };
				}
			},
			async confirm(opts) {
				const title = String(opts?.title ?? "");
				const detail = typeof opts?.detail === "string" ? opts.detail : "";
				try {
					if (typeof deps.dialogConfirm === "function") {
						try {
							return (await deps.dialogConfirm({ title, ...(detail ? { detail } : {}) })) === true;
						} catch {
							/* 注入失败 → 回退 window.confirm */
						}
					}
					if (typeof window !== "undefined" && typeof window.confirm === "function") {
						try {
							return window.confirm(detail ? `${title}\n\n${detail}` : title);
						} catch {
							return false;
						}
					}
					return false;
				} catch {
					return false;
				}
			},
			async input(opts) {
				try {
					const inject = deps.input;
					if (typeof inject !== "function") return { ok: false };
					const res = await inject({
						title: String(opts?.title ?? ""),
						...(typeof opts?.placeholder === "string" ? { placeholder: opts.placeholder } : {}),
						...(typeof opts?.initial === "string" ? { initial: opts.initial } : {}),
					});
					if (!res || typeof res !== "object" || res.ok !== true) return { ok: false };
					return typeof res.value === "string" ? { ok: true, value: res.value } : { ok: true };
				} catch {
					return { ok: false };
				}
			},
		},
		async notifyAction(opts) {
			const text = String(opts?.text ?? "");
			const actions = (Array.isArray(opts?.actions) ? opts.actions : []).filter(
				(a): a is PluginHostNotifyActionItem =>
					typeof a === "object" &&
					a !== null &&
					typeof (a as { id?: unknown }).id === "string" &&
					typeof (a as { label?: unknown }).label === "string",
			);
			try {
				if (typeof deps.notifyAction === "function") {
					const picked = await deps.notifyAction({ text, actions });
					return typeof picked === "string" ? picked : null;
				}
			} catch {
				return null;
			}
			// 未注入：发一个 toast 回退信号（App 后续可监听并转成真正的 toast），再 resolve null。
			try {
				if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
					window.dispatchEvent(new CustomEvent(PLUGIN_TOAST_EVENT, { detail: { text } }));
				}
			} catch {
				/* 非浏览器/事件不可用：静默跳过 */
			}
			return null;
		},
		shortcuts: {
			register: (shortcut, handler) => registerPluginShortcut(String(shortcut ?? ""), handler),
		},
		searchProviders: {
			register: (provider) => registerPluginSearchProvider(provider),
			list: () => listPluginSearchProviders(),
		},
		composerProviders: {
			register: (provider) => registerPluginComposerProvider(provider),
			list: () => listPluginComposerProviders(),
		},
		onTheme: (handler) => subscribePluginHostTheme(handler),
		onLocale: (handler) => subscribePluginHostLocale(handler),
		onViewChange: (handler) => subscribePluginHostView(handler),
	};
}

/** 装上 / 卸下宿主 API（App 挂载时装，卸载时传 null 摘掉）。 */
export function installPluginHostApi(api: PluginHostApi | null): void {
	try {
		const w = window as unknown as Record<string, unknown>;
		if (api) w[PLUGIN_HOST_GLOBAL] = api;
		else delete w[PLUGIN_HOST_GLOBAL];
	} catch {
		/* 非浏览器环境（单测）忽略 */
	}
}

/* -------------------------------------------------------------------------- */
/* 顶栏动作注册表（issue #146）                                                */
/* -------------------------------------------------------------------------- */

/** 插件的顶栏动作处理器：key = `${pluginId}:${action}`。 */
const topbarHandlers = new Map<string, Set<PluginTopbarActionHandler>>();

/** 当前「正在加载/挂载」的插件 id：这段时间里插件调 onTopbarAction 就绑到它名下。
 *  App 懒加载插件 bundle 时用 withPluginScopeAsync 括住，插件的模块顶层代码即可注册。 */
let pluginScope: string | null = null;

/** 在指定插件作用域里同步执行一段代码（挂载插件视图时用），异常原样抛出。 */
export function withPluginScope<T>(pluginId: string | null, fn: () => T): T {
	const prev = pluginScope;
	pluginScope = pluginId;
	try {
		return fn();
	} finally {
		pluginScope = prev;
	}
}

/** 异步版：等待 fn（通常是 `await import(bundle)`）期间保持作用域。 */
export async function withPluginScopeAsync<T>(pluginId: string | null, fn: () => Promise<T>): Promise<T> {
	const prev = pluginScope;
	pluginScope = pluginId;
	try {
		return await fn();
	} finally {
		pluginScope = prev;
	}
}

/** 注册一个顶栏动作处理器（pluginId 为 null = 全局注册）。返回取消注册函数。 */
function registerPluginTopbarAction(
	pluginId: string | null,
	name: string,
	handler: PluginTopbarActionHandler,
): () => void {
	if (!name || typeof handler !== "function") return () => {};
	const key = pluginId ? `${pluginId}:${name}` : name;
	let set = topbarHandlers.get(key);
	if (!set) {
		set = new Set();
		topbarHandlers.set(key, set);
	}
	const bucket = set;
	bucket.add(handler);
	return () => {
		bucket.delete(handler);
		if (bucket.size === 0) topbarHandlers.delete(key);
	};
}

/** 旧名别名（issue #146 早期只有顶栏动作）。 */
export const triggerPluginTopbarAction = triggerPluginUiAction;

/** 触发一个 UI 动作：先找该插件名下的处理器，再找全局同名；都没有时按需加载
 *  插件的客户端 bundle（顶栏按钮可能来自一个还没被任何视图加载过的插件）后再试。
 *  返回是否真的调到了处理器（false = 插件没接管这个动作，宿主应给个提示）。 */
export async function triggerPluginUiAction(
	pluginId: string,
	action: string,
	itemId: string,
	opts?: {
		loadBundle?: (pluginId: string) => Promise<boolean>;
		waitMs?: number;
		value?: string;
		target?: { id: string; kind?: string; label?: string };
	},
): Promise<boolean> {
	const fire = (key: string): boolean => {
		const set = topbarHandlers.get(key);
		if (!set || set.size === 0) return false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot：handler 可能在回调里注销自己
		for (const h of [...set]) {
			try {
				h(itemId, opts?.value, opts?.target);
			} catch (err) {
				console.error(`[plugin:${pluginId}] 顶栏动作 ${action} 抛错:`, err);
			}
		}
		return true;
	};
	if (fire(`${pluginId}:${action}`) || fire(action)) return true;
	if (opts?.loadBundle) {
		const ok = await opts.loadBundle(pluginId).catch(() => false);
		if (ok) {
			const deadline = Date.now() + Math.max(100, Number(opts.waitMs ?? 1500));
			for (;;) {
				if (fire(`${pluginId}:${action}`) || fire(action)) return true;
				if (Date.now() >= deadline) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}
	return false;
}

/* -------------------------------------------------------------------------- */
/* 宿主 API v8：notifyAction 回退信号 / 快捷键 / 搜索提供者 / 主题订阅          */
/* -------------------------------------------------------------------------- */

/** notifyAction 未注入时的回退信号（App 后续可监听并转成真正的 toast；当前只求不抛错）。 */
export const PLUGIN_TOAST_EVENT = "pi-web-ui:toast";

/* ---- 快捷键（内存注册表 + 全局 keydown） ---- */

const shortcutHandlers = new Map<string, Set<PluginHostShortcutHandler>>();
let shortcutListenerOn = false;

/** 解析 "ctrl+shift+k"（大小写不敏感；修饰键固定顺序拼成规范形）。非法直接回 null。 */
function parseShortcut(
	raw: string,
): { combo: string; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } | null {
	const parts = raw
		.split("+")
		.map((p) => p.trim().toLowerCase())
		.filter((p) => p.length > 0);
	if (parts.length === 0) return null;
	let ctrl = false;
	let shift = false;
	let alt = false;
	let meta = false;
	for (const p of parts.slice(0, -1)) {
		if (p === "ctrl" || p === "control") ctrl = true;
		else if (p === "shift") shift = true;
		else if (p === "alt" || p === "option") alt = true;
		else if (p === "meta" || p === "cmd" || p === "command" || p === "win" || p === "super") meta = true;
		else return null; // 未知修饰键：拒绝注册，不断言
	}
	const key = parts[parts.length - 1] ?? "";
	if (!key || ["ctrl", "control", "shift", "alt", "option", "meta", "cmd", "command", "win", "super"].includes(key)) {
		return null; // 光有修饰键、没有主键：拒绝注册
	}
	const combo = `${ctrl ? "ctrl+" : ""}${shift ? "shift+" : ""}${alt ? "alt+" : ""}${meta ? "meta+" : ""}${key}`;
	return { combo, key, ctrl, shift, alt, meta };
}

/** 当前焦点是否在输入框里（是 = 快捷键让路，防劫持打字）。 */
function isTypingFocus(): boolean {
	try {
		if (typeof document === "undefined") return false;
		const el = document.activeElement as HTMLElement | null;
		if (!el) return false;
		const tag = (el.tagName || "").toUpperCase();
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		if (el.isContentEditable) return true;
		return false;
	} catch {
		return false;
	}
}

function onShortcutKeyDown(e: KeyboardEvent): void {
	try {
		if (isTypingFocus()) return;
		const combo = `${e.ctrlKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}${e.altKey ? "alt+" : ""}${e.metaKey ? "meta+" : ""}${(e.key ?? "").toLowerCase()}`;
		const set = shortcutHandlers.get(combo);
		if (!set || set.size === 0) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot：handler 可能在回调里注销自己
		for (const h of [...set]) {
			try {
				h();
			} catch (err) {
				console.error("[plugin-host] 快捷键处理器抛错:", err);
			}
		}
	} catch {
		/* 绝不把异常漏到页面的按键链里 */
	}
}

function ensureShortcutListener(): void {
	if (shortcutListenerOn) return;
	try {
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		window.addEventListener("keydown", onShortcutKeyDown as EventListener);
		shortcutListenerOn = true;
	} catch {
		/* 非浏览器环境：保持未安装状态，注册照收、只是永远不触发 */
	}
}

function maybeDropShortcutListener(): void {
	if (shortcutHandlers.size > 0 || !shortcutListenerOn) return;
	try {
		window.removeEventListener("keydown", onShortcutKeyDown as EventListener);
	} catch {
		/* 忽略 */
	} finally {
		shortcutListenerOn = false;
	}
}

/** 注册一个全局快捷键（key 形如 "ctrl+shift+k"，大小写不敏感）。返回取消函数。 */
export function registerPluginShortcut(shortcut: string, handler: PluginHostShortcutHandler): () => void {
	if (typeof handler !== "function") return () => {};
	const parsed = parseShortcut(shortcut);
	if (!parsed) return () => {};
	let set = shortcutHandlers.get(parsed.combo);
	if (!set) {
		set = new Set();
		shortcutHandlers.set(parsed.combo, set);
	}
	const bucket = set;
	bucket.add(handler);
	ensureShortcutListener();
	return () => {
		bucket.delete(handler);
		if (bucket.size === 0) shortcutHandlers.delete(parsed.combo);
		maybeDropShortcutListener();
	};
}

/* ---- 全局搜索提供者（纯内存注册表） ---- */

const searchProviderRegistry = new Map<string, PluginHostSearchProvider>();

/** 注册一个搜索提供者（同 id 后注册的覆盖前面的）。返回取消函数。 */
export function registerPluginSearchProvider(provider: PluginHostSearchProvider): () => void {
	const id = String(provider?.id ?? "").trim();
	if (!id || typeof provider?.search !== "function") return () => {};
	const stored: PluginHostSearchProvider = { id, label: String(provider.label ?? id), search: provider.search };
	searchProviderRegistry.set(id, stored);
	return () => {
		if (searchProviderRegistry.get(id) === stored) searchProviderRegistry.delete(id);
	};
}

/** 列出已注册的搜索提供者（轻量信息；GlobalSearchModal 如需接入调这里）。 */
export function listPluginSearchProviders(): PluginHostSearchProviderInfo[] {
	return [...searchProviderRegistry.values()].map((p) => ({ id: p.id, label: p.label }));
}

/* ---- `@` 提及提供者（纯内存注册表，与 searchProviders 同口径） ---- */

const composerProviderRegistry = new Map<string, PluginHostComposerProvider>();

/** 注册一个 `@` 提及提供者（同 id 后注册的覆盖前面的）。返回取消函数。 */
export function registerPluginComposerProvider(provider: PluginHostComposerProvider): () => void {
	const id = String(provider?.id ?? "").trim();
	if (!id || typeof provider?.search !== "function") return () => {};
	const stored: PluginHostComposerProvider = { id, label: String(provider.label ?? id), search: provider.search };
	composerProviderRegistry.set(id, stored);
	return () => {
		if (composerProviderRegistry.get(id) === stored) composerProviderRegistry.delete(id);
	};
}

/** 列出已注册的 `@` 提及提供者（轻量信息；ChatInput 的 `@` 浮层调这里枚举）。 */
export function listPluginComposerProviders(): PluginHostComposerProviderInfo[] {
	return [...composerProviderRegistry.values()].map((p) => ({ id: p.id, label: p.label }));
}

/** 取一个 `@` 提及提供者的完整定义（含 search 函数；ChatInput 调 search 用）。 */
export function getPluginComposerProvider(id: string): PluginHostComposerProvider | undefined {
	return composerProviderRegistry.get(String(id ?? ""));
}

/** 取一个提供者的完整定义（含 search 函数；GlobalSearchModal 调 search 用）。 */
export function getPluginSearchProvider(id: string): PluginHostSearchProvider | undefined {
	return searchProviderRegistry.get(String(id ?? ""));
}

/* ---- 主题 / 语言 / 视图订阅（简单集合 + 触发器） ---- */

const themeListeners = new Set<PluginHostThemeHandler>();
const localeListeners = new Set<PluginHostLocaleHandler>();
const viewListeners = new Set<PluginHostViewHandler>();
const modelListeners = new Set<(modelId: string | null) => void>();

export function onModelChange(handler: (modelId: string | null) => void): () => void {
	modelListeners.add(handler);
	return () => {
		modelListeners.delete(handler);
	};
}

/** 触发模型变更订阅（供 App 在模型切换后调用）。 */
export function emitPluginHostModel(modelId: string | null): void {
	// Snapshot subscriptions: handlers may subscribe or unsubscribe during dispatch.
	const handlers = [...modelListeners];
	for (const h of handlers) {
		try {
			h(modelId);
		} catch (err) {
			console.error("[plugin-host] onModelChange 处理器抛错:", err);
		}
	}
}

/** 订阅主题变化（返回取消函数；非函数直接回空函数，不抛错）。 */
export function subscribePluginHostTheme(handler: PluginHostThemeHandler): () => void {
	if (typeof handler !== "function") return () => {};
	themeListeners.add(handler);
	return () => {
		themeListeners.delete(handler);
	};
}

/** 订阅语言变化（返回取消函数）。 */
export function subscribePluginHostLocale(handler: PluginHostLocaleHandler): () => void {
	if (typeof handler !== "function") return () => {};
	localeListeners.add(handler);
	return () => {
		localeListeners.delete(handler);
	};
}

/** 订阅视图变化（返回取消函数）。 */
export function subscribePluginHostView(handler: PluginHostViewHandler): () => void {
	if (typeof handler !== "function") return () => {};
	viewListeners.add(handler);
	return () => {
		viewListeners.delete(handler);
	};
}

/** 触发主题订阅（供 App 在主题切换后调用；单个 handler 抛错不影响其余）。 */
export function emitPluginHostTheme(name: string): void {
	const n = String(name ?? "");
	// Snapshot subscriptions: handlers may subscribe or unsubscribe during dispatch.
	const handlers = [...themeListeners];
	for (const h of handlers) {
		try {
			h(n);
		} catch (err) {
			console.error("[plugin-host] onTheme 处理器抛错:", err);
		}
	}
}

/** 触发语言订阅（供 App 在语言切换后调用）。 */
export function emitPluginHostLocale(locale: string): void {
	const l = String(locale ?? "");
	// Snapshot subscriptions: handlers may subscribe or unsubscribe during dispatch.
	const handlers = [...localeListeners];
	for (const h of handlers) {
		try {
			h(l);
		} catch (err) {
			console.error("[plugin-host] onLocale 处理器抛错:", err);
		}
	}
}

/** 触发视图订阅（供 App 在切视图后调用）。 */
export function emitPluginHostView(view: string): void {
	const v = String(view ?? "");
	// Snapshot subscriptions: handlers may subscribe or unsubscribe during dispatch.
	const handlers = [...viewListeners];
	for (const h of handlers) {
		try {
			h(v);
		} catch (err) {
			console.error("[plugin-host] onViewChange 处理器抛错:", err);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* 目录同步回执（use-chat 收到 plugin_catalog_sync_result 时转交这里）          */
/* -------------------------------------------------------------------------- */

type CatalogSyncResolver = (result: PluginHostReloadCatalogResult) => void;
const pendingCatalogSync = new Map<string, CatalogSyncResolver>();

/** use-chat 调用：把服务端的同步回执交给等待中的 reloadCatalog()（无等待者则丢弃）。 */
export function resolveCatalogSyncResult(msg: {
	requestId: string;
	ok: boolean;
	error?: string;
	entries?: UiPluginCatalogEntry[];
	installed?: { id: string; ok: boolean; error?: string }[];
}): void {
	const resolve = pendingCatalogSync.get(msg.requestId);
	if (!resolve) return;
	pendingCatalogSync.delete(msg.requestId);
	if (!msg.ok) {
		resolve({ ok: false, error: msg.error ?? "目录同步失败" });
		return;
	}
	resolve({
		ok: true,
		...(msg.entries ? { entries: msg.entries } : {}),
		...(msg.installed ? { installed: msg.installed } : {}),
	});
}
