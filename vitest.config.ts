import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// 纯函数单测：毫秒级、零 token、零端口 —— CI 必跑。
		// 端到端脚本（tests/*-test.mjs）不在这里：它们自起 server，用
		// `npm run test:smoke` / 单独 node 运行。
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
