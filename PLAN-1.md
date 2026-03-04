# Pulsarbot v1 从零架构与实施计划

## 摘要
- 目标是做一个部署在 Railway 的个人私用 Telegram Agent Bot，包含同域的 Telegram Mini App 管理台。
- 第一版按这些边界落地：单工作区、单 owner 管理、仅私聊、官方仓库内市场、Cloudflare 强制引导、自研 Agent 状态机。
- 配置与状态以 Cloudflare D1 为主存储，R2 保存 Markdown 记忆与导出包，Vectorize 用于向量记忆，Railway Volume 仅用于运行缓存、日志、导出暂存和外部依赖缓存。
- 模型层原生适配 OpenAI、Anthropic、OpenRouter、阿里云百炼，以及通用 OpenAI Chat Compatible / Responses Compatible。
- Bot 不只是问答，要支持工具调用、多步推理、skills 管理器、插件化能力、MCP 市场、自动时间注入、自动上下文压缩与静默记忆刷新。

## 已锁定的产品决策
- 部署形态：Railway 单服务一体化。
- 技术路线：TypeScript Monorepo。
- Agent 编排：自研状态机，不依赖外部 Agent 框架做主控。
- 管理认证：Telegram 身份校验 + `access_token` 绑定/高敏操作二次校验。
- 目标用户：个人私用 Bot，不做公共多用户隔离。
- 聊天范围：仅 Telegram 私聊。
- 配置主存储：Cloudflare D1。
- Cloudflare 引导：首次进入管理台必须完成绑定并初始化资源。
- 市场来源：仅官方仓库内 manifests，不允许任意远程代码安装。
- MCP 兼容：`stdio` + Streamable HTTP。
- 导入导出：全量可移植，密钥不以明文导出。

## 总体架构
- 包管理与构建：`pnpm workspace + Turborepo`
- 后端：`Node.js 22 + Fastify + grammY + zod + pino`
- 前端：`React + Vite + TanStack Router + TanStack Query + Zustand + Tailwind CSS`
- 数据访问：自建 Cloudflare API 客户端层，不依赖 Worker 绑定
- 作业执行：进程内 worker + D1 `jobs` 表调度，不引入 Redis
- 运行镜像：自定义 Dockerfile，内置 `node`、`python3`、`uv`，为文档处理和 `stdio MCP` 预留运行环境

## 单仓目录
```text
pulsarbot/
  apps/
    server/                 # Fastify API + Telegram webhook + Mini App 静态托管
    admin/                  # Telegram Mini App 前端
  packages/
    core/                   # 通用类型、配置、错误模型、token 预算器
    agent/                  # Agent loop、planner、executor、compaction
    telegram/               # grammY 集成、update router、reply streaming
    providers/              # 各模型提供商原生适配器
    skills/                 # skill runtime、prompt assembler、skill registry
    plugins/                # plugin runtime、health check、permission model
    mcp/                    # MCP supervisor、transport adapters、tool bridge
    memory/                 # R2 markdown memory、Vectorize、summary pipeline
    cloudflare/             # D1/R2/Vectorize/AI Search API client
    storage/                # repository 层、migrations、secret envelope
    market/                 # market manifest loader、resolver、installer
    ui-kit/                 # 管理台通用组件
    shared/                 # zod schemas、DTO、API contracts
  market/
    skills/                 # 官方 skills 市场清单
    plugins/                # 官方插件市场清单
    mcp/                    # 官方 MCP 市场清单
    assets/                 # 图标和静态资源
  infra/
    docker/
    railway/
    migrations/
```

## Railway 运行设计
- 单个 Railway Service 暴露一个 HTTP 入口。
- `apps/server` 同时处理：
- `POST /telegram/webhook`
- `GET /healthz`
- `/api/*` 管理 API
- `/` 与 `/miniapp/*` 的前端静态资源
- Railway Volume 挂载到 `/data`。
- `/data` 只保存这些内容：
- `runtime-cache/`
- `plugin-cache/`
- `mcp-logs/`
- `exports-staging/`
- `temp-docs/`
- Railway 重启或 redeploy 后，系统从 D1/R2 重新装载工作区配置，不依赖本地 volume 恢复业务状态。

## 环境变量
- 必填：`TELEGRAM_BOT_TOKEN`
- 必填：`PULSARBOT_ACCESS_TOKEN`
- 选填：`PORT`
- 选填：`DATA_DIR=/data`

