/**
 * Build the chained shell command for updating pi components in a visible
 * terminal tab. The command depends on WHERE each component lives:
 *
 * - "package" (pi extensions, installed under <agentDir>/npm — e.g.
 *   ~/.pi/agent/npm): first re-register an unpinned source, then update it.
 *   Pi silently skips `npm:<name>@<version>` during `pi update` while still
 *   printing "Updated"; `pi install npm:<name>` replaces that source in
 *   settings, and the following `pi update` installs the latest version.
 * - "git-extension" (git-source pi extensions, cloned under <agentDir>/git):
 *   `pi update git:<host>/<path>` — the `git:` prefix is required (a bare
 *   `host/path` fails with "No matching package found"; issue #178).
 * - "pi-core" / "webui" (globally installed via npm): `npm i -g <name>@latest`.
 *
 * Multiple targets are joined with `;` so a failing step never blocks the
 * rest. Pure — unit-tested.
 */
export interface UpdateTarget {
	name: string;
	kind: "webui" | "pi-core" | "package" | "git-extension";
	/** git-extension only: `host/path` shorthand carried from update_status_all. */
	source?: string;
}

export function buildUpdateCommand(targets: UpdateTarget[]): string {
	return targets
		.map((t) =>
			t.kind === "package"
				? `pi install npm:${t.name} && pi update npm:${t.name}`
				: t.kind === "git-extension"
					? `pi update ${toGitUpdateArg(t.source ?? t.name)}`
					: `npm i -g ${t.name}@latest`,
		)
		.join("; ");
}

/** `host/path` → `git:host/path` (already-prefixed values pass through). */
function toGitUpdateArg(source: string): string {
	return source.startsWith("git:") ? source : `git:${source}`;
}
