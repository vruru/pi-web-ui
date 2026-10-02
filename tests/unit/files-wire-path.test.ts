/**
 * files-wire-path.test.ts — workspacePath / isAbsoluteWirePath 的 Windows 绕过
 * 回归（盘符相对路径 "D:x"、UNC "\\host\share"、跨盘 relative 返回绝对路径）
 * 与 uploadFile 的保留名 / 尾点 / 已存在拒绝语义。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService, isAbsoluteWirePath, workspacePath } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-wirepath-test-"));
	dirs.push(dir);
	return dir;
}

describe("isAbsoluteWirePath", () => {
	it("通用形态：机器根 / posix 绝对 / UNC 斜杠形式 / 相对", () => {
		expect(isAbsoluteWirePath("@root")).toBe(true);
		expect(isAbsoluteWirePath("/etc/passwd")).toBe(true);
		expect(isAbsoluteWirePath("//host/share")).toBe(true);
		expect(isAbsoluteWirePath("a/b")).toBe(false);
		expect(isAbsoluteWirePath("")).toBe(false);
	});
	describe.skipIf(process.platform !== "win32")("win32 专属", () => {
		it("盘符绝对、裸盘符、盘符相对路径（冒号后无分隔符）都判绝对", () => {
			expect(isAbsoluteWirePath("C:/Users/x")).toBe(true);
			expect(isAbsoluteWirePath("C:\\Users\\x")).toBe(true);
			expect(isAbsoluteWirePath("C:")).toBe(true);
			// 回归：resolve("C:/ws", "D:x") 会落到 D: 的当前目录，此前被当相对路径
			expect(isAbsoluteWirePath("D:x")).toBe(true);
		});
		it("反斜杠 UNC 判绝对", () => {
			expect(isAbsoluteWirePath("\\\\host\\share")).toBe(true);
		});
		it("workspacePath 拒绝盘符相对 / UNC / 跨盘目标", () => {
			const root = tempRoot();
			expect(workspacePath(root, "D:x")).toBeNull();
			expect(workspacePath(root, "\\\\host\\share")).toBeNull();
			expect(workspacePath(root, "//host/share")).toBeNull();
			expect(workspacePath(root, `${root[0] === "C" ? "D" : "C"}:/Windows`)).toBeNull();
		});
	});
	describe.skipIf(process.platform === "win32")("posix 专属", () => {
		it('posix 上 "C:x" 是合法相对文件名，不算绝对 wire 路径', () => {
			expect(isAbsoluteWirePath("C:x")).toBe(false);
		});
	});
});

describe("workspacePath", () => {
	it("工作区内相对路径照常解析（跨平台回归）", () => {
		const root = tempRoot();
		const wp = workspacePath(root, "sub/file.txt");
		expect(wp).not.toBeNull();
		expect(wp!.rel).toBe("sub/file.txt");
		expect(wp!.abs.toLowerCase().startsWith(root.toLowerCase())).toBe(true);
	});
	it('".." 逃逸照旧拒绝（跨平台回归）', () => {
		const root = tempRoot();
		expect(workspacePath(root, "../escape.txt")).toBeNull();
		expect(workspacePath(root, "a/../../escape.txt")).toBeNull();
	});
	// 回归：跨盘/UNC 时 relative() 返回绝对路径（不以 ".." 开头），此前只查
	// ".." 放行了这些输入。root 换盘符后 resolve 直接落在别的盘上。
	describe.skipIf(process.platform !== "win32")("win32 跨盘 relative 返回绝对路径", () => {
		it("拒绝其它盘符的绝对目标", () => {
			const root = tempRoot();
			const other = `${root[0] === "C" ? "D" : "C"}:\\somewhere`;
			expect(workspacePath(root, other)).toBeNull();
		});
	});
});

function makeService(cwd: string) {
	const seen: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
	});
	return { svc, seen };
}

describe("uploadFile 文件名与覆盖语义", () => {
	it("尾点 / 纯点文件名拒绝", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		const data = Buffer.from("hi").toString("base64");
		await svc.uploadFile("", "a..", data);
		await svc.uploadFile("", "..", data);
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(2);
		expect(existsSync(join(cwd, "a.."))).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("Windows 保留名拒绝", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		await svc.uploadFile("", "con.txt", Buffer.from("hi").toString("base64"));
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(existsSync(join(cwd, "con.txt"))).toBe(false);
	});

	it("目标已存在时拒绝而不是静默覆盖（与 file-transfer 路由同语义）", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		writeFileSync(join(cwd, "a.txt"), "keep");
		await svc.uploadFile("", "a.txt", Buffer.from("overwritten").toString("base64"));
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("keep");
	});

	it("正常上传照常工作", async () => {
		const cwd = tempRoot();
		const { svc, seen } = makeService(cwd);
		await svc.uploadFile("sub", "b.txt", Buffer.from("hello").toString("base64"));
		expect(readFileSync(join(cwd, "sub", "b.txt"), "utf8")).toBe("hello");
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(0);
	});
});
