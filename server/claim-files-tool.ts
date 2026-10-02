// ---------------------------------------------------------------------------
// claim-files-tool.ts — 文件认领（claim_files）：并行冲突的「事前打招呼」
// ---------------------------------------------------------------------------
// 触碰集是事后信息（写完才知道），claim 是事前意图（"我要改这几个文件"）。
// advisory 语义：认领只出现在提醒/files/list 里升级措辞，不拦 edit/bash ——
// 强制锁会死锁（见 claim-store.ts 文件头）。先到先得；自己的可刷新，
// 别人的动不了；过期自动释放 + 发 prompt 心跳续期 + 对话关闭释放。
//
// 开关走统一工具 tab（AGENT_TOOL_CATALOG 目录 + 设置页开关行；ActiveSet 门控，
// live 生效）：认领是纯 advisory（关掉只会少提醒），默认开。DSH 引擎无 customTool
// 注册面，只有 pi 引擎对话能认领（提醒是服务端算的，DSH 照样能看到别人的认领）。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { CLAIM_FILES_TOOL_NAME } from "./tool-manager.js";
import { CLAIM_TTL_MS, resolveClaimPath, type ClaimStore } from "./claim-store.js";

/** 工具名（唯一定义在 tool-manager.ts，本模块 re-export 供单测沿用，模式同 present-files-tool.ts）。 */
export { CLAIM_FILES_TOOL_NAME };

/** 由 ClientSession 实现的数据宿主（owner 口径同 subagent：本 runtime 所属会话）。 */
export interface ClaimFilesHost {
	/** 认领 end up 落在哪个项目分表（owner 对话的 cwd，不是派发瞬间 active）。 */
	cwd(): string;
	/** 认领归属（owner 对话 id + 标题，展示用）。 */
	self(): { convId: string; title: string };
	/** 全局认领表（AgentService 级单例；未接线时 undefined，工具转报错）。 */
	store(): ClaimStore | undefined;
}

