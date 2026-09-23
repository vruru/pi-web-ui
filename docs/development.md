# 开发工作流

## 常用命令

```bash
npm run dev          # 并行：node --watch --import tsx 后端(:8788，dev:server 脚本，cross-env 固定 PI_WEB_PORT=8788，
#                     避开全局 pi-web-ui 的默认 :8787) + vite 前端(:5173，代理 /ws 到 :8788)。
#                     注意：不要用 `tsx watch` 起后端——它在 Windows 下、stdio 为管道（concurrently 的 spawn 方式）
#                     时会静默挂死（tsx 上游 bug），改用 Node 原生 --watch。
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run check:protocol  # 守护协议单源 shim 机制（CI 必跑）
npm run format       # prettier 全仓库格式化（.prettierrc.json：tabs + 宽 120；提交前必跑）
npm run format:check # 只检查不改写（CI 跑这个）
npm run build        # build:web (vite) + build:server (tsc) + build:dsh-runtime + build:mermaid-vendor + build:runtrace-vendor
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # vitest 纯函数单测（tests/unit/，毫秒级零 token）
npm run test:smoke   # 零 token 协议冒烟聚合跑器（tests/run-smoke.mjs，67 个自包含测试）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要本机 chromium headless）
```

## CI

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 触发）：`format:check → lint → check:protocol → typecheck → build → build:extension → pack:extension → vitest → test:smoke`。

