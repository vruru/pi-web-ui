// ---------------------------------------------------------------------------
// claim-store.ts — 文件认领表（claim store）+ 触碰 sidecar
// ---------------------------------------------------------------------------
// 背景：触碰集是「事后诸葛亮」（写完才知道），并行冲突要的是「事前打招呼」。
// claim = 某对话声明「我要改这几个文件」，其他对话在提醒/files/status 里看到
// 并绕行。注意这只是 advisory（建议）：提醒措辞升级，但不拦 edit/bash ——
// 强制锁会引入死锁与 stall（见设计说明）， first-wins + 过期自动释放是唯一的
// 防腐机制（fail-open：丢认领只会少一条提醒，绝不卡死任何人）。
//
// 存放：
//   - 认领表全局共享（跨浏览器标签页可见）→ AgentService 级单例，落盘
//     <dataDir>/claims.json（SubagentTemplatesStore 同款 best-effort 持久化：
//     写坏/读坏绝不弄崩 server，坏文件直接丢弃重建）。
//   - 触碰 sidecar 按会话落盘（<转录文件>.touches.json）：压缩后旧消息被摘要
//     替代，sidecar 让 files/status 在压缩后仍有答案；只读小文件，不扫全量转录。
//     inMemory 子代理没有转录文件 → 无 sidecar，走实时消息（老样子）。
//
// key 口径：认领按「项目 cwd」分表（默认不跨项目）；路径一律存绝对路径
// （认领时按 conv cwd resolve），比对时触碰路径同样 resolve 后比较 —— 后缀
// 模糊匹配继续禁用（假阳性比漏报更糟，见 conversation-touches 文件头）。
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { normalizeTouchPath, unionTouchLists, type TouchedFile } from "./conversation-touches.js";

/** 认领默认 TTL：30 分钟（每次发 prompt 心跳续期，对话关闭时释放）。 */
export const CLAIM_TTL_MS = 30 * 60 * 1000;
/** 认领 TTL 上下限（工具参数钳制用）。 */
export const CLAIM_TTL_MIN_MS = 60 * 1000;
export const CLAIM_TTL_MAX_MS = 8 * 60 * 60 * 1000;
/** sidecar 条目上限（防无界增长；超了按 lastTs 掐尾）。 */
export const SIDECAR_MAX_ENTRIES = 500;
/** claims.json 版本（以后改格式时迁移用）。 */
const CLAIMS_FILE_VERSION = 1;

export interface Claim {
	/** 绝对路径（认领时已按 conv cwd resolve）。 */
	path: string;
	ownerConvId: string;
	ownerTitle: string;
	note?: string;
	claimedAt: number;
	expiresAt: number;
}

/** 给 files/status/提醒看的轻量视图（不暴露 convId 等内部标识）。 */
export interface ClaimView {
	path: string;
	ownerTitle: string;
	note?: string;
}

export interface ClaimInput {
	path: string;
	note?: string;
	ttlMs?: number;
}

/** cwd 分表键：绝对归一（大小写不归一，见 touches 局限 3）。 */
function cwdKey(cwd: string): string {
	try {
		return resolve(cwd);
	} catch {
		return cwd;
	}
}

/** 认领路径合法性：必须落在 conv cwd 内（../ 逃逸拒绝，由工具转报错）。 */
export function resolveClaimPath(raw: string, cwd: string): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	let abs: string;
	try {
		abs = resolve(cwd, normalizeTouchPath(raw));
	} catch {
		return undefined;
	}
	const root = cwdKey(cwd);
	if (abs !== root && !abs.startsWith(root + sep)) return undefined;
	return abs;
}

function isValidClaim(c: unknown): c is Claim {
	if (!c || typeof c !== "object") return false;
	const o = c as Record<string, unknown>;
	return (
		typeof o.path === "string" &&
		!!o.path &&
		typeof o.ownerConvId === "string" &&
		!!o.ownerConvId &&
		typeof o.ownerTitle === "string" &&
		typeof o.claimedAt === "number" &&
		typeof o.expiresAt === "number"
	);
}

/** 项目级认领表（AgentService 级单例；I/O 全 best-effort）。 */
export class ClaimStore {
	private tables = new Map<string, Claim[]>();
	constructor(private file: string) {
		this.load();
	}

