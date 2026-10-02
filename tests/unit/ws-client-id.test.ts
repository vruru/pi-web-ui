import { describe, expect, it } from "vitest";
import { MAX_CLIENT_ID_LEN, validateClientId } from "../../server/ws-client-id.js";

describe("ws hello clientId 校验", () => {
	it("合法 uuid 与伪客户端前缀原样通过", () => {
		expect(validateClientId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
		expect(validateClientId("scheduler:task-1")).toBe("scheduler:task-1");
		expect(validateClientId("plugin:demo_ui")).toBe("plugin:demo_ui");
		expect(validateClientId("A_9:z")).toBe("A_9:z");
	});

	it("非 string（对象/数字/undefined/null）拒绝", () => {
		expect(validateClientId({ id: "x" })).toBeNull();
		expect(validateClientId(123)).toBeNull();
		expect(validateClientId(undefined)).toBeNull();
		expect(validateClientId(null)).toBeNull();
		expect(validateClientId(["x"])).toBeNull();
	});

	it("空串与超长（>128）拒绝", () => {
		expect(validateClientId("")).toBeNull();
		expect(validateClientId("a".repeat(MAX_CLIENT_ID_LEN))).toBe("a".repeat(MAX_CLIENT_ID_LEN));
		expect(validateClientId("a".repeat(MAX_CLIENT_ID_LEN + 1))).toBeNull();
	});

	it("路径穿越/特殊字符拒绝（clientId 会成为 uploads/<clientId>/ 目录名）", () => {
		expect(validateClientId("../etc/passwd")).toBeNull();
		expect(validateClientId("..\\win")).toBeNull();
		expect(validateClientId("a/b")).toBeNull();
		expect(validateClientId("a b")).toBeNull();
		expect(validateClientId("a.b")).toBeNull();
		expect(validateClientId("a%2fb")).toBeNull();
		expect(validateClientId("中文")).toBeNull();
		expect(validateClientId("a\nb")).toBeNull();
	});
});