## Cloudflare 资源策略
- D1：工作区配置、会话元数据、市场安装状态、消息索引、作业、审计日志
- R2：`MEMORY.md`、`memory/YYYY-MM-DD.md`、文档原件、导出包、长摘要快照
- Vectorize：Markdown 记忆和文档块的向量索引
- AI Search：可选，用于统一搜索层；未配置时系统仍可工作
- Cloudflare 凭证优先支持“受限作用域 API Token”，兼容“Global API Key”仅作为后备方案

## D1 数据模型
- `workspace`
- `bootstrap_state`
- `admin_identity`
- `auth_session`
- `secret_envelope`
- `provider_profile`
- `agent_profile`
- `skill_install`
- `plugin_install`
- `mcp_server`
- `search_provider`
- `conversation`
- `message`
- `tool_run`
- `conversation_summary`
- `memory_document`
- `memory_chunk`
- `vector_index_binding`
- `job`
- `audit_event`
- `import_export_run`

## R2 对象布局
- `workspace/{workspaceId}/memory/MEMORY.md`
- `workspace/{workspaceId}/memory/daily/YYYY-MM-DD.md`
- `workspace/{workspaceId}/documents/{docId}/source/*`
- `workspace/{workspaceId}/exports/{exportId}.json.enc`
- `workspace/{workspaceId}/snapshots/summary/{conversationId}/{timestamp}.md`

## 密钥与配置加密
- 除 `TELEGRAM_BOT_TOKEN` 与 `PULSARBOT_ACCESS_TOKEN` 外，其余敏感字段全部存入 `secret_envelope`。
- 加密方式固定为 `AES-256-GCM`。
- 主密钥派生方式固定为 `HKDF(PULSARBOT_ACCESS_TOKEN, workspaceId, "pulsarbot-master-key")`。
- D1 中只保存密文、IV、tag、版本号、用途标识。
- `access_token` 轮换时，管理台提供“重包裹全部密钥”的显式流程。

## 管理台认证流程
- 用户从 Telegram Bot 菜单打开 Mini App。
- 服务端验证 Telegram `initData` 签名。
- 首次启动时：
- 输入 `PULSARBOT_ACCESS_TOKEN`
- 绑定当前 Telegram 用户为 owner
- 输入 Cloudflare 凭证
- 选择“载入已有 D1/R2/Vectorize 资源”或“创建新资源”
- 执行 bootstrap migration
- 后续启动时：
- 只有 owner 的 Telegram 用户 ID 可进入管理台
- 高敏操作需要再次输入 `access_token`
- 会话采用短时 JWT Cookie，签名密钥由主密钥派生，不新增必填 env

## Agent 运行时设计
- 每次用户消息进入一个固定的 Agent loop。
- 运行阶段固定为：
1. 读取工作区配置、当前 agent profile、启用的 skills/plugins/MCP。
2. 注入精确时间头部，格式固定为 ISO 时间戳 + 工作区时区。
3. 读取长期记忆 `MEMORY.md` 与今日/昨日 daily memory。
4. 依据 token 预算器决定是否先执行静默 memory refresh 与 compact。
5. 构建可用工具列表。
6. 调用模型生成下一步动作。
7. 执行工具并回填结果。
8. 达到终止条件后生成最终回复。
9. 保存消息、工具轨迹、摘要和记忆写入。

## Agent loop 的默认约束
- 单回合最大规划步数：8
- 单回合最大工具调用数：6
- 单回合最大总耗时：30 秒
- 单工具默认超时：15 秒
- 同一时刻同一私聊只允许一个活跃 Agent 回合
- 流式输出默认开启，但可在 provider profile 中关闭

## 模型提供商设计
- 统一抽象名：`AgentProviderAdapter`
- 原生 provider kind 固定为：
- `openai`
- `anthropic`
- `openrouter`
- `bailian`
- `openai_compatible_chat`
- `openai_compatible_responses`

### 每个 provider profile 必填字段
- `id`
- `kind`
- `label`
- `apiBaseUrl`
- `apiKeyRef`
- `defaultModel`
- `stream`
- `reasoningEnabled`
- `reasoningLevel`
- `temperature`
- `maxOutputTokens`
- `toolCallingEnabled`
- `jsonModeEnabled`
- `headers`
- `extraBody`

