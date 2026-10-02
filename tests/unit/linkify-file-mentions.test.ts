import { describe, expect, it } from "vitest";
import { linkifyFileMentions } from "../../web/src/components/Markdown";

describe("linkifyFileMentions", () => {
	it("converts simple file mentions to pi-file links", () => {
		const input = "请分析一下 @src/App.tsx 的性能";
		expect(linkifyFileMentions(input)).toBe("请分析一下 [@src/App.tsx](pi-file://src%2FApp.tsx) 的性能");
	});

	it("converts multiple file mentions in one line", () => {
		const input = "把 @auth.ts 的逻辑合并到 @login.ts";
		expect(linkifyFileMentions(input)).toBe(
			"把 [@auth.ts](pi-file://auth.ts) 的逻辑合并到 [@login.ts](pi-file://login.ts)",
		);
	});

	it("does NOT convert email addresses", () => {
		const input = "联系邮箱是 admin@example.com 和 support@pi.dev";
		expect(linkifyFileMentions(input)).toBe(input);
	});

	it("does NOT convert twitter/user handles without extension", () => {
		const input = "感谢 @alice 和 @bob 的贡献";
		expect(linkifyFileMentions(input)).toBe(input);
	});

	it("does NOT convert file mentions inside fenced code blocks", () => {
		const fence = String.fromCharCode(96, 96, 96);
		const input = ["前文", fence + "ts", 'const file = "@test.ts";', fence, "后文 @real.ts"].join(
			String.fromCharCode(10),
		);
		const expected = [
			"前文",
			fence + "ts",
			'const file = "@test.ts";',
			fence,
			"后文 [@real.ts](pi-file://real.ts)",
		].join(String.fromCharCode(10));
		expect(linkifyFileMentions(input)).toBe(expected);
	});

	it("does NOT convert file mentions inside inline code", () => {
		const tick = String.fromCharCode(96);
		const input = "运行 " + tick + "node script.js" + tick + " 命令，或查看 @main.py";
		expect(linkifyFileMentions(input)).toBe(
			"运行 " + tick + "node script.js" + tick + " 命令，或查看 [@main.py](pi-file://main.py)",
		);
	});

	it("handles parentheses and punctuation around mentions", () => {
		const input = "参考 (@config.json)，或者 (@data.csv)。";
		expect(linkifyFileMentions(input)).toBe(
			"参考 ([@config.json](pi-file://config.json))，或者 ([@data.csv](pi-file://data.csv))。",
		);
	});
});
