/**
 * WS hello 的 clientId 校验 —— 独立成模块是为了可单测
 * （`server/index.ts` 起 WS + SDK，不适合在单测里 import）。
 *
 * 背景：hello.clientId 原样进入 service.attach → ClientSession → saveUpload
 * （`<dataDir>/uploads/<clientId>/`，见 attachments.ts / dsh-agent-service.ts），
 * 无校验时外部可传对象/数字/路径穿越串。合法客户端用 uuid（含连字符，在字符集
 * 内）；服务端伪客户端是 `scheduler:`/`plugin:` 前缀（冒号在字符集内），但那些
 * 不走 WS hello——收进字符集只是不挡未来的复用，不构成放行面。
 */

/** clientId 长度上限：uuid 36 字符的数倍余量，防超长串写盘/进日志。 */
export const MAX_CLIENT_ID_LEN = 128;

/** clientId 字符集：uuid（含 -）、伪客户端前缀（含 :）、下划线。 */
const CLIENT_ID_RE = /^[A-Za-z0-9:_-]+$/;

/**
 * 校验 hello.clientId：必须是 string、1-128 字符、限定字符集。
 * 合法原样返回；不合法（类型不对/空串/超长/含非法字符）返回 null，
 * 调用方回退 randomUUID()——校验必须在 hello 入口统一做（服务端所有把
 * clientId 落盘/当目录名的路径都从 attach 这一条链来）。
 */
export function validateClientId(input: unknown): string | null {
	if (typeof input !== "string") return null;
	if (input.length < 1 || input.length > MAX_CLIENT_ID_LEN) return null;
	if (!CLIENT_ID_RE.test(input)) return null;
	return input;
}
