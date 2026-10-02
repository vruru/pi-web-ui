/**
 * server/approval-rules.ts
 *
 * 审批规则库与多维匹配引擎（Approval Rules Store & Match Engine）。
 *
 * 功能：
 * 1. 规则数据模型（ApprovalRule / UiApprovalRule）：
 *    - 工具名单（tools：["bash"]、["write", "edit"]、["*"]）
 *    - 匹配字段（field："command" | "path" | "params"）
 *    - 匹配方式（match："regex" | "glob" | "contains" | "prefix" | "outside_workspace"）
 *    - 命中动作（action："ask" | "deny" | "allow"）
 *      - "deny"：直接阻断执行并向模型报错（不弹窗、不产生 pending）
 *      - "ask"：触发人工协同审批（弹窗让用户决定，带档位可「允许同类」）
 *      - "allow"：免审直接放行（白名单，跳过后续规则与内置高危检测）
 *    - 启停开关（enabled）+ 内置标记（builtin）
 *    - 双语名称与拦截原因（label/labelEn, reason/reasonEn）
 *
 * 2. 匹配与判定纯函数（matchApprovalRule / evaluateApprovalRules）：
 *    - 优先级规则：
 *      先按规则列表自顶向下顺序遍历，遇到第一个匹配成功的启用规则即返回其判决；
 *      若命中 "allow"，直接免审放行；
 *      若命中 "deny"，直接拒绝执行；
 *      若命中 "ask"，挂起审批弹窗；
 *      若所有规则均未命中，回落至内置默认安全策略（兼容旧硬编码逻辑）。
 *
 * 3. 存储与多客户端同步（ApprovalRulesStore）：
 *    - 存储路径：<dataDir>/approval-rules.json（所有客户端共享同一份）
 *    - 播种 sidecar：<dataDir>/approval-rules.seeded.json（记录已播种过的内置规则 id，
 *      老用户删掉的内置规则不会在重启后复活；发版新增的内置规则可安全合并进老用户文件）。
 *    - 内存缓存 + 文件 mtime 感知，支持直接编辑 JSON 文件热生效。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { UiApprovalCategory } from "./protocol.js";

/** 工具调用审批命中动作：需审批 / 直接拒绝 / 直接放行（白名单）。 */
export type ApprovalRuleAction = "ask" | "deny" | "allow";

/** 匹配字段。 */
export type ApprovalRuleField = "command" | "path" | "params";

/** 匹配方式。 */
export type ApprovalRuleMatchKind = "regex" | "glob" | "contains" | "prefix" | "outside_workspace";

/**
 * 跨平台判定 target 路径是否严格位于 root 目录内部或就是 root 本身。
 * 针对 Windows 盘符大小写不敏感及正反斜杠统一进行规范化，防止 .. 路径穿越逃逸。
 */
export function isPathInsideRoot(target: string, root: string): boolean {
	const normTarget = resolve(target);
	const normRoot = resolve(root);
	if (process.platform === "win32") {
		const lowerTarget = normTarget.toLowerCase();
		const lowerRoot = normRoot.toLowerCase();
		return (
			lowerTarget === lowerRoot || lowerTarget.startsWith(lowerRoot + sep) || lowerTarget.startsWith(lowerRoot + "/")
		);
	}
	return normTarget === normRoot || normTarget.startsWith(normRoot + sep);
}

/** 审批规则定义（也与 wire 协议 UiApprovalRule 同形）。 */
export interface ApprovalRule {
	/** 规则唯一标识（内置规则形如 "builtin.bash.rm-rf"，自定义规则形如 "custom.<uuid|slug>"）。 */
	id: string;
	/** 是否启用（默认 true；false = 停用跳过）。 */
	enabled: boolean;
	/** 适用的工具名列表，如 ["bash"]、["write", "edit", "edit_soft"]、["*"] 表示通配。 */
	tools: string[];
	/** 检查的参数字段：command | path | params（params 表示对参数 JSON 字符串全文匹配）。 */
	field: ApprovalRuleField;
	/** 匹配方式：regex（正则）| glob（通配符）| contains（包含子串）| prefix（前缀）| outside_workspace（工作区外）。 */
	match: ApprovalRuleMatchKind;
	/** 匹配目标值/模式串（match 为 outside_workspace 时此字段可空）。 */
	value: string;
	/** 命中后的动作：ask（弹窗审批）| deny（直接拒绝）| allow（免审放行）。 */
	action: ApprovalRuleAction;
	/** 规则显示名称（zh）。 */
	label: string;
	/** 规则英文名称（en；缺失时回落 label）。 */
	labelEn?: string;
	/** 拦截/拒绝时展示的人性化原因（zh）。 */
	reason?: string;
	/** 拦截/拒绝时展示的人性化原因（en）。 */
	reasonEn?: string;
	/** 对应的规则档位 id（用于「允许同类」；缺省时以 rule.id 为档位 id）。 */
	categoryId?: string;
	/** 是否为系统内置规则（true 时设置面板不可删除，但可编辑、停用或恢复默认）。 */
	builtin?: boolean;
}

