// @vitest-environment jsdom
import { getContextMenu, resetContextMenu } from "../../web/src/context-menu-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { joinProjectPath, isValidProjectName, parentOf, MACHINE_ROOT } from "../../web/src/components/ProjectPicker.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

let root: Root | null = null;

/** 内存 localStorage：某些 jsdom/CI 环境的存储不可写，桩掉以保证语言确定为中文。 */
function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [
			{
				path: "session-1.jsonl",
				name: "Test Session",
				firstMessage: "Hello",
				modified: Date.now(),
				messageCount: 1,
			},
		],
		projects: [],
		activeConversationId: "",
		panelSend,
		pathCompletions: [
			{ name: "sub1", path: "/test/sub1", type: "dir" as const },
			{ name: "sub2", path: "/test/sub2", type: "dir" as const },
			{ name: "file.txt", path: "/test/file.txt", type: "file" as const },
		],
		...overrides,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return { container, sent };
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	resetContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("LeftPanel 标题栏操作与项目管理", () => {
	it("projects=[] 时仍渲染“最近项目”标题栏和项目管理按钮，且不渲染项目滚动区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 标题栏存在
		const projectsSection = container.querySelector(".panel-projects");
		expect(projectsSection).toBeTruthy();
		expect(projectsSection?.textContent).toContain("最近项目");

		// 项目管理按钮存在
		const projectActionBtn = container.querySelector(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 空项目区不渲染 .projects-scroll
		expect(container.querySelector(".projects-scroll")).toBeNull();
	});

	it("“历史对话”标题栏渲染新对话加号按钮，点击后发送 new_chat 且不影响折叠状态", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const newChatBtn = container.querySelector<HTMLButtonElement>(".lp-new-chat-action");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.title).toBeTruthy();
		expect(newChatBtn?.getAttribute("aria-label")).toBeTruthy();

		const sessionsSection = container.querySelector(".panel-sessions");
		const wasCollapsed = sessionsSection?.classList.contains("collapsed");

		// 点击加号
		sent.length = 0;
		act(() => newChatBtn!.click());
		expect(sent).toEqual([{ type: "new_chat" }]);
		expect(sessionsSection?.classList.contains("collapsed")).toBe(wasCollapsed);
	});

	it("标题行容器与折叠按钮不产生嵌套 button（无 button button）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 保证没有嵌套按钮
		const nestedButtons = container.querySelectorAll("button button");
		expect(nestedButtons.length).toBe(0);
	});

	it("点击项目管理按钮打开项目管理面板，点击遮罩或按 Escape 键可关闭", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 点击打开项目管理面板
		act(() => projectActionBtn!.click());
		const dialog = container.querySelector("[role=dialog]");
		expect(dialog).toBeTruthy();

		// 按 Escape 键关闭
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(container.querySelector("[role=dialog]")).toBeNull();

		// 再次打开并点击遮罩关闭
		act(() => projectActionBtn!.click());
		expect(container.querySelector("[role=dialog]")).toBeTruthy();
		const backdrop = container.querySelector(".status-cwd-backdrop, .project-picker-backdrop");
		expect(backdrop).toBeTruthy();
		act(() => (backdrop as HTMLElement).click());
		expect(container.querySelector("[role=dialog]")).toBeNull();
	});

	it("项目管理面板：非法项目名称（空或含分隔符）不能发送创建消息，合法名称发送 make_dir(setAsCwd: true)", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		// 展开新建项目输入框
		const newBtn = container.querySelector<HTMLButtonElement>(".cwd-newbtn, .project-picker-newbtn");
		expect(newBtn).toBeTruthy();
		act(() => newBtn!.click());

		const input = container.querySelector<HTMLInputElement>(".cwd-newrow input, .project-picker-newrow input");
		expect(input).toBeTruthy();
		const createBtn = container.querySelector<HTMLButtonElement>(
			".cwd-newrow button.primary, .project-picker-newrow button.primary",
		);
		expect(createBtn).toBeTruthy();

		// 空名称点击
		sent.length = 0;
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 包含路径分隔符
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "foo/bar");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 合法名称
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "my-new-project");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		const makeDirMsg = sent.find((m: any) => m.type === "make_dir") as any;
		expect(makeDirMsg).toBeTruthy();
		expect(makeDirMsg.setAsCwd).toBe(true);
		expect(makeDirMsg.path).toContain("my-new-project");
	});

	it("项目管理面板：选择现有目录发送 set_cwd", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		const chooseBtns = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".cwd-choose-btn, .project-picker-choose-btn"),
		);
		expect(chooseBtns.length).toBeGreaterThan(0);

		sent.length = 0;
		act(() => chooseBtns[0].click());
		const setCwdMsg = sent.find((m: any) => m.type === "set_cwd") as any;
		expect(setCwdMsg).toBeTruthy();
		expect(setCwdMsg.path).toBeTruthy();
	});

	it("joinProjectPath 纯函数正确处理 POSIX 和 Windows 根与路径拼接", () => {
		expect(joinProjectPath("/", "foo")).toBe("/foo");
		expect(joinProjectPath("/a", "b")).toBe("/a/b");
		expect(joinProjectPath("/a/", "b")).toBe("/a/b");
		expect(joinProjectPath("C:", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:/", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:\\dir", "sub")).toBe("C:/dir/sub");
	});

	it("isValidProjectName 校验项目名称合法性", () => {
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("  my-project  ")).toBe(true);
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
	});

	it("parentOf 返回父路径或在根处返回 null", () => {
		expect(parentOf("/")).toBeNull();
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/a")).toBe("/");
		expect(parentOf("/a/b")).toBe("/a");
		expect(parentOf("/a/b/")).toBe("/a");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/test")).toBe("C:/Users");
	});
});

