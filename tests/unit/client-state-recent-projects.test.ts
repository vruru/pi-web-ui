import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

describe("ClientStateStore 最近项目删除全局持久化", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-test-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("在 client A 删除的项目，对新 client B 同样保持删除状态（全局 tombstone）", () => {
		store.remember("clientA", "/path/to/project1");
		store.remember("clientA", "/path/to/project2");
		store.remember("clientB", "/path/to/project1");

		// clientA 移除 project1
		store.removeProject("clientA", "/path/to/project1");

		// clientA 和 clientB 以及全新 clientC 均应视 project1 为已移除
		expect(store.getRemovedProjects("clientA")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).toContain("/path/to/project1");

		// clientB 的 projects 列表中也应被移除
		expect(store.get("clientB").projects.map((p) => p.path)).not.toContain("/path/to/project1");
	});

	it("服务重启（新 ClientStateStore 实例）后 tombstone 依然有效", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");

		const reopened = new ClientStateStore(file);
		expect(reopened.getRemovedProjects("brandNewClient")).toContain("/path/to/project1");
	});

	it("用户显式重新打开该项目时，清除全局 tombstone", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");

		// 用户重新打开 project1
		store.remember("clientB", "/path/to/project1");

		expect(store.getRemovedProjects("clientA")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).not.toContain("/path/to/project1");
	});

	it("路径大小写或斜杠不一致时，依然能正确移出并匹配 tombstone (Windows 归一化)", () => {
		const originalPath = process.platform === "win32" ? "C:\\Users\\test\\ProjectA" : "/Users/test/ProjectA";
		const variantPath = process.platform === "win32" ? "c:\\users\\test\\projecta" : "/Users/test/ProjectA";

		store.remember("clientA", originalPath);
		expect(store.get("clientA").projects.length).toBe(1);

		// 使用不同大小写移出
		store.removeProject("clientA", variantPath);

		// 两个形态都应被识别为已移出
		expect(store.get("clientA").projects.length).toBe(0);
		const removed = store.getRemovedProjects("clientB");
		expect(removed.some((p) => p.toLowerCase() === originalPath.toLowerCase())).toBe(true);
	});

	it("启动/加载时自动将老 client 中的 removedProjects 迁移到全局 __settings__", () => {
		// 模拟老版本写入的 client-state.json：只有 clientOld 记了 removedProjects，__settings__ 为空
		const oldContent = {
			clientOld: {
				projects: [],
				removedProjects: ["/legacy/path/to/projectX"],
			},
			__settings__: {
				projects: [],
			},
		};
		writeFileSync(file, JSON.stringify(oldContent, null, 2) + "\n");

		// 新实例加载
		const newStore = new ClientStateStore(file);
		// 全新 client 应该能继承老 client 的墓碑
		expect(newStore.getRemovedProjects("brandNewClient")).toContain("/legacy/path/to/projectX");
	});

	it("getRecentProjects 跨 client 聚合且过滤墓碑与不存在目录", () => {
		// dir 本身存在
		store.remember("clientA", dir);
		// 不存在的目录
		store.remember("clientB", join(dir, "non-existent-subfolder"));

		const recentA = store.getRecentProjects("clientA");
		expect(recentA.map((p) => p.path)).toContain(dir);
		expect(recentA.map((p) => p.path)).not.toContain(join(dir, "non-existent-subfolder"));

		// 全新 client 也能跨 client 获取到存在的 dir
		const recentBrandNew = store.getRecentProjects("brandNewClient");
		expect(recentBrandNew.map((p) => p.path)).toContain(dir);

		// 移除 dir 后，即使是 brandNewClient 也获取不到
		store.removeProject("clientA", dir);
		const recentAfterRemove = store.getRecentProjects("brandNewClient");
		expect(recentAfterRemove.map((p) => p.path)).not.toContain(dir);
	});

	it("mergeDiscoveredProjects 能合并新发现的项目并尊重墓碑", () => {
		store.removeProject("clientA", dir);
		store.mergeDiscoveredProjects([{ path: dir, lastUsed: 12345 }]);

		// 墓碑依然生效
		expect(store.getRecentProjects("clientA").map((p) => p.path)).not.toContain(dir);
	});
});
