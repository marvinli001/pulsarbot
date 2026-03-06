# 仓库结构与架构

Pulsarbot 当前是一个 `pnpm workspace + Turbo` monorepo。它的设计目标不是拆成多个彼此独立的服务，而是在一个主服务里闭合 Telegram Bot、Mini App、管理 API 和后台作业。

## 目录结构

```text
apps/
  admin/    React + Vite 的 Telegram Mini App
  server/   Fastify 服务端，负责 API、Webhook、静态资源与后台作业

packages/
  agent/       Agent runtime 与多步执行图
  cloudflare/  Cloudflare D1 / R2 / Vectorize / AI Search 接口封装
  core/        环境变量、日志、ID、时间等基础能力
  market/      manifests 装载与 runtime resolver
  mcp/         MCP supervisor、health、tools、日志
  memory/      记忆存储、文档抽取、索引处理
  plugins/     内建插件实现
  providers/   模型提供商请求适配
  shared/      schema 与共享类型
  skills/      技能定义与 prompt/tool binding
  storage/     repository、D1 / in-memory 存储、secret envelope
  telegram/    Telegram webhook、消息发送与 turn 状态控制
  ui-kit/      管理台共享 UI 组件

market/
  skills/      官方 skills manifests
  plugins/     官方 plugins manifests
  mcp/         官方 MCP manifests

infra/
  docker/      Docker 构建入口
  railway/     Railway 配置镜像

tests/
  *.test.ts    核心逻辑与集成测试
  e2e/         Playwright Mini App 流程测试
  fixtures/    MCP 夹具和测试资源
```

## 运行时拓扑

推荐部署时，系统由一个公开服务承载：

1. Telegram 把更新推送到 `POST /telegram/webhook`
2. `apps/server` 负责会话、权限、运行时装配和消息处理
3. `apps/server` 同时暴露 `/api/*` 管理接口与 `/miniapp/` 静态页面
4. `apps/admin` 只是前端构建产物来源，不单独对外提供业务 API

这就是为什么 Railway 场景下推荐只保留 `@pulsarbot/server`。

## 一次请求如何流动

一次典型对话大致会经过这些层：

1. Telegram 私聊消息进入 `apps/server`
2. 服务端读取 workspace、provider、agent profile、market install、MCP server 等配置
3. `packages/market` 解析最终 runtime snapshot
4. `packages/agent` 构造 prompt、工具集、memory 上下文并执行当前 turn
5. 如需工具调用，则进入 `packages/plugins`、`packages/memory` 或 `packages/mcp`
6. 如需模型调用，则由 `packages/providers` 负责适配并发出请求
7. 结果回写 conversation、memory、documents、jobs、audit 等存储

## 配置和事实源

从当前实现看，下面这些数据会直接影响运行时行为：

- Workspace
- Provider Profiles
- Agent Profiles
- Install Records
- MCP Providers
- MCP Servers
- Search Settings

这些配置的组合结果，可以通过 `/api/runtime/preview?agentProfileId=<id>` 查看。

## 存储边界

Pulsarbot 当前把 Cloudflare 作为完整能力链路的主要事实源：

- D1：workspace、provider、agent profile、conversation、jobs、audit、导入导出运行记录等结构化数据
- R2：记忆文件、文档原始对象、抽取文本、导出包等对象
- Vectorize：memory / document chunk 的向量索引
- AI Search：可选搜索增强
- `DATA_DIR`：缓存、MCP 日志、导出暂存和临时文件

本地开发或未挂载 volume 的部署环境也能跑，但 `DATA_DIR` 中的内容不保证持久。

## 安全与敏感数据

当前代码中的敏感信息主要包括：

- `PULSARBOT_ACCESS_TOKEN`
- Provider API Keys
- MCP Provider API Keys
- Cloudflare 凭证

其中 Provider 与 MCP Provider 的 API Key 会通过 secret envelope 落库，`rewrap` 能力用于更换 `PULSARBOT_ACCESS_TOKEN` 后重加密已有 secrets。

## 对开发者最有用的落点

如果你要修改某类能力，优先看下面这些目录：

- 调整 Bot / API / webhook / jobs：`apps/server`
- 修改管理台页面：`apps/admin`
- 增加 provider 适配：`packages/providers`
- 调整 agent 执行和工具装配：`packages/agent`
- 处理记忆、文档、索引：`packages/memory`
- 改 MCP 连接、health、tool discovery：`packages/mcp`
- 增删官方 market 条目：`market/`

## 当前成熟度判断

从仓库现状看，Pulsarbot 已经不是概念原型，而是一个可部署、可联调、可恢复、可观测的 beta 基线：

- 有完整的管理台
- 有清晰的 API 和 webhook 入口
- 有关键路径测试
- 有导入导出与恢复
- 有健康检查与日志摘要

后续工作更多是产品化收口和部署体验优化，而不是从零开始补主链路。