### 适配策略
- OpenAI：原生支持 Responses API，兼容 Chat Completions
- Anthropic：原生走 Messages API，映射 `thinking` 与工具调用
- OpenRouter：走其原生 OpenAI 风格接口，但保留 provider-specific body passthrough
- 百炼：使用原生请求体映射 reasoning/thinking 选项
- OpenAI Compatible：由用户选择 Chat 模式或 Responses 模式，配置独立保存，不能混用

### 模型运行档位
- `primary_model_id`：主对话模型
- `background_model_id`：摘要、memory refresh、文档分析等后台任务模型
- 若未配置后台模型，则回退到主模型

## Skills、插件、MCP 的职责边界
- Skill：模型可感知的能力包，包含提示模板、工具绑定、启用条件、参数面板
- 插件：实际提供工具能力的运行单元，可是内部 TS 模块、HTTP 集成器或受控二进制包装器
- MCP：插件的一种来源，通过 MCP transport 暴露工具并注册进统一工具目录

## 官方市场文件结构
```text
market/skills/<id>.json
market/plugins/<id>.json
market/mcp/<id>.json
```

## 市场 manifest 公共契约
```ts
type RuntimeKind =
  | "internal"
  | "http"
  | "binary"
  | "mcp-stdio"
  | "mcp-streamable-http";

interface MarketManifestBase {
  id: string;
  version: string;
  title: string;
  description: string;
  icon?: string;
  tags: string[];
  configSchema: ZodJsonSchema;
  permissions: string[];
  dependencies: string[];
}

interface SkillManifest extends MarketManifestBase {
  kind: "skill";
  promptFragments: string[];
  toolBindings: string[];
  enabledByDefault: boolean;
}

interface PluginManifest extends MarketManifestBase {
  kind: "plugin";
  runtimeKind: RuntimeKind;
  entrypoint: string;
  healthcheck?: string;
}

interface McpManifest extends MarketManifestBase {
  kind: "mcp";
  transport: "stdio" | "streamable_http";
  command?: string;
  args?: string[];
  url?: string;
  envTemplate?: Record<string, string>;
}
```

## 第一版内置官方条目
- Skills：
- `core-agent`
- `memory-core`
- `web-search`
- `web-browse`
- `document-tools`
- `mcp-bridge`

- 插件：
- `native-google-search`，实验性，基于 HTML 结果提取
- `native-bing-search`
- `web-browse-fetcher`
- `document-processor`
- `time-context`
- `export-import`

- MCP：
- `exa-search`
- `alibaba-bailian`
- `modelscope`
- `tokenflux`
- `mcp-router`
- `generic-stdio-template`
- `generic-streamable-http-template`

## MCP 运行模型
- `stdio` MCP 由 `McpSupervisor` 启动与监管。
- `streamable_http` MCP 由 `McpHttpClient` 直连。
- 每个 MCP server 都有：
- 启用开关
- 配置校验
- 健康检查
- 最近日志缓冲
- 工具发现缓存
- 崩溃重启策略
- 自定义 MCP 表单字段按你给的界面风格固定为：
- 名称
- 描述
- 类型
- 命令或 URL
- 参数
- 环境变量
- Header
- 开关
- 保存
- 查看日志

## 内置搜索与浏览设计
- 搜索与浏览不依赖 MCP 才能工作。
- 内置搜索 provider 抽象名：`SearchProvider`
- 第一版固定支持：
- `google_native`
- `bing_native`
- `exa_mcp`
- `web_browse`
- `google_native` 与 `bing_native` 定位为“best effort”，实现方式是受控网页结果抓取，不要求用户额外 API key。
- `web_browse` 固定采用 `fetch + readability + cheerio` 提取正文，不在 v1 引入 Playwright 作为默认浏览内核。
- 若内置原生搜索被封锁，系统自动回退到 `exa_mcp` 或直接 `web_browse`。

## 记忆系统设计
- 完全采用 OpenClaw 风格的 Markdown 记忆模型。
- 长期记忆：`MEMORY.md`
- 每日日志：`memory/YYYY-MM-DD.md`
- daily memory 仅追加，不做原位编辑。
- `MEMORY.md` 允许结构化重写，但所有修改必须经 `memory-core` 工具执行。
- 对话开始时必读：
- 今天的 daily memory
- 昨天的 daily memory
- `MEMORY.md`
- 显式“记住这个”必须写入记忆，而不是只留在上下文。

