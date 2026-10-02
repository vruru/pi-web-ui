/**
 * 插件工具拦截扩展点：类型化 Decision（DSH 对照 P1-5）。
 *
 * 只做 **pre + post 两阶段**、只覆盖**已接管**的工具（`bash` / `read`），
 * 不照搬 DSH 的五阶段 —— 工具执行在 pi SDK 内部，只有这两处有插手面
 * （`agent-service.ts` 的 customTools 覆盖 + 终端接管 bash）。
 *
 * - pre：`allow` 放行 / `deny` 拒绝（带原因）/ `ask` 需要用户确认。
 *   首个非 allow 胜出；handler 抛错或超时一律降级为弃权（allow），
 *   与 DSH chain 的「select 抛错降级为弃权」同源。
 * - post：变换内容（脱敏/改写）/ 附加 `additionalContext`（自动补上下文）。
 *   逐个顺序合并，抛错的那个被跳过。
 * - `ask` 的完整审批 UI（弹框等人点）本次不做：按阻断处理，原因里注明
 *   待确认，模型能看到、人能在诊断里看到；以后要做审批流只改
 *   `plugins.ts#evaluateToolPre` 的 ask 分支，不用动类型。
 */

export type GuardedToolName = "bash" | "read";

/** pre 守卫看到的请求：参数在执行前封存（浅冻，插件改了也无效）。 */
export interface ToolPreRequest {
	toolName: GuardedToolName;
	params: unknown;
	conversationId?: string;
}

/** pre 决策：三种权力。终结守卫只能拒绝（deny/ask），没有改写参数的权力。 */
export type ToolPreDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string; reasonEn?: string }
	| { decision: "ask"; reason?: string; reasonEn?: string };

export type ToolPreHandler = (
	req: ToolPreRequest,
) => ToolPreDecision | void | undefined | null | Promise<ToolPreDecision | void | undefined | null>;

/** post 守卫看到的请求：result 是执行结果的快照（改了也无效，用返回的 edit 说话）。 */
export interface ToolPostRequest {
	toolName: GuardedToolName;
	params: unknown;
	/** 执行结果（`{content?, details?, ...}`，原样透传，只读）。 */
	result: unknown;
	conversationId?: string;
}

/** post 编辑：换内容 / 补上下文（二者可同时给）。 */
export interface ToolPostEdit {
	/** 整体替换结果的 content（须为 `[{type, text?}...]` 形状，否则忽略）。 */
	content?: Array<{ type: string; text?: string }>;
	/** 追加给模型的额外上下文（截断封顶，不会撑爆上下文）。 */
	additionalContext?: string;
	additionalContextEn?: string;
}

export type ToolPostHandler = (
	req: ToolPostRequest,
) => ToolPostEdit | void | undefined | null | Promise<ToolPostEdit | void | undefined | null>;

/** 单个守卫的最长等待：超时按弃权处理（不能让一个插件挂住整轮工具调用）。 */
export const GUARD_HANDLER_TIMEOUT_MS = 5000;
/** 附加上下文的上限（字符）：插件补的上下文不能无节制进 LLM 上下文。 */
export const GUARD_CONTEXT_CAP = 2000;

/** 归一 pre 返回：void/null/垃圾一律按 allow（弃权）；只认三决策的形状。 */
export function normalizePreDecision(raw: unknown): ToolPreDecision {
	if (!raw || typeof raw !== "object") return { decision: "allow" };
	const d = (raw as Record<string, unknown>).decision;
	if (d === "deny" || d === "ask") {
		const o = raw as Record<string, unknown>;
		const reason = typeof o.reason === "string" ? o.reason.slice(0, 500) : undefined;
		const reasonEn = typeof o.reasonEn === "string" ? o.reasonEn.slice(0, 500) : undefined;
		return d === "deny" ? { decision: "deny", reason, reasonEn } : { decision: "ask", reason, reasonEn };
	}
	return { decision: "allow" };
}

/** 是否阻断执行（deny/ask 都算阻断；ask 只是原因不同）。 */
export function isBlockingDecision(d: ToolPreDecision): boolean {
	return d.decision === "deny" || d.decision === "ask";
}

