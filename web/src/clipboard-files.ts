/**
 * clipboard-files — 从粘贴事件里挑出「真文件」条目（纯函数）。
 *
 * 粘贴和拖拽在浏览器里是两套数据通道：拖拽给 DataTransfer.files / items，
 * 粘贴给 ClipboardEvent.clipboardData。本模块只负责从后者把 File 摘出来，
 * 后续分流（图片走视觉管线、其余走 fileData 上传）复用 ChatInput.handleFiles，
 * 与拖拽保持同一条路径，避免两处口径漂移。
 *
 * 结构化类型而非 DOM 类型，单测可以直接造假对象。
 */
export interface ClipboardItemLike {
	kind: string;
	type?: string;
	/** DOM DataTransferItem.getAsFile 的镜像：拿不到（条目已失效）返回 null。 */
	getAsFile(): File | null;
}

/**
 * 从粘贴数据里收集文件。纯文本粘贴返回空数组（调用方据此保持默认行为，
 * 不要 preventDefault，否则连打字都粘贴不进来）。
 *
 * @param items 主通道：Chromium 系从文件管理器复制文件时在此提供 File。
 * @param files 兜底通道：个别浏览器只填 files 不填 items。
 */
export function collectClipboardFiles(
	items: ArrayLike<ClipboardItemLike> | null | undefined,
	files: ArrayLike<File> | null | undefined,
): File[] {
	const out: File[] = [];
	const n = items?.length ?? 0;
	for (let i = 0; i < n; i++) {
		const item = items?.[i];
		if (!item || item.kind !== "file") continue;
		const f = item.getAsFile();
		if (f) out.push(f);
	}
	if (out.length === 0 && files) {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (f) out.push(f);
		}
	}
	return out;
}