## 向量记忆设计
- `memory_document` 记录 Markdown 文档元数据
- `memory_chunk` 记录 chunk、embedding 状态、Vectorize id
- 向量检索默认只检索当前工作区
- embeddings 来源由管理台选择：
- 首选已配置模型提供商中的 embedding 模型
- 若用户额外配置 Cloudflare AI Search，则可作为补充检索层
- 记忆检索工具固定为：
- `memory_search`
- `memory_append_daily`
- `memory_upsert_longterm`
- `memory_refresh_before_compact`

## 自动压缩与静默记忆刷新
- token 预算器每轮都估算上下文消耗。
- 软阈值：上下文预计达到模型上限的 70%
- 硬阈值：上下文预计达到模型上限的 85%
- 达到软阈值时：
- 先触发 `memory_refresh_before_compact`
- 使用后台模型生成滚动摘要
- 将较旧消息折叠为 `conversation_summary`
- 达到硬阈值时：
- 在下一次主模型调用前强制 compact
- compact 后保留：
- 系统提示
- 当前 agent profile
- 已启用 skills 摘要
- 最近 6 轮消息
- 最新滚动摘要
- 命中的长期记忆片段
- 工具会话状态
- 静默 memory refresh 默认输出 `NO_REPLY`，用户不可见

## Telegram 交互流
1. 用户在私聊发送消息。
2. `grammY` webhook 收到 update。
3. 系统确认是私聊并载入当前工作区配置。
4. 运行 Agent loop。
5. 如果 provider 支持流式，则先发“思考中”占位消息并持续编辑。
6. 最终回复发回 Telegram。
7. 所有轨迹写入 D1，记忆对象写入 R2，向量任务写入 `job` 表。

## 管理台模块
- 总览 Dashboard
- API 服务商 / 模型管理
- Agent Profile 管理
- Skills 管理器
- 插件市场
- MCP 市场与自定义 MCP
- 搜索与浏览设置
- 记忆与向量记忆设置
- 文档处理设置
- 导入/导出与备份恢复
- 系统日志与健康状态

## 管理 API 公开契约
- `POST /api/bootstrap/verify-access-token`
- `POST /api/bootstrap/bind-owner`
- `POST /api/bootstrap/cloudflare/connect`
- `POST /api/bootstrap/cloudflare/init-resources`
- `GET /api/workspace`
- `PUT /api/workspace`
- `GET /api/providers`
- `POST /api/providers`
- `PUT /api/providers/:id`
- `POST /api/providers/:id/test`
- `GET /api/agent-profiles`
- `POST /api/agent-profiles`
- `PUT /api/agent-profiles/:id`
- `GET /api/market/:kind`
- `POST /api/market/:kind/:id/install`
- `POST /api/market/:kind/:id/enable`
- `POST /api/market/:kind/:id/disable`
- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `PUT /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/test`
- `GET /api/memory/status`
- `POST /api/memory/reindex`
- `POST /api/settings/export`
- `POST /api/settings/import`
- `GET /api/system/logs`
- `GET /api/system/health`
- `POST /telegram/webhook`
- `GET /healthz`

## 核心 TypeScript 接口
```ts
interface AgentRuntimeContext {
  workspaceId: string;
  nowIso: string;
  timezone: string;
  profileId: string;
  enabledSkillIds: string[];
  enabledPluginIds: string[];
  enabledMcpServerIds: string[];
}

interface ToolDescriptor {
  id: string;
  title: string;
  description: string;
  inputSchema: ZodJsonSchema;
  permissionScopes: string[];
  source:
    | "plugin"
    | "mcp"
    | "builtin";
}

interface McpServerConfig {
  id: string;
  transport: "stdio" | "streamable_http";
  command?: string;
  args?: string[];
  url?: string;
  envRefs: Record<string, string>;
  enabled: boolean;
}

interface WorkspaceExportBundle {
  version: string;
  workspace: object;
  providers: object[];
  profiles: object[];
  marketInstalls: object[];
  mcpServers: object[];
  memories: object[];
  encryptedSecrets: object[];
}
```

## 导入导出设计
- 导出时要求 owner 再次输入 `access_token`。
- 导出包格式固定为 JSON。
- 导出内容包含：
- 工作区配置
- provider/profile 配置
- 市场安装状态
- MCP 配置
- 记忆元数据
- 文档元数据
- 加密后的 secrets
- 导出时再要求用户输入一次“导出口令”。
- 所有 secret 用导出口令重新加密后写入导出包。
- 导入时要求：
- Telegram owner 身份
- `access_token`
- 导入口令
- 导入完成后系统执行校验、版本迁移、Vectorize 补索引作业。

