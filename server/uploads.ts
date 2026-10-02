/**
 * uploads — 文件对话上传的存储与清理。
 *
 * 上传文件落在 <dataDir>/uploads/<clientId>/<ts>-<name>（模型以绝对路径
 * reference 读取）。此前这里硬编码 ~/.pi-web，不吃 PI_WEB_DATA_DIR —— 已改为
 * 与 index.ts 相同的解析逻辑。清理策略：默认保留 14 天，启动时扫一次 +
 * 每 6 小时扫一次；PI_WEB_UPLOAD_RETENTION_DAYS 覆盖保留天数，0 = 关闭清理。
 * 全程 best-effort：清理失败绝不影响服务。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Same resolution as index.ts DATA_DIR — kept in sync by env contract. */
export function resolveDataDir(): string {
	return resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

export function uploadsRoot(dataDir = resolveDataDir()): string {
	return join(dataDir, "uploads");
}

/** Retention in days; 0 disables sweeping. */
export function uploadRetentionDays(): number {
	const v = Number(process.env.PI_WEB_UPLOAD_RETENTION_DAYS);
	return Number.isFinite(v) && v >= 0 ? v : 14;
}

/** clientId 白名单：clientId 来自浏览器自报（ws hello），却直接拼进上传目录
 *  路径 —— 只允许安全的单段字符（字母数字、:、_、-，1-128 长），否则可
 *  "../" 遍历写任意目录。不匹配整条拒绝抛错：绝不能静默换 randomUUID，
 *  上传目录必须与 ws 会话一一对应（编辑重问靠 uploadPath 按同一目录找回）。 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/** Persist an uploaded buffer; returns the absolute path + sanitized display name.
 *  clientId 不匹配白名单、displayName 为空 / "." / ".." 时抛错，调用方负责报错。 */
export function saveUpload(
	clientId: string,
	name: string,
	buf: Buffer,
	dataDir = resolveDataDir(),
): { abs: string; displayName: string } {
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		throw new Error(`Invalid upload clientId: ${JSON.stringify(clientId.slice(0, 129))}`);
	}
	// displayName 只取 basename 并拒绝 "." / ".."：防 ".." 与绝对路径拼接穿越
	// （最终文件名带 <ts>- 前缀兜底，这里从源头收紧）。
	const base = name.split(/[\\/]/).pop() ?? "";
	if (!base || base === "." || base === "..") {
		throw new Error(`Invalid upload name: ${JSON.stringify(name.slice(0, 129))}`);
	}
	const displayName = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80) || "file";
	const dir = join(uploadsRoot(dataDir), clientId);
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, `${Date.now()}-${displayName}`);
	writeFileSync(abs, buf);
	return { abs, displayName };
}

/**
 * Delete uploaded files older than the retention window, then prune client
 * dirs left empty. Returns { files, bytes, dirs } removed (best-effort:
 * individual failures are skipped).
 */
export async function cleanupUploads(
	dataDir = resolveDataDir(),
	retentionDays = uploadRetentionDays(),
): Promise<{ files: number; bytes: number; dirs: number }> {
	const out = { files: 0, bytes: 0, dirs: 0 };
	if (retentionDays <= 0) return out;
	const root = uploadsRoot(dataDir);
	if (!existsSync(root)) return out;

	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	let clients: string[];
	try {
		clients = await readdir(root);
	} catch {
		return out;
	}
	for (const clientId of clients) {
		const dir = join(root, clientId);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue; // not a dir / vanished
		}
		for (const entry of entries) {
			const abs = join(dir, entry);
			try {
				const st = await stat(abs);
				if (st.mtimeMs >= cutoff) continue;
				await rm(abs, { recursive: true });
				out.files++;
				out.bytes += st.size;
			} catch {
				// skip on any per-file failure
			}
		}
		try {
			if ((await readdir(dir)).length === 0) {
				await rmdirSafe(dir);
				out.dirs++;
			}
		} catch {
			// ignore
		}
	}
	return out;
}

async function rmdirSafe(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: false });
	} catch {
		// non-empty or race — fine
	}
}

/** Startup sweep + periodic re-sweep. Timer is unref'd so it never blocks exit. */
export function scheduleUploadCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
	void cleanupUploads().catch(() => {});
	const timer = setInterval(() => {
		void cleanupUploads().catch(() => {});
	}, intervalMs);
	timer.unref?.();
}