	/** 认领：先到先得。别人（含过期前）的 → conflicts；自己的 → 刷新 note/过期。 */
	claim(
		cwd: string,
		owner: { convId: string; title: string },
		inputs: ClaimInput[],
		now = Date.now(),
	): { claimed: Claim[]; conflicts: { path: string; claim: Claim }[] } {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		const table = this.tables.get(key) ?? [];
		const claimed: Claim[] = [];
		const conflicts: { path: string; claim: Claim }[] = [];
		for (const input of inputs) {
			const abs = resolveClaimPath(input.path, cwd);
			if (!abs) continue; // 非法路径调用方已拦，这里只跳过不抛错
			const ttl =
				typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
					? Math.min(CLAIM_TTL_MAX_MS, Math.max(CLAIM_TTL_MIN_MS, Math.floor(input.ttlMs)))
					: CLAIM_TTL_MS;
			const existing = table.find((c) => c.path === abs);
			if (existing && existing.ownerConvId !== owner.convId) {
				conflicts.push({ path: abs, claim: { ...existing } });
				continue;
			}
			const row: Claim = {
				path: abs,
				ownerConvId: owner.convId,
				ownerTitle: owner.title,
				...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
				claimedAt: existing?.claimedAt ?? now,
				expiresAt: now + ttl,
			};
			if (existing) Object.assign(existing, row);
			else table.push(row);
			claimed.push({ ...row });
		}
		this.tables.set(key, table);
		this.save();
		return { claimed, conflicts };
	}

	/** 释放：只放自己的（别人的动不了）；paths 空 = 全放。返回释放条数。 */
	release(cwd: string, ownerConvId: string, paths?: string[], now = Date.now()): number {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		const table = this.tables.get(key) ?? [];
		let drop: Set<string> | null = null;
		if (Array.isArray(paths) && paths.length > 0) {
			drop = new Set();
			for (const p of paths) {
				const abs = resolveClaimPath(p, cwd);
				if (abs) drop.add(abs);
			}
		}
		const before = table.length;
		this.tables.set(
			key,
			table.filter((c) => c.ownerConvId !== ownerConvId || (drop !== null && !drop.has(c.path))),
		);
		const n = before - (this.tables.get(key)?.length ?? 0);
		if (n > 0) this.save();
		return n;
	}

	/** 按 owner 全放（对话关闭/释放时调）。返回释放条数。 */
	releaseByOwner(ownerConvId: string, now = Date.now()): number {
		let n = 0;
		for (const [key, table] of this.tables) {
			this.sweepTable(key, now);
			const kept = (this.tables.get(key) ?? table).filter((c) => c.ownerConvId !== ownerConvId);
			n += table.length - kept.length;
			this.tables.set(key, kept);
		}
		if (n > 0) this.save();
		return n;
	}

	/** 心跳续期：该 owner 的全部认领延长 TTL（发 prompt 时调）。返回续期条数。 */
	touch(ownerConvId: string, now = Date.now()): number {
		let n = 0;
		for (const [key, table] of this.tables) {
			this.sweepTable(key, now);
			for (const c of this.tables.get(key) ?? table) {
				if (c.ownerConvId === ownerConvId) {
					c.expiresAt = now + CLAIM_TTL_MS;
					n++;
				}
			}
		}
		if (n > 0) this.save();
		return n;
	}

	/** 读某项目认领表（已扫过期，返回副本，调用方随便改）。 */
	list(cwd: string, now = Date.now()): Claim[] {
		const key = cwdKey(cwd);
		this.sweepTable(key, now);
		return (this.tables.get(key) ?? []).map((c) => ({ ...c }));
	}

	private sweepTable(key: string, now: number): void {
		const table = this.tables.get(key);
		if (!table || table.length === 0) return;
		const kept = table.filter((c) => c.expiresAt > now);
		if (kept.length !== table.length) {
			this.tables.set(key, kept);
			this.save();
		}
	}

