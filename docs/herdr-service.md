# macOS 网页服务与 Herdr

`pi-herdr-agents` 需要真实的 Herdr 父窗格和 socket。仅安装包或手工设置 `HERDR_ENV=1` 不能完成对接。

使用 `PI_WEB_HERDR_SESSION=pi-web-ui pi-web-ui server install` 可让 launchd 通过 `bin/herdr-service.mjs` 启动网页服务。保留安装时原有的端口、工作目录、SDK 和其他环境配置。会话名称应专供该服务使用。

包装器启动专用的无界面 Herdr 服务，再在独立窗格内执行原 Node 启动命令。Herdr 自己注入 pane/tab/workspace/socket 身份；launchd 仍负责保活，包装器退出时停止自己的 Node 进程并关闭父窗格，不关闭其他 Herdr 会话。服务日志继续写到 `/tmp/pi-web-ui.log` 和 `/tmp/pi-web-ui.err`。

服务的正常重启会短暂断开网页连接。切换前等待运行任务结束，保存内存子代理记录。回滚时恢复原 launchd plist、重新加载服务即可，用户数据不迁移。

零额度端到端测试（需要本机 Herdr、Pi CLI 和已安装的 pi-herdr-agents）：

```sh
PI_HERDR_EXTENSION=/path/to/pi-herdr-agents/pi-extension/subagents/index.ts node tests/herdr-service-test.mjs
```

测试使用单独的 Herdr 会话、工作区、配置和本地模拟模型，验证真实子代理进程启动、默认继承父模型以及结果自动回传，不访问用户工作区或远端模型。
