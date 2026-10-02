/**
 * legado-web 的公共抓取层 —— 书源站请求（绕 CORS 不需要：这里就是服务端）＋ 编码处理 ＋ cookie jar。
 *
 * 三个使用方共用这一份实现，保证 UI、AI 工具、同步 JS 规则行为完全一致：
 *   - index.mjs 的 `/proxy` HTTP 路由（浏览器里的内嵌前端走这条）
 *   - engine-host.mjs 的异步 transport（AI 工具跑规则链路）
 *   - sync-worker.mjs 的同步桥（书源 JS 规则里的 java.ajax/connect/get/post）
 *
 * 编码：GBK 等非 UTF-8 用内置 TextDecoder 解码；编码方向用惰性构建的反查表
 * （遍历 GBK 双字节空间反向建映射，约 20ms，只在用到时构建）——零 npm 依赖。
 */

export const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/** 编码名归一（TextDecoder 认的标签形式）。 */
export function normCharset(raw) {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

function isUtf8(cs) {
	return !cs || cs === "utf-8" || cs === "utf8";
}

/** 字节 → 文本；utf-8 解出替换字符时自动回退 GBK。 */
export function decodeBytes(buf, charset) {
	const cs = normCharset(charset);
	if (isUtf8(cs)) {
		const s = buf.toString("utf8");
		if (!s.includes("\uFFFD")) return s;
		try {
			return new TextDecoder("gbk").decode(buf);
		} catch {
			return s;
		}
	}
	try {
		return new TextDecoder(cs).decode(buf);
	} catch {
		return buf.toString("utf8");
	}
}

/** 从响应头 / HTML 头部嗅探编码。 */
export function detectCharset(contentType, headBytes) {
	const ct = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
	if (ct) return ct[1];
	const head = headBytes.toString("latin1").slice(0, 4000);
	const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /charset=([\w-]+)/i.exec(head);
	return m ? m[1] : "utf-8";
}

/** char → GBK 双字节反查表（惰性）。 */
let gbkEncodeMap = null;
function gbkBytes(ch) {
	if (!gbkEncodeMap) {
		gbkEncodeMap = new Map();
		let dec = null;
		try {
			dec = new TextDecoder("gbk", { fatal: false });
		} catch {
			/* 无 GBK 支持：退化成 UTF-8 字节 */
		}
		if (dec) {
			for (let b1 = 0x81; b1 <= 0xfe; b1++) {
				for (let b2 = 0x40; b2 <= 0xfe; b2++) {
					if (b2 === 0x7f) continue;
					const s = dec.decode(Uint8Array.of(b1, b2));
					if (s.length === 1 && s !== "\uFFFD" && !gbkEncodeMap.has(s)) gbkEncodeMap.set(s, [b1, b2]);
				}
			}
		}
	}
	return gbkEncodeMap.get(ch) ?? null;
}

/** 按 charset 把字符串编成字节（GBK 系走反查表；表里没有的字符退化成 UTF-8 字节）。 */
export function encodeText(text, charset) {
	const cs = normCharset(charset);
	if (isUtf8(cs)) return Buffer.from(text, "utf8");
	const out = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 128) {
			out.push(cp);
			continue;
		}
		const pair = gbkBytes(ch);
		if (pair) out.push(pair[0], pair[1]);
		else out.push(...Buffer.from(ch, "utf8"));
	}
	return Buffer.from(out);
}

/** 按 charset 把 URL 里的非 ASCII 字符转百分号编码（ASCII 段原样，避免二次编码）。 */
export function encodeUrlCharset(target, charset) {
	const cs = normCharset(charset);
	let raw;
	try {
		raw = decodeURIComponent(target);
	} catch {
		return target;
	}
	if (isUtf8(cs)) return raw;
	let out = "";
	for (const ch of raw) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 128) out += ch;
		else out += [...encodeText(ch, cs)].map((b) => "%" + b.toString(16).padStart(2, "0").toUpperCase()).join("");
	}
	return out;
}

// ---------------------------------------------------------------------------
// cookie jar（host → "k=v; k2=v2"，单用户自部署够用）
// ---------------------------------------------------------------------------

const jar = new Map();

export function jarClear() {
	jar.clear();
}

// ---------------------------------------------------------------------------
// 私网/回环防护（SSRF）
// ---------------------------------------------------------------------------

/** IPv4 → 四段字节数组；非 IPv4 字面量返回 null。 */
function ipv4Bytes(hostname) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!m) return null;
	const b = m.slice(1).map(Number);
	if (b.some((v) => v > 255)) return null;
	return b;
}

/**
 * 目标主机是否为回环/私网/链路本地地址（书源抓取不需要它们；命中即拒，
 * 防开放代理被用来探测内网）。IPv4 覆盖 127/8、10/8、172.16/12、192.168/16、
 * 169.254/16、0/8 与广播 255.255.255.255；IPv6 覆盖 ::1、::、fe80::/10、fc00::/7；
 * `*.localhost` 一律视为本机。
 */
