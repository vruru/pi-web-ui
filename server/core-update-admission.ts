import type { CoreUpdateState } from "./protocol.js";
import { updateBusy } from "./core-update-state.js";

interface AdmissionService {
	quiesce(): void;
	unquiesce(): void;
	isQuiesced(): boolean;
	activeConversations(): number;
	pendingMessages(): number;
}
interface UpdateManager {
	getState(): CoreUpdateState;
	start(): Promise<unknown>;
}

/** Holds the existing engine admission gate across the detached install, including
 * a server restart. It never drains by killing a conversation or clears a gate
 * owned by a separate operator. */
export class CoreUpdateAdmission {
	private ownsGate = false;
	private starting = false;
	constructor(
		private readonly manager: UpdateManager,
		private readonly service: AdmissionService,
		private readonly pluginBusy: () => boolean,
		private readonly pendingWork: () => number = () => 0,
	) {}

	isBusy(): boolean {
		return this.starting || updateBusy(this.manager.getState().job);
	}

	sync(): void {
		if (this.isBusy()) {
			if (!this.service.isQuiesced()) {
				this.service.quiesce();
				this.ownsGate = true;
			}
		} else if (this.ownsGate) {
			this.service.unquiesce();
			this.ownsGate = false;
		}
	}

	getState(): CoreUpdateState {
		this.sync();
		const state = this.manager.getState();
		const busyReason =
			this.service.activeConversations() > 0 || this.service.pendingMessages() > 0 || this.pendingWork() > 0
				? "有对话正在运行或消息排队，请结束后再更新。 / Wait for active conversations and queued messages to finish."
				: this.pluginBusy()
					? "插件安装正在进行，请结束后再更新。 / Wait for the plugin installation to finish."
					: this.service.isQuiesced() && !this.ownsGate
						? "服务已暂停接收新任务，请恢复服务后再更新。 / Resume the drained service before updating."
						: undefined;
		return { ...state, canUpdate: state.canUpdate && !busyReason && !this.starting, busyReason };
	}

	async start(): Promise<void> {
		if (this.isBusy()) throw new Error("核心更新已经在进行中。 / A core update is already running.");
		const state = this.getState();
		if (!state.canUpdate) {
			throw new Error(state.busyReason ?? state.unsupportedReason ?? "当前无法更新核心。 / Core update unavailable.");
		}
		// No await between taking the gate and checking work: other browser tabs
		// and scheduler/plugin work cannot sneak in before the install starts.
		this.service.quiesce();
		this.ownsGate = true;
		this.starting = true;
		try {
			if (
				this.service.activeConversations() > 0 ||
				this.service.pendingMessages() > 0 ||
				this.pendingWork() > 0 ||
				this.pluginBusy()
			) {
				throw new Error("服务仍有运行中的任务，请稍后重试。 / The service still has active work; retry later.");
			}
			await this.manager.start();
		} finally {
			this.starting = false;
			this.sync();
		}
	}
}
