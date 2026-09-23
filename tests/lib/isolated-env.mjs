/** Never let test servers inherit the user's live data or agent directories. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolatedTestEnv(label, inherited = process.env) {
	const root = mkdtempSync(join(tmpdir(), `pi-smoke-${label}-`));
	return {
		env: {
			...inherited,
			PI_WEB_DATA_DIR: join(root, "data"),
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_WEB_PLUGIN_CATALOG_URL: "off",
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
