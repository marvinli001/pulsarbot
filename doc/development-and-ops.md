# 开发、测试与运维

这份文档关注开发命令、测试入口、本地联调方式，以及部署和日常运维时最常用的信息。

## 常用命令

在仓库根目录执行：

```bash
npm exec --yes pnpm@10.6.3 install
npm exec --yes pnpm@10.6.3 build
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
npm exec --yes pnpm@10.6.3 test:e2e
```

按包执行：

```bash
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/server dev
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/admin dev
```

## 推荐本地联调方式

最稳妥的链路是：

1. `build`
2. `@pulsarbot/server dev`
3. 打开 `http://localhost:3000/miniapp/`

原因：

- 管理台 API 使用相对路径请求
- 当前 `apps/admin` 的 Vite 配置没有默认 API 代理
- 因此单跑 `apps/admin` 更适合纯 UI 开发，不适合完整业务联调

## 环境变量清单

| 变量名 | 必需 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token |
| `PULSARBOT_ACCESS_TOKEN` | 是 | 管理台访问口令，也是部分高敏操作的确认凭证 |
| `PORT` | 否 | 服务监听端口，默认 `3000` |
| `DATA_DIR` | 否 | 运行数据目录，默认 `/data` |
| `BODY_LIMIT_BYTES` | 否 | HTTP body 限制，默认 `10485760` |
| `CORS_ORIGIN` | 否 | 逗号分隔来源白名单 |
| `PUBLIC_BASE_URL` | 否 | 对外访问基准 URL |
| `TELEGRAM_WEBHOOK_URL` | 否 | 显式覆盖 webhook URL |
| `NODE_ENV` | 否 | `development` / `test` / `production` |

说明：

- 部署到 Railway 时，`RAILWAY_PUBLIC_DOMAIN` 和 `RAILWAY_STATIC_URL` 可能由平台注入，无需手动设置。
- 如果没有显式设置 `TELEGRAM_WEBHOOK_URL`，服务端会优先尝试用 `PUBLIC_BASE_URL` 或 Railway 域名推导 webhook 地址。

## 测试结构

当前仓库的测试大致分为三类：

- 单元与模块测试
  - provider request
  - secret envelope
  - market loader
  - runtime resolver
  - mcp runtime / validation
  - memory search
  - token budget
  - telegram stream
- 集成测试
  - server flows
  - agent runtime
  - import/export 恢复
- 端到端测试
  - Playwright Mini App 流程

## 什么时候跑哪些检查

### 改了服务端、运行时、Provider、MCP 或存储逻辑

至少执行：

```bash
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
```

### 改了管理台主流程或交互

补充执行：

```bash
npm exec --yes pnpm@10.6.3 test:e2e
```

## 部署入口

当前仓库已提供：

- `infra/docker/Dockerfile`
- `railway.json`
- `infra/railway/railway.json`

其中 `railway.json` 的关键行为是：

- 使用 Dockerfile 构建整个 monorepo
- 启动命令为 `node /app/apps/server/dist/index.js`
- 健康检查路径为 `/healthz`
- 配置 watch patterns，使 `apps/`、`packages/`、`market/` 等改动触发重新部署

更完整的上线说明请看：

- [部署总览](deployment.md)
- [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)

## `DATA_DIR` 说明

`DATA_DIR` 是本地或部署环境中的运行目录，当前主要承载：

- MCP 日志
- 导出暂存
- 临时文件
- 运行缓存

本地开发建议：

```bash
export DATA_DIR="./data"
```

生产环境建议：

- 挂载 volume 到 `/data`
- 保持 `DATA_DIR=/data`

## 运行观测入口

日常排障建议按以下顺序检查：

1. `GET /healthz`
2. `GET /api/system/health`
3. `GET /api/system/logs`
4. `GET /api/jobs`
5. `GET /api/system/telegram-webhook`
6. `GET /api/mcp/servers/:id/logs`

如果你在排查某个具体 turn，还可以看：

- `GET /api/system/turns/:turnId/state`
- `GET /api/system/turns/:turnId/events`

## 多模态与后台作业

文档、语音、图片等链路依赖 job 系统。出现抽取失败或状态异常时，建议顺序如下：

1. 看 `Documents` 面板或 `GET /api/documents`
2. 看 `GET /api/jobs`
3. 必要时执行 `re-extract` 或 `retry`
4. 如果 memory 检索异常，再执行 `memory reindex`

## 日常运维建议

### 发布前

1. 跑 `typecheck`
2. 跑 `test`
3. 如果涉及管理台主流程，再跑 `test:e2e`
4. 确认 `railway.json`、Dockerfile 和文档是否需要同步更新

### 发布后

1. 检查 `/healthz`
2. 检查 `/api/system/health`
3. 检查 provider test 和 webhook 状态
4. 用 Telegram 私聊真实发起一轮对话

### 迁移或重大改动前

1. 执行导出
2. 记录当前 webhook 配置
3. 如需更换 `PULSARBOT_ACCESS_TOKEN`，执行 `rewrap secrets`

## 常见误区

- 只启动 `apps/admin` 并不能覆盖完整业务联调。
- 没有挂载 `/data` 时，运行目录内的数据不具备持久性。
- 在生产环境只设置域名还不够，Telegram webhook 仍需要确认是否已成功同步。
