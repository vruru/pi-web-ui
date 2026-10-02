export interface StreamingCueFinished {
	id: string;
	title?: string;
	isActive: boolean;
}

export interface StreamingCuesDiff {
	/** 是否触发开始运行提示音（仅前台活动会话真正开始生成时为 true） */
	startCue: boolean;
	/** 刚刚结束运行的会话列表（流式状态由 true 跃迁为 false） */
	finishedConvs: StreamingCueFinished[];
	/** 更新后的各会话流式状态映射，供下一次比对 */
	nextMap: Map<string, boolean>;
}

export interface StreamingCueConversation {
	id: string;
	title?: string;
	isStreaming?: boolean;
}

/**
 * 计算多会话流式状态的边缘跃迁（edge transition）。
 *
 * 核心设计原则：
 * 1. 按会话 ID 独立跟踪每个会话的 streaming 状态，绝不在会话切换时跨会话做状态比对。
 *    切换会话（无论从 running 切到 idle，还是从 idle 切到 running）绝对不触发任何提示音与通知。
 * 2. 活动会话的流式状态以 activeStreaming（来自 chat.state，毫秒级实时）为权威；后台会话以 conversations 列表为准。
 * 3. 只有当前活动会话从明确的非运行态变为运行态时，才触发 startCue；切换会话后的第一拍
 *    （prevActiveId 已知且 ≠ activeId）一律不触发——后台会话刚开流时 conversations 列表可能
 *    还没更新，prevMap 里它仍是 false，此刻切入会把「切入正在运行的会话」误判成本会话开始。
 *    宁可漏掉这一拍（下一拍起恢复正常边沿判定），也不在切换时出声。
 * 4. 任何已存在的会话由运行态（true）变为结束态（false）时，记录在 finishedConvs 中（无论在前台还是后台）。
 * 5. 初次初始化时（prevMap 为 null），仅同步状态，不触发任何 cue。
 */
export function diffStreamingCues(
	prevMap: Map<string, boolean> | null,
	activeId: string | null,
	activeStreaming: boolean,
	conversations: readonly StreamingCueConversation[],
	prevActiveId?: string | null,
): StreamingCuesDiff {
	const currentMap = new Map<string, boolean>();
	for (const c of conversations) {
		currentMap.set(c.id, !!c.isStreaming);
	}
	if (activeId) {
		currentMap.set(activeId, activeStreaming);
	}

	// 首次观察：不发任何提示
	if (prevMap === null) {
		return {
			startCue: false,
			finishedConvs: [],
			nextMap: currentMap,
		};
	}

	// 1. 检查当前活动会话是否开始流式：只有当前活动会话明确从 false 变为 true 才触发
	// 若从别的会话切入一个已经在 running 的后台会话，其在 prevMap 中已记录为 true，不会误报 startCue；
	// 切换后的第一拍（prevActiveId 已知且 ≠ activeId）也直接不判定，堵住列表滞后时的误报窗口。
	let startCue = false;
	if (activeId && (prevActiveId === undefined || prevActiveId === activeId)) {
		const prevActive = prevMap.get(activeId);
		const nowActive = currentMap.get(activeId) ?? false;
		if (prevActive === false && nowActive === true) {
			startCue = true;
		}
	}

	// 2. 检查哪些会话真正结束了流式（true -> false）
	const finishedConvs: StreamingCueFinished[] = [];
	for (const [id, wasStreaming] of prevMap.entries()) {
		if (!wasStreaming) continue;
		// 必须在当前已知会话中（排除直接被删除/销毁的会话），且状态由 true 变为 false
		if (currentMap.has(id) && !currentMap.get(id)) {
			const c = conversations.find((item) => item.id === id);
			finishedConvs.push({
				id,
				title: c?.title,
				isActive: id === activeId,
			});
		}
	}

	return {
		startCue,
		finishedConvs,
		nextMap: currentMap,
	};
}
