/**
 * self-update-policy — may this install replace itself with `pi-web-ui@latest`?
 *
 * The top bar checks the npm registry for a newer pi-web-ui and offers to run
 * `npm i -g pi-web-ui@latest`. For the official package that is the right
 * source. A fork ships under the same name and installs into the same global
 * directory, so the same command replaces the fork — local fixes, service
 * wrapper and all — with the upstream build.
 *
 * A fork says so in its own package.json:
 *
 *   "piWebUiDistribution": { "selfUpdate": false }
 *
 * The marker travels inside the package, so it survives a rerun of
 * `server install` (which only bakes a fixed set of env vars into the unit).
 *
 * Fails closed: anything unreadable or unrecognised means "do not self-update".
 * Only a readable pi-web-ui manifest without the opt-out enables it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEBUI_PACKAGE = "pi-web-ui";

/** Whether a parsed package.json allows the registry self-update. */
export function isSelfUpdateEnabled(manifest: unknown): boolean {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
	const pkg = manifest as { name?: unknown; piWebUiDistribution?: unknown };
	if (pkg.name !== WEBUI_PACKAGE) return false;
	const marker = pkg.piWebUiDistribution;
	// No marker: the official package.
	if (marker === undefined) return true;
	// A marker that is not an object is a broken opt-out, not a missing one.
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
	return (marker as { selfUpdate?: unknown }).selfUpdate !== false;
}

/**
 * Resolve the policy for the package that contains `moduleUrl` (a `file:` URL,
 * normally `import.meta.url`): walk up from the module's directory to the
 * first package.json named pi-web-ui. Directories without a package.json and
 * manifests of other packages are skipped; an unreadable or unparsable
 * manifest on the way stops the walk with `false`.
 */
export function loadSelfUpdatePolicy(moduleUrl: string): boolean {
	try {
		let dir = dirname(fileURLToPath(moduleUrl));
		for (;;) {
			let text: string | null = null;
			try {
				text = readFileSync(join(dir, "package.json"), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
			if (text !== null) {
				const manifest: unknown = JSON.parse(text);
				if ((manifest as { name?: unknown } | null)?.name === WEBUI_PACKAGE) return isSelfUpdateEnabled(manifest);
			}
			const parent = dirname(dir);
			if (parent === dir) return false;
			dir = parent;
		}
	} catch {
		// Not a file: URL, or a manifest that does not parse.
		return false;
	}
}

export const WEBUI_SELF_UPDATE_ENABLED = loadSelfUpdatePolicy(import.meta.url);
