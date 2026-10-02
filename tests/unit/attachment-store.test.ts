import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAttachmentStore, saveAttachment, findAttachment, readAttachment } from "../../server/attachment-store.js";

describe("attachment-store 内容寻址附件存储（CAS）", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-test-"));
		initAttachmentStore(tempDir);
		return () => {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		};
	});

	it("成功保存二进制附件并按 SHA-256 寻址", async () => {
		const data = Buffer.from("Hello attachment CAS test");
		const record = await saveAttachment(data, "image/png");

		expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(record.url).toBe(`/api/attachment/${record.hash}`);
		expect(record.size).toBe(data.length);
		expect(record.mimeType).toBe("image/png");
		expect(record.ext).toBe(".png");
	});

	it("同一内容的写入幂等去重", async () => {
		const data = Buffer.from("Identical content test");
		const rec1 = await saveAttachment(data, "image/jpeg");
		const rec2 = await saveAttachment(data, "image/jpeg");

		expect(rec1.hash).toBe(rec2.hash);
		expect(rec1.url).toBe(rec2.url);
	});

	it("readAttachment 可以正确读回内容与 MIME", async () => {
		const data = Buffer.from("Test read content 123456");
		const record = await saveAttachment(data, "image/webp");

		const hit = await readAttachment(record.hash);
		expect(hit).not.toBeNull();
		expect(hit!.buffer.toString()).toBe("Test read content 123456");
		expect(hit!.mimeType).toBe("image/webp");
	});

	it("防御路径穿越：非法 hash 拒绝读取", async () => {
		expect(await findAttachment("../../../etc/passwd")).toBeNull();
		expect(await readAttachment("../../secret")).toBeNull();
		expect(await findAttachment("short-hash")).toBeNull();
	});

	it("原子写：同 hash 并发保存全部成功，落盘唯一且无 .tmp 残留", async () => {
		const data = Buffer.from("concurrent atomic write probe");
		// 旧实现（existsSync 检查 + 原地 writeFile）在并发下会互相截断半个文件；
		// 新实现 tmp + rename，并发同 hash 各自 rename，Windows 上 EEXIST/EPERM
		// 视为成功（内容寻址同 hash 同内容）。
		const results = await Promise.all([saveAttachment(data), saveAttachment(data), saveAttachment(data)]);
		const hashes = new Set(results.map((r) => r.hash));
		expect(hashes.size).toBe(1);
		const leftover = readdirSync(join(tempDir, "attachments")).filter((f) => f.endsWith(".tmp"));
		expect(leftover).toEqual([]);
		const hit = await readAttachment(results[0].hash);
		expect(hit?.buffer.equals(data)).toBe(true);
	});

	it("findAttachment 跳过 .tmp 残留", async () => {
		const data = Buffer.from("tmp leftover probe");
		const rec = await saveAttachment(data);
		// 模拟崩溃残留：同前缀的 tmp 文件（后缀错乱）不能被当成附件命中
		writeFileSync(join(tempDir, "attachments", `${rec.hash}.deadbeef.tmp`), Buffer.from("junk"));
		const hit = await findAttachment(rec.hash);
		expect(hit?.ext).toBe(rec.ext);
		const read = await readAttachment(rec.hash);
		expect(read?.buffer.equals(data)).toBe(true);
	});
});