function pickText(zh: string | undefined, en: string | undefined, fbZh: string, fbEn: string, lang: string): string {
	if (lang === "zh") return zh?.trim() ? zh.trim() : fbZh;
	return en?.trim() ? en.trim() : fbEn;
}

/** 阻断时给模型看的一句话（ask 注明待确认 + 按拒绝处理）。 */
export function denialText(d: ToolPreDecision, pluginId: string, lang: string): string {
	if (d.decision === "ask") {
		return pickText(
			d.reason,
			d.reasonEn,
			`插件 ${pluginId} 要求先确认再执行，已按拒绝处理（审批 UI 尚未实现，ask 暂按 deny 执行）`,
			`Plugin ${pluginId} asked for confirmation before execution; treated as denied (approval UI not implemented yet, ask behaves as deny)`,
			lang,
		);
	}
	return pickText(
		d.decision === "deny" ? d.reason : undefined,
		d.decision === "deny" ? d.reasonEn : undefined,
		`插件 ${pluginId} 拒绝了本次工具调用`,
		`Plugin ${pluginId} denied this tool call`,
		lang,
	);
}

/** 归一 post 返回：void/null/垃圾 → undefined（无编辑）；content 坏形状时只保留上下文。 */
export function normalizePostEdit(raw: unknown): ToolPostEdit | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const o = raw as Record<string, unknown>;
	let content: ToolPostEdit["content"];
	if (Array.isArray(o.content)) {
		const rows = o.content.filter(
			(p): p is { type: string; text?: string } =>
				Boolean(p) && typeof p === "object" && typeof (p as { type: unknown }).type === "string",
		);
		if (rows.length > 0 && rows.length === (o.content as unknown[]).length) {
			content = rows.map((p) => ({
				type: p.type.slice(0, 32),
				...(typeof p.text === "string" ? { text: p.text } : {}),
			}));
		} else if (rows.length > 0) {
			content = rows.map((p) => ({
				type: p.type.slice(0, 32),
				...(typeof p.text === "string" ? { text: p.text } : {}),
			}));
		}
	}
	const additionalContext =
		typeof o.additionalContext === "string" && o.additionalContext.trim()
			? o.additionalContext.slice(0, GUARD_CONTEXT_CAP)
			: undefined;
	const additionalContextEn =
		typeof o.additionalContextEn === "string" && o.additionalContextEn.trim()
			? o.additionalContextEn.slice(0, GUARD_CONTEXT_CAP)
			: undefined;
	if (!content && !additionalContext && !additionalContextEn) return undefined;
	return {
		...(content ? { content } : {}),
		...(additionalContext ? { additionalContext } : {}),
		...(additionalContextEn ? { additionalContextEn } : {}),
	};
}

/** 把一次 post 编辑合进执行结果（返回新对象，不改原结果）。 */
export function applyPostEdit(
	result: { content?: Array<{ type: string; text?: string }>; [k: string]: unknown },
	edit: ToolPostEdit,
	lang: string,
): { content?: Array<{ type: string; text?: string }>; [k: string]: unknown } {
	const ctx =
		lang === "zh"
			? edit.additionalContext?.trim()
			: (edit.additionalContextEn?.trim() ?? edit.additionalContext?.trim());
	const tail = ctx ? [{ type: "text", text: ctx }] : [];
	if (edit.content) {
		return { ...result, content: [...edit.content, ...tail] };
	}
	if (!tail.length) return result;
	return { ...result, content: [...(result.content ?? []), ...tail] };
}

/** 带超时的守卫调用：超时按弃权（pre→allow，post→undefined），调用方再归一。 */
export function withGuardTimeout<T>(p: Promise<T>, ms = GUARD_HANDLER_TIMEOUT_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** 封存请求参数：浅冻一层（插件拿到的是快照，改了也不影响执行）。 */
export function freezeParams<T>(params: T): T {
	if (params && typeof params === "object" && !Object.isFrozen(params)) {
		try {
			Object.freeze(params);
		} catch {
			// 冻不住（如 sealed 变体）就原样给：决策只读快照，不依赖冻结成功。
		}
	}
	return params;
}