describe("LeftPanel 会话行内嵌区", () => {
	const sectionEntry = (id: string, label: string, icon: string) => ({
		id,
		source: "host",
		slot: "leftpanel.sessions",
		label,
		kind: "action",
		icon,
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("分区别名条目不进会话行（行内无 activity/clock 原文）；插件行动作正常渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
				{
					id: "plug:x:go",
					source: "plugin:x",
					slot: "leftpanel.sessions",
					label: "Go",
					kind: "action",
					order: 100,
					align: "start",
					hidden: false,
					userOverrides: [],
					arrangedBy: [],
				},
			],
		});
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".lp-slot-btn"));
		// 只有插件那一条；分区别名两条被过滤（以前会按原文画出 activity/clock）
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Go");
		expect(buttons.every((b) => !/activity|clock/.test(b.textContent ?? ""))).toBe(true);
	});

	it("内嵌区为空时不留 .lp-slot-sessions 占位（会话行 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-projects", "最近项目", "folder"),
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
			],
		});
		expect(container.querySelector(".lp-slot-sessions")).toBeNull();
		expect(container.querySelector(".lp-slot-btn")).toBeNull();
	});
});

describe("LeftPanel selected-page ownership", () => {
	const elsewhere = {
		title: "Conversation 2",
		cwd: "/test",
		isStreaming: false,
		owner: "browser-a",
		convId: "conv-2",
		sessionFile: "/test/two.jsonl",
	};
	const uiContextSession = [
		{ id: "host:conv-takeover", source: "host", label: "Take over", type: "action", slot: "contextmenu.session" },
	];
	it("opens an inactive retained conversation directly, without a takeover badge or action", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open" });
		const { container, sent } = mountLeftPanel({
			elsewhere: [{ ...elsewhere, requiresTakeover: false }],
			uiContextSession,
		});
		const button = container.querySelector<HTMLButtonElement>(".convs-scroll button.session-item")!;
		expect(button).not.toBeNull();
		expect(button.textContent).toContain("Conversation 2");
		expect(button.title).toContain("打开");
		expect(container.querySelector(".elsewhere-badge")).toBeNull();
		sent.length = 0;
		act(() => button.click());
		expect(sent).toEqual([{ type: "switch_session", path: "/test/two.jsonl" }]);
		act(() => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
		expect(getContextMenu()?.entries.find((entry) => entry.id === "host:conv-takeover")?.hidden).toBe(true);
	});
	it.each([true, undefined])(
		"keeps manual takeover for another page's selected or legacy conversation (%s)",
		(requiresTakeover) => {
			setAppGlobals({ cwd: "/test", ready: true, status: "open" });
			const { container } = mountLeftPanel({ elsewhere: [{ ...elsewhere, requiresTakeover }], uiContextSession });
			expect(container.querySelector(".convs-scroll button.session-item")).toBeNull();
			const row = container.querySelector(".elsewhere-item")!;
			expect(row).not.toBeNull();
			act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
			expect(getContextMenu()?.entries.find((entry) => entry.id === "host:conv-takeover")?.hidden).not.toBe(true);
		},
	);
	it("does not invent a session path for a legacy in-memory conversation", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open" });
		const { container } = mountLeftPanel({
			elsewhere: [{ ...elsewhere, sessionFile: undefined, requiresTakeover: false }],
		});
		expect(container.querySelector(".convs-scroll button.session-item")).toBeNull();
		expect(container.querySelector(".elsewhere-item")).not.toBeNull();
	});
});
