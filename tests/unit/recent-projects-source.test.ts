import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import type { ProjectSummary } from "../../server/protocol.js";

for (const Session of [ClientSession, DshClientSession]) {
	describe(`${Session.name} recent project sources`, () => {
		let dir: string;
		let store: ClientStateStore;
		let published: ProjectSummary[];
		let session: ClientSession | DshClientSession;
		let workspace: string;
		let incidental: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "pi-recent-projects-"));
			workspace = join(dir, "opened-workspace");
			incidental = join(dir, "agent-working-directory");
			mkdirSync(workspace);
			mkdirSync(incidental);
			const sessionRoot = join(dir, "sessions");
			// A real DSH-shaped session directory must not become a project.
			mkdirSync(join(sessionRoot, `--${incidental.replaceAll("/", "-")}--`), { recursive: true });
			vi.spyOn(SessionManager, "listAll").mockResolvedValue([
				{ cwd: incidental, modified: new Date() } as Awaited<ReturnType<typeof SessionManager.listAll>>[number],
			]);
			store = new ClientStateStore(join(dir, "client-state.json"));
			store.remember("browser", workspace);
			published = [];
			session = Object.assign(Object.create(Session.prototype), {
				stateStore: store,
				clientId: "browser",
				cwd: incidental,
				sessionRoot,
				emit: (event: { projects: ProjectSummary[] }) => {
					published = event.projects;
				},
			});
		});

		afterEach(() => {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		});

		it("does not discover agent transcript directories or promote the active child cwd", async () => {
			await session.pushProjects();
			await session.pushProjects();
			expect(published.map((p) => p.path)).toEqual([workspace]);
			expect(SessionManager.listAll).not.toHaveBeenCalled();
		});

		it("shows an explicitly opened workspace immediately and never restores removed entries", async () => {
			await session.pushProjects();
			// set_cwd records successful explicit opens through remember().
			store.remember("browser", incidental);
			await session.pushProjects();
			expect(published.map((p) => p.path)).toContain(incidental);
			store.removeProject("other-browser", incidental);
			await session.pushProjects();
			await session.pushProjects();
			expect(published.map((p) => p.path)).toEqual([workspace]);
			store.remember("browser", incidental);
			await session.pushProjects();
			expect(published.map((p) => p.path)).toContain(incidental);
		});

		it("retains explicit recency without borrowing timestamps from background activity", async () => {
			store.remember("browser", incidental);
			store.get("browser").projects = [
				{ path: workspace, lastUsed: 200 },
				{ path: incidental, lastUsed: 100 },
			];
			await session.pushProjects();
			expect(published).toEqual([
				{ path: workspace, lastUsed: 200 },
				{ path: incidental, lastUsed: 100 },
			]);
			rmSync(workspace, { recursive: true });
			await session.pushProjects();
			expect(published).toEqual([{ path: incidental, lastUsed: 100 }]);
		});
	});
}
