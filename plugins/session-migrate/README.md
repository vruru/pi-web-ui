# 会话迁移 Session Migrate 🔄

扫描 `~/.omp/agent/sessions` 与 `~/.pi/agent/sessions` 的历史会话，只读预览后一键导入 pi 会话库（issue 286 Phase 1）。

Scan history sessions under `~/.omp/agent/sessions` and `~/.pi/agent/sessions`, preview read-only, then import into the pi session store (issue 286 Phase 1).

- AI tools: `session_migrate_scan` / `session_migrate_import`
- HTTP: `GET /plugins-api/session-migrate/scan`, `POST /plugins-api/session-migrate/import`
- 规则 Rules: model_change 的 `model:'p/m'` 拆成 provider+modelId；删除 message.attribution；目标 id 已存在跳过；可选 cwd 重定向。
