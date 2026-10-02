import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceSnapshot, isGitWorkspace, restoreWorkspaceSnapshot } from "../../server/workspace-snapshot.js";

describe("工作区版本影子快照与双向联动回滚 (Dual-State Rollback)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-test-snap-"));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("非 Git 目录下能够安全降级并返回 null", async () => {
		const isGit = await isGitWorkspace(testDir);
		expect(isGit).toBe(false);

		const snapshot = await createWorkspaceSnapshot(testDir);
		expect(snapshot).toBeNull();

		const restoreRes = await restoreWorkspaceSnapshot(testDir, "dummy-ref");
		expect(restoreRes.success).toBe(false);
		expect(restoreRes.error).toContain("not a Git repository");
	});

	it("在 Git 仓库中创建快照，并在文件被篡改后完整还原 (Dual-State Rollback)", async () => {
		// 1. 初始化 Git 仓库
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		// 初始文件
		writeFileSync(join(testDir, "file1.txt"), "hello v1\n");
		writeFileSync(join(testDir, "file2.txt"), "config v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });

		// 2. 创建快照 1（工作区干净状态）
		const snapshot1 = await createWorkspaceSnapshot(testDir);
		expect(snapshot1).toBeTruthy();
		expect(typeof snapshot1).toBe("string");

		// 3. 修改文件并新增未跟踪文件
		writeFileSync(join(testDir, "file1.txt"), "hello v2 MODIFIED\n");
		writeFileSync(join(testDir, "untracked.txt"), "untracked file content\n");

		// 4. 创建快照 2（包含未跟踪文件和修改）
		const snapshot2 = await createWorkspaceSnapshot(testDir);
		expect(snapshot2).toBeTruthy();
		expect(snapshot2).not.toEqual(snapshot1);

		// 5. 再次对工作区进行破坏性修改：删除 file2，新增 junk.txt
		rmSync(join(testDir, "file2.txt"));
		writeFileSync(join(testDir, "junk.txt"), "junk content\n");
		writeFileSync(join(testDir, "file1.txt"), "hello v3 DESTROYED\n");

		// 6. 还原到快照 2
		const restore2 = await restoreWorkspaceSnapshot(testDir, snapshot2!);
		expect(restore2.success).toBe(true);

		// 验证还原状态与快照 2 一致
		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v2 MODIFIED\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(readFileSync(join(testDir, "untracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"untracked file content\n",
		);
		expect(existsSync(join(testDir, "junk.txt"))).toBe(false);

		// 7. 还原到快照 1
		const restore1 = await restoreWorkspaceSnapshot(testDir, snapshot1!);
		expect(restore1.success).toBe(true);

		// 验证还原状态与快照 1 一致（未跟踪文件也被清理）
		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v1\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(existsSync(join(testDir, "untracked.txt"))).toBe(false);
	}, 20000);
});
