/**
 * tool-overrides.ts —— pi-web-ui 对 SDK 内置工具的覆盖（read / write / edit）如何与
 * **第三方 pi 扩展提供的同名工具共存**。
 *
 * 为什么需要这个模块（问题）：SDK 的注册表合并链是
 * `allCustomTools = [...扩展注册的工具, ...customTools]` 再逐个 `definitionRegistry.set(name, …)`
 * —— 后写赢 ⇒ **customTools 恒顶掉扩展的同名工具，与加载顺序无关、也没有开关**（见
 * `dist/core/agent-session.js` 的 `_refreshToolRegistry()`）。而官方
 * `docs/extensions.md` §Overriding Built-in Tools 明写扩展**可以**覆盖 `read` / `bash` /
 * `powershell` / `edit` / `write` / `grep` / `find` / `ls` 并逐个列出了 `read`。
 * pi-web-ui 过去把这三个覆盖直接塞进创建时的 `customTools` ⇒ 那句话在 `read`/`write`/`edit`
 * 上失效：第三方扩展的同名工具**永远轮不到**，而且症状会伪装（覆盖层转发内置实现 ⇒
 * 「读文件/图片/目录都正常，只有扩展特有的能力没有」，例如 `pi-better-edit` 的 read 不出锚、
 * 它的 edit 随后一律 `E_UNKNOWN_ANCHOR`）。
 *
 * 做法：这三个覆盖**不再于创建时注册**。会话建好后按名字从**扩展注册表**
 * （`session.extensionRunner.getAllRegisteredTools()`，不受 customTools 顶替影响）取扩展的同名
 * 实现当基底，没有则用 pi-web-ui 自己的完整实现，再交给装饰器（`composeWith`）在其上叠加
 * pi-web-ui 的能力（目录列条目 / 权限沙箱）。装饰器必须把**行为**委托给基底，只加自己那一层；
 * 基底的 schema、描述、prompt 指引、渲染全部原样保留，扩展独有的参数（如 better-edit 的
 * `windows`）照旧可用。
 *
 * 注入手法与 `plugins.ts` 的 `syncPluginToolsIntoSession` 相同：改 `session._customTools`
 * 后调 `_refreshToolRegistry()`（SDK 改私有字段名即返回 null，调用方按「覆盖没装上」降级；
 * `extensionRunner` 缺失时退化成「有扩展也当内置」＝改动前的行为，不会更差）。
 *
 * 顺序：注入项排在既有 `_customTools` **之前** ⇒ pi-web-ui 插件注册的同名工具（也是
 * customTools，比覆盖层后写）仍然是最后赢家，与改动前的相对顺序一致。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 任意具体的工具定义类型：SDK 内置定义各自的 TParams/TDetails 都不同，扩展注册的又不同，
 * 而 `renderCall` 的参数是逆变的 ⇒ `ToolDefinition<TSchema, unknown, any>` 与具体定义之间
 * 互不可赋值。覆盖层要能接住任何一个，只能用 any 参数化（SDK 内部同款别名 AnyToolDefinition）。
 */
export type AnyToolDefinition = ToolDefinition<any, any, any>;

/** 一个「覆盖内置工具」的规格：没有扩展同名工具 / 有扩展同名工具两条路。 */
export interface ToolOverrideSpec {
	/** 被覆盖的工具名（`read` / `write` / `edit`）。 */
	name: string;
	/**
	 * 没有第三方扩展提供同名工具时用的**完整实现**（pi-web-ui 自己的覆盖，
	 * 行为与改动前逐字一致）。
	 */
	fallback: () => AnyToolDefinition;
	/**
	 * 有第三方扩展提供同名工具时的装饰器：以扩展实现为基底，保留它的一切，
	 * 只叠加 pi-web-ui 的能力（行为仍委托基底）。省掉它 = 该名字直接让给扩展
	 * （pi-web-ui 的覆盖能力在该名字上不生效）。
	 */
	composeWith?: (base: AnyToolDefinition) => AnyToolDefinition;
}

/** 会话状对象（SDK `AgentSession` 的结构子集）：只认本模块要用的三个面。 */
export interface OverrideSessionLike {
	extensionRunner?: {
		getAllRegisteredTools?: () => Array<{ definition: AnyToolDefinition }>;
	};
	_customTools?: AnyToolDefinition[];
	_refreshToolRegistry?: () => void;
}

/** 解析某个工具名在**扩展注册表**里的实现；没有扩展提供时返回 undefined。 */
export function extensionToolDefinition(session: OverrideSessionLike, name: string): AnyToolDefinition | undefined {
	const tools = session.extensionRunner?.getAllRegisteredTools?.();
	return tools?.find((tool) => tool.definition?.name === name)?.definition;
}

/**
 * 把覆盖装进已建好的会话：逐个解析基底（扩展同名工具优先）→ 装饰 → 注入 → 刷新注册表。
 * 返回注入的工具名；会话对象形状不符（SDK 改私有字段名）返回 null，调用方按「覆盖未生效」降级。
 */
export function installToolOverrides(
	session: OverrideSessionLike,
	specs: readonly ToolOverrideSpec[],
): string[] | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const names = new Set(specs.map((s) => s.name));
	const injected: AnyToolDefinition[] = [];
	for (const spec of specs) {
		const extensionTool = extensionToolDefinition(session, spec.name);
		if (extensionTool) {
			// 有扩展同名工具：只能叠（composeWith）；没给装饰器就整个让给它 ——
			// **绝不**用 fallback 顶掉它（那就又是本模块存在要防的那个问题）。
			if (spec.composeWith) injected.push(spec.composeWith(extensionTool));
			continue;
		}
		injected.push(spec.fallback());
	}
	// 同名项先剔除再前置：重复调用幂等（不会层层叠加），且插件工具仍然后写赢。
	session._customTools = [...injected, ...session._customTools.filter((t) => !names.has(t.name))];
	session._refreshToolRegistry();
	return [...names];
}
