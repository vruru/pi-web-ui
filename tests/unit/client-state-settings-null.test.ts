import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

/** saveSettings 的 null 清除语义：visionBridgeModel / subagentDefaultModel 以
 *  null 为合法值（"清除，跟随主对话"）。合并必须按键存在性而不是 `??`——
 *  `null ?? cur` 会把旧值写回磁盘，设置面板清空后重启又复活。 */
describe("ClientStateStore.saveSettings null 清除语义", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-null-test-"));
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

	it("传 null 能清除 visionBridgeModel / subagentDefaultModel", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/old", subagentDefaultModel: "provider/other" });
		expect(store.getSettings("c1").visionBridgeModel).toBe("provider/old");
		expect(store.getSettings("c1").subagentDefaultModel).toBe("provider/other");

		store.saveSettings("c1", { visionBridgeModel: null, subagentDefaultModel: null });
		expect(store.getSettings("c1").visionBridgeModel).toBeNull();
		expect(store.getSettings("c1").subagentDefaultModel).toBeNull();
	});

	it("不传该 key 时保持旧值（partial 合并不受影响）", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/keep-me" });
		store.saveSettings("c1", { promptMode: "replace" });
		expect(store.getSettings("c1").visionBridgeModel).toBe("provider/keep-me");
		expect(store.getSettings("c1").promptMode).toBe("replace");
	});

	it("null 清除结果落盘：新实例（模拟重启）后仍是 null，不复活旧值", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/old" });
		store.saveSettings("c1", { visionBridgeModel: null });

		const reopened = new ClientStateStore(file);
		expect(reopened.getSettings("c1").visionBridgeModel).toBeNull();
	});
});
