# Pulsarbot

Pulsarbot 是一个面向 Telegram 私聊场景的私有 AI Agent Bot，内置同域 Telegram Mini App 管理台。它把 Bot webhook、管理后台、Provider 配置、Skills / Plugins / MCP 装配、记忆与文档处理、导入导出、健康检查和审计能力收敛在一个可部署的 monorepo 里。

当前仓库已经具备完整主链路，适合继续开发、联调和私有化部署。

## 项目能力

- Telegram 私聊 Bot：处理文本、图片、音频、语音、文档等入站内容。
- Telegram Mini App 管理台：通过 `/miniapp/` 管理 workspace、providers、profiles、market、memory、documents、logs 和 health。
- 多 Provider 适配：支持 OpenAI、Anthropic、Gemini、OpenRouter、百炼和 OpenAI-compatible 接口。
- Skills / Plugins / MCP 运行时装配：支持官方 market、手动 MCP server 配置和运行时预览。
- 记忆与文档链路：支持 Cloudflare D1、R2、Vectorize、AI Search 组合。
- 运维与恢复：支持 provider test、MCP health、导入导出、secret rewrap、审计和 webhook 同步。

## 推荐部署形态

当前项目推荐以单服务方式部署：

- 保留 `@pulsarbot/server` 作为唯一对外服务
- 由 `apps/server` 同时承载 API、Telegram webhook 和 `/miniapp/` 静态资源
- 不单独部署 `@pulsarbot/admin`

生产环境的三个核心入口：

- `https://<your-domain>/healthz`
- `https://<your-domain>/miniapp/`
- `https://<your-domain>/telegram/webhook`

完整部署说明见：

- [Railway + Telegram Mini App 部署指南](DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)
- [文档目录中的部署总览](doc/deployment.md)

## 技术栈

- Monorepo: `pnpm workspace` + `Turbo`
- 服务端: Fastify + TypeScript
- 管理台: React 19 + Vite + TanStack Query + TanStack Router
- Telegram: `grammy`
- 存储与基础设施: Cloudflare D1 / R2 / Vectorize / AI Search
- 测试: Vitest + Playwright

## 仓库结构

```text
pulsarbot/
  apps/
    admin/      # Telegram Mini App 管理台
    server/     # API、Webhook、后台作业、静态资源托管
  packages/
    agent/      # Agent runtime 与执行图
    cloudflare/ # Cloudflare 接口封装
    core/       # env、日志、ID、时间等基础能力
    market/     # manifests 装载与 runtime resolver
    mcp/        # MCP supervisor、health、tools、logs
    memory/     # 记忆、文档、索引处理
    plugins/    # 内建插件
    providers/  # 模型提供商适配
    shared/     # schema 与共享类型
    skills/     # skills 定义
    storage/    # repository、secret envelope、持久化
    telegram/   # Telegram webhook 和 turn 控制
    ui-kit/     # 管理台共享组件
  market/       # 官方 skills / plugins / mcp manifests
  infra/        # Dockerfile、Railway 配置
  tests/        # Vitest 与 Playwright 测试
  doc/          # 使用、开发、部署与排障文档
```

## 快速开始

### 环境要求

- Node.js `>= 22`
- `pnpm 10.6.3`
- 一个可用的 Telegram Bot Token
- 一个你自己生成的 `PULSARBOT_ACCESS_TOKEN`

### 安装依赖

```bash
npm exec --yes pnpm@10.6.3 install
```

### 配置最小环境变量

```bash
export TELEGRAM_BOT_TOKEN="123456:replace-me"
export PULSARBOT_ACCESS_TOKEN="replace-me"
export PORT=3000
export DATA_DIR="./data"
```

常用可选变量：

- `PUBLIC_BASE_URL`：部署后对外访问域名，用于 webhook 推导和回显
- `TELEGRAM_WEBHOOK_URL`：显式覆盖 webhook URL
- `BODY_LIMIT_BYTES`：请求体大小限制，默认 `10485760`
- `CORS_ORIGIN`：逗号分隔的白名单来源
- `NODE_ENV`：`development` / `test` / `production`

### 首次构建

```bash
npm exec --yes pnpm@10.6.3 build
```

### 启动服务端

```bash
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/server dev
```

本地入口：

- `http://localhost:3000/`
- `http://localhost:3000/miniapp/`
- `http://localhost:3000/healthz`

说明：

- 完整联调请优先走 `apps/server` 提供的 `/miniapp/`。
- `apps/admin` 可单独运行 Vite，但默认没有 API 代理，更适合纯前端开发。
- 开发模式下，Mini App 支持本地调试用户回退；真正的 Telegram 私聊消息链路仍需要公网 HTTPS webhook。

下一步建议：

1. 阅读 [快速开始文档](doc/quick-start.md) 完成本地 bootstrap。
2. 阅读 [管理台使用说明](doc/miniapp-guide.md) 了解各面板作用。
3. 如果要上线 Railway，直接看 [Railway + Telegram Mini App 部署指南](DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)。

## 开发与测试

```bash
npm exec --yes pnpm@10.6.3 build
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
npm exec --yes pnpm@10.6.3 test:e2e
```

当前测试重点覆盖：

- Provider 请求体映射与多模态能力判断
- Secret envelope 与 rewrap
- Market 装载与 runtime resolver
- MCP `stdio` / `streamable_http` 健康检查与工具发现
- Agent runtime、Telegram turn 控制与导入导出恢复
- Mini App 关键流程 E2E

## 文档入口

- [文档总览](doc/README.md)
- [快速开始](doc/quick-start.md)
- [部署总览](doc/deployment.md)
- [Railway + Telegram Mini App 部署指南](DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)
- [仓库结构与架构](doc/project-structure.md)
- [管理台使用说明](doc/miniapp-guide.md)
- [开发、测试与运维](doc/development-and-ops.md)
- [API 总览](doc/api-overview.md)
- [常见问题与排障](doc/help-and-faq.md)

## 运行与运维提示

- 生产环境建议挂载持久化目录到 `/data`，并设置 `DATA_DIR=/data`。
- 健康检查优先看 `/healthz`，运行态再看 `/api/system/health`。
- 结构化诊断可查看 `/api/system/logs`、`/api/system/audit` 和 `/api/jobs`。
- Telegram webhook 的预期地址与当前状态可查看 `/api/system/telegram-webhook`，必要时可调用同步接口。

## 当前产品边界

- 当前边界仍以单 owner、单 workspace、Telegram 私聊为主。
- Cloudflare 是完整记忆、文档和备份恢复链路的主要事实源。
- 根目录里的 `PLAN*.md` 适合查看后续方向，但不应替代本 README 和 `doc/` 下的实际使用文档。