/** 规则判定结果。 */
export interface RuleEvaluationResult {
	/** 决策动作：ask（弹审批）| deny（直接阻断）| allow（白名单放行）| none（未命中规则）。 */
	action: "ask" | "deny" | "allow" | "none";
	/** 命中的规则。 */
	matchedRule?: ApprovalRule;
	/** 拦截/拒绝原因（zh）。 */
	reason?: string;
	/** 拦截/拒绝原因（en）。 */
	reasonEn?: string;
	/** 规则档位（用于「允许同类审批」）。 */
	category?: UiApprovalCategory;
}

/**
 * 极简 glob 转 RegExp（只支持 * 单段、? 单字符、** 跨段）。
 * 纯函数，支持正反斜杠统一归一为 /。
 */
export function globToRegex(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * 从工具参数里取「这次调用动的是哪个文件」。SDK 内置 read/write/edit 用 `path`，read 还有
 * `file_path` 别名，部分扩展（如 pi-better-edit 的 edit）用 `file` —— 三种都认，否则叠在
 * 扩展实现之上的权限沙箱与审批规则会静默放行（取不到 → 空串 → 被判成工作区内）。
 */
export function extractTargetPath(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const obj = params as Record<string, unknown>;
	for (const key of ["path", "file_path", "file"]) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/**
 * 从工具参数对象中提取待检查文本。
 */
export function extractRuleFieldValue(field: ApprovalRuleField, toolName: string, params: unknown): string {
	if (!params || typeof params !== "object") {
		return typeof params === "string" ? params : "";
	}
	const obj = params as Record<string, unknown>;
	if (field === "command") {
		return String(obj.command ?? "");
	}
	if (field === "path") {
		return extractTargetPath(params);
	}
	if (field === "params") {
		try {
			return JSON.stringify(params);
		} catch {
			return String(params);
		}
	}
	return "";
}

/**
 * 单条规则针对具体工具调用的匹配判定（纯函数）。
 */
export function matchApprovalRule(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): boolean {
	if (!rule.enabled) return false;

	// 1. 工具名匹配
	const targetTools = rule.tools.map((t) => t.trim().toLowerCase());
	const toolMatches = targetTools.includes("*") || targetTools.includes(toolName.trim().toLowerCase());
	if (!toolMatches) return false;

	// 2. 特殊匹配方式：outside_workspace（工作区外路径）
	if (rule.match === "outside_workspace") {
		const targetPath = extractRuleFieldValue("path", toolName, params);
		if (!targetPath) return false;
		// 无论相对或绝对路径，统一经 resolve(cwd, targetPath) 规范化并消除 ".."
		const abs = resolve(cwd, targetPath);
		const allRoots = [resolve(cwd), ...workspaceRoots.map((r) => resolve(r))];
		const inside = allRoots.some((r) => isPathInsideRoot(abs, r));
		return !inside;
	}

	// 3. 提取字段文本
	const fieldValue = extractRuleFieldValue(rule.field, toolName, params);

	// 4. 按 match kind 进行文本判定
	switch (rule.match) {
		case "regex": {
			try {
				const re = new RegExp(rule.value, "i");
				return re.test(fieldValue);
			} catch {
				return false;
			}
		}
		case "glob": {
			try {
				const re = globToRegex(rule.value);
				return re.test(fieldValue.replace(/\\/g, "/"));
			} catch {
				return false;
			}
		}
		case "contains": {
			return fieldValue.toLowerCase().includes(rule.value.toLowerCase());
		}
		case "prefix": {
			return fieldValue.toLowerCase().startsWith(rule.value.toLowerCase());
		}
		default:
			return false;
	}
}

/**
 * 完整评估规则列表对工具调用的决策（纯函数，按列表顺序首个匹配胜出）。
 */
export function evaluateApprovalRules(
	rules: ApprovalRule[],
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): RuleEvaluationResult {
	for (const rule of rules) {
		if (matchApprovalRule(rule, toolName, params, cwd, workspaceRoots)) {
			const catId = rule.categoryId || rule.id;
			const category: UiApprovalCategory = {
				id: catId,
				label: rule.label,
				labelEn: rule.labelEn || rule.label,
			};
			return {
				action: rule.action,
				matchedRule: rule,
				reason: rule.reason || rule.label,
				reasonEn: rule.reasonEn || rule.labelEn || rule.label,
				category,
			};
		}
	}
	return { action: "none" };
}

/**
 * 内置默认审批规则（与 server/tool-approval.ts 既有内置检测表保持 100% 同口径与同一 id）。
 */
export const DEFAULT_APPROVAL_RULES: ApprovalRule[] = [
	{
		id: "builtin.bash.rm-rf",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value:
			"\\brm\\s+((-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*|--recursive|--force)\\s+)+(((\\/)|(~)|(\\.\\.)|(\\*)|(\\.\\/))|[a-zA-Z]:[\\\\/])",
		action: "ask",
		label: "递归/强制删除 (rm -rf)",
		labelEn: "Recursive/force delete (rm -rf)",
		reason: "检测到高风险的递归/强制删除大范围路径命令 (rm -rf)",
		reasonEn: "Detected high-risk recursive/force deletion of wide paths (rm -rf)",
		categoryId: "bash.rm-rf",
		builtin: true,
	},
	{
		id: "builtin.bash.win-del",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value: "\\b(del|rmdir|rd)\\s+[/\\-][fsq]",
		action: "ask",
		label: "Windows 强制删除 (del/rmdir/rd)",
		labelEn: "Windows force delete (del/rmdir/rd)",
		reason: "检测到高风险的 Windows 强制/递归删除目录命令 (del/rmdir/rd /s /q)",
		reasonEn: "Detected high-risk Windows force/recursive deletion command (del/rmdir/rd /s /q)",
		categoryId: "bash.win-del",
		builtin: true,
	},
	{
		id: "builtin.bash.disk",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value: "\\b(mkfs|format\\s+[a-zA-Z]:|dd\\s+if=)",
		action: "ask",
		label: "磁盘格式化/底层写入",
		labelEn: "Disk format / raw block write",
		reason: "检测到磁盘格式化或底层块写入危险命令 (format/mkfs/dd)",
		reasonEn: "Detected dangerous disk formatting or raw block write command (format/mkfs/dd)",
		categoryId: "bash.disk",
		builtin: true,
	},
	{
		id: "builtin.bash.git-destructive",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value:
			"\\bgit\\s+(push\\s+.*?(--force|-[a-zA-Z0-9]*f)\\b|reset\\s+--hard|clean\\s+-[a-zA-Z0-9]*f|branch\\s+-[dD]\\b)",
		action: "ask",
		label: "破坏性 Git 操作",
		labelEn: "Destructive git operation",
		reason: "检测到不可逆的破坏性 Git 操作 (force push / reset --hard / clean -f)",
		reasonEn: "Detected irreversible destructive Git operation (force push / reset --hard / clean -f)",
		categoryId: "bash.git-destructive",
		builtin: true,
	},
	{
		id: "builtin.bash.chmod",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value: "\\bchmod\\s+(-R\\s+)?(777|000)\\b",
		action: "ask",
		label: "危险权限修改 (chmod)",
		labelEn: "Dangerous permission change (chmod)",
		reason: "检测到过度开放或全局破坏性的文件权限修改 (chmod 777/000)",
		reasonEn: "Detected overly permissive or globally destructive file permission change (chmod 777/000)",
		categoryId: "bash.chmod",
		builtin: true,
	},
	{
		id: "builtin.bash.system-redirect",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "regex",
		value: ">\\s*(\\/etc\\/|\\/boot\\/|C:\\\\Windows)",
		action: "ask",
		label: "写入系统关键目录",
		labelEn: "Write into system directories",
		reason: "检测到重定向写入系统关键目录的危险操作",
		reasonEn: "Detected dangerous redirection writing into critical system directories",
		categoryId: "bash.system-redirect",
		builtin: true,
	},
	{
		id: "builtin.file.sensitive.env",
		enabled: true,
		tools: ["write", "edit", "edit_soft"],
		field: "path",
		match: "regex",
		value: "(^|[\\/\\\\])\\.env(\\.[a-zA-Z0-9_-]+)?$",
		action: "ask",
		label: "敏感配置 (.env)",
		labelEn: "Sensitive config (.env)",
		reason: "尝试修改敏感环境变量/密钥配置文件 (.env)",
		reasonEn: "Attempting to modify sensitive environment/secret configuration (.env)",
		categoryId: "file.sensitive.env",
		builtin: true,
	},
	{
		id: "builtin.file.sensitive.ssh",
		enabled: true,
		tools: ["write", "edit", "edit_soft"],
		field: "path",
		match: "regex",
		value: "(^|[\\/\\\\])(id_rsa|id_ed25519|authorized_keys|known_hosts)$",
		action: "ask",
		label: "SSH 密钥/凭据",
		labelEn: "SSH keys / credentials",
		reason: "尝试修改 SSH 密钥或认证凭据文件",
		reasonEn: "Attempting to modify SSH keys or authentication credentials",
		categoryId: "file.sensitive.ssh",
		builtin: true,
	},
	{
		id: "builtin.file.sensitive.shell",
		enabled: true,
		tools: ["write", "edit", "edit_soft"],
		field: "path",
		match: "regex",
		value: "(^|[\\/\\\\])(\\.bashrc|\\.zshrc|\\.profile|\\.bash_profile)$",
		action: "ask",
		label: "Shell 启动配置",
		labelEn: "Shell profile",
		reason: "尝试修改用户全局 Shell 启动配置文件",
		reasonEn: "Attempting to modify user global Shell profile configuration",
		categoryId: "file.sensitive.shell",
		builtin: true,
	},
	{
		id: "builtin.file.outside-workspace",
		enabled: true,
		tools: ["write", "edit", "edit_soft"],
		field: "path",
		match: "outside_workspace",
		value: "",
		action: "ask",
		label: "工作区外写入",
		labelEn: "Write outside workspace",
		reason: "尝试在工作区外部写入/修改文件",
		reasonEn: "Attempting to write/modify file outside the workspace",
		categoryId: "file.outside-workspace",
		builtin: true,
	},
];

/** 归一化输入规则。脏数据或非法规则返回 null。 */
export function normalizeApprovalRule(raw: unknown): ApprovalRule | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" ? o.id.trim() : "";
	if (!id || id.length > 120) return null;

	const label = typeof o.label === "string" ? o.label.trim() : "";
	if (!label || label.length > 120) return null;

	const labelEn = typeof o.labelEn === "string" && o.labelEn.trim() ? o.labelEn.trim() : undefined;
	const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined;
	const reasonEn = typeof o.reasonEn === "string" && o.reasonEn.trim() ? o.reasonEn.trim() : undefined;

	const action: ApprovalRuleAction = o.action === "deny" ? "deny" : o.action === "allow" ? "allow" : "ask";
	const field: ApprovalRuleField = o.field === "path" ? "path" : o.field === "params" ? "params" : "command";

	const match: ApprovalRuleMatchKind =
		o.match === "glob"
			? "glob"
			: o.match === "contains"
				? "contains"
				: o.match === "prefix"
					? "prefix"
					: o.match === "outside_workspace"
						? "outside_workspace"
						: "regex";

	const value = typeof o.value === "string" ? o.value : "";
	if (match === "regex") {
		try {
			new RegExp(value);
		} catch {
			return null; // 非法正则拒绝
		}
	}

	const tools: string[] = Array.isArray(o.tools)
		? o.tools
				.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
				.map((t) => t.trim().toLowerCase())
		: ["*"];

	return {
		id,
		enabled: o.enabled !== false,
		tools: tools.length > 0 ? tools : ["*"],
		field,
		match,
		value,
		action,
		label,
		...(labelEn ? { labelEn } : {}),
		...(reason ? { reason } : {}),
		...(reasonEn ? { reasonEn } : {}),
		...(typeof o.categoryId === "string" && o.categoryId.trim() ? { categoryId: o.categoryId.trim() } : {}),
		builtin: o.builtin === true,
	};
}

/** 全局审批规则库持久化与操作类。 */
export class ApprovalRulesStore {
	private rules: ApprovalRule[] | null = null;
	private lastMtime = 0;

	constructor(private readonly filePath: string) {}

	private seededPath(): string {
		return /\.json$/i.test(this.filePath)
			? this.filePath.replace(/\.json$/i, ".seeded.json")
			: `${this.filePath}.seeded.json`;
	}

	private loadSeeded(): Set<string> {
		const out = new Set<string>();
		try {
			const parsed = JSON.parse(readFileSync(this.seededPath(), "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "string" && item) out.add(item);
				}
			}
		} catch {
			// 文件不存在时返回空集合
		}
		return out;
	}

	private saveSeeded(names: Set<string>): void {
		try {
			mkdirSync(dirname(this.seededPath()), { recursive: true });
			const tmp = `${this.seededPath()}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify([...names].sort(), null, 2) + "\n");
			renameSync(tmp, this.seededPath());
		} catch {
			// best effort
		}
	}

	private load(): ApprovalRule[] {
		let currentMtime = 0;
		try {
			if (existsSync(this.filePath)) {
				currentMtime = statSync(this.filePath).mtimeMs;
			}
		} catch {
			currentMtime = 0;
		}

		if (this.rules && currentMtime > 0 && currentMtime === this.lastMtime) {
			return this.rules;
		}

		let list: ApprovalRule[] = [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				list = parsed.map(normalizeApprovalRule).filter((r): r is ApprovalRule => r !== null);
			}
		} catch {
			// 文件不存在或格式损坏，以默认规则初始化
			list = DEFAULT_APPROVAL_RULES.map((r) => ({ ...r, tools: [...r.tools] }));
		}

		// 检查播种：老用户新增内置规则自动合并
		const seeded = this.loadSeeded();
		const existingIds = new Set(list.map((r) => r.id));
		let grown = false;

		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!existingIds.has(def.id) && !seeded.has(def.id)) {
				list.push({ ...def, tools: [...def.tools] });
				existingIds.add(def.id);
				grown = true;
			}
			seeded.add(def.id);
		}

		if (grown || seeded.size > 0) {
			this.saveSeeded(seeded);
		}

		this.rules = list;
		this.lastMtime = currentMtime;
		return this.rules;
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.rules ?? [], null, 2) + "\n");
			renameSync(tmp, this.filePath);
			try {
				this.lastMtime = statSync(this.filePath).mtimeMs;
			} catch {
				// ignore
			}
		} catch {
			// best effort
		}
	}

	/** 获取全部有效规则清单（深拷贝返回）。 */
	list(): ApprovalRule[] {
		return this.load().map((r) => ({ ...r, tools: [...r.tools] }));
	}

	/** Upsert 一条规则（同 id 替换，新 id 追加到列表末尾）。返回错误提示，成功返回 null。 */
	upsert(input: unknown): string | null {
		const rule = normalizeApprovalRule(input);
		if (!rule) return "规则格式非法（缺少名称、工具列表或正则格式错误）";

		const list = this.load();
		const idx = list.findIndex((r) => r.id === rule.id);
		if (idx >= 0) {
			// 内置规则保留 builtin 标记
			if (list[idx].builtin) {
				rule.builtin = true;
			}
			list[idx] = rule;
		} else {
			list.push(rule);
		}
		this.persist();
		return null;
	}

	/** 批量重排/替换整份规则（供前端拖拽排序后保存）。 */
	saveAll(inputs: unknown[]): string | null {
		if (!Array.isArray(inputs)) return "规则列表必须是数组";
		const normalized: ApprovalRule[] = [];
		const ids = new Set<string>();

		for (const raw of inputs) {
			const r = normalizeApprovalRule(raw);
			if (!r) return "存在格式非法的规则项";
			if (ids.has(r.id)) return `规则 id 冲突: ${r.id}`;
			ids.add(r.id);
			normalized.push(r);
		}

		// 内置规则是安全底线：整表替换绝不能把它们裁掉（旧客户端 / 并发竞态都
		// 可能送来缺内置规则的清单）。缺失的按默认定义补种、追加到队尾——与
		// load/resetBuiltin 同口径；插队首会改变用户 allow 规则的 first-match
		// 语义。id 命中内置定义的一律强制 builtin 标记（同 upsert 的保护），
		// 防止 remove() 的内置不可删保护被绕过。
		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!ids.has(def.id)) {
				normalized.push({ ...def, tools: [...def.tools] });
				ids.add(def.id);
			} else {
				const i = normalized.findIndex((r) => r.id === def.id);
				normalized[i].builtin = true;
			}
		}

		this.rules = normalized;
		this.persist();
		return null;
	}

	/** 删除一条自定义规则（内置规则不可删除）。 */
	remove(id: string): boolean {
		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx < 0) return false;
		if (list[idx].builtin) return false; // 内置规则不许直接删除，只允许禁用

		list.splice(idx, 1);
		this.persist();
		return true;
	}

	/** 恢复某条内置规则到系统默认设定。 */
	resetBuiltin(id: string): boolean {
		const def = DEFAULT_APPROVAL_RULES.find((r) => r.id === id);
		if (!def) return false;

		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx >= 0) {
			list[idx] = { ...def, tools: [...def.tools] };
		} else {
			list.push({ ...def, tools: [...def.tools] });
		}
		this.persist();
		return true;
	}
}