function fmtTtl(ms: number): string {
	const m = Math.round(ms / 60000);
	return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`;
}

export function makeClaimFilesTool(host: ClaimFilesHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: CLAIM_FILES_TOOL_NAME,
		label: "Claim files to avoid parallel conflicts",
		description:
			"Declare files you are about to edit so parallel runs in the same project steer clear (advisory only — never blocks edits). " +
			"claim reserves paths for THIS conversation (first wins; conflicts reported, not overridden); release frees yours (no paths = all yours); list shows the project's claim table. " +
			"Claims expire after ~30 min idle (your prompts refresh them) and release when the conversation closes. Paths must stay inside the project.",
		promptSnippet: "claim files you are about to edit (advisory, first-wins) so parallel runs steer clear",
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({ description: 'claim = reserve paths; release = free yours; list = show table. Default "list".' }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "claim/release only: file paths (inside the project)." }),
			),
			note: Type.Optional(Type.String({ description: "claim only: why you need them (shown to others, ≤200 chars)." })),
			ttlMinutes: Type.Optional(
				Type.Number({ description: "claim only: expiry in minutes (1-480, default 30; refreshed by your prompts)." }),
			),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const store = host.store();
			if (!store) {
				return text(
					pick(
						getLang(),
						`认领表暂不可用（服务端未接线），先按无认领处理。`,
						`Claim store unavailable (not wired); proceed as if nothing is claimed.`,
						"claimfiles.no.store",
					),
				);
			}
			const cwd = host.cwd();
			const self = host.self();
			const action = (p.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				const rows = store.list(cwd);
				const L = getLang();
				if (rows.length === 0) {
					return text(
						pick(
							L,
							`本项目暂无认领（parallel reminder 的触碰集照常工作）。`,
							`No claims in this project (parallel touch reminders still apply).`,
							"claimfiles.list.empty",
						),
						{ cwd, total: 0, claims: [] },
					);
				}
				const lines = rows.map(
					(c) =>
						`- ${c.path} · 「${c.ownerTitle}」${c.note ? ` · ${c.note}` : ""} · ${pick(
							L,
							`剩约 ${fmtTtl(Math.max(0, c.expiresAt - Date.now()))}`,
							`~${fmtTtl(Math.max(0, c.expiresAt - Date.now()))} left`,
							"claimfiles.list.ttl",
							{ ttl: fmtTtl(Math.max(0, c.expiresAt - Date.now())) },
						)}`,
				);
				return text(
					`${pick(
						L,
						`本项目认领表（${rows.length} 条，先到先得，只作绕行参考）：`,
						`Claim table for this project (${rows.length}, first-wins, advisory):`,
						"claimfiles.list.head",
						{ total: rows.length },
					)}\n${lines.join("\n")}`,
					{
						cwd,
						total: rows.length,
						claims: rows.map((c) => ({ path: c.path, ownerTitle: c.ownerTitle, note: c.note })),
					},
				);
			}
			if (action === "claim" || action === "release") {
				const rawPaths = Array.isArray(p.paths) ? p.paths : [];
				if (action === "release" && rawPaths.length === 0) {
					const n = store.release(cwd, self.convId);
					return text(
						pick(
							getLang(),
							n > 0 ? `已释放你名下 ${n} 条认领。` : `你名下没有认领，无事可做。`,
							n > 0 ? `Released ${n} of your claim(s).` : `You hold no claims; nothing to do.`,
							"claimfiles.release.all",
							{ n },
						),
						{ cwd, released: n },
					);
				}
				if (rawPaths.length === 0) {
					return text(
						pick(
							getLang(),
							`action=${action} 需要 paths（release 不给 paths = 全放自己名下的）。`,
							`action=${action} needs paths (release without paths = free all yours).`,
							"claimfiles.bad.paths",
							{ action },
						),
					);
				}
				const bad = rawPaths.filter((s) => !resolveClaimPath(s, cwd));
				if (bad.length > 0) {
					return text(
						pick(
							getLang(),
							`这些路径不在项目目录内，认领只接受项目内路径：${bad.slice(0, 3).join("、")}${bad.length > 3 ? `（等 ${bad.length} 个）` : ""}。`,
							`These paths escape the project directory (claims are project-local): ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` (+${bad.length - 3})` : ""}.`,
							"claimfiles.bad.outside",
							{ paths: bad.slice(0, 3).join(", ") },
						),
					);
				}
				if (action === "claim") {
					const ttlMs =
						typeof p.ttlMinutes === "number" && Number.isFinite(p.ttlMinutes)
							? Math.floor(p.ttlMinutes * 60000)
							: CLAIM_TTL_MS;
					const { claimed, conflicts } = store.claim(
						cwd,
						{ convId: self.convId, title: self.title },
						rawPaths.map((s) => ({
							path: s,
							...(typeof p.note === "string" && p.note.trim() ? { note: p.note } : {}),
							ttlMs,
						})),
					);
					const L = getLang();
					const okLine =
						claimed.length > 0
							? pick(
									L,
									`已认领 ${claimed.length} 个（${claimed.map((c) => c.path).join("、")}），约 ${fmtTtl(ttlMs)} 后过期（你发 prompt 自动续）。`,
									`Claimed ${claimed.length} (${claimed.map((c) => c.path).join(", ")}), expiring in ~${fmtTtl(ttlMs)} (refreshed by your prompts).`,
									"claimfiles.claim.ok",
									{ n: claimed.length },
								)
							: "";
					const clashLine =
						conflicts.length > 0
							? pick(
									L,
									`先到先得，以下已被别人认领（没抢占）：${conflicts.map((c) => `${c.path}（「${c.claim.ownerTitle}」${c.claim.note ? `：${c.claim.note}` : ""}）`).join("；")} —— 绕行，或问用户。`,
									`First-wins; already claimed by others (not overridden): ${conflicts.map((c) => `${c.path} ("${c.claim.ownerTitle}"${c.claim.note ? `: ${c.claim.note}` : ""})`).join("; ")} — steer clear or ask the user.`,
									"claimfiles.claim.conflict",
									{ n: conflicts.length },
								)
							: "";
					return text(
						[okLine, clashLine].filter(Boolean).join("\n") ||
							pick(L, `无事可做。`, `Nothing to do.`, "claimfiles.claim.noop"),
						{
							cwd,
							claimed: claimed.map((c) => c.path),
							conflicts: conflicts.map((c) => ({ path: c.path, ownerTitle: c.claim.ownerTitle })),
						},
					);
				}
				// release 指定 paths：只放自己的，别人的动不了（返回里如实说）。
				const n = store.release(cwd, self.convId, rawPaths);
				return text(
					pick(
						getLang(),
						n > 0
							? `已释放 ${n} 条你名下的认领（别人的动不了，也没动）。`
							: `这些路径没有你名下的认领（可能是别人的，无权释放）。`,
						n > 0
							? `Released ${n} of your claim(s) (others' untouched, as they should be).`
							: `None of these are yours (possibly someone else's — not yours to release).`,
						"claimfiles.release.paths",
						{ n },
					),
					{ cwd, released: n },
				);
			}
			return text(
				pick(
					getLang(),
					`action 非法：${p.action}（只能是 claim、release 或 list）。`,
					`Invalid action: ${p.action} (must be "claim", "release" or "list").`,
					"claimfiles.bad.action",
					{ "p.action": p.action },
				),
			);
		},
	});
}
