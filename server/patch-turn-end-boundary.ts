/**
 * turn_end boundary error patch for @earendil-works/pi-coding-agent (issue #411).
 *
 * In SDK 0.87+, when an in-flight turn is aborted or torn down before its assistant
 * message is persisted, `_dispatchTurnEndBoundary()` in `agent-session.js` calls
 * `this._extensionRunner.emitError({ event: "turn_end", error: "turn_end could not resolve..." })`
 * right before returning `false`, causing false-positive extension errors to flood
 * both the main conversation and subagents.
 *
 * This module idempotently patches `agent-session.js` in the installed SDK to
 * silently skip the boundary (`return false`) without emitting an error, matching
 * the upstream issue expectation (earendil-works/pi#10149).
 *
 * Same pattern as patch-remote-catalog.ts and patch-node-pty.ts: best-effort, idempotent,
 * and skips gracefully if the SDK code structure differs or is already fixed upstream.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sdkCopies } from "./sdk-origin.js";

export const TARGET_PATTERN =
	/if\s*\(!messageEntryId\)\s*\{\s*this\._extensionRunner\.emitError\(\{\s*extensionPath:\s*"<boundary>",\s*event:\s*"turn_end",\s*error:\s*"turn_end could not resolve the persisted assistant entry ID",\s*\}\);\s*return false;\s*\}/;

export const PATCHED_SENTINEL = "// pi-web-ui patch (issue #411: silent turn_end on aborted turns)";

export const REPLACEMENT = `if (!messageEntryId) {
            ${PATCHED_SENTINEL}
            return false;
        }`;

/**
 * 纯函数：给定 agent-session.js 内容，返回打补丁后的内容。
 * - 命中目标代码段 → 替换并返回新内容；
 * - 已打过补丁（含 PATCHED_SENTINEL）→ 原样返回；
 * - 目标代码段未命中（上游已修复或版本不匹配）→ 原样返回，静默跳过。
 */
export function patchAgentSessionSource(src: string): { patched: boolean; code: string } {
	if (src.includes(PATCHED_SENTINEL)) {
		return { patched: false, code: src };
	}
	if (!TARGET_PATTERN.test(src)) {
		return { patched: false, code: src };
	}
	return { patched: true, code: src.replace(TARGET_PATTERN, REPLACEMENT) };
}

/**
 * Only the copy shipped inside this package is patched. An ancestor/global SDK (followed
 * via resolve-global-sdk) belongs to the user: the pi CLI runs the same files and the core
 * updater replaces them. For that copy the boundary error is dropped where it is reported
 * instead (isTurnEndBoundaryNoise).
 */
export function candidateAgentSessionFiles(copies: { path: string }[] = sdkCopies()): string[] {
	const bundled = copies[0];
	return bundled ? [join(dirname(bundled.path), "dist", "core", "agent-session.js")] : [];
}

/** The false-positive this patch removes, as seen by an extension error handler. */
export function isTurnEndBoundaryNoise(err: { extensionPath?: string; event?: string; error?: string }): boolean {
	return (
		err?.extensionPath === "<boundary>" &&
		err?.event === "turn_end" &&
		typeof err?.error === "string" &&
		err.error.includes("turn_end could not resolve the persisted assistant entry ID")
	);
}

export function applyPatch(): void {
	for (const file of candidateAgentSessionFiles()) {
		try {
			if (!existsSync(file)) continue;
			const src = readFileSync(file, "utf8");
			const { patched, code } = patchAgentSessionSource(src);
			if (patched) {
				writeFileSync(file, code, "utf8");
			}
		} catch {
			// best-effort
		}
	}
}

applyPatch();