function isPrivateHost(hostname) {
	const h = String(hostname ?? "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (!h) return true;
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	const v4 = ipv4Bytes(h);
	if (v4) {
		const [a, b] = v4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10，按内网对待
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) || // benchmark 198.18/15
			(a >= 224 && a <= 255) // 组播/保留/广播
		);
	}
	// IPv6（含括号形式剥离已在调用方处理）：粗颗粒段判断，够本场景
	if (h.includes(":")) {
		if (h === "::" || h === "::1") return true;
		// IPv4 映射地址 ::ffff:a.b.c.d —— 按内嵌 IPv4 判定
		const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
		if (mapped) return isPrivateHost(mapped[1]);
		if (/^f[ce][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local + fe80::/10 link-local
		return false;
	}
	return false;
}

/** 环境变量显式放行的主机（本机自建书源站等场景），逗号分隔。 */
function allowedPrivateHosts() {
	return new Set(
		String(process.env.LEGADO_ALLOW_PRIVATE_HOSTS ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

/** 解析目标 hostname（失败按私网处理 = 拒绝）；字面量直接判定。 */
async function resolveTargetPrivate(hostname) {
	const allowed = allowedPrivateHosts();
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (allowed.has(bare)) return false; // 显式放行（本机自建书源站）
	if (isPrivateHost(bare)) return true;
	const isIpLiteral = ipv4Bytes(bare) !== null || bare.includes(":");
	if (isIpLiteral) return false; // 公网 IP 字面量
	try {
		const { lookup } = await import("node:dns/promises");
		const res = await lookup(bare, { all: true });
		if (!res || res.length === 0) return true;
		return res.some((r) => isPrivateHost(r.address));
	} catch {
		return true; // 解析不了的一律不抓
	}
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** fetch 会拒绝的逐跳头。 */
const HOP_BY_HOP = /^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection)$/i;

/** 单次请求（redirect:"manual"，由 proxyFetch 的循环逐跳检查私网）。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 抓一个书源站地址。
 * @param {object} req
 * @param {string} req.url 目标地址（http/https）
 * @param {string} [req.method]
 * @param {Record<string,string>} [req.headers] 书源声明的头（**不接受浏览器头**）
 * @param {string|Buffer} [req.body]
 * @param {string} [req.charset] 影响 URL 重编码与 body 编码
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{url:string,status:number,headers:Record<string,string>,body:string,bytes:number}>}
 */
export async function proxyFetch(req) {
	const targetRaw = String(req?.url ?? "");
	if (!targetRaw || !/^https?:\/\//i.test(targetRaw)) throw new Error("缺少合法 url（http(s)://…）");

	const charset = String(req?.charset ?? "");
	const target = encodeUrlCharset(targetRaw, charset);
	const headers = { "User-Agent": DEFAULT_UA, Accept: "text/html,application/json,*/*", ...(req?.headers ?? {}) };
	for (const k of Object.keys(headers)) {
		if (HOP_BY_HOP.test(k)) delete headers[k];
	}

	let jarHost = "";
	try {
		jarHost = new URL(target).host;
		const saved = jar.get(jarHost);
		if (saved && !headers.Cookie && !headers.cookie) headers.Cookie = saved;
	} catch {
		throw new Error(`非法的目标地址：${target}`);
	}

	let body;
	if (req?.body === undefined || req?.body === null) body = undefined;
	else if (Buffer.isBuffer(req.body)) body = req.body;
	else body = encodeText(String(req.body), charset);

	// ---- SSRF 防护：每跳都过私网黑名单（含 DNS 解析结果），重定向手动跟 ≤5 跳 ----
	const MAX_REDIRECTS = 5;
	let currentUrl = target;
	let resp;
	for (let hop = 0; ; hop++) {
		let hostname;
		try {
			hostname = new URL(currentUrl).hostname;
		} catch {
			throw new Error(`非法的目标地址：${currentUrl}`);
		}
		if (await resolveTargetPrivate(hostname)) {
			throw new Error(`拒绝抓取内网/回环地址：${hostname}（如为本机自建书源站，可用 LEGADO_ALLOW_PRIVATE_HOSTS 放行）`);
		}
		resp = await fetch(currentUrl, {
			method: String(req?.method ?? "GET").toUpperCase(),
			headers,
			// 手动重定向：跨跳不重放 body（301/302 语义本身不重放 POST body）
			body: hop === 0 ? body : undefined,
			signal: AbortSignal.timeout(Number(req?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
			redirect: "manual",
		});
		if (resp.status < 300 || resp.status >= 400 || !REDIRECT_STATUSES.has(resp.status)) break;
		const location = resp.headers.get("location");
		if (!location) break;
		let next;
		try {
			next = new URL(location, currentUrl);
		} catch {
			throw new Error(`重定向地址非法：${location}`);
		}
		if (!/^https?:$/i.test(next.protocol)) throw new Error(`重定向到不支持的协议：${next.protocol}`);
		if (hop >= MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳，已中止`);
		currentUrl = next.href;
	}
	const buf = Buffer.from(await resp.arrayBuffer());

	try {
		const setCookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
		if (jarHost && setCookies.length) {
			const pairs = setCookies.map((c) => String(c).split(";")[0]).filter(Boolean);
			if (pairs.length) {
				const prev = jar.get(jarHost);
				jar.set(jarHost, prev ? `${prev}; ${pairs.join("; ")}` : pairs.join("; "));
			}
		}
	} catch {
		/* jar 尽力而为 */
	}

	const contentType = resp.headers.get("content-type") ?? "";
	const outHeaders = {};
	resp.headers.forEach((v, k) => {
		outHeaders[k] = v;
	});
	return {
		url: currentUrl || resp.url || target, // 手动重定向：报最终到达的地址
		status: resp.status,
		headers: outHeaders,
		body: decodeBytes(buf, charset || detectCharset(contentType, buf.subarray(0, 4000))),
		bytes: buf.length,
	};
}

/** 把底层错误转成人话（带上 ENOTFOUND/超时等错误码，便于前端与 AI 区分「域名黑洞/被墙」与「站点拒绝」）。 */
export function describeFetchError(err) {
	const cause = err?.cause?.code ?? err?.cause?.message ?? "";
	const isTimeout = err?.name === "TimeoutError" || /timeout/i.test(String(cause));
	return `${isTimeout ? "连接超时" : String(err?.message ?? err)}${cause ? ` [${cause}]` : ""}`;
}