## 日志与可观测性
- 结构化日志统一使用 `pino`
- 所有敏感字段默认脱敏
- MCP 子进程日志写入 `/data/mcp-logs`
- 审计事件写入 D1 `audit_event`
- 健康检查至少覆盖：
- D1 连通性
- R2 连通性
- Vectorize 绑定状态
- Telegram webhook 状态
- provider profile 基本连通性
- 市场 manifest 装载状态

## 安全边界
- v1 不支持任意 Git 安装插件
- v1 不支持任意 shell 命令型用户插件
- 官方市场中的 `binary`/`mcp-stdio` 条目只能调用仓库内白名单 entrypoint
- 所有高成本工具都必须可被 profile 级开关禁用
- 任何会产生外部写操作的工具都必须通过 permission scope 显式授权

## 实施阶段
1. 基础骨架  
完成 monorepo、Dockerfile、Railway 配置、Fastify 服务、React Mini App 壳子、日志与配置加载。
2. Cloudflare 与启动引导  
完成 Cloudflare API 客户端、D1 migration runner、owner 绑定、Mini App 首次引导、secret envelope。
3. Telegram 与模型层  
完成 grammY webhook、provider adapters、agent profile、主模型/后台模型、流式回复。
4. Skills / 插件 / MCP  
完成 manifest 解析、市场安装、统一 tool registry、MCP supervisor、自定义 MCP 页面。
5. 记忆与压缩  
完成 R2 Markdown 记忆、Vectorize 管线、memory-core skill、自动 compact、静默 memory refresh。
6. 导入导出与加固  
完成导出包、导入迁移、审计、健康检查、失败恢复、文档处理插件与内置搜索完善。

## 测试用例与验收场景
### 单元测试
- provider 请求体映射对 OpenAI、Anthropic、OpenRouter、百炼分别正确
- `access_token` 派生密钥的加解密与重包裹正确
- token 预算器在 70%/85% 阈值下行为正确
- market manifest 校验和依赖解析正确
- MCP transport 配置解析正确

### 集成测试
- 首次 Mini App 打开后能完成 owner 绑定与 Cloudflare 初始化
- 已存在 D1/R2/Vectorize 资源时能正确接管
- 自定义 `stdio MCP` 能启动、发现工具、记录日志
- 自定义 Streamable HTTP MCP 能连接并暴露工具
- provider test connection 能正确返回成功或失败原因
- 记忆写入后能在下次会话中被检索命中

### 端到端测试
- owner 在 Mini App 中添加 OpenAI provider、启用 `memory-core`、安装 `exa-search` MCP，然后在 Telegram 私聊中完成一次多步工具调用任务
- 上下文被压缩前触发静默记忆刷新，用户只看到正常回复
- 导出后删除本地 volume，再导入导出包，系统恢复工作区配置
- Railway 重启后，Bot 与管理台仍能从 D1/R2 完整恢复
- 禁用某个 skill / plugin / MCP 后，对应工具立即从 Agent 工具目录消失

## 默认值
- 默认主对话 profile：`balanced`
- 默认背景 profile：`background-low-cost`
- 默认时区：`UTC`，首次启动时可在 Mini App 中改为 owner 所在时区
- 默认 compact 策略：滚动摘要 + 最近 6 轮保留
- 默认 memory 载入窗口：今天、昨天、`MEMORY.md`
- 默认市场条目均为“已安装但未启用”，除 `core-agent` 与 `time-context`
- 默认启用 `time-context`，确保模型每轮都知道确切日期和时间

## 关键假设
- 你说的 “telegram bot id” 在实现上按 `TELEGRAM_BOT_TOKEN` 处理；如果只有 bot id 而没有 token，Bot 无法连接 Telegram。
- 第一版是个人私用 Bot，不做公共多用户记忆隔离。
- 仅支持私聊，不做群聊逻辑。
- D1 必须通过 Cloudflare API 从 Railway 访问，因此 repository 层将直接走 Cloudflare HTTP API，而不是 Worker 绑定。
- 原生 Google/Bing 搜索在 v1 作为 best-effort 功能实现；若搜索结果页阻断抓取，Exa MCP 与 `web_browse` 是可靠回退方案。
- 受你当前边界限制，除 Telegram 与 access token 外不再新增必须 env；因此所有其他密钥都通过 Mini App 配置并存入加密的 D1 记录中。