	private load(): void {
		let raw = "";
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return; // 文件不存在 = 空表
		}
		try {
			const data = JSON.parse(raw) as { version?: unknown; tables?: unknown };
			if (!data || typeof data !== "object" || data.version !== CLAIMS_FILE_VERSION) return;
			if (!data.tables || typeof data.tables !== "object") return;
			for (const [key, rows] of Object.entries(data.tables as Record<string, unknown>)) {
				if (!Array.isArray(rows)) continue;
				const valid = rows.filter(isValidClaim).map((c) => ({
					...c,
					note: typeof c.note === "string" ? c.note : undefined,
				}));
				if (valid.length > 0) this.tables.set(key, valid);
			}
		} catch {
			// 坏文件丢弃（下次 save 覆盖重建），绝不抛错
			this.tables.clear();
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			// tmp 带进程唯一后缀：同机多实例（多 worktree/多开）写同一文件不互踩
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: CLAIMS_FILE_VERSION, tables: Object.fromEntries(this.tables) }));
			renameSync(tmp, this.file);
		} catch {
			// 持久化故障绝不能弄崩 server（内存表照常用）
		}
	}
}

/** 触碰集里命中认领表的条目（双方都 resolve 成绝对路径后比较）。 */
export function matchClaims(
	touches: TouchedFile[],
	claims: Claim[],
	cwd: string,
): { touch: TouchedFile; claim: Claim }[] {
	if (!Array.isArray(touches) || !Array.isArray(claims) || touches.length === 0 || claims.length === 0) return [];
	const byPath = new Map(claims.map((c) => [c.path, c]));
	const out: { touch: TouchedFile; claim: Claim }[] = [];
	for (const t of touches) {
		let abs: string;
		try {
			abs = resolve(cwd, normalizeTouchPath(t.path));
		} catch {
			continue;
		}
		const hit = byPath.get(abs);
		if (hit) out.push({ touch: t, claim: hit });
	}
	return out;
}

function sidecarPath(sessionFile: string): string {
	return `${sessionFile}.touches.json`;
}

/** 读触碰 sidecar（同步小文件；不存在/坏了 → undefined，调用方回落现算）。 */
export function readTouchSidecar(sessionFile: string | undefined): TouchedFile[] | undefined {
	if (typeof sessionFile !== "string" || !sessionFile) return undefined;
	let raw = "";
	try {
		if (statSync(sidecarPath(sessionFile)).size > 1024 * 1024) return undefined;
		raw = readFileSync(sidecarPath(sessionFile), "utf8");
	} catch {
		return undefined;
	}
	try {
		const data = JSON.parse(raw) as { files?: unknown };
		if (!data || !Array.isArray(data.files)) return undefined;
		const valid = data.files.filter(
			(f): f is TouchedFile => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string",
		);
		return valid.map((f) => ({
			path: f.path,
			count: typeof f.count === "number" && Number.isFinite(f.count) ? f.count : 1,
			lastTs: typeof f.lastTs === "number" && Number.isFinite(f.lastTs) ? f.lastTs : 0,
		}));
	} catch {
		return undefined;
	}
}

/** 写触碰 sidecar（读-合并-写；空集不写；全 best-effort， never throw）。 */
export async function mergeTouchSidecar(sessionFile: string | undefined, fresh: TouchedFile[]): Promise<void> {
	if (typeof sessionFile !== "string" || !sessionFile) return;
	if (!Array.isArray(fresh) || fresh.length === 0) return;
	try {
		const merged = unionTouchLists(readTouchSidecar(sessionFile) ?? [], fresh).slice(0, SIDECAR_MAX_ENTRIES);
		// tmp 带进程唯一后缀（同 client-state.ts 惯例）：避免并发进程互踩
		const tmp = `${sidecarPath(sessionFile)}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), files: merged }));
		renameSync(tmp, sidecarPath(sessionFile));
	} catch {
		// sidecar 只是加速+防压缩丢失，写坏了下次重算
	}
}

/** 删 sidecar（会话删除时顺带；不存在不报错）。 */
export function removeTouchSidecar(sessionFile: string | undefined): void {
	if (typeof sessionFile !== "string" || !sessionFile) return;
	try {
		unlinkSync(sidecarPath(sessionFile));
	} catch {
		// 不存在或删不掉都无所谓
	}
}