冒烟清单（tests/run-smoke.mjs 的 ALL，67 个）只收**自包含、零 token、跨平台**的测试；attach 型（需外部 server）、需真模型、平台相关的脚本不进 CI，本地手动跑（分类见 run-smoke.mjs 头部注释）。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时给 `zh`/`en` 两个内置 locale 各加一个 key（`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。另外 `locales/*.json` 的 8 个可下载语言包（de/es/fr/it/ja/ko/pt/ru）也要同步加 key 且顺序与 `zh` 一致——`tests/unit/locales.test.ts` 锁这条对齐。
- **通知文案**：服务端 notice 写中文 `text` + 英文 `textEn`（客户端按 locale 二选一；中英双语字段，见 `ChatInput` 的 `description`/`descriptionEn` 先例）。发给模型的提示保持中文。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。新写/改名变量前先确认它**真有定义**：引用未定义的自定义属性按规范是 guaranteed-invalid，整条声明在计算值阶段失效（不带 fallback 的 `background` 直接没背景、`box-shadow` 连投影一起丢；带 fallback 的静默用硬编码值 → 浅色主题下是深色块）。`tests/unit/css-tokens.test.ts` 静态体检全仓 `var()` 引用，新增变量后跑一次。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 顶部维护（分平台两套）。
- **lint（oxlint）**：`npm run lint` 必须零警告；`lint:fix` 只修机械项。`.oxlintrc.json` 关掉的三条是故意：`no-control-regex`（文件名清洗正则）、`unicorn/no-new-array` 与 `typescript/no-this-alias`（oxlint 忽略行内 disable 注释，改写法反而伤可读性）。广播循环的 `[...set]` 拷贝是故意的（处理器可能在 emit 中途退订），行内有注释，别“优化”掉。
- 新增协议消息 → 只改 server/protocol.ts（见 `docs/architecture-core.md`「协议单源」），再在两端 dispatch/onmessage switch 各加分支。

## 斜杠命令目录

服务端 `pushSlashCommands()` 收集当前活动会话的扩展命令（`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+ 技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 11 个内置命令（NATIVE_COMMANDS：/new /name /model /compact /cwd /thinking /resume /reload /help /copy /pi-web-ui:quit），经 `slash_commands` 消息推送（attach / set_cwd / new_chat / switch_conversation / switch_session / get_commands 时刷新）；内置命令在 `prompt()` 里拦截（`execNativeCommand`，含 /model 模糊匹配、/thinking 中英别名、`/reload` 调 `session.reload()` 重新发现扩展/技能/模板后重推目录），其余透传 SDK（SDK 会展开扩展/技能/模板命令）。

注意 SDK 的 `getSkills()` 返回的是会话创建时的内存快照——删除/新增 skill 文件后必须 `/reload`（或 /new / 切项目重建 runtime）才生效。改动时保持 `NATIVE_COMMANDS` 与 `execNativeCommand()` 同步。回归：`slash-commands-test.mjs`。

## 验证清单

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → `tests/` 下有现成脚本可参照：先跑 `npm run test:smoke`（自包含协议测试全量），单个用 `node tests/xxx-test.mjs`（需先 `npm run build`；浏览器 E2E 需要本机 Chrome，路径由 `tests/lib/chrome.mjs` 逐平台探测，`PI_WEB_CHROME` 可覆盖）

## 测试规范

### 全局 vs 本地

用户日常可能正用**全局安装**的 `pi-web-ui`（`npm root -g` 下的 `pi-web-ui`，默认端口 `8787`）跑着对话/工作。开发改造对象永远是**本地仓库**（clone 下来的 pi-web-ui 目录）。用户会在自己测试时手动关闭全局 dev、切到本地。

**绝对不要杀全局进程/占 8787**：禁止 `pkill -f "dist/server/index.js"`——它会命中全局 server（端口 8787），把用户正在用的会话打断。清理只针对**自己启动的测试 server**。

### 隔离端口

每个 `*-test.mjs` 用独立端口（≥8900，避开 8787/5173/3300），并在启动 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 确认空闲；若被占，改端口而非硬杀。

### 精确清理自己起的进程

spawn 后记录 `server.pid`，测试收尾（含异常 catch 路径）用 `process.kill(pid, 'SIGTERM')` 只杀自己启动的。多开几个 server 时用各自 PID 逐个杀，别用宽泛模式匹配。

### data-dir 隔离

测试 server 设 `PI_WEB_DATA_DIR` 为 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地仓库——避免污染真实 user data / client-state / session。

### 界面缩放与消息跟随

全局缩放由 `UiSettingsStore` 写入 `<dataDir>/ui-settings.json`，`ready` / `ui_settings` / `settings_state` 将权威值同步到所有浏览器。测试 `ui-zoom-settings-test` 覆盖跨客户端、后到客户端、非法值及真实重启；`ui-zoom.test` 和真实浏览器检查覆盖六档与固定浮层坐标。不要把该设置加入 per-client 状态或 localStorage。

`use-message-scroll` 默认贴底，仅真实用户上翻或显式搜索跳转暂停；`MessageList.active` 在返回聊天视图时恢复。布局变化及流式结束不得伪造用户逃逸。

### 插件市场同步回归

冒烟聚合默认设置 `PI_WEB_PLUGIN_CATALOG_URL=off`，避免官方线上清单污染本地 fixture。`plugin-cwd-test` 显式覆盖为受控的本地 HTTP 清单，等插件激活后才释放启动同步响应；同时验证手动清单同步不重新激活插件、后续目录切换仍能触发钩子。仅市场元数据变化时推送 `plugin_catalog`，只有实际安装/更新后才重载插件。

### 自包含 vs 外部依赖

能进 `tests/run-smoke.mjs` 清单的测试必须**自起 server + 自清理**；不进清单的分两类（原因写在 run-smoke.mjs 头部注释）：
- ①attach 型需外部已运行 server——ws-session-test / file-upload-test / image-paste-test / commands-test(8791) / edit-reask-test / projects-test
- ②需真模型——goal-abort-test / goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test / tool-status-test（title-jsonl-test 已修复可本地跑；win32 下 terminal-smoke / restart-handoff 自动跳过）

### 需要真模型/走审查调研的（goal-*, wizard）

会真实调用 LLM、耗 token 且依赖本机模型（opencode-go 可能慢/卡）——写测试时区分「协议冒烟（无 token，如 goal-test/goal-prefs 的 set/clear 轮序）」和「live（真调用）」两类，避免误以为功能坏。

### 验证项

每改完一版，`npm run check:protocol` + `npm test` → 本地 server（隔离端口+独立 data-dir）→ 对应 `tests/*-test.mjs` 或 `npm run test:smoke` → `npm run typecheck` → 涉及 UI 再用 `playwright` 浏览器测试（chromium 由 `tests/lib/chrome.mjs` 逐平台探测，`PI_WEB_CHROME` 可覆盖）。

### 测试家族速查

| 测试组 | 说明 |
| --- | --- |
| **goal 家族** | `goal-test`=协议冒烟；`goal-prefs-test`=偏好持久化；`goal-pill-test`=GoalBar UI；`goal-rounds-test`=最大轮数输入；`goal-autostart-test`=自动触发生成；`goal-abort-test`=Stop 清除 goal；`goal-wizard-test`=问卷收敛；`goal-wizard-cancel-test`=调研取消/超时；`goal-review-loop-test`=锁定+无限轮数审查循环（需真模型） |
| **settings 家族** | `settings-test.mjs`（端口 8931）：设置面板协议冒烟——settings_state 推送 / get_settings / set_settings / save_preset / apply_preset / delete_preset / 重连持久化 |
| **global-search 家族** | `global-search-test.mjs`（端口 8962）=search_files 协议冒烟；`global-search-ui-test.mjs`（端口 8963）=真 Chrome headless UI 测试 |
| **scm 家族** | `scm-features-test.mjs`=SCM v2 功能协议测试（懒加载 history / 远程分支 / git-dir watcher）；`scm-test.mjs`=SCM 面板 E2E（真 Chrome headless） |
| **其他** | `lazy-window-test.mjs`=消息列表惰性窗口化 E2E；`terminal-bash-test.mjs`=终端接管 bash 回归；`quiesce-test.mjs`（端口 8911）=安全加固冒烟；`fetch-models-test.mjs`（端口 8955）=模型列表自动获取；`clone-provider-test.mjs`（端口 8965）=内置供应商复制；`model-config-ui-test.mjs`=模型管理 UI（真 Chrome）；`vision-bridge-test.mjs`（端口 8945）=视觉桥端到端；`vision-bridge-ui-test.mjs`=视觉桥设置面板 UI（真 Chrome） |

**Playwright 脚本**：Chrome 路径不再写死——`tests/lib/chrome.mjs` 逐平台探测（`PI_WEB_CHROME` 可覆盖）。跨平台两条硬规则：① 脚本里取仓库根用 `fileURLToPath(new URL("..", import.meta.url))`，`URL.pathname` 在 Windows 上是 `/E:/...`，`spawn` 的 cwd/脚本参数都会 ENOENT；② 服务端进程清理在 win32 用 `tests/lib/port-utils.mjs` 的 `freePort(port)`（Windows 没有负数 PID 的进程组，`process.kill(-pid)` 静默失败会留下监听进程）。

**测试脚本里禁止在 try 块内直接 `process.exit`**：`process.exit` 会跳过 `finally`，spawn 的 server 永远不会被杀 → 每次运行泄漏一个进程，下次跑同端口测试报 "port busy — abort"（steer-queue-smoke 踩过，已修：设 ok 标志 + finally 里杀进程并等端口释放再 exit）。

### Pi 核心更新

底栏连接入口使用 `CoreUpdateStatus`，服务端 `CoreUpdateManager` 维护真实运行 SDK 版本与 npm 官方 `latest` 稳定版。启动及每 6 小时检查，强制检查也有 30 秒去重；`PI_WEB_CORE_UPDATE_CHECK=off` 仅关闭自动检查，隔离测试默认设置。

当前自动安装支持 macOS launchd 管理、`PI_WEB_SDK=global` 的独立 npm 全局核心。必须从已加载 SDK 路径确定实际安装前缀，不能用另一套 Node 的默认 npm 前缀。其他安装形态仍可查看版本，但明确显示无法自动安装。`PI_WEB_MANAGED=1` 在服务端拒绝更新。

点击更新走 `update_pi_core`：先由 `CoreUpdateAdmission` 同步暂停接收新工作，并拒绝有运行中对话、已接收但尚在准备的消息、会话初始化、排队消息或插件安装的情况；独立 worker 将核心及依赖备份到 data-dir，安装精确稳定版本，校验 SDK 导入，重启同一 launchd 服务并校验新 PID/目标版本。失败时从本地备份恢复。全过程不更新 pi-web-ui，不触碰 Pi 配置和会话。持久化 `core-update.json` 让重启后的服务恢复状态；`/api/core-update` 为遵守现有 token 鉴权的只读状态接口，供断线页面轮询。页面只有在聊天连接恢复后才显示升级完成。

`core-update-test` 覆盖真实 HTTP/WS 协议、鉴权和不支持环境的拒绝路径；对应 unit 测试覆盖安装状态机、版本检查、并发锁、恢复、接收新工作控制以及浮层提醒和重连显示。
