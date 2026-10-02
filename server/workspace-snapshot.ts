/**
 * server/workspace-snapshot.ts
 *
 * 工作区版本影子快照机制（Workspace Snapshot / Dual-State Rollback）。
 *
 * 每次用户发起新任务或运行关键操作前，为当前工作区记录轻量快照引用（Git commit SHA）。
 * 机制：
 * - 利用独立的临时 GIT_INDEX_FILE，通过 `git add -A` + `git write-tree` + `git commit-tree` 生成独立 commit；
 * - 绝不改变用户现有的 HEAD、branch 指针、工作区文件或 .git/index；
 * - 回滚时若启用 restoreWorkspace，通过 `git checkout <snapshotRef> -- .` 与 `git clean -fd` 还原物理文件。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./scm.js";

const exec = promisify(execFile);

/** 单次 git 快照/还原命令超时时间（毫秒）。 */
const GIT_SNAPSHOT_TIMEOUT_MS = 15_000;

/** 执行单条 git 命令，返回 stdout。 */
async function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
		cwd,
		env: envExtra ? { ...process.env, ...envExtra } : process.env,
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout.trim();
}

/** 检查工作区是否由 Git 管理。 */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
	return (await gitDirOf(cwd)) !== null;
}

/**
 * 为当前工作区创建轻量版本快照。
 * 若当前目录不在 Git 仓库内，返回 null。
 *
 * 该操作纯粹在临时 index 文件中完成，绝不影响用户的实际 index 或 HEAD。
 */
export async function createWorkspaceSnapshot(cwd: string): Promise<string | null> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) return null;

	const tempIndex = join(gitDir, `temp-index-snapshot-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: tempIndex };

	try {
		// 1. 将当前工作区所有改动（含未跟踪与新增）记录到临时 index
		await runGit(cwd, ["add", "-A"], env);

		// 2. 写入 tree 对象
		const tree = await runGit(cwd, ["write-tree"], env);
		if (!tree) return null;

		// 3. 检查是否有 HEAD commit 作为 parent
		let hasHead = false;
		try {
			await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
			hasHead = true;
		} catch {
			hasHead = false;
		}

		// 4. 创建轻量 commit 对象，不关联任何分支引用
		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGit(cwd, commitArgs, env);
		return commitHash || null;
	} catch (err) {
		console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, (err as Error).message);
		return null;
	} finally {
		// 务必清理临时 index 文件
		try {
			await rm(tempIndex, { force: true });
		} catch {
			// ignore cleanup error
		}
	}
}

/**
 * 将工作区物理文件还原到指定的快照状态。
 *
 * 执行步骤：
 * 1. `git read-tree -u --reset <snapshotRef>` 将 index 与工作区重置为快照树，并删除快照之后新增的文件；
 * 2. `git clean -fd` 清理快照之后新增的未跟踪文件与空目录。
 */
export async function restoreWorkspaceSnapshot(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) {
		return { success: false, error: "Workspace is not a Git repository" };
	}

	try {
		// 验证 snapshotRef 合法性
		await runGit(cwd, ["rev-parse", "--verify", snapshotRef]);

		// 1. 将 index 和工作区彻底重置到快照树状态（自动清除快照中不存在的文件）
		await runGit(cwd, ["read-tree", "-u", "--reset", snapshotRef]);

		// 2. 清理新产生的未跟踪文件与目录
		await runGit(cwd, ["clean", "-fd"]);

		return { success: true };
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[workspace-snapshot] 还原快照失败 (${cwd}, ${snapshotRef}):`, msg);
		return { success: false, error: msg };
	}
}
