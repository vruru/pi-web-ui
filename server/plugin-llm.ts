/**
 * 插件直调模型（host.llm.complete 的底层）：一次性的孤立无工具会话。
 *
 * 与审查循环的 reviewer 同一条 SDK 链路（createAgentSessionServices +
 * ModelRuntime.create + createAgentSessionFromServices + prompt +
 * getLastAssistantText + dispose），区别：
 * - `noTools: true` + skills 全剥：纯补全，无副作用、可预测花费；
 * - 调用方（agent-service.completeForPlugins）只给 cwd/agentDir/回落模型，
 *   并发与预算门在本文件内收敛。
 *
 * 约束（fail-closed，一律结构化返回、绝不抛错）：
 * - 输入封顶：prompt ≤ 8000 字、system ≤ 4000 字；
 * - 输出截断：maxChars 缺省 8000、上限 32000；
 * - 超时：缺省 90s、范围 5s–5min，超时即 dispose 掉会话；
 * - 并发：全局最多 4 路在飞，超了直接回 {ok:false}（插件侧重试，不排队——
 *   排队会把插件的 await 变成不定等待，调用方超时兜底更难写）。
 */
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "./attachments.js";

/** host.llm.complete 的入参（插件侧形状，服务端再归一化）。 */
export interface PluginLlmRequest {
	/** 本次要模型做的事（必填）。 */
	prompt: string;
	/** 系统指令（可选；拼在 prompt 前面，会话仍带 SDK 默认系统提示）。 */
	system?: string;
	/** "provider/id"（可选；缺省 = 主会话当前模型，再缺省 = 会话默认模型）。 */
	model?: string;
	/** 输出截断字符数（缺省 8000，上限 32000）。 */
	maxChars?: number;
	/** 超时毫秒（缺省 90000，范围 5000–300000）。 */
	timeoutMs?: number;
}

/** host.llm.complete 的回执。 */
export type PluginLlmResult =
	{ ok: true; text: string; model: string; usage?: { input: number; output: number } } | { ok: false; error: string };

/** agent-service 提供的环境（cwd/agentDir/回落模型，全部只读快照）。 */
export interface PluginLlmEnv {
	cwd: string;
	agentDir: string;
	fallbackModel?: { provider: string; id: string };
}

const MAX_PROMPT_CHARS = 8000;
const MAX_SYSTEM_CHARS = 4000;
const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 32000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_INFLIGHT = 4;

let inflight = 0;

/** 当前在飞的孤立调用数（单测/诊断用）。 */
export function llmInflight(): number {
	return inflight;
}

function fail(error: string): PluginLlmResult {
	return { ok: false, error };
}

export async function completeWithIsolatedSession(env: PluginLlmEnv, req: PluginLlmRequest): Promise<PluginLlmResult> {
	const prompt = String(req?.prompt ?? "");
	if (!prompt.trim()) return fail("llm.complete: prompt 为空");
	if (prompt.length > MAX_PROMPT_CHARS)
		return fail(`llm.complete: prompt 超长（${prompt.length} > ${MAX_PROMPT_CHARS} 字），请裁剪后重发`);
	const system = String(req?.system ?? "");
	if (system.length > MAX_SYSTEM_CHARS)
		return fail(`llm.complete: system 超长（${system.length} > ${MAX_SYSTEM_CHARS} 字），请裁剪后重发`);
	if (inflight >= MAX_INFLIGHT) return fail(`llm.complete: 并发已满（${MAX_INFLIGHT} 路在飞），请稍后重试`);
	const maxChars = Math.min(
		Math.max(Number(req?.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, 1),
		MAX_MAX_CHARS,
	);
	const timeoutMs = Math.min(
		Math.max(Number(req?.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
		MAX_TIMEOUT_MS,
	);

	inflight += 1;
	const run = (async (): Promise<PluginLlmResult> => {
		let dispose: (() => void) | undefined;
		try {
			const services = await createAgentSessionServices({
				cwd: env.cwd,
				agentDir: env.agentDir,
				// 技能全剥：纯补全不需要技能上下文（省 token，结果可预测）。
				resourceLoaderOptions: {
					skillsOverride: (res) => ({ ...res, skills: [] }),
				},
				modelRuntime: await ModelRuntime.create({
					authPath: join(env.agentDir, "auth.json"),
					modelsPath: join(env.agentDir, "models.json"),
				}),
			});
			// 模型：显式指定 > 主会话回落 > 会话默认（与 reviewer 同优先级）。
			let model;
			let modelName = "default";
			const spec = parseModelSpec(req?.model);
			if (spec) {
				model = services.modelRuntime.getModel(spec.provider, spec.id);
				if (!model) return fail(`llm.complete: 找不到模型 ${spec.spec}`);
				modelName = spec.spec;
			}
			if (!model && env.fallbackModel) {
				model = services.modelRuntime.getModel(env.fallbackModel.provider, env.fallbackModel.id);
				if (model) modelName = `${env.fallbackModel.provider}/${env.fallbackModel.id}`;
			}
			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(env.cwd),
				...(model ? { model } : {}),
				// 全部工具关闭（"all"）：纯补全，无副作用（SDK 的 noTools 是 "builtin"|"all" 枚举）。
				noTools: "all",
			});
			dispose = () => {
				try {
					srv.session.dispose();
				} catch {
					/* dispose 尽力而为 */
				}
			};
			const text = system.trim() ? `系统指令：${system.trim()}\n\n---\n\n任务：${prompt}` : prompt;
			await srv.session.prompt(text, { expandPromptTemplates: false });
			const raw = srv.session.getLastAssistantText() ?? "";
			let usage: { input: number; output: number } | undefined;
			try {
				const stats = srv.session.getSessionStats();
				usage = { input: stats.tokens.input, output: stats.tokens.output };
			} catch {
				/* usage 尽力而为 */
			}
			return { ok: true, text: raw.slice(0, maxChars), model: modelName, ...(usage ? { usage } : {}) };
		} finally {
			// 会话回收跟 run 走：超时竞速输了 run 还在飞，run 落定才 dispose，不留孤儿。
			try {
				dispose?.();
			} catch {
				/* dispose 尽力而为 */
			}
		}
	})();
	// 并发计数跟**真实 run** 走，而不是外层函数的 finally：超时竞速返回后 run 还在飞，
	// 计数必须继续占着 MAX_INFLIGHT 的位 —— 否则每次超时都「腾出」一路并发，
	// 连续超时的插件能把在飞会话越堆越多，护栏失效。catch 挂在分支上兜住 run 的
	// 拒绝（竞速已由 timer 赢时，外层 catch 不会再收到它）。
	void run
		.catch(() => {})
		.finally(() => {
			inflight -= 1;
		});
	try {
		const timer = new Promise<PluginLlmResult>((resolve) =>
			setTimeout(() => resolve(fail(`llm.complete: 超时（约${Math.round(timeoutMs / 1000)}s）`)), timeoutMs),
		);
		return await Promise.race([run, timer]);
	} catch (err) {
		return fail(`llm.complete: ${(err as Error).message}`);
	}
}
