/**
 * 构建脚本：把 src/client.js 打包成自包含的 client/entry.mjs
 * （插件静态服务只暴露 client/ 子树，产物必须无 bare import）。
 *
 * 客户端零第三方依赖，纯 vanilla JS，esbuild 只做打包/压缩。
 * 用法：npm install && npm run build
 */
import { build } from "esbuild";

await build({
	entryPoints: ["src/client.js"],
	bundle: true,
	format: "esm",
	outfile: "client/entry.mjs",
	target: "es2022",
	charset: "utf8",
	minify: false,
	banner: { js: "/* db-client 客户端 bundle —— 由 npm run build 生成，源码在 src/client.js */" },
});
console.log("built → client/entry.mjs");
