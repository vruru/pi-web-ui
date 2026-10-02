import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 每个 slot 条目**独立**的错误边界（P0-1：失败不许静默 / 炸一片）。
 *
 * 插件条目（尤其 kind="view"/ 自定义渲染）抛错时，React 默认会把**整棵子树**卸成
 * 空白页——一个坏条目连累整条顶栏/底栏/右栏。这里把它收在单条里：崩溃只丢这一条，
 * 就地置一个可点的灰色占位（点了 console.error 出细节），其余条目照常工作。
 *
 * key 由调用方给成**条目的稳定 id**：换个条目 = 换个实例 = 重置错误态（否则一次崩溃
 * 会永久粘在该位置上，用户重新排布也甩不掉）。
 */
interface Props {
	/** 出错时占位显示的名字（一般是条目 label）。 */
	label: string;
	/** 归因（打印进 console.error + 占位 title）。 */
	slot?: string;
	entryId?: string;
	children: ReactNode;
}

interface State {
	message: string | null;
}

export class SlotErrorBoundary extends Component<Props, State> {
	state: State = { message: null };

	static getDerivedStateFromError(err: unknown): State {
		return { message: err instanceof Error ? err.message : String(err) };
	}

	componentDidCatch(err: unknown, info: ErrorInfo): void {
		// 宿主控制台留全量信息（组件栈 + 归因）；占位上只放一行短句，不吓用户。
		console.error(
			`[ui-slot] entry "${this.props.entryId ?? this.props.label}" in slot "${this.props.slot ?? "?"}" crashed:`,
			err,
			info.componentStack,
		);
	}

	render(): ReactNode {
		if (this.state.message === null) return this.props.children;
		const tip = `slot=${this.props.slot ?? "?"} entry=${this.props.entryId ?? this.props.label}: ${this.state.message}`;
		return (
			<button
				type="button"
				className="slot-error"
				title={tip}
				aria-label={this.props.label}
				onClick={() => console.error(`[ui-slot] ${tip}`)}
			>
				<span aria-hidden>⚠</span>
				<span>{this.props.label}</span>
			</button>
		);
	}
}
