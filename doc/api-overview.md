# API 总览

Pulsarbot 当前的核心管理接口都由 `apps/server` 提供。本文按功能分组整理一份面向开发、联调和排障的索引。

说明：

- 除 `GET /`、`GET /healthz`、`POST /telegram/webhook` 和登录相关接口外，大多数 `/api/*` 接口都要求 owner 会话。
- 会话建立后，管理台通过 cookie 访问这些接口。
- 真正的接口定义以 `apps/server/src/app.ts` 为准。

## 公共入口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/` | 服务落地页 |
| `GET` | `/healthz` | 基础存活探针 |
| `POST` | `/telegram/webhook` | Telegram webhook 入口 |
| `POST` | `/api/session/telegram` | 建立 Telegram Mini App 会话 |
| `POST` | `/api/session/logout` | 退出当前管理会话 |

## Bootstrap 与 Cloudflare 接入

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/bootstrap/verify-access-token` | 校验 `PULSARBOT_ACCESS_TOKEN` |
| `POST` | `/api/bootstrap/bind-owner` | 绑定当前 Telegram 用户为 owner |
| `POST` | `/api/bootstrap/cloudflare/connect` | 连接 Cloudflare 并验证凭证 |
| `GET` | `/api/bootstrap/cloudflare/resources` | 读取当前账号下的 Cloudflare 资源 |
| `POST` | `/api/bootstrap/cloudflare/init-resources` | 创建或接管 Pulsarbot 所需资源 |

## Workspace

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/workspace` | 读取 workspace、bootstrapState、searchSettings |
| `PUT` | `/api/workspace` | 更新 workspace 基础配置 |

## Providers

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/providers` | 列出 provider profiles |
| `POST` | `/api/providers` | 创建 provider |
| `PUT` | `/api/providers/:id` | 更新 provider |
| `DELETE` | `/api/providers/:id` | 删除 provider |
| `POST` | `/api/providers/:id/test` | 执行 provider capability test |
| `GET` | `/api/providers/:id/tests` | 查看最近的 provider test 记录 |

## Agent Profiles 与 Runtime

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/agent-profiles` | 列出 agent profiles |
| `POST` | `/api/agent-profiles` | 创建 agent profile |
| `PUT` | `/api/agent-profiles/:id` | 更新 agent profile |
| `DELETE` | `/api/agent-profiles/:id` | 删除 agent profile |
| `GET` | `/api/runtime/preview?agentProfileId=<id>` | 查看最终运行时装配快照 |

## Market 与 Search

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/market/:kind` | 读取指定 market 分类的 manifests 和 installs |
| `POST` | `/api/market/:kind/:id/install` | 安装 market 条目 |
| `POST` | `/api/market/:kind/:id/uninstall` | 卸载 market 条目 |
| `POST` | `/api/market/:kind/:id/enable` | 启用 market 条目 |
| `POST` | `/api/market/:kind/:id/disable` | 停用 market 条目 |
| `GET` | `/api/search/settings` | 读取搜索设置 |
| `PUT` | `/api/search/settings` | 更新搜索设置 |

其中 `:kind` 目前支持：

- `skills`
- `plugins`
- `mcp`

## MCP Providers

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/mcp/providers/catalog` | 读取内置 MCP provider catalog |
| `GET` | `/api/mcp/providers` | 列出已保存的 MCP providers |
| `POST` | `/api/mcp/providers` | 创建 MCP provider |
| `PUT` | `/api/mcp/providers/:id` | 更新 MCP provider |
| `DELETE` | `/api/mcp/providers/:id` | 删除 MCP provider |
| `POST` | `/api/mcp/providers/:id/fetch` | 拉取 provider 侧远端服务目录 |
| `POST` | `/api/mcp/providers/:id/servers` | 从 provider catalog 中添加 server |

## MCP Servers

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/mcp/servers` | 列出 MCP servers |
| `POST` | `/api/mcp/servers` | 创建 MCP server |
| `PUT` | `/api/mcp/servers/:id` | 更新 MCP server |
| `DELETE` | `/api/mcp/servers/:id` | 删除 MCP server |
| `POST` | `/api/mcp/servers/:id/test` | 执行 health check |
| `GET` | `/api/mcp/servers/:id/tools` | 列出远端 tools |
| `GET` | `/api/mcp/servers/:id/logs` | 读取最近 MCP 日志和最近一次检测结果 |

## Memory、Documents 与 Jobs

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/memory/status` | 读取记忆状态与 Cloudflare 绑定信息 |
| `POST` | `/api/memory/reindex` | 触发全量 memory reindex |
| `GET` | `/api/documents` | 列出 documents |
| `GET` | `/api/documents/:id` | 查看单个 document |
| `POST` | `/api/documents/:id/re-extract` | 重新抽取文档 |
| `POST` | `/api/documents/:id/reindex` | 重新索引文档 |
| `GET` | `/api/jobs` | 列出 jobs，支持 `status` 和 `kind` 查询参数 |
| `POST` | `/api/jobs/:id/retry` | 重试失败或待处理 job |

## 导入、导出与 Secret 维护

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/settings/export` | 导出当前工作区 bundle |
| `POST` | `/api/settings/import` | 导入历史 bundle |
| `POST` | `/api/settings/rewrap-secrets` | 用新 access token 重加密 secrets |

这组接口通常要求在 body 中再次提交 `accessToken`。

## 系统诊断与审计

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/system/logs` | 查看 provider tests、jobs、audit、MCP logs 摘要 |
| `GET` | `/api/system/audit` | 查看审计事件 |
| `GET` | `/api/system/health` | 查看系统健康、runtime 诊断和 webhook 状态 |
| `GET` | `/api/system/turns/:turnId/state` | 查看 turn 的最新状态快照 |
| `GET` | `/api/system/turns/:turnId/events` | 查看 turn 事件流 |
| `GET` | `/api/system/telegram-webhook` | 查看 webhook 预期地址与实际状态 |
| `POST` | `/api/system/telegram-webhook/sync` | 同步 Telegram webhook 到目标 URL |

## 使用建议

- 日常配置优先通过管理台完成，API 主要用于联调、自动化和排障。
- 排查装配问题时优先看 `/api/runtime/preview`。
- 排查 webhook、provider、MCP、memory 或 jobs 时优先看 `/api/system/health` 和 `/api/system/logs`。
- 如果需要更细粒度地分析单次对话，直接查看 turn state / events 接口。
