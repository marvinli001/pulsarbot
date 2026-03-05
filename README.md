# Pulsarbot

Pulsarbot 是一个面向单 owner、单 workspace、Telegram 私聊场景的私有 Agent Bot，附带同域 Telegram Mini App 管理台。当前仓库已经具备从首次 bootstrap、Provider/Profile 配置、Skills/Plugins/MCP 管理，到记忆、文档处理、导入导出、健康检查的主链路能力。

## 当前状态

- 项目处于 `Beta` 收口阶段，核心能力已经成型，适合继续开发、联调与私有部署验证。
- 仓库采用 `pnpm workspace + Turbo` monorepo，服务端和管理台都已落地。
- 测试覆盖包含 Provider 请求体映射、MCP 连接、Agent runtime、Telegram 回合、导入导出恢复、Mini App E2E 等关键路径。

## 已实现能力

- Telegram 私聊消息接入，覆盖文本、语音、图片、文档、音频等入站类型
- Telegram Mini App 管理台，覆盖 workspace、provider、agent profile、market、MCP、search、memory、documents、import/export、health、logs
- Provider 适配层，支持 OpenAI、Anthropic、Gemini、OpenRouter、百炼、OpenAI-compatible Chat/Responses
- Skills / Plugins / MCP 三层能力装配，以及 runtime preview 能力预览
- `stdio` 与 `streamable_http` 两类 MCP 服务发现、健康检查、工具调用与日志读取
- 基于 Cloudflare D1、R2、Vectorize、AI Search 的持久化记忆与文档处理链路
- 导入、导出、恢复、secret rewrap、系统健康与审计接口

## 仓库结构

```text
pulsarbot/
  apps/
    admin/      # Telegram Mini App 管理台（React + Vite）
    server/     # Fastify 服务、Webhook、API、静态资源
  packages/
    agent/ cloudflare/ core/ market/ mcp/ memory/
    plugins/ providers/ shared/ skills/ storage/
    telegram/ ui-kit/
  market/       # 官方 skills / plugins / mcp manifests
  infra/        # Dockerfile、Railway 配置
  tests/        # Vitest + Playwright 覆盖
  doc/          # 项目使用与帮助文档
```

## 环境要求

- Node.js `>= 22`
- `pnpm 10.6.3`
- 必需环境变量：
  - `TELEGRAM_BOT_TOKEN`
  - `PULSARBOT_ACCESS_TOKEN`
- 常用可选变量：
  - `PORT`，默认 `3000`
  - `DATA_DIR`，默认 `/data`
  - `BODY_LIMIT_BYTES`，默认 `10485760`（10MB）
  - `CORS_ORIGIN`，默认未限制（建议生产配置白名单）
  - `NODE_ENV`，默认 `development`

## 快速开始

安装依赖：

```bash
npm exec --yes pnpm@10.6.3 install
```

首次本地运行前，先构建一次管理台与各个包：

```bash
npm exec --yes pnpm@10.6.3 build
```

启动服务端：

```bash
export TELEGRAM_BOT_TOKEN="123456:replace-me"
export PULSARBOT_ACCESS_TOKEN="replace-me"
export PORT=3000
export DATA_DIR="./data"

npm exec --yes pnpm@10.6.3 --filter @pulsarbot/server dev
```

访问：

- `http://localhost:3000/`
- `http://localhost:3000/miniapp/`
- `http://localhost:3000/healthz`

说明：

- 当前最稳妥的本地使用方式是先执行一次 `build`，再通过 `apps/server` 提供的 `/miniapp/` 使用管理台。
- `apps/admin` 可以单独运行 `vite` 做界面开发，但默认没有内置 API 代理，不能替代完整联调入口。

## 推荐使用流程

1. 在管理台首页输入 `PULSARBOT_ACCESS_TOKEN` 完成访问校验。
2. 连接 Cloudflare 账号，并选择接管已有资源或初始化新资源。
3. 检查默认创建的 Provider 与 Agent Profile。
4. 为 `Primary Provider` 填入真实 API Key，并调用 provider test。
5. 在 `Profiles`、`Skills`、`Plugins`、`MCP Market` 和 `MCP Servers` 中启用所需能力。
6. 用 `Runtime Preview`、`Health`、`Logs` 和 `Documents` 面板确认运行状态。
7. 在 Telegram 中与 Bot 私聊，验证问答、搜索、记忆与多模态链路。

## 开发与测试

```bash
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
npm exec --yes pnpm@10.6.3 test:e2e
```

当前测试覆盖重点：

- Provider 请求体与多模态能力检测
- Secret envelope 加解密与 rewrap
- Market 装载与 runtime resolver
- MCP `stdio` / `streamable_http` 工具发现与调用
- Agent runtime、token budget、Telegram 流式控制
- 服务端 bootstrap、provider test、Telegram turn、memory reindex、export/import restore
- Mini App 端到端流程

## 部署

- Railway 入口配置位于根目录 `railway.json`（`infra/railway/railway.json` 为镜像）
- Docker 构建入口位于 `infra/docker/Dockerfile`
- 生产环境建议将持久化目录挂载到 `/data`
- `DATA_DIR` 主要承载缓存、MCP 日志、导出暂存与临时文件

## 文档入口

- [文档总览](doc/README.md)
- [快速开始](doc/quick-start.md)
- [仓库结构与架构](doc/project-structure.md)
- [管理台使用说明](doc/miniapp-guide.md)
- [开发、测试与运维](doc/development-and-ops.md)
- [API 总览](doc/api-overview.md)
- [常见问题与排障](doc/help-and-faq.md)

## 当前边界

- 当前产品边界仍然以单 owner、单 workspace、Telegram 私聊为主
- Cloudflare 相关能力是完整记忆、文档、导入导出链路的主要事实源
- 仓库内的 `PLAN.md`、`PLAN-1.md`、`PLAN-2.md` 适合查看后续收口方向，但不应替代使用文档
