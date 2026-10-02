/**
 * 服务端下发文案的双语回归（issue: 英文界面仍见中文预设/审批提示）。
 *
 * 背景：界面语言开关（i18n.setLocale）只换前端文案；凡是服务端 name/reason
 * 字段一路原样渲染的，英文用户就会看到中文。三处曾经漏了：
 *   1. PI_AGENT_PRESETS / PI_PERMISSION_OPTIONS 只有中文 name/description；
 *   2. 审批弹窗写 `reason || reasonEn`（reason 恒存在 → 永远中文）；
 *   3. 预设/权限选项的 tooltip 优先取服务端 description。
 *
 * 这里钉住不变量：内置预设与权限档必须两种语言都给全，且 *En 不得含中文。
 */
import { describe, expect, it } from "vitest";
import {
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	localizedDescription,
	localizedName,
} from "../../server/tool-manager.js";
import { DEFAULT_APPROVAL_RULES } from "../../server/approval-rules.js";

/** CJK Unified Ideographs —— 只要命中就是漏翻译。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe("预设/权限文案双语（server → client）", () => {
	it("每个内置预设都带英文名与英文描述，且不含中文", () => {
		for (const p of PI_AGENT_PRESETS) {
			expect(p.nameEn, `${p.id} 缺 nameEn`).toBeTruthy();
			expect(p.descriptionEn, `${p.id} 缺 descriptionEn`).toBeTruthy();
			expect(p.nameEn).not.toMatch(CJK);
			expect(p.descriptionEn).not.toMatch(CJK);
		}
	});

	it("每个权限档都带英文名与英文描述，且不含中文", () => {
		for (const o of PI_PERMISSION_OPTIONS) {
			expect(o.nameEn, `${o.value} 缺 nameEn`).toBeTruthy();
			expect(o.descriptionEn, `${o.value} 缺 descriptionEn`).toBeTruthy();
			expect(o.nameEn).not.toMatch(CJK);
			expect(o.descriptionEn).not.toMatch(CJK);
		}
	});

	it("localizedName: zh 用 name，其它语言用 nameEn（缺 En 时回落 name）", () => {
		const preset = PI_AGENT_PRESETS[0];
		expect(localizedName(preset, "zh")).toBe(preset.name);
		expect(localizedName(preset, "en")).toBe(preset.nameEn);
		expect(localizedName(preset, "ja")).toBe(preset.nameEn); // 其它语言包同口径回落英文
		expect(localizedName({ name: "只有中文" }, "en")).toBe("只有中文"); // 无 En → 不空白
		expect(localizedName(undefined, "en", "全功能")).toBe("全功能");
	});

	it("localizedDescription: 同样双语回落", () => {
		const preset = PI_AGENT_PRESETS[0];
		expect(localizedDescription(preset, "zh")).toBe(preset.description);
		expect(localizedDescription(preset, "en")).toBe(preset.descriptionEn);
		expect(localizedDescription({ description: "只有中文" }, "en")).toBe("只有中文");
		expect(localizedDescription(undefined, "en")).toBeUndefined();
	});
});

describe("审批规则文案双语（rm -rf 等高危检测）", () => {
	it("每条内置规则都带 labelEn/reasonEn，且不含中文", () => {
		for (const r of DEFAULT_APPROVAL_RULES) {
			expect(r.labelEn, `${r.id} 缺 labelEn`).toBeTruthy();
			expect(r.reasonEn, `${r.id} 缺 reasonEn`).toBeTruthy();
			expect(r.labelEn).not.toMatch(CJK);
			expect(r.reasonEn).not.toMatch(CJK);
		}
	});

	it("rm -rf 规则的英文文案确实存在（弹窗按语言取 reasonEn）", () => {
		const rule = DEFAULT_APPROVAL_RULES.find((r) => r.id === "builtin.bash.rm-rf");
		expect(rule?.reasonEn).toContain("rm -rf");
		expect(rule?.labelEn).toContain("rm -rf");
	});
});
