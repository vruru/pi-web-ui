# 微信通道（wechat-ilink）

微信扫码登录，直连微信 ilink 后端（`https://ilinkai.weixin.qq.com`），协议与
腾讯官方的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 同源
（见其 `docs/protocol_zh_CN.md`，MIT 协议）。

## 为什么不需要公网

不出回调、只出站：扫码登录拿 `bot_token` → `getupdates` 长轮询（35s）收消息 →
`sendmessage` 回消息。家里内网、公司内网都能跑，不用开端口、不用公网 IP。

## 上手

1. 装上插件，打开顶栏 💬 视图，点「扫码登录」，微信扫码确认。
2. 有人发来消息：白名单（设置 → 允许的用户，或填 `*` 全放行）直接执行；
   陌生人先挂「待配对」，在视图里点允许/拒绝（并会推一条系统通知）。
3. 微信里直接说话，agent 跑完回结果；跑超 `执行超时提醒` 先回“还在执行”。

## v1 范围（诚实版）

- 单账号、文本消息全双工；图片/语音/文件/视频只转写成 `[图片]` 这类占位，
  不传内容（协议上传链路以后再接）。
- 默认只回私聊，群聊忽略（可开开关）。
- 每个已配对微信用户按 ID 隔离独立会话（基于 accountId 独立伪客户端，peer 名拼进任务前缀，防止多用户串扰或关闭冲突）。
- 过滤内部控制标记（如 [[plan:...]]、[[todo:...]]、[[conv:...]]、[[notify:...]]），只将用户可见正文发送到微信。
- 设置里可配默认工作空间（显式 pin cwd，防后台启动飘到 system32；
  Windows 下系统目录直接拒绝）、模型 / 思考强度（两个都是**下拉选择**：模型列已配置
  鉴权的模型、思考强度列 SDK 档位，留空 = 跟随全局默认），以及「投递到网页当前会话」
  （开 = 微信指令 steer 到浏览器正在打开的对话，网页实时可见）。
- 个人微信扫码走官方 ilink 后端——比野路子 Hook 干净，但个人号自动化仍有
  平台风险，小号先行、重要号三思。`bot_token` 存宿主加密机密（拷机解不开）。

## 文件

- `index.mjs` 服务端：ilink 客户端 + 登录/轮询/配对/回包 + `wechat_send` 工具
- `client/entry.mjs` 视图：状态/扫码/配对/收件箱/手动发送
- `client/vendor/qrcode.js` 二维码编码器（kazuhikoarase/qrcode-generator 1.4.4，MIT，
  仅追加一行 ESM 导出）：官方 `qrcode_img_content` 是 JS 跳转页不是图片，
  扫的内容就是该 URL 本身，视图在本地生成（与官方 CLI 的 qrcode-terminal 一致）
- 无头调用走宿主 `host.chat`（`server/plugins.ts` + `AgentService.chatFromPlugin`），
  无浏览器也能跑；结果经 `onRunEvent(run_end)` 按 conversationId 关联回包。
