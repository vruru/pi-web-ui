// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BgTasksModal } from "../../web/src/components/BgTasksModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { setAppSend } from "../../web/src/app-globals.js";
import type { BgServer, SchedulerTaskView } from "../../server/protocol.js";

const task: SchedulerTaskView = {
	id: "task-existing",
	name: "Existing schedule",
	description: "",
	cwd: "/tmp/project",
	kind: "interval",
	spec: "3300000",
	prompt: "Report status",
	enabled: true,
	model: "",
	thinkingLevel: "",
	catchUp: "skip",
	conversationId: "c5",
	sessionFile: "/tmp/session.jsonl",
	oneShot: false,
	createdAt: 1,
	updatedAt: 1,
	nextFire: Date.now() + 3300000,
	lastRun: null,
	history: [],
	running: false,
};
let root: Root | undefined;
const sent: unknown[] = [];
function render(tasks: SchedulerTaskView[], servers: BgServer[] = []) {
	if (!root) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		setAppSend((message) => {
			sent.push(message);
			return true;
		});
	}
	act(() =>
		root!.render(createElement(LanguageProvider, null, createElement(BgTasksModal, { tasks, servers, onClose() {} }))),
	);
}
function click(selector: string) {
	const element = document.querySelector<HTMLButtonElement>(selector);
	expect(element).not.toBeNull();
	act(() => element!.click());
}
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	setAppSend(null);
	sent.length = 0;
	vi.restoreAllMocks();
});
describe("background task schedules", () => {
	it("shows persisted schedules without any processes; refresh requests both sources", () => {
		render([task]);
		expect(document.querySelector(".bg-task-empty")).toBeNull();
		expect(document.body.textContent).toContain(task.name);
		expect(document.body.textContent).toContain("3300s");
		expect(document.body.textContent).toContain(task.cwd);
		expect(document.querySelector(".bg-task-count")?.textContent).toBe("1");
		expect(sent).toEqual([{ type: "list_bg_servers" }, { type: "schedule_list" }]);
		sent.length = 0;
		click(".bg-task-foot button");
		expect(sent).toEqual([{ type: "list_bg_servers" }, { type: "schedule_list" }]);
		expect(document.querySelector(".bg-task-stopall")).toBeNull();
	});
	it("pauses and resumes by stable id, keeps paused rows and accepts server updates", () => {
		render([task]);
		click(".bg-task-controls button:first-child");
		expect(sent.at(-1)).toEqual({ type: "schedule_toggle", id: task.id, enabled: false });
		// No optimistic mutation: the server remains authoritative.
		expect(document.querySelector(".bg-task-scheduled.off")).toBeNull();
		render([{ ...task, enabled: false, nextFire: null }]);
		expect(document.querySelector(".bg-task-scheduled.off")).not.toBeNull();
		expect(document.querySelector(".bg-task-scheduled")?.textContent).toContain("—");
		click(".bg-task-controls button:first-child");
		expect(sent.at(-1)).toEqual({ type: "schedule_toggle", id: task.id, enabled: true });
	});
	it("runs paused tasks once, blocks duplicate running clicks and confirms deletion", () => {
		render([{ ...task, enabled: false }]);
		click(".bg-task-controls button:nth-child(2)");
		expect(sent.at(-1)).toEqual({ type: "schedule_run", id: task.id });
		render([{ ...task, running: true, kind: "cron", spec: "0 9 * * *" }]);
		expect(document.body.textContent).toContain("cron 0 9 * * *");
		sent.length = 0;
		click(".bg-task-controls button:nth-child(2)");
		expect(sent).toEqual([]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		click(".bg-task-controls button:last-child");
		expect(sent).toEqual([]);
		expect(confirm.mock.calls[0]?.[0]).toContain(task.name);
		confirm.mockReturnValue(true);
		click(".bg-task-controls button:last-child");
		expect(sent).toEqual([{ type: "schedule_delete", id: task.id }]);
		render([]);
		expect(document.querySelector(".bg-task-empty")).not.toBeNull();
	});
	it("counts all sources and routes plugin/process stop without touching schedules", () => {
		const servers: BgServer[] = [
			{ taskId: task.id, plugin: "notes", name: "Reminder", since: 1, port: 0, pid: 0, command: "" },
			{ port: 8912, pid: 1234, name: "Test service", since: 1, command: "node server" },
		];
		render([task], servers);
		expect(document.querySelector(".bg-task-count")?.textContent).toBe("3");
		click(".bg-task-item:not(.bg-task-scheduled) .bg-task-stop");
		expect(sent.at(-1)).toEqual({ type: "kill_background_server", taskId: task.id });
		click(".bg-task-item:last-child .bg-task-stop");
		expect(sent.at(-1)).toEqual({ type: "kill_background_server", port: 8912 });
		click(".bg-task-stopall");
		expect(sent.at(-1)).toEqual({ type: "kill_background_servers" });
	});
});
