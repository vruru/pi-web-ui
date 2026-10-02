import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { useT } from "../i18n";
import { loadFileHandler, type FileHandlerPlugin, type FileHandlerDeclaration } from "../plugin-file-handlers";
import { makePluginContext, type PluginFile, type PluginFileHandlerContext } from "../plugin-loader";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";

interface PluginFilePreviewProps {
	file: PluginFile;
	plugin: FileHandlerPlugin;
	declaration: FileHandlerDeclaration;
	epoch: number;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	onClose: () => void;
	onFallback: () => void;
}

/**
 * 文件插件的统一宿主壳。插件只能拥有这个容器的子树；文件路径由宿主
 * 传入，读取走插件自己的服务端路由/host.fs，不开放主应用 DOM。
 */
export function PluginFilePreview({
	file,
	plugin,
	declaration,
	epoch,
	send,
	onClose,
	onFallback,
}: PluginFilePreviewProps) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [mounted, setMounted] = useState(false);
	const fallbackRef = useRef(onFallback);
	fallbackRef.current = onFallback;
	const label = declaration.label ?? plugin.name;

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let disposed = false;
		let cleanup: void | (() => void);
		setError(null);
		setMounted(false);
		void (async () => {
			try {
				const loaded = await loadFileHandler({ plugin, declaration });
				if (disposed) return;
				if (!loaded) throw new Error("插件没有提供可用的文件查看器");
				const base = `/plugins-api/${encodeURIComponent(plugin.id)}`;
				const ctx: PluginFileHandlerContext = {
					...makePluginContext(plugin.id, send),
					file,
					apiUrl: (path, params) => {
						const suffix = String(path ?? "").startsWith("/") ? String(path) : `/${String(path ?? "")}`;
						const query = new URLSearchParams();
						for (const [key, value] of Object.entries(params ?? {})) {
							if (value !== undefined) query.set(key, String(value));
						}
						const qs = query.toString();
						return withToken(appUrl(`${base}${suffix}${qs ? `?${qs}` : ""}`));
					},
				};
				cleanup = loaded.handler.mount(el, file, ctx);
				if (!disposed) setMounted(true);
			} catch (err) {
				if (!disposed) {
					console.error(`[plugin:${plugin.id}] file handler failed:`, err);
					fallbackRef.current();
				}
			}
		})();
		return () => {
			disposed = true;
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					console.error(`[plugin:${plugin.id}] file handler cleanup failed:`, err);
				}
			}
			el.textContent = "";
		};
	}, [file, plugin, declaration, epoch, send]);

	return (
		<Modal className="plugin-file-preview" title={label} icon={plugin.icon} onClose={onClose}>
			<div className="modal-body plugin-file-preview-body">
				<div className="plugin-file-preview-file" title={file.path}>
					{file.name}
				</div>
				{error ? <div className="plugin-file-preview-error">{error}</div> : null}
				{!error && !mounted ? <div>{t("loading")}</div> : null}
				<div ref={ref} className="plugin-file-preview-host" />
			</div>
		</Modal>
	);
}
