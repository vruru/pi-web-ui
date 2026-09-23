import { describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { CoreUpdateAdmission } from "../../server/core-update-admission.js";
import { pendingCoreWork, withCoreWork } from "../../server/core-work.js";
import type { CoreUpdateState } from "../../server/protocol.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function serviceWith(clients: ClientSession[] = []) {
	const service = Object.create(AgentService.prototype) as AgentService;
	Object.assign(service, { clients: new Map(clients.map((client, index) => [String(index), client])) });
	return service;
}
function updaterFor(service: AgentService) {
	const state: CoreUpdateState = {
		currentVersion: "1.0.0",
		latestVersion: "1.0.1",
		updateAvailable: true,
		checkedAt: 1,
		checking: false,
		canUpdate: true,
		job: null,
	};
	const start = vi.fn(async () => {});
	const admission = new CoreUpdateAdmission(
		{ getState: () => state, start },
		{
			quiesce: vi.fn(),
			unquiesce: vi.fn(),
			isQuiesced: () => false,
			activeConversations: () => 0,
			pendingMessages: () => 0,
		},
		() => false,
		() => service.pendingCoreWork(),
	);
	return { admission, start };
}

describe("accepted SDK work prevents core replacement before a stream exists", () => {
	it("counts a prompt waiting for attachment preparation and clears it on rejection", async () => {
		const attachments = deferred<void>();
		const client = Object.create(ClientSession.prototype) as ClientSession;
		Object.assign(client, { promptImpl: vi.fn(() => attachments.promise) });
		const service = serviceWith([client]);
		const updater = updaterFor(service);
		const prompt = client.prompt("read the image", [{ path: "image.png" }]);
		expect(client.pendingCoreWork()).toBe(1);
		expect(service.pendingCoreWork()).toBe(1);
		await expect(updater.admission.start()).rejects.toThrow();
		expect(updater.start).not.toHaveBeenCalled();
		attachments.reject(new Error("image could not be read"));
		await expect(prompt).rejects.toThrow("image could not be read");
		expect(service.pendingCoreWork()).toBe(0);
	});
	it("counts attach before session listing and creation, including a rejected initialization", async () => {
		const initialization = deferred<ClientSession>();
		const service = serviceWith();
		Object.assign(service, { attachImpl: vi.fn(() => initialization.promise) });
		const updater = updaterFor(service);
		const attached = service.attach("new-browser", () => {});
		expect(service.pendingCoreWork()).toBe(1);
		await expect(updater.admission.start()).rejects.toThrow();
		expect(updater.start).not.toHaveBeenCalled();
		initialization.reject(new Error("extension init failed"));
		await expect(attached).rejects.toThrow("extension init failed");
		expect(service.pendingCoreWork()).toBe(0);
	});
	it.each(["newChat", "switchSession", "setCwd", "retryLast", "editMessage", "resumeInterrupted"])(
		"counts %s until its SDK mutation completes",
		async (method) => {
			const work = deferred<void>();
			const client = Object.create(ClientSession.prototype) as ClientSession;
			Object.assign(client, { [`${method}Impl`]: vi.fn(() => work.promise) });
			const methods = client as unknown as Record<string, () => Promise<unknown>>;
			const result = methods[method]();
			expect(client.pendingCoreWork()).toBe(1);
			work.resolve();
			await result;
			expect(client.pendingCoreWork()).toBe(0);
		},
	);
	it.each(["completeForPlugins", "chatFromPlugin", "chatFromScheduler", "wakeConversation", "wakeViewportInCwd"])(
		"counts accepted %s work before a client/stream is registered",
		async (method) => {
			const work = deferred<void>();
			const service = serviceWith();
			Object.assign(service, { [`${method}Impl`]: vi.fn(() => work.promise) });
			const methods = service as unknown as Record<string, () => Promise<unknown>>;
			const result = methods[method]();
			expect(service.pendingCoreWork()).toBe(1);
			work.resolve();
			await result;
			expect(service.pendingCoreWork()).toBe(0);
		},
	);
	it("nested work and synchronous failure never clear another accepted operation", async () => {
		const owner = {};
		const first = deferred<void>();
		const outer = withCoreWork(owner, () => first.promise);
		expect(pendingCoreWork(owner)).toBe(1);
		await expect(
			withCoreWork(owner, () => {
				throw new Error("sync error");
			}),
		).rejects.toThrow("sync error");
		expect(pendingCoreWork(owner)).toBe(1);
		first.resolve();
		await outer;
		expect(pendingCoreWork(owner)).toBe(0);
	});
});
