/**
 * attachment-store.ts — 基于 SHA-256 内容寻址（CAS）的附件存储。
 *
 * 借鉴 DSH 的 dsh-attachment 机制：
 *  - 图片与大二进制附件以 sha256 哈希落盘到 `<dataDir>/attachments/<hash>.<ext>`；
 *  - WebSocket 快照与会话转录中仅传递紧凑的 hash 引用与 URL；
 *  - 浏览器通过 `/api/attachment/:hash` 经 HTTP 访问，带永久强缓存（immutable）；
 *  - 避免快照和消息列表随会话进行出现数兆字节 base64 的膨胀。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

let storeDir = "";

/** 初始化附件存储目录（服务启动时调用）。 */
export function initAttachmentStore(dataDir: string): string {
	storeDir = join(dataDir, "attachments");
	if (!existsSync(storeDir)) {
		mkdirSync(storeDir, { recursive: true });
	}
	return storeDir;
}

/** 附件元数据。 */
export interface AttachmentRecord {
	hash: string;
	size: number;
	mimeType: string;
	ext: string;
	url: string;
	filePath: string;
}

const MIME_EXT_MAP: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"application/pdf": ".pdf",
};

const EXT_MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".pdf": "application/pdf",
};

/**
 * 将二进制内容写入附件存储（内容寻址，幂等）：
 * 已存在同哈希文件则直接返回元数据，不重复写盘。
 */
export async function saveAttachment(
	buffer: Buffer,
	mimeType = "application/octet-stream",
	preferredExt?: string,
): Promise<AttachmentRecord> {
	if (!storeDir) {
		throw new Error("AttachmentStore has not been initialized with initAttachmentStore(dataDir)");
	}
	const hash = createHash("sha256").update(buffer).digest("hex");
	const ext = preferredExt || MIME_EXT_MAP[mimeType] || ".bin";
	const fileName = `${hash}${ext}`;
	const filePath = join(storeDir, fileName);

	if (!existsSync(filePath)) {
		// 原地 writeFile 有两个问题：a) 同 hash 并发写时两个 writeFileSync
		// 交错会留下半个文件；b) 读方（/api/attachment/:hash）可能在写完前就命中。
		// 因此先写私有 tmp 再 rename（同目录内原子生效）。POSIX rename 原子覆盖；
		// Windows 目标已存在时报 EEXIST/EPERM —— 内容寻址同 hash 即同内容，
		// 并发对手落盘视为成功。tmp 命名带 uuid，绝不与真实附件名冲突。
		const tmpPath = `${filePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(tmpPath, buffer);
			await rename(tmpPath, filePath);
		} catch (err) {
			await rm(tmpPath, { force: true }).catch(() => {});
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EPERM") throw err;
		}
	}

	return {
		hash,
		size: buffer.length,
		mimeType,
		ext,
		url: `/api/attachment/${hash}`,
		filePath,
	};
}

/**
 * 根据哈希查找已存储的附件文件路径及元数据。
 */
export async function findAttachment(hash: string): Promise<AttachmentRecord | null> {
	if (!storeDir || !existsSync(storeDir)) return null;
	// 校验 hash 必须是 64 位十六进制字符串（防止目录遍历）
	if (!/^[a-f0-9]{64}$/i.test(hash)) return null;

	try {
		const files = readdirSync(storeDir);
		// 跳过原子写（tmp + rename）崩溃时可能残留的 .tmp —— 前缀同为 hash，
		// 若被命中会拿到错误的后缀与 MIME。
		const match = files.find((f) => f.startsWith(hash) && !f.endsWith(".tmp"));
		if (!match) return null;

		const filePath = join(storeDir, match);
		const st = await stat(filePath);
		const ext = extname(match).toLowerCase();
		const mimeType = EXT_MIME_MAP[ext] || "application/octet-stream";

		return {
			hash,
			size: st.size,
			mimeType,
			ext,
			url: `/api/attachment/${hash}`,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * 读取附件二进制数据。
 */
export async function readAttachment(hash: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
	const record = await findAttachment(hash);
	if (!record) return null;
	try {
		const buffer = await readFile(record.filePath);
		return { buffer, mimeType: record.mimeType };
	} catch {
		return null;
	}
}
