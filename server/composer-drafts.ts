/**
 * composer-drafts.ts — 未发送输入框草稿的单中心文件存储（全局 <dataDir>/composer-drafts.json）。
 *
 * 设计（issue #166 单中心文件方案）：不进 session JSONL、不按会话建 sidecar，
 * 全会话的草稿集中在一个文件里，按 **sessionId**（uuidv7，重启稳定）键入。
 * conversationId 每次重启都变，不能做 key（见 agent-service 的 compaction 注释）。
 *
 * - 空白新会话也能存：sessionId 在 SessionManager.create() 时内存里就有了，
 *   不依赖转录文件落盘（SDK 的 _persist 门控要等首轮 assistant 才写盘）。
 * - 每会话只留最新一条（last-write-wins，按 ts，比 marker-store 的扫描模式更轻）。
 * - 与 per-client 的 client-state.json 不同：按 sessionId 全局存，跨标签页可见。
 * - 文件 I/O 一律 best-effort：持久化故障绝不能弄崩 server（同 subagent-templates）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** 单条草稿上限字符数：超出截断再存（快照全量下发时携带，太大浪费流量）。 */
export const DRAFT_TEXT_MAX = 20_000;
/** 草稿保留期：超过这么久没更新，下次加载时清扫（兜底；正常路径靠 clear/prune）。 */
export const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;

export interface ComposerDraft {
	text: string;
	ts: number;
	updatedAt: number;
}

/** 转录文件名 `<timestamp>_<sessionId>.jsonl` → sessionId。
 *  时间戳里的 `:`/`.` 已被 SDK 换成 `-`（无下划线），取首个 `_` 之后即 sessionId
 *  （uuidv7 本身也不含下划线）。对不上形状返回 undefined（调用方跳过剪枝）。 */
export function sessionIdFromTranscriptPath(p: string): string | undefined {
	const base = basename(p);
	if (!base.endsWith(".jsonl")) return undefined;
	const noExt = base.slice(0, -".jsonl".length);
	const i = noExt.indexOf("_");
	if (i < 0 || i + 1 >= noExt.length) return undefined;
	return noExt.slice(i + 1);
}

/** 归一化待存文本：超长截断；纯空白 → undefined（调用方按「删除」处理，不存空条目）。 */
export function normalizeDraftText(text: string): string | undefined {
	const t = (text ?? "").slice(0, DRAFT_TEXT_MAX);
	return t.trim() ? t : undefined;
}

function isValidDraft(d: unknown): d is ComposerDraft {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return typeof o.text === "string" && typeof o.ts === "number" && typeof o.updatedAt === "number";
}

/** clear 水位：sessionId → clear 时刻（max(旧条目 ts, Date.now())）。
 *  模块级（非实例级）：同进程每个 ClientSession 各有一个 ComposerDraftsStore
 *  实例（agent-service.ts:1922），跨 tab 的 prompt-clear 与陈旧写落在不同
 *  实例上，水位必须跨实例可见。进程重启即失 —— 重启后文件态本身已干净
 *  （clear 落盘删 key），late-save 无处可达。
 *  ponytail: 内存水位，TTL/持久化按需加（当前重启语义已够用）。 */
const clearedAt = new Map<string, number>();

export class ComposerDraftsStore {
	private cache: Record<string, ComposerDraft> | null = null;

	constructor(private readonly filePath: string) {}

	private load(): Record<string, ComposerDraft> {
		if (this.cache) return this.cache;
		let raw: Record<string, unknown> = {};
		try {
			raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
		} catch {
			// 坏文件改名留存而非直接覆盖：先有留存，后续 save 落盘的才是新数据
			//（否则一次解析失败 → 空表 → 下次 save 把全部草稿的原始记录抹掉）。
			try {
				renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
				console.warn(`[composer-drafts] 草稿文件解析失败，已改名留存：${this.filePath}（丢草稿可重打，不留坏副本）`);
			} catch {
				// 改名失败（占用等）也无妨：空表继续，save 时照常覆盖
			}
			raw = {};
		}
		const now = Date.now();
		const kept: Record<string, ComposerDraft> = {};
		let pruned = false;
		for (const [k, v] of Object.entries(raw)) {
			if (!isValidDraft(v)) {
				pruned = true;
				continue;
			}
			if (now - v.updatedAt > DRAFT_TTL_MS) {
				pruned = true;
				continue;
			}
			kept[k] = v;
		}
		this.cache = kept;
		// 读到过期/脏条目才回写：正常加载不碰磁盘。
		if (pruned) this.persist();
		return this.cache;
	}

	private persist(): void {
		if (!this.cache) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
			renameSync(tmp, this.filePath);
		} catch {
			// best-effort：草稿丢了可以重打，server 绝不能因此崩。
		}
	}

	/** 读一条草稿（{text, ts}；没有返回 undefined）。 */
	get(sessionId: string): { text: string; ts: number } | undefined {
		if (!sessionId) return undefined;
		const d = this.load()[sessionId];
		return d ? { text: d.text, ts: d.ts } : undefined;
	}

	/** 存一条草稿：空文本 = 删除；同 key 上 ts 更大的才覆盖（last-write-wins，
	 *  `>=` 让同 ts 的重发幂等）。只有实际变化才写盘。
	 *  clear 时间戳守卫：prompt() 清掉草稿后才 landing 的旧 `draft_update`
	 *  （防抖延迟 / 跨 tab 陈旧写，ts <= clearTs）直接丢弃，不复活存储
	 *  （reload-resurrect，见 clearedAt）。*/
	save(sessionId: string, text: string, ts: number): void {
		if (!sessionId) return;
		const cut = clearedAt.get(sessionId);
		if (cut !== undefined && ts <= cut) return;
		const map = this.load();
		const norm = normalizeDraftText(text);
		if (norm === undefined) {
			if (map[sessionId] !== undefined) {
				delete map[sessionId];
				this.persist();
			}
			return;
		}
		const prev = map[sessionId];
		if (prev && prev.ts > ts) return;
		if (prev && prev.ts === ts && prev.text === norm) return;
		map[sessionId] = { text: norm, ts, updatedAt: Date.now() };
		this.persist();
	}

	/** 发送成功 / 会话删除后清掉（有 key 才写盘）。同时记录 clear 时间戳
	 *  （max(旧条目 ts, Date.now())）：之后 ts <= 该水位的 save 一律丢弃，
	 *  拦住 prompt() 清掉之后才 landing 的旧 `draft_update`。
	 *  模块级共享：同进程多 ClientSession（多 tab）共用同一水位。 */
	clear(sessionId: string): void {
		if (!sessionId) return;
		const map = this.load();
		const prevTs = map[sessionId]?.ts ?? 0;
		clearedAt.set(sessionId, Math.max(prevTs, Date.now()));
		if (map[sessionId] !== undefined) {
			delete map[sessionId];
			this.persist();
		}
	}

	/** delete_session 用：按转录文件路径反解 sessionId 并清掉（形状对不上就跳过）。 */
	pruneSessionFile(sessionPath: string): void {
		const id = sessionIdFromTranscriptPath(sessionPath);
		if (id) this.clear(id);
	}
}
