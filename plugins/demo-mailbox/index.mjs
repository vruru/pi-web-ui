/**
 * demo-mailbox 服务端入口 —— 插件协议示例。
 *
 * 约定：ESM 默认导出 { activate(host) → deactivate? }。
		// 声明式设置（manifest "settings"）：读默认值 + 订阅面板改动。
		// 演示完整循环：宿主已按 schema 校验并持久化，插件这里只消费。
		let cfg = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v;
			host.log("settings changed:", JSON.stringify(v));
			host.broadcast({ settings: cfg });
		});
 * host 提供 broadcast / onMessage / dir / dataDir / cwd / log。
 * 真实邮箱插件在这里接 IMAP/SMTP（凭据存 host.dir，不进代码库）；
 * 示例只做内存收发 + 回声，证明链路可用。
 */

const mails = [
	{
		id: 1,
		from: "alice@example.com",
		subject: "欢迎使用 pi-web-ui 插件",
		date: new Date().toISOString(),
		body:
			"这是一个由插件提供的界面组件：目录放在 <dataDir>/plugins/demo-mailbox/，" +
			"删掉目录即卸载。服务端入口（本文件）可以访问 Node 全部能力。",
	},
	{
		id: 2,
		from: "bob@example.com",
		subject: "试试发一封",
		date: new Date(Date.now() - 3600_000).toISOString(),
		body: "在下方表单里填收件人和正文，点发送——消息经 WebSocket 到达本文件，再广播回所有打开的页面。",
	},
];
let nextId = 3;

export default {
	activate(host) {
		const off = host.onMessage((payload) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "list":
					host.broadcast({ mails });
					break;
				case "notify":
					host.notify("info", String(msg.text ?? "插件通知测试"));
					break;
				case "send": {
					const mail = {
						id: nextId++,
						from: "me@local",
						to: String(msg.to ?? ""),
						subject: String(msg.subject ?? "(无主题)"),
						date: new Date().toISOString(),
						body: String(msg.body ?? ""),
						outgoing: true,
					};
					mails.unshift(mail);
					host.log("sent:", mail.to, mail.subject);
					host.broadcast({ mails });
					break;
				}
				default:
					host.log("unknown action:", msg.action);
			}
		});
		host.log("activated; mails in memory:", mails.length);

		// 返回清理函数：插件目录被删除 / 服务关停时调用
		return () => {
			off();
			host.log("deactivated");
		};
	},
};
