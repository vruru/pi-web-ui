/**
 * resolve-global-sdk — pi SDK 副本选择钩子（issue #260；#321 起默认启用）。
 *
 * 背景：pi-web-ui 依赖 `@earendil-works/pi-coding-agent`，而 npm 全局安装会把依赖
 * **嵌在** `<npm root -g>/pi-web-ui/node_modules/`（不 hoist，实测），Node 又「嵌套优先于
 * 祖先」—— 于是用户 `npm i -g @earendil-works/pi-coding-agent@latest` 改的是全局那份，
 * 服务加载的仍是自带那份，表现为「升了 0.86.1，横幅和 /api/health 还显示 0.85.1」。
 * 这个割裂在 #321 里反复咬人（界面此前完全看不见），所以解析顺序默认反转：
 *
 *   缺省 / global / auto   → 机器上有**更新**的 pi 副本（祖先链，如全局 pi CLI）就用它，
 *                              多份取版本最高的；没有或都更旧 → 自带副本兜底。
 *   bundled / 0 / off /
 *   false / no             → 强制自带副本（可复现、CI 覆盖的那份；报 bug 请用它复现）。
 *
 * 为什么「绝不降级」：祖先副本必须严格比自带的新才采用（同版本继续用自带那份，
 * 少一次重定向）；绝不为了「用全局」而跑更旧的版本。
 *
 * 显式 `PI_WEB_SDK=global` 是更强的承诺：同版本时也选祖先那份（仍不降级）。安装包
 * 不带依赖锁，`npm i -g <tarball>` 可能把嵌套副本装成与全局相同的版本；此时若仍用
 * 嵌套那份，核心更新（只替换独立的全局安装，见 core-update.ts）就再也够不着运行中的
 * SDK。缺省 / auto 仍只跟随严格更新的副本。
 *
 * 为什么默认跟随（#321）：用户升级全局 pi 后界面「显示没更新」，每个版本都有人踩，
 * 每次都要人肉排查。可复现性的代价用两条路补回来：界面更新面板与 /api/health 的
 * `piSdkCopies` 都如实报出实际加载的那份；`PI_WEB_SDK=bundled` 随时显式换回自带。
 * 「全局 SDK 比宿主新」的兼容风险是被接受的：pi 与 pi-web-ui 同步演进，跟随全局
 * 正是用户升级 pi 的本意。
 *
 * 安全约定：整个注册流程包在 try/catch 里，任何异常都退回默认解析 —— 这个模块**绝不允许**
 * 让服务起不来。它必须在任何 SDK 静态 import **之前**被加载（`--import <本文件>`，
 * 或前台启动时在 import 服务入口之前先 import 它）。
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { compareVersions, sdkCopies, type SdkCopy } from "./sdk-origin.js";

const PKG = "@earendil-works/pi-coding-agent";

/** 显式强制自带副本的取值（旧默认；可复现、CI 覆盖的那份）。 */
const BUNDLED_MODES = new Set(["bundled", "0", "off", "false", "no"]);

/**
 * 该用哪一份对外解析（纯函数，便于单测）。
 * `copies` 按 Node 的解析顺序（[0] = 自带的、无钩子时实际会被用到的），
 * 返回 null = 保持默认（用自带副本兜底）。
 */
export function pickGlobalSdk(copies: SdkCopy[], mode: string | undefined): SdkCopy | null {
	const normalized = mode?.trim().toLowerCase();
	if (BUNDLED_MODES.has(normalized ?? "global")) return null;
	const bundled = copies[0];
	// 显式 global：同版本也用祖先那份（核心更新只管得到它）；其余只认**严格更新**的。
	const minimum = normalized === "global" ? 0 : 1;
	// 多份取版本最高的（更旧的永不采用）。
	let best: SdkCopy | null = null;
	for (const copy of copies.slice(1)) {
		if (
			(!bundled || compareVersions(copy.version, bundled.version) >= minimum) &&
			(!best || compareVersions(copy.version, best.version) > 0)
		) {
			best = copy;
		}
	}
	return best;
}

/** 注册钩子；返回实际选中的副本（null = 用自带副本）。 */
export function registerGlobalSdkPreference(mode = process.env.PI_WEB_SDK, fromFile = import.meta.url): SdkCopy | null {
	try {
		const copies = sdkCopies(fromFile);
		const chosen = pickGlobalSdk(copies, mode);
		if (!chosen) return null;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier !== PKG) return nextResolve(specifier, context);
				// 以目标副本的 package.json 为父重新解析：Node 从那里往上找，
				// 第一个命中的就是它自己 —— 等价于「从那个包内部 import 自己」。
				try {
					return nextResolve(specifier, { ...context, parentURL: pathToFileURL(chosen.path).href });
				} catch {
					return nextResolve(specifier, context);
				}
			},
		});
		return chosen;
	} catch {
		// 钩子注册失败（Node 太老 / 环境怪异）→ 静默退回默认解析，绝不影响启动。
		return null;
	}
}

// ---- 副作用：被 `--import` 加载时立刻生效 --------------------------------
const used = registerGlobalSdkPreference();
if (used) {
	console.log(
		`[pi-web-ui] following the pi SDK installed on this machine: ${used.path} (v${used.version}; ` +
			"set PI_WEB_SDK=bundled to pin the bundled copy)",
	);
}
