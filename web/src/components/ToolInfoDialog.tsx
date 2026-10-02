import { createPortal } from "react-dom";
import { FiInfo, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { closeToolInfo, useToolInfoState, type ToolInfoView } from "../tool-info-state";
import { schemaRows, type SchemaRow } from "../tool-schema";
import { CopyButton } from "./copy-button";

/**
 * 「工具详细信息」弹窗 —— 工具卡右键菜单（`contextmenu.toolcall`）的宿主内置条目
 * `host:tool-info` 打开，展示**工具的定义说明**（不含本次调用数据）。
 *
 * 内容来自 `get_tool_info` 应答（服务端从 SDK / DSH 运行时现取，不进快照），
 * 状态机在 tool-info-state.ts；参数 schema 的表格化在 tool-schema.ts（都是纯函数 + 单测）。
 *
 * 为什么 portal 到 body：弹窗挂在 App 上，但触发点在消息流里 —— 消息列表有自己的滚动
 * 容器（祖先还有 overflow/transform），fixed 定位会被裁掉（同 ContextMenu.tsx 的理由）。
 */
export function ToolInfoDialog() {
	const t = useT();
	const info = useToolInfoState();

	// 审查 #12：Esc 改走 shortcut-stack 分层栈（与 Modal 同一调度）；
	// 关闭状态下不启用，避免吞掉下层弹窗的 Esc。
	useEscapeKey(() => {
		closeToolInfo();
	}, Boolean(info));

	if (!info) return null;

	return createPortal(
		<div className="modal-backdrop" onClick={closeToolInfo}>
			<div
				className="tool-info-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("toolInfoTitle")}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="tool-info-head">
					<span className="tool-info-title">
						<FiInfo />
						{t("toolInfoTitle")}
					</span>
					<code className="tool-info-name">{info.name}</code>
					{info.label && info.label !== info.name && <span className="tool-info-label">{info.label}</span>}
					<button type="button" className="btn" title={t("close")} onClick={closeToolInfo}>
						<FiX />
					</button>
				</div>
				<div className="tool-info-body">
					<StatusBody info={info} />
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** 按状态渲染正文：读取中 / 未找到 / 引擎不支持 / 有定义。 */
function StatusBody({ info }: { info: ToolInfoView }) {
	const t = useT();
	if (info.status === "loading") {
		return (
			<div className="tool-info-state" role="status">
				<span className="cursor" /> {t("toolInfoLoading")}
			</div>
		);
	}
	if (info.status === "unsupported") {
		return <div className="tool-info-state">{t("toolInfoUnsupported")}</div>;
	}
	if (info.status === "missing") {
		return <div className="tool-info-state">{t("toolInfoMissing")}</div>;
	}

	const rows = info.parameters === undefined ? [] : schemaRows(info.parameters);
	const rawSchema = info.parameters === undefined ? "" : safeJson(info.parameters);

	return (
		<>
			<div className="tool-info-badges">
				{info.active !== undefined && (
					<span className={`tool-info-badge ${info.active ? "on" : "off"}`}>
						{info.active ? t("toolInfoActive") : t("toolInfoInactive")}
					</span>
				)}
				{info.source && (
					<span className="tool-info-badge">
						{t("toolInfoSource")}: {info.source}
						{info.scope ? ` · ${info.scope}` : ""}
					</span>
				)}
			</div>

			<section className="tool-info-sec">
				<div className="tool-info-sec-label">{t("toolInfoDescription")}</div>
				<div className="tool-info-text">{info.description || t("toolInfoNoDescription")}</div>
			</section>

			{info.promptSnippet && (
				<section className="tool-info-sec">
					<div className="tool-info-sec-label">{t("toolInfoPromptSnippet")}</div>
					<div className="tool-info-text dim">{info.promptSnippet}</div>
				</section>
			)}

			{info.promptGuidelines && info.promptGuidelines.length > 0 && (
				<section className="tool-info-sec">
					<div className="tool-info-sec-label">{t("toolInfoGuidelines")}</div>
					<ul className="tool-info-list">
						{info.promptGuidelines.map((g, i) => (
							<li key={i}>{g}</li>
						))}
					</ul>
				</section>
			)}

			<section className="tool-info-sec">
				<div className="tool-info-sec-label">{t("toolInfoParams")}</div>
				{rows.length > 0 ? (
					<SchemaTable rows={rows} />
				) : (
					<div className="tool-info-text dim">{t("toolInfoParamsNone")}</div>
				)}
				{info.parametersDropped && <div className="tool-info-text warn">{t("toolInfoSchemaDropped")}</div>}
				{rawSchema && (
					<details className="tool-info-raw">
						<summary>
							{t("toolInfoRawSchema")}
							<CopyButton text={rawSchema} />
						</summary>
						<pre>{rawSchema}</pre>
					</details>
				)}
			</section>

			<div className="tool-info-foot">{t("toolInfoFootnote")}</div>
		</>
	);
}

/** 参数表：参数名 / 类型 / 必填 / 说明（嵌套对象属性按 depth 缩进）。 */
function SchemaTable({ rows }: { rows: SchemaRow[] }) {
	const t = useT();
	return (
		<div className="tool-schema-table" role="table">
			{rows.map((row) => (
				<div className="tool-schema-row" role="row" key={row.name} style={{ paddingLeft: 8 + row.depth * 14 }}>
					<div className="tool-schema-name">
						<code>{row.name}</code>
						{row.required && <span className="tool-schema-req">{t("toolInfoRequired")}</span>}
					</div>
					<div className="tool-schema-type">
						{row.type}
						{row.hint && <span className="tool-schema-hint">{row.hint}</span>}
					</div>
					{row.description && <div className="tool-schema-desc">{row.description}</div>}
				</div>
			))}
		</div>
	);
}

/** JSON 美化（循环引用等脏数据回落成一句说明，绝不抛错 —— 这是只读展示）。 */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
}
