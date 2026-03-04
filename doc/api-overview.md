# API 总览

Pulsarbot 当前的核心管理接口都挂在 `apps/server` 中，由 Fastify 提供。这里按功能分组做一份面向开发和排障的索引。

## 公共入口

- `GET /healthz`
  - 基础存活探针
- `GET /`
  - 落地页
- `POST /telegram/webhook`
  - Telegram webhook 入口

## 会话与 bootstrap

- `POST /api/session/telegram`
  - 建立 Telegram Mini App 会话
- `POST /api/session/logout`
  - 退出当前会话
- `POST /api/bootstrap/verify-access-token`
  - 校验 `PULSARBOT_ACCESS_TOKEN`
- `POST /api/bootstrap/cloudflare/connect`
  - 连接 Cloudflare 并读取资源
- `POST /api/bootstrap/cloudflare/init-resources`
  - 初始化或接管资源
- `GET /api/workspace`
- `PUT /api/workspace`

## Providers

- `GET /api/providers`
- `POST /api/providers`
- `PUT /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/test`
  - 执行 provider capability test
- `GET /api/providers/:id/tests`
  - 读取最近测试记录

## Agent Profiles 与 Runtime

- `GET /api/agent-profiles`
- `POST /api/agent-profiles`
- `PUT /api/agent-profiles/:id`
- `DELETE /api/agent-profiles/:id`
- `GET /api/runtime/preview?agentProfileId=<id>`
  - 查看 profile 最终会装配出的 runtime 快照

## Market 与 Search

- `GET /api/market/:kind`
- `POST /api/market/:kind/:id/install`
- `POST /api/market/:kind/:id/uninstall`
- `POST /api/market/:kind/:id/enable`
- `POST /api/market/:kind/:id/disable`
- `GET /api/search/settings`
- `PUT /api/search/settings`

其中 `:kind` 为：

- `skills`
- `plugins`
- `mcp`

## MCP Servers

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `PUT /api/mcp/servers/:id`
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/test`
- `GET /api/mcp/servers/:id/tools`
- `GET /api/mcp/servers/:id/logs`

## Memory、Documents、Jobs

- `GET /api/memory/status`
- `POST /api/memory/reindex`
- `GET /api/documents`
- `GET /api/documents/:id`
- `POST /api/documents/:id/re-extract`
- `POST /api/documents/:id/reindex`
- `GET /api/jobs`
  - 支持 `status` 和 `kind` 查询参数
- `POST /api/jobs/:id/retry`

## 导入、导出与安全操作

- `POST /api/settings/export`
- `POST /api/settings/import`
- `POST /api/settings/rewrap-secrets`

这些接口通常要求再次提交 `accessToken`，以确认高敏操作。

## 诊断与审计

- `GET /api/system/logs`
- `GET /api/system/audit`
- `GET /api/system/health`

## 使用建议

- 日常配置与调试优先通过管理台完成
- 排查运行时装配错误时优先查看 `/api/runtime/preview`
- 排查 provider、MCP、memory、job 问题时优先查看 `/api/system/health` 与 `/api/system/logs`
- 做自动化测试或二次集成时，再直接调用这些 API
