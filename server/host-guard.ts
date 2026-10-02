/**
 * HTTP Host 白名单守卫（防 DNS rebinding，审查跟踪 issue #352）。
 *
 * 此前 Host/Origin 校验只覆盖 WS 升级，HTTP 路由完全不校验 Host；而
 * originAllowed 的「Origin 与 Host 自比」在 rebinding 下必然相等——恶意网页
 * 让自己的域名解析到 127.0.0.1（或私网 IP）后，浏览器发出的请求 Host 就是
 * 攻击者域名，无 token 默认部署即可获得与本地用户等价的 API 面。
 *
 * 规则（纯函数，便于单测）：
 * - `hasAuthToken` 为真 → 直接放行（token 本身就是鉴权，rebinding 拿不到口令）；
 * - 显式白名单 PI_WEB_ALLOW_HOSTS 非空 → 严格模式，只认白名单（与 WS 侧
 *   旧行为一致，回环/私网兜底不再生效）；
 * - Host 是回环（localhost / 127.0.0.0-127.255.255.255 / [::1]）→ 放行；
 * - Host 是私网/链路本地（10/8、172.16/12、192.168/16、169.254/16、
 *   ::ffff: 映射的上述段、fe80::/10、fc00::/7）→ 放行，保留「局域网用 IP
 *   直接访问」的既有用法（rebinding 的 Host 是公网域名，不会命中这些段）；
 * - 其余（公网域名等）→ 拒绝。
 */

/** 拆掉 Host 头里的端口与 IPv6 方括号，返回小写 hostname。 */
export function hostWithoutPort(authority: string): string {
	let a = authority.trim().toLowerCase();
	if (a.startsWith("[")) {
		const end = a.indexOf("]");
		if (end === -1) return "";
		return a.slice(1, end);
	}
	// IPv6 裸形式（无方括号的 Host 头不合规，但容忍）：含多个冒号时整体当 hostname。
	const colon = a.lastIndexOf(":");
	if (colon !== -1 && a.indexOf(":") === colon) a = a.slice(0, colon);
	return a;
}

function isIpv4Literal(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		octets.push(n);
	}
	return octets;
}

/** 归一 IPv4-mapped IPv6（::ffff:a.b.c.d）为点分 IPv4，便于按段判断。 */
function unwrapIpv4Mapped(host: string): string {
	const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
	return m ? m[1] : host;
}

export function isLoopbackHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const h = unwrapIpv4Mapped(host);
	if (h.includes(":")) return h === "::1";
	const o = isIpv4Literal(h);
	return o !== null && o[0] === 127;
}

export function isPrivateLanHost(host: string): boolean {
	const h = unwrapIpv4Mapped(host);
	if (h.includes(":")) {
		// fe80::/10 链路本地；fc00::/7 (fc/fd 开头) ULA 私网。
		return /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
	}
	const o = isIpv4Literal(h);
	if (!o) return false;
	const [a, b] = o;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

export function httpHostAllowed(
	hostHeader: string,
	opts: { allowHosts: readonly string[]; hasAuthToken: boolean },
): boolean {
	if (opts.hasAuthToken) return true;
	const host = hostWithoutPort(hostHeader);
	if (!host) return false;
	// PI_WEB_ALLOW_HOSTS 是文档化的「严格模式」：设置了就只认白名单（与 WS
	// 侧旧行为一致），回环/私网兜底仅在未设置时生效。
	if (opts.allowHosts.length > 0) return opts.allowHosts.includes(host);
	return isLoopbackHost(host) || isPrivateLanHost(host);
}
