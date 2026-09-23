/**
 * buildUpdateCommand 单测：pi 扩展先解除版本固定，再 `pi update npm:<name>`（装在
 * <agentDir>/npm），pi-core/webui 走 `npm i -g`；多目标 `;` 连接；空数组。
 */
import { describe, expect, it } from "vitest";
import { buildUpdateCommand } from "../../web/src/update-command.js";

describe("buildUpdateCommand", () => {
	it("package (pi extension) → unpin the source before updating", () => {
		expect(buildUpdateCommand([{ name: "foo", kind: "package" }])).toBe("pi install npm:foo && pi update npm:foo");
	});

	it("scoped package", () => {
		expect(buildUpdateCommand([{ name: "@scope/bar", kind: "package" }])).toBe(
			"pi install npm:@scope/bar && pi update npm:@scope/bar",
		);
	});

	it("pi-core → npm i -g (globally installed)", () => {
		expect(buildUpdateCommand([{ name: "@earendil-works/pi-coding-agent", kind: "pi-core" }])).toBe(
			"npm i -g @earendil-works/pi-coding-agent@latest",
		);
	});

	it("chains multiple targets with `;`", () => {
		expect(
			buildUpdateCommand([
				{ name: "@earendil-works/pi-coding-agent", kind: "pi-core" },
				{ name: "foo", kind: "package" },
				{ name: "pi-x", kind: "package" },
			]),
		).toBe(
			"npm i -g @earendil-works/pi-coding-agent@latest; pi install npm:foo && pi update npm:foo; pi install npm:pi-x && pi update npm:pi-x",
		);
	});

	it("empty list → empty command", () => {
		expect(buildUpdateCommand([])).toBe("");
	});

	it("git-extension → pi update git:<host/path> (issue #178)", () => {
		expect(buildUpdateCommand([{ name: "sol-pi", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi" }])).toBe(
			"pi update git:github.com/NVlabs/SoL-Pi",
		);
	});

	it("git-extension source with git: prefix is not doubled", () => {
		expect(
			buildUpdateCommand([{ name: "sol-pi", kind: "git-extension", source: "git:github.com/NVlabs/SoL-Pi" }]),
		).toBe("pi update git:github.com/NVlabs/SoL-Pi");
	});

	it("git-extension without source falls back to name", () => {
		expect(buildUpdateCommand([{ name: "github.com/acme/widgets", kind: "git-extension" }])).toBe(
			"pi update git:github.com/acme/widgets",
		);
	});

	it("chains mixed npm + git targets with `;`", () => {
		expect(
			buildUpdateCommand([
				{ name: "foo", kind: "package" },
				{ name: "sol-pi", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi" },
			]),
		).toBe("pi install npm:foo && pi update npm:foo; pi update git:github.com/NVlabs/SoL-Pi");
	});
});
