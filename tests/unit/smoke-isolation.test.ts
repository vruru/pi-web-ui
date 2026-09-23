import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { isolatedTestEnv } from "../lib/isolated-env.mjs";

it("test subprocesses override live data and agent paths, without altering the live control socket", () => {
	const live = isolatedTestEnv("live-fixture");
	const test = isolatedTestEnv("child-fixture", live.env);
	try {
		mkdirSync(live.env.PI_WEB_DATA_DIR, { recursive: true });
		const control = join(live.env.PI_WEB_DATA_DIR, "pi-web-ui.sock");
		writeFileSync(control, "live socket sentinel");
		const child = spawnSync(
			process.execPath,
			[
				"-e",
				`
			const fs = require('node:fs');
			const path = require('node:path');
			fs.mkdirSync(process.env.PI_WEB_DATA_DIR, {recursive:true});
			fs.writeFileSync(path.join(process.env.PI_WEB_DATA_DIR,'pi-web-ui.sock'),'test socket');
			console.log(JSON.stringify([process.env.PI_WEB_DATA_DIR, process.env.PI_CODING_AGENT_DIR]));
		`,
			],
			{ env: test.env, encoding: "utf8" },
		);
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual([test.env.PI_WEB_DATA_DIR, test.env.PI_CODING_AGENT_DIR]);
		expect(test.env.PI_WEB_DATA_DIR).not.toBe(live.env.PI_WEB_DATA_DIR);
		expect(test.env.PI_CODING_AGENT_DIR).not.toBe(live.env.PI_CODING_AGENT_DIR);
		expect(readFileSync(control, "utf8")).toBe("live socket sentinel");
		test.cleanup();
		expect(existsSync(test.env.PI_WEB_DATA_DIR)).toBe(false);
		expect(readFileSync(control, "utf8")).toBe("live socket sentinel");
	} finally {
		test.cleanup();
		live.cleanup();
	}
});
