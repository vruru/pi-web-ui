import { describe, expect, it } from "vitest";
import { hostWithoutPort, isLoopbackHost, isPrivateLanHost, httpHostAllowed } from "../../server/host-guard.js";

describe("hostWithoutPort", () => {
	it("剥离端口与大小写归一", () => {
		expect(hostWithoutPort("localhost:8787")).toBe("localhost");
		expect(hostWithoutPort("EVIL.com:80")).toBe("evil.com");
		expect(hostWithoutPort("127.0.0.1")).toBe("127.0.0.1");
	});
	it("IPv6 方括号形式取花括号内 hostname", () => {
		expect(hostWithoutPort("[::1]:8787")).toBe("::1");
		expect(hostWithoutPort("[2001:db8::1]")).toBe("2001:db8::1");
	});
	it("空/畸形返回空串", () => {
		expect(hostWithoutPort("")).toBe("");
		expect(hostWithoutPort("[bad")).toBe("");
	});
});

describe("isLoopbackHost", () => {
	it("放行 localhost 与 127/8", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("sub.localhost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.9.9.9")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
	});
	it("拒绝其他地址", () => {
		expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
		expect(isLoopbackHost("evil.com")).toBe(false);
		expect(isLoopbackHost("192.168.1.5")).toBe(false);
		expect(isLoopbackHost("::2")).toBe(false);
	});
});

describe("isPrivateLanHost", () => {
	it("放行 RFC1918/链路本地/ULA", () => {
		expect(isPrivateLanHost("10.0.0.1")).toBe(true);
		expect(isPrivateLanHost("172.16.0.1")).toBe(true);
		expect(isPrivateLanHost("172.31.255.255")).toBe(true);
		expect(isPrivateLanHost("192.168.1.1")).toBe(true);
		expect(isPrivateLanHost("169.254.1.1")).toBe(true);
		expect(isPrivateLanHost("fe80::1")).toBe(true);
		expect(isPrivateLanHost("febf::1")).toBe(true);
		expect(isPrivateLanHost("fd00::1")).toBe(true);
		expect(isPrivateLanHost("::ffff:192.168.0.1")).toBe(true);
	});
	it("拒绝公网与边界外地址", () => {
		expect(isPrivateLanHost("172.32.0.1")).toBe(false);
		expect(isPrivateLanHost("172.15.0.1")).toBe(false);
		expect(isPrivateLanHost("8.8.8.8")).toBe(false);
		expect(isPrivateLanHost("fec0::1")).toBe(false);
		expect(isPrivateLanHost("2001:db8::1")).toBe(false);
	});
});

describe("httpHostAllowed", () => {
	const noToken = { allowHosts: [] as string[], hasAuthToken: false };
	it("有 token 时全放行", () => {
		expect(httpHostAllowed("evil.com", { allowHosts: [], hasAuthToken: true })).toBe(true);
	});
	it("无 token：回环/私网放行，公网域名拒绝（rebinding 防线）", () => {
		expect(httpHostAllowed("localhost:8787", noToken)).toBe(true);
		expect(httpHostAllowed("[::1]:8787", noToken)).toBe(true);
		expect(httpHostAllowed("192.168.1.10:8787", noToken)).toBe(true);
		expect(httpHostAllowed("evil.com", noToken)).toBe(false);
		expect(httpHostAllowed(" evil.com ", noToken)).toBe(false);
	});
	it("严格模式：白名单非空时只认白名单（既有 WS 语义）", () => {
		expect(httpHostAllowed("localhost", { allowHosts: ["pi.example.com"], hasAuthToken: false })).toBe(false);
		expect(httpHostAllowed("pi.example.com:8443", { allowHosts: ["pi.example.com"], hasAuthToken: false })).toBe(true);
	});
	it("空 Host 头拒绝", () => {
		expect(httpHostAllowed("", noToken)).toBe(false);
	});
});
