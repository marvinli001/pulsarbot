# 仓库结构与架构

Pulsarbot 当前是一个 `pnpm workspace + Turbo` monorepo。它的目标不是拆成很多独立服务，而是在一个主服务里闭合 Telegram Bot、Mini App、管理 API 和后台作业。

## 目录结构

```text
apps/
  admin/    React + Vite 的 Telegram Mini App
  server/   Fastify 服务端，负责 API、Webhook、静态资源与后台作业

packages/
  agent/       Agent runtime 与多步执行
  cloudflare/  Cloudflare D1 / R2 / Vectorize / AI Search 接口封装
  core/        环境变量、日志、ID、时间等基础能力
  market/      官方 manifest 装载与 runtime resolver
  mcp/         MCP supervisor、健康检查、工具发现、日志
  memory/      记忆存储、文档抽取、R2/Vectorize 相关逻辑
  plugins/     内建插件实现
  providers/   各类模型提供商请求适配
  shared/      共享类型与 schema
  skills/      技能定义与 prompt/tool binding
  storage/     Repository、D1/In-memory 存储、secret envelope
  telegram/    Telegram webhook、消息流式更新等能力
  ui-kit/      管理台基础 UI 组件

market/
  skills/      官方 skills manifests
  plugins/     官方 plugins manifests
  mcp/         官方 mcp manifests

infra/
  docker/      Docker 构建入口
  railway/     Railway 部署配置

tests/
  *.test.ts    核心逻辑测试
  e2e/         Playwright 管理台端到端测试
  fixtures/    MCP 测试夹具
```

## 应用边界

### `apps/server`

服务端是当前仓库的运行核心，负责：

- `GET /` 与 `GET /healthz`
- `/miniapp/*` 管理台静态资源
- `/api/*` 管理接口
- `POST /telegram/webhook`
- 后台 job 轮询与执行

### `apps/admin`

管理台是一个基于 React 的 Telegram Mini App，当前主要包含这些面板：

- Overview
- Workspace
- Providers
- Profiles
- Skills
- Plugins
- MCP Market
- MCP Servers
- Search
- Memory
- Documents
- Import/Export
- Logs
- Health

## 运行时主链路

一次典型请求大致会经过这些层：

1. Telegram 私聊消息进入 `apps/server`
2. 服务端读取 workspace、provider、agent profile、market install、MCP server 等配置
3. `packages/market` 解析 runtime snapshot
4. `packages/agent` 构造 prompt、工具集、memory 上下文并执行 turn
5. 如需工具调用，则进入 plugins、memory tools 或 `packages/mcp`
6. 如需模型调用，则由 `packages/providers` 负责适配并发出请求
7. 结果回写 conversation、memory、documents、jobs、audit 等存储

## 存储职责

当前代码的设计中心是 Cloudflare：

- D1：配置、conversation、messages、jobs、audit、provider test、import/export run 等结构化数据
- R2：记忆文件、文档原始对象、抽取文本、导出包等对象存储
- Vectorize：memory/document chunk 的向量索引
- AI Search：可选的搜索增强能力
- `DATA_DIR`：缓存、MCP 日志、导出暂存、临时文件

## 当前事实源

从代码实现看，以下几类数据直接影响运行时：

- Workspace
- Provider Profiles
- Agent Profiles
- Install Records
- MCP Servers
- Search Settings

这些配置的组合结果可以通过 `/api/runtime/preview` 直接查看。

## 当前成熟度判断

从仓库现状看，Pulsarbot 已经不是概念原型，而是一个具备完整主链路的 beta 基线：

- 有可访问的管理台
- 有可调用的管理 API
- 有关键路径测试
- 有导入导出与恢复
- 有健康检查与日志接口

但它仍然处于持续收口阶段，尤其是在部署、恢复、多模态作业可见性和产品化细节上，还在继续完善。
