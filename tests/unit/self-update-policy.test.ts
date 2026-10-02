import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isSelfUpdateEnabled,
	loadSelfUpdatePolicy,
	WEBUI_SELF_UPDATE_ENABLED,
} from "../../server/self-update-policy.js";

/**
 * A fork installs under the same name and into the same global directory as
 * the official package, so `npm i -g pi-web-ui@latest` replaces it with the
 * upstream build. The fork opts out in its own package.json; everything the
 * policy cannot read or recognise also counts as "do not self-update".
 */
describe("isSelfUpdateEnabled", () => {
	it("allows the official package (no distribution marker)", () => {
		expect(isSelfUpdateEnabled({ name: "pi-web-ui", version: "0.97.0" })).toBe(true);
	});

	it("is disabled by selfUpdate: false", () => {
		expect(isSelfUpdateEnabled({ name: "pi-web-ui", piWebUiDistribution: { selfUpdate: false } })).toBe(false);
	});

	it("only the literal false disables it", () => {
		for (const selfUpdate of [true, undefined, null, 0, "", "false"]) {
			expect(isSelfUpdateEnabled({ name: "pi-web-ui", piWebUiDistribution: { selfUpdate } }), String(selfUpdate)).toBe(
				true,
			);
		}
		expect(isSelfUpdateEnabled({ name: "pi-web-ui", piWebUiDistribution: {} })).toBe(true);
	});

	it("treats a marker that is not an object as disabled", () => {
		for (const marker of [null, false, "fork", 1, []]) {
			expect(isSelfUpdateEnabled({ name: "pi-web-ui", piWebUiDistribution: marker }), String(marker)).toBe(false);
		}
	});

	it("rejects anything that is not a pi-web-ui manifest", () => {
		for (const manifest of [undefined, null, "pi-web-ui", 1, [], {}, { name: "other" }, { name: ["pi-web-ui"] }]) {
			expect(isSelfUpdateEnabled(manifest), JSON.stringify(manifest)).toBe(false);
		}
	});
});

describe("loadSelfUpdatePolicy", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-web-self-update-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Create `<root>/<dir>` and return the URL of a policy module inside it. */
	function moduleIn(dir: string): string {
		mkdirSync(join(root, dir), { recursive: true });
		return pathToFileURL(join(root, dir, "self-update-policy.js")).href;
	}
	function writeManifest(dir: string, manifest: unknown): void {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
	}

	it("finds the fork marker from server/ and from dist/server/", () => {
		writeManifest(".", { name: "pi-web-ui", piWebUiDistribution: { selfUpdate: false } });
		expect(loadSelfUpdatePolicy(moduleIn("server"))).toBe(false);
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);
	});

	it("allows the official package from server/ and from dist/server/", () => {
		writeManifest(".", { name: "pi-web-ui", version: "0.97.0" });
		expect(loadSelfUpdatePolicy(moduleIn("server"))).toBe(true);
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(true);
	});

	it("is disabled when no pi-web-ui package.json exists", () => {
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);
	});

	it("is disabled when the module directory itself is missing", () => {
		expect(loadSelfUpdatePolicy(pathToFileURL(join(root, "gone", "dist", "server", "x.js")).href)).toBe(false);
	});

	it("is disabled by a package.json that does not parse", () => {
		mkdirSync(join(root, "dist/server"), { recursive: true });
		writeFileSync(join(root, "package.json"), '{ "name": "pi-web-ui", ');
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);
	});

	it("is disabled by a package.json that cannot be read", () => {
		// A directory named package.json: readFileSync fails with EISDIR, not ENOENT.
		mkdirSync(join(root, "package.json"));
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);
	});

	it("does not look past a broken manifest for a valid one", () => {
		writeManifest(".", { name: "pi-web-ui" });
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "package.json"), "not json");
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);
	});

	it("skips manifests of other packages on the way up", () => {
		writeManifest(".", { name: "pi-web-ui", piWebUiDistribution: { selfUpdate: false } });
		writeManifest("dist", { type: "module" });
		writeManifest("dist/server", { name: "other" });
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(false);

		writeManifest(".", { name: "pi-web-ui" });
		expect(loadSelfUpdatePolicy(moduleIn("dist/server"))).toBe(true);
	});

	it("uses the nearest pi-web-ui manifest, not an outer one", () => {
		// Fork installed under its own prefix, below a directory that holds the official package.
		writeManifest(".", { name: "pi-web-ui" });
		writeManifest("prefix/lib/node_modules/pi-web-ui", {
			name: "pi-web-ui",
			piWebUiDistribution: { selfUpdate: false },
		});
		expect(loadSelfUpdatePolicy(moduleIn("prefix/lib/node_modules/pi-web-ui/dist/server"))).toBe(false);
	});

	it("is disabled for anything but a file: URL", () => {
		expect(loadSelfUpdatePolicy("https://example.com/dist/server/self-update-policy.js")).toBe(false);
		expect(loadSelfUpdatePolicy(join(root, "dist", "server", "self-update-policy.js"))).toBe(false);
	});
});

describe("WEBUI_SELF_UPDATE_ENABLED", () => {
	it("reflects this checkout's own package.json", () => {
		const manifest = JSON.parse(
			readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
		) as unknown;
		expect(WEBUI_SELF_UPDATE_ENABLED).toBe(isSelfUpdateEnabled(manifest));
	});
});
