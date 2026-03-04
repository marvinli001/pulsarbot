# Pulsarbot v1 完整实施计划（基于现有仓库补齐到可部署可实机测试）

## 摘要

本计划以当前 `pulsarbot` 现有 monorepo 为基础，不推翻重做，而是将其补齐为一个可以部署到 Railway、面向 Telegram 私聊的完整 Agent Flow Bot 平台。  
目标不是“再做一个聊天机器人”，而是交付一套可运行的私有 Agent 系统，包含：

- Telegram Bot 私聊入口，覆盖文本、语音、图片、文档接收识别
- Telegram Mini App 管理台，作为唯一图形化配置入口
- 自研状态机 Agent Orchestrator，支持多步推理、工具调用、上下文压缩、静默记忆刷新
- Provider Router，原生支持 OpenAI / Anthropic / Gemini / OpenRouter / 阿里云百炼 / OpenAI-compatible
- Skills / Plugins / MCP 三层能力体系
- Cloudflare D1/R2/Vectorize/AI Search 驱动的配置、记忆、向量检索与恢复
- 导入导出、审计、健康检查、部署恢复链路

本计划默认 v1 的产品边界如下：

- 单工作区
- 单 owner
- 仅 Telegram 私聊使用，不支持群组
- 管理入口仅 Telegram Mini App
- 官方市场仅来自仓库内 `market/` 清单，不支持任意远程代码安装
- 配置与业务状态以 D1/R2 为唯一事实源
- Railway Volume 只用于缓存、日志、导出暂存、临时文件
- Agent 主控采用自研状态机，不引入外部 agent framework 做主控
- Telegram Bot API 在“私聊场景”下广覆盖支持，不做群组与支付电商能力

---

## 一、现状判断与本次实施目标

### 1. 当前代码库可复用部分

现仓库已具备这些可复用基础：

- `pnpm workspace + turborepo` monorepo 骨架
- `apps/server` Fastify 主服务
- `apps/admin` Mini App 前端壳子
- `packages/providers` 基础 provider adapter
- `packages/mcp` 基础 stdio / streamable_http 连接能力
- `packages/memory` 基础 R2 Markdown 记忆与向量化逻辑
- `packages/storage` 基础 D1 repository + secret envelope
- `packages/telegram` 基础 grammY webhook 接入
- `market/` 官方 skills/plugins/mcp manifests
- 基础测试、构建、类型检查链路

### 2. 当前代码的关键缺口

现有实现距离目标仍缺：

- 管理台 owner 鉴权不闭合
- 市场启用状态未真正驱动运行时
- Agent 只是单次 plan + 批量工具执行，不是完整多步状态机
- provider 配置字段与 UI 不完整
- 无 Gemini 原生适配
- Telegram Bot API 仅覆盖文本消息，未覆盖语音/图片/文档
- Mini App 缺少导入导出、日志、搜索/浏览设置、文档处理、记忆设置、MCP 详情页等模块
- 对话压缩、静默 memory refresh、审计、健康检查、恢复链路未完善
- provider secret 更新存在旧 secret 被继续读取的缺陷
- 观测性、失败恢复和部署安全边界未闭环

### 3. 本次实施定义

本次实施不是继续“补几个页面”，而是完成一次完整的 v1 收口，产出可直接部署并实机测试的系统。

---

## 二、最终产品边界与决策

### 1. 已锁定决策

- 持久化事实源：`Cloudflare D1 + R2 + Vectorize (+ AI Search optional)`
- Railway Volume：非事实源，仅缓存/日志/导出暂存/临时文件
- Telegram 范围：仅私聊 + Mini App 管理台，不做群组
- Telegram 能力：私聊内广覆盖 Bot API，至少支持文本、语音、图片、文档接收识别
- Agent 内核：自研状态机
- Provider 原生矩阵：
  - OpenAI
  - Anthropic
  - Gemini
  - OpenRouter
  - 阿里云百炼
  - OpenAI-compatible Chat
  - OpenAI-compatible Responses
- 管理台认证：Telegram initData 验证 + owner 绑定 + access_token 二次校验
- 市场来源：仓库内官方 manifests
- 插件安全：禁止任意远程代码安装、禁止任意 shell 用户插件
- v1 不做群组隔离、多租户、公开 SaaS

### 2. v1 成功标准

满足以下条件即视为 v1 完成：

- 新环境下，用户可通过 Mini App 完成首次 bootstrap
- 可配置 Cloudflare 并选择“载入已有资源”或“新建资源”
- 可在管理台配置 provider、agent profile、skills、plugins、MCP
- Telegram 私聊可发送文本/语音/图片/文档并进入 Agent loop
- Agent 支持多步工具调用、上下文压缩、记忆刷新
- 记忆可写入 R2，并通过 Vectorize 检索
- 导出包可完整导出并在新实例恢复
- Railway redeploy 后不丢配置与记忆
- 管理台移动端可操作，不因侧边栏缺失而不可用
- 基础安全、审计、健康检查闭环
- 完整测试通过

---

## 三、目标架构

## 1. 目录结构

沿用现有结构并补齐：

```text
pulsarbot/
  apps/
    server/
    admin/
  packages/
    core/
    agent/
    telegram/
    providers/
    skills/
    plugins/
    mcp/
    memory/
    cloudflare/
    storage/
    market/
    shared/
    ui-kit/
  market/
    skills/
    plugins/
    mcp/
    assets/
  infra/
    docker/
    railway/
    migrations/
```

### 2. Railway 部署拓扑

单 Railway Service，一体化运行：

- `POST /telegram/webhook`
- `GET /healthz`
- `/api/*` 管理 API
- `/miniapp/*` 管理台静态资源
- `/` 落地页

挂载 Railway Volume 到 `/data`，仅保存：

- `/data/runtime-cache`
- `/data/plugin-cache`
- `/data/mcp-logs`
- `/data/exports-staging`
- `/data/temp-docs`
- `/data/bootstrap`

---

## 四、数据与存储设计

## 1. 存储职责划分

### D1 作为主配置与业务状态库

保存：

- workspace
- bootstrap_state
- admin_identity
- auth_session
- secret_envelope
- provider_profile
- agent_profile
- skill_install
- plugin_install
- mcp_install
- mcp_server
- search_provider
- conversation
- message
- tool_run
- conversation_summary
- memory_document
- memory_chunk
- vector_index_binding
- job
- audit_event
- import_export_run
- webhook_state

### R2 作为对象存储

保存：

- `workspace/{workspaceId}/memory/MEMORY.md`
- `workspace/{workspaceId}/memory/daily/YYYY-MM-DD.md`
- `workspace/{workspaceId}/documents/{docId}/source/*`
- `workspace/{workspaceId}/documents/{docId}/derived/*`
- `workspace/{workspaceId}/exports/{exportId}.json.enc`
- `workspace/{workspaceId}/snapshots/summary/{conversationId}/{timestamp}.md`
- `workspace/{workspaceId}/media/{telegramFileId}/meta.json`

### Vectorize

保存：

- 记忆 chunk 向量
- 文档 chunk 向量
- 可选 conversation summary 向量

### AI Search

可选开启：

- 聚合搜索层
- 当未配置时，系统仍可工作

---

## 五、数据库模型

## 1. 必须新增或补齐的核心表

### `workspace`

字段：

- `id`
- `label`
- `timezone`
- `owner_telegram_user_id`
- `owner_telegram_username`
- `primary_model_profile_id`
- `background_model_profile_id`
- `active_agent_profile_id`
- `created_at`
- `updated_at`

### `admin_identity`

字段：

- `workspace_id`
- `telegram_user_id`
- `telegram_username`
- `role` 固定为 `owner`
- `bound_at`
- `last_verified_at`

### `auth_session`

字段：

- `id`
- `workspace_id`
- `telegram_user_id`
- `jwt_jti`
- `created_at`
- `expires_at`
- `revoked_at`

### `provider_profile`

在现有基础上补全：

- `id`
- `kind`
- `label`
- `api_base_url`
- `api_key_ref`
- `default_model`
- `stream`
- `reasoning_enabled`
- `reasoning_level`
- `thinking_budget`
- `temperature`
- `top_p`
- `max_output_tokens`
- `tool_calling_enabled`
- `json_mode_enabled`
- `vision_enabled`
- `audio_input_enabled`
- `headers_json`
- `extra_body_json`
- `enabled`
- `created_at`
- `updated_at`

### `agent_profile`

补全：

- `id`
- `label`
- `description`
- `system_prompt`
- `primary_model_profile_id`
- `background_model_profile_id`
- `embedding_model_profile_id`
- `enabled_skill_ids_json`
- `enabled_plugin_ids_json`
- `enabled_mcp_server_ids_json`
- `max_planning_steps`
- `max_tool_calls`
- `max_turn_duration_ms`
- `max_tool_duration_ms`
- `compact_soft_threshold`
- `compact_hard_threshold`
- `allow_network_tools`
- `allow_write_tools`
- `allow_mcp_tools`
- `created_at`
- `updated_at`

### `skill_install` / `plugin_install` / `mcp_install`

不要再用一个通用 `install_record` 混装三类，改成三张显式表，便于约束与查询。

共通字段：

- `id`
- `manifest_id`
- `enabled`
- `config_json`
- `installed_at`
- `updated_at`

### `mcp_server`

补齐：

- `id`
- `label`
- `description`
- `transport`
- `command`
- `args_json`
- `url`
- `env_secret_refs_json`
- `headers_json`
- `restart_policy`
- `tool_cache_json`
- `last_health_status`
- `last_health_checked_at`
- `enabled`
- `source`
- `created_at`
- `updated_at`

### `conversation`

新增：

- `id`
- `workspace_id`
- `telegram_chat_id`
- `telegram_user_id`
- `mode` 固定 `private`
- `active_turn_lock`
- `created_at`
- `updated_at`

### `message`

统一消息表，替代当前 `conversation_message` 临时模型：

- `id`
- `conversation_id`
- `role`
- `content`
- `source_type` `text|voice|image|document|system|tool`
- `telegram_message_id`
- `metadata_json`
- `created_at`

### `tool_run`

补齐：

- `id`
- `conversation_id`
- `turn_id`
- `tool_id`
- `tool_source`
- `input_json`
- `output_json`
- `status`
- `duration_ms`
- `created_at`

### `job`

扩展 job kind：

- `memory_reindex_document`
- `memory_reindex_all`
- `memory_refresh_before_compact`
- `document_extract`
- `telegram_file_fetch`
- `telegram_voice_transcribe`
- `telegram_image_describe`
- `mcp_healthcheck`
- `export_bundle_build`

### `audit_event`

必须落写，不再只建表不用。

字段：

- `id`
- `workspace_id`
- `actor_telegram_user_id`
- `event_type`
- `target_type`
- `target_id`
- `detail_json`
- `created_at`

### `import_export_run`

字段：

- `id`
- `workspace_id`
- `type` `import|export`
- `status`
- `operator_telegram_user_id`
- `artifact_path`
- `error`
- `created_at`
- `updated_at`

---

## 六、密钥与安全模型

## 1. 环境变量

唯一必填：

- `TELEGRAM_BOT_TOKEN`
- `PULSARBOT_ACCESS_TOKEN`

可选：

- `PORT`
- `DATA_DIR=/data`

不新增其它必填 env。

## 2. Secret Envelope

保留现有 `AES-256-GCM + HKDF` 方案，固定：

- `HKDF(PULSARBOT_ACCESS_TOKEN, workspaceId, "pulsarbot-master-key")`

### 必须修复

- provider secret 更新时必须按 `scope` upsert，而不是新增重复记录
- `resolveApiKey` 必须按 `scope` 精确唯一取值，不允许“找到第一条就返回”
- 增加 `rewrap_all_secrets` 管理流程，用于 access_token 轮换

## 3. 管理台鉴权

### 首次进入

流程固定：

1. Telegram WebApp `initData` 校验
2. 输入 `access_token`
3. 若未绑定 owner，则将当前 Telegram 用户绑定为 owner
4. 输入 Cloudflare 凭证
5. 选择：
   - 使用已有 D1/R2/Vectorize/AI Search
   - 创建新资源
6. 执行 bootstrap migration
7. 创建默认 provider/profile/install records

### 后续进入

要求：

- 仅 owner Telegram 用户 ID 可访问管理台
- JWT 中必须包含 `sub = ownerTelegramUserId`
- 服务端每次受保护 API 都要校验 JWT `sub` 是否与 workspace owner 一致
- 高敏操作必须再次提交 `access_token`：
  - 导入
  - 导出
  - 重包裹全部 secrets
  - 删除/替换 provider key
  - 变更 Cloudflare 凭证
  - 变更 owner

### Cookie 策略

- `httpOnly`
- `sameSite=lax`
- Railway 生产环境 `secure=true`
- JWT secret 使用主密钥派生，不直接用原始 `PULSARBOT_ACCESS_TOKEN`

---

## 七、Telegram Bot API 支持范围

## 1. v1 需要支持的 update types

私聊内支持：

- `message:text`
- `message:voice`
- `message:photo`
- `message:document`
- `message:audio`
- `message:caption`
- `callback_query`
- `edited_message` 可选记录
- `my_chat_member` 用于自检和 webhook 状态感知

不做：

- 群组消息处理
- 支付
- inline query
- shipping/pre_checkout
- forum topics

## 2. Telegram 私聊交互能力

### 文本

- 普通问答
- 命令入口
- 工具调用结果返回
- 流式编辑占位消息

### 语音

- 下载 Telegram voice 文件
- 转写为文本
- 将转写文本注入 agent 输入
- 保留原文件元数据到 D1/R2

### 图片

- 下载最大可用图片
- 调用支持 vision 的 provider 做图像理解
- 将提取描述与用户 caption 一并进入 agent

### 文档

- 拉取文件
- 识别类型：
  - txt / md
  - pdf
  - docx
  - csv / json
  - 其他可下载但不解析的类型
- 成功提取后写入文档对象，并可进入向量索引

### 回复形式

v1 默认仍以文本回复为主。  
不系统化支持“生成语音回复/生成图片回复”，只保留后续扩展接口。

---

## 八、Provider Router 与模型适配

## 1. 支持矩阵

### 原生适配器

- `openai`
- `anthropic`
- `gemini`
- `openrouter`
- `bailian`
- `openai_compatible_chat`
- `openai_compatible_responses`

### Gemini 增加项

新增 `gemini` adapter，支持：

- 文本输入
- 图片输入
- reasoning / thinking 配置映射
- tool/function calling 映射
- JSON mode 映射
- 流式能力开关

## 2. Provider Profile 公共字段

统一接口：

```ts
interface ProviderProfile {
  id: string;
  kind:
    | "openai"
    | "anthropic"
    | "gemini"
    | "openrouter"
    | "bailian"
    | "openai_compatible_chat"
    | "openai_compatible_responses";
  label: string;
  apiBaseUrl: string;
  apiKeyRef: string;
  defaultModel: string;
  stream: boolean;
  reasoningEnabled: boolean;
  reasoningLevel: "off" | "low" | "medium" | "high";
  thinkingBudget?: number | null;
  temperature: number;
  topP?: number | null;
  maxOutputTokens: number;
  toolCallingEnabled: boolean;
  jsonModeEnabled: boolean;
  visionEnabled: boolean;
  audioInputEnabled: boolean;
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
  enabled: boolean;
}
```

## 3. Router 行为

### 运行档位

- `primary_model_id`
- `background_model_id`
- `embedding_model_id` 可选

### 调用策略

- 主对话默认用 `primary`
- 自动 compact、memory refresh、文档抽取优先用 `background`
- 嵌入优先使用专门 embedding provider；无独立 embedding model 时允许回退到本地 hash embedding
- vision / audio input 需要检查 provider capability，不支持时退回插件级处理

---

## 九、Agent Orchestrator 设计

## 1. 状态机阶段

固定为以下状态：

1. `load_workspace`
2. `load_profile`
3. `load_memory_context`
4. `load_conversation_context`
5. `evaluate_budget`
6. `maybe_memory_refresh`
7. `assemble_tool_registry`
8. `plan_step`
9. `execute_tool`
10. `ingest_tool_result`
11. `check_stop_conditions`
12. `final_response`
13. `persist_turn`
14. `post_turn_jobs`

## 2. 运行约束

默认：

- 最大规划步数 `8`
- 最大工具调用数 `6`
- 最大总时长 `30s`
- 单工具超时 `15s`
- 同一私聊同一时刻只允许一个 active turn
- 若 provider 支持流式且 profile 开启，则使用 Telegram edit-message 流式回显

## 3. 多步执行方式

### 固定机制

- 不是一次 JSON plan 后就结束
- 每次 planner 只生成“下一步动作”
- 可能的动作：
  - `final_response`
  - `call_tool`
  - `write_memory`
  - `compact_now`
  - `abort`

### 工具执行后

- 工具结果回填 scratchpad
- 再进行下一轮 planner
- 直到达到 stop condition：
  - 得到 final response
  - 达到最大步数
  - 达到最大工具调用数
  - 达到时间上限
  - 出现不可恢复错误

## 4. ReAct / Function Calling / Chains 的实现决策

v1 统一由自研状态机承载：

- ReAct：由 planner + scratchpad 实现
- Function calling：作为 provider adapter 的可选原生能力
- Chains：作为状态机中的显式阶段组合，不独立引入外部框架

即：

- 主控永远是状态机
- provider native tool calling 只是 planner 的一种实现后端
- 不引入 LangChain / LlamaIndex / AutoGen 作为主控

---

## 十、上下文压缩与记忆刷新

## 1. 必须修复的现状问题

- Agent 必须读取 conversation history，而不是只看当前用户输入
- `conversation_summary` 的 `conversation_id` 必须是真实 conversation id，不能错写 profile id
- compact 不能只是生成文本，还必须影响下一轮上下文装载

## 2. 预算器策略

- 软阈值：70%
- 硬阈值：85%

### 达到软阈值时

1. 触发 `memory_refresh_before_compact`
2. 用后台模型生成滚动摘要
3. 写入 `conversation_summary`
4. 将旧消息折叠

### 达到硬阈值时

在下一次主模型调用前强制 compact，仅保留：

- 系统提示
- 当前 agent profile
- 已启用 skills 摘要
- 最近 6 轮消息
- 最新滚动摘要
- 命中的长期记忆
- 工具 scratchpad 状态

### 静默 memory refresh

- 默认隐藏
- 内部响应允许 `NO_REPLY`
- 用户不可见

---

## 十一、记忆系统设计

## 1. Markdown 记忆模型

固定：

- 长期记忆：`MEMORY.md`
- 每日日志：`memory/YYYY-MM-DD.md`

规则：

- daily 只追加
- `MEMORY.md` 可结构化重写
- “记住这个”必须写记忆，不允许只停留在上下文

## 2. 记忆工具

固定内置：

- `memory_search`
- `memory_append_daily`
- `memory_upsert_longterm`
- `memory_refresh_before_compact`

## 3. 文档与向量化

### 文档摄入

- Telegram 文件
- 管理台导入
- 未来插件导入

### 向量化

优先级：

1. 配置的 embedding provider
2. Cloudflare AI Search 增强检索
3. 本地 hash embedding 回退

---

## 十二、Skills / Plugins / MCP 设计

## 1. 职责边界

### Skill

模型可感知能力包，包含：

- 提示片段
- 工具绑定
- 启用条件
- 参数配置

### Plugin

提供工具执行能力的运行单元：

- 内部 TS 模块
- HTTP 集成器
- 白名单二进制包装器

### MCP

插件来源之一，通过 MCP transport 接入统一工具目录。

## 2. 市场机制

来源固定为仓库内：

- `market/skills/*.json`
- `market/plugins/*.json`
- `market/mcp/*.json`

不支持：

- 任意 Git 安装
- 任意远程脚本
- 任意 shell 命令插件

## 3. 运行时联动规则

必须改成：

- market install state 不再只是展示
- `skill_install.enabled` 决定是否可出现在 profile 选择器中
- `agent_profile.enabledSkillIds` 决定本回合实际启用项
- plugin / MCP 同理
- profile 才是最终运行时裁决层
- market 是“可安装池”
- profile 是“实际启用集”

---

## 十三、内置官方条目

## 1. Skills

- `core-agent`
- `memory-core`
- `web-search`
- `web-browse`
- `document-tools`
- `mcp-bridge`

## 2. Plugins

- `time-context`
- `native-google-search`
- `native-bing-search`
- `web-browse-fetcher`
- `document-processor`
- `telegram-media-ingest`
- `telegram-voice-transcriber`
- `telegram-image-reader`
- `export-import`

## 3. MCP Presets

- `exa-search`
- `alibaba-bailian`
- `modelscope`
- `tokenflux`
- `mcp-router`
- `generic-stdio-template`
- `generic-streamable-http-template`

---

## 十四、搜索与浏览能力

## 1. 内置搜索 provider

固定支持：

- `google_native`
- `bing_native`
- `exa_mcp`
- `web_browse`

## 2. 路由规则

- 若用户启用了内置搜索插件，优先原生搜索
- 原生搜索失败则回退到 `exa_mcp`
- 若 Exa 不可用，回退到 `web_browse`

## 3. 管理项

新增 `search_provider` 设置：

- 默认搜索优先级
- 每轮是否允许联网
- 失败回退策略
- 每次最大结果数

---

## 十五、MCP 运行模型

## 1. 传输支持

- `stdio`
- `streamable_http`

## 2. 每个 MCP server 必须具备

- 启用开关
- 配置校验
- 健康检查
- 工具发现缓存
- 最近日志缓冲
- 崩溃重启策略
- Header 配置
- Env secret refs
- 保存/测试/查看日志

## 3. 自定义 MCP 表单字段

固定：

- 名称
- 描述
- 类型
- 命令或 URL
- 参数
- 环境变量
- Header
- 开关
- 保存
- 测试
- 查看日志

---

## 十六、Mini App 管理台实施方案

## 1. 信息架构

管理台改为以下模块：

1. Dashboard
2. Workspace & Bootstrap
3. Providers
4. Agent Profiles
5. Skills Manager
6. Plugin Market
7. MCP Market
8. MCP Servers
9. Search & Browse
10. Memory
11. Documents
12. Import / Export
13. System Logs
14. Health

## 2. 移动端要求

必须支持 Telegram 内嵌 WebView：

- 不能依赖桌面侧边栏
- 移动端使用底部导航或抽屉导航
- 所有关键操作在 390px 宽度下可完成
- 表单区分高敏操作与普通操作
- Toast / error state 明确

## 3. 首次引导页

包含：

- Telegram 用户信息确认
- 输入 access_token
- 绑定 owner
- 输入 Cloudflare 凭证
- 选择资源模式：
  - 使用已有实例
  - 创建新实例
- 选择 D1 / R2 / Vectorize / AI Search 下拉框
- 初始化

## 4. Provider 管理页

可配置：

- provider kind
- label
- apiBaseUrl
- apiKey
- defaultModel
- stream
- reasoningEnabled
- reasoningLevel
- thinkingBudget
- temperature
- topP
- maxOutputTokens
- toolCallingEnabled
- jsonModeEnabled
- visionEnabled
- audioInputEnabled
- headers
- extraBody
- 测试按钮

## 5. Agent Profile 页

可配置：

- label / description
- system prompt
- primary / background / embedding provider
- enabled skills
- enabled plugins
- enabled mcp servers
- planning/tool/duration limits
- compact 阈值
- network / write / mcp 权限开关

## 6. Skills / Plugin / MCP 市场页

功能：

- 查看 manifest
- install / uninstall
- enable / disable
- 查看依赖
- 编辑 config
- 一键加入当前 profile

## 7. MCP 自定义页

支持：

- 新建
- 编辑
- 删除
- 健康检查
- 工具发现
- 日志查看
- env secret 绑定

## 8. Memory 页

展示：

- MEMORY.md 预览
- 今日/昨日 daily 预览
- 文档数量
- chunk 数量
- 向量状态
- 重建索引按钮
- compact 状态
- memory refresh job 状态

## 9. Import / Export 页

功能：

- 输入 access_token
- 输入导出口令
- 导出 JSON bundle
- 导入 JSON bundle
- 输入导入口令
- 恢复结果和日志

## 10. System / Health 页

必须显示：

- D1 连接
- R2 连接
- Vectorize 状态
- AI Search 状态
- Telegram webhook 状态
- provider test 状态
- MCP 健康摘要
- 最近审计事件
- 最近错误日志

---

## 十七、管理 API 公开契约

在现有基础上补全并固定以下接口。

## 1. Bootstrap / Session

- `POST /api/session/telegram`
- `POST /api/bootstrap/verify-access-token`
- `POST /api/bootstrap/bind-owner`
- `POST /api/bootstrap/cloudflare/connect`
- `GET /api/bootstrap/cloudflare/resources`
- `POST /api/bootstrap/cloudflare/init-resources`

## 2. Workspace

- `GET /api/workspace`
- `PUT /api/workspace`

## 3. Providers

- `GET /api/providers`
- `POST /api/providers`
- `PUT /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/test`

## 4. Agent Profiles

- `GET /api/agent-profiles`
- `POST /api/agent-profiles`
- `PUT /api/agent-profiles/:id`
- `DELETE /api/agent-profiles/:id`

## 5. Market

- `GET /api/market/:kind`
- `POST /api/market/:kind/:id/install`
- `POST /api/market/:kind/:id/uninstall`
- `POST /api/market/:kind/:id/enable`
- `POST /api/market/:kind/:id/disable`

## 6. MCP

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `PUT /api/mcp/servers/:id`
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/test`
- `GET /api/mcp/servers/:id/tools`
- `GET /api/mcp/servers/:id/logs`

## 7. Search / Browse / Memory / Documents

- `GET /api/search/settings`
- `PUT /api/search/settings`
- `GET /api/memory/status`
- `POST /api/memory/reindex`
- `GET /api/documents`
- `GET /api/documents/:id`
- `POST /api/documents/:id/reindex`

## 8. Import / Export / Secrets

- `POST /api/settings/export`
- `POST /api/settings/import`
- `POST /api/settings/rewrap-secrets`

## 9. System

- `GET /api/system/logs`
- `GET /api/system/health`
- `GET /api/system/audit`

## 10. Telegram

- `POST /telegram/webhook`
- `GET /healthz`

---

## 十八、核心 TypeScript 接口变更

## 1. ProviderKind 扩展

```ts
type ProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "bailian"
  | "openai_compatible_chat"
  | "openai_compatible_responses";
```

## 2. Agent planner action

```ts
type PlannerAction =
  | { type: "final_response"; content: string }
  | { type: "call_tool"; toolId: string; input: Record<string, unknown> }
  | { type: "write_memory"; target: "daily" | "longterm"; content: string }
  | { type: "compact_now" }
  | { type: "abort"; reason: string };
```

## 3. Telegram inbound payload abstraction

```ts
interface TelegramInboundContent {
  kind: "text" | "voice" | "image" | "document";
  text?: string;
  fileId?: string;
  mimeType?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
}
```

## 4. Conversation model

```ts
interface ConversationTurn {
  id: string;
  conversationId: string;
  inputMessages: RuntimeMessage[];
  toolRuns: ToolRunRecord[];
  summaryId?: string | null;
  finalReply: string;
  createdAt: string;
}
```

## 5. Export bundle

```ts
interface WorkspaceExportBundle {
  version: string;
  workspace: Workspace;
  providers: ProviderProfile[];
  profiles: AgentProfile[];
  skillInstalls: SkillInstall[];
  pluginInstalls: PluginInstall[];
  mcpInstalls: McpInstall[];
  mcpServers: McpServerConfig[];
  searchSettings: SearchSettings;
  memories: MemoryDocumentWithContent[];
  documents: DocumentMetadata[];
  encryptedSecrets: SecretEnvelope[];
}
```

---

## 十九、分阶段实施顺序

## Phase 1：安全与持久化收口

目标：先把“能上线的底座”修稳。

实施项：

- 修复 owner 鉴权
- JWT 校验和 owner 绑定闭环
- secure cookie / prod 配置
- secret 按 scope upsert
- D1 schema 补齐
- repository 拆分 `skill_install/plugin_install/mcp_install`
- bootstrap 流程补齐资源列表读取
- Cloudflare 资源“已有/新建”两条路完整实现
- `audit_event` 和 `import_export_run` 落写

验收：

- 非 owner 无法访问任一管理 API
- provider key 更新后立即生效
- 新实例 bootstrap 成功
- 旧实例资源可选择并接管

## Phase 2：Provider 与 Telegram 能力扩展

目标：完成模型层和 Telegram 私聊输入面。

实施项：

- 增加 Gemini adapter
- provider capabilities 建模
- provider UI 全字段编辑
- Telegram 支持 voice/photo/document/audio
- Telegram 文件下载与对象落盘
- 语音转写、图片理解、文档抽取 job 流程
- 私聊消息统一入 conversation/message 表

验收：

- 文本/语音/图片/文档都能进入 agent 输入
- OpenAI / Anthropic / Gemini / OpenRouter / 百炼 / compatible 均可测试通过

## Phase 3：自研 Agent 状态机落地

目标：从“单次调用”升级为真实 agent flow。

实施项：

- planner action 协议
- 多步循环执行器
- tool registry 统一编排
- provider-native function calling 适配
- conversation history 装载
- tool scratchpad
- stop conditions
- 单会话 active turn lock
- 流式输出

验收：

- 同一回合可连续多步调用工具
- 限制条件生效
- 并发同私聊 turn 被拒绝或排队

## Phase 4：Skills / Plugins / MCP 真正联动

目标：市场、profile、运行时三层打通。

实施项：

- market install state 与 profile 选择联动
- skill prompt fragments 注入规范化
- plugin runtime 权限控制
- MCP server 管理页、健康检查、工具发现、日志
- Exa MCP、generic stdio/http presets
- 内置 google/bing/web browse 回退链

验收：

- 管理台启停后，运行时工具列表真实变化
- 自定义 MCP 能测试、能列工具、能实际被 agent 调用

## Phase 5：记忆、压缩、文档与向量化

目标：完成长期工作记忆链路。

实施项：

- 启动时 MEMORY + 今日/昨日 daily 装载
- remember-this 自动写记忆
- compact 与 summary 真正接入对话上下文
- memory refresh 静默回合
- 文档向量化
- reindex job
- AI Search optional 接入

验收：

- 记忆可写入、检索、重建
- 对话过长时自动 compact 且保留关键上下文
- 导入恢复后可重建向量索引

## Phase 6：Mini App 完整管理面与导入导出

目标：补齐实机管理链路。

实施项：

- 移动端导航重构
- Providers/Profile/Market/MCP/Memory/Documents/Import-Export/System/Health 全页面
- 导出 bundle 加密
- 导入 bundle 迁移与恢复
- access_token 二次确认
- 错误提示、loading、empty states

验收：

- 390px 宽度下全流程可完成
- 导出后新实例导入恢复成功

## Phase 7：可观测性、加固与部署验收

目标：补齐上线前最后一层。

实施项：

- pino 结构化日志脱敏
- MCP 日志落 `/data/mcp-logs`
- health 检查真实探测
- webhook 状态显示
- provider connectivity 批量测试
- Railway 模板与部署文档
- 恢复/重建演练

验收：

- health API 能反映真实依赖状态
- redeploy 后配置恢复正常
- 整套验收场景通过

---

## 二十、测试计划

## 1. 单元测试

必须覆盖：

- secret envelope 加解密、按 scope 更新、rewrap
- provider request mapping：
  - OpenAI
  - Anthropic
  - Gemini
  - OpenRouter
  - 百炼
  - compatible chat/responses
- token budget 70% / 85%
- planner action parsing
- MCP config validation
- market manifest loading
- Telegram inbound payload normalization
- memory chunking / vector fallback

## 2. 集成测试

必须覆盖：

- bootstrap 全链路
- owner 鉴权
- provider 保存与 test
- market 安装 + profile 启用 + runtime 生效
- MCP stdio / streamable_http 实调
- Telegram 文本回合
- Telegram 语音回合
- Telegram 图片回合
- Telegram 文档回合
- compact 触发
- memory refresh 触发
- export / import / restore / reindex

## 3. E2E 测试

### Mini App

使用 Playwright：

- 首次 bootstrap
- provider 配置
- profile 配置
- MCP 添加与测试
- market enable / disable
- memory reindex
- export / import
- mobile viewport 390px

### Telegram

使用模拟 webhook payload：

- text
- voice
- image
- document

## 4. 手工验收场景

- 新建 Railway 服务后首次 bootstrap
- 使用已有 Cloudflare 资源接管
- owner 登录管理台
- 给 bot 发语音并得到转写分析
- 给 bot 发图片并得到识别分析
- 给 bot 发 PDF 并进行摘要
- 给 bot 发“记住这个”
- 长对话自动 compact
- 导出配置后在新实例恢复

---

## 二十一、上线与迁移策略

## 1. 迁移原则

- 现有 `apps/server` 和各 package 不重写目录
- 优先增量重构
- 数据模型通过 migration 扩展
- 旧测试保留，新增测试覆盖新行为

## 2. 发布策略

- `v1-beta`: 本地和 Railway 预览部署
- `v1-rc`: 完整链路验证
- `v1.0`: 单人正式使用

## 3. 回滚策略

- D1 migration 向前兼容
- 导出包始终可恢复到新实例
- 高风险变更前强制导出快照

---

## 二十二、显式默认值与假设

以下默认值已为实现者锁定，不需要再自行决定：

- 仅支持单 owner
- 仅支持 Telegram 私聊，不支持群组
- Telegram 私聊内支持文本/语音/图片/文档接收识别
- 回复默认文本，不做系统化多媒体生成回复
- D1/R2/Vectorize 为主存；Volume 不是事实源
- Mini App 是唯一图形化配置入口
- access_token 为所有高敏操作二次校验口令
- Cloudflare 凭证 UI 同时支持 API Token 和 Global API Key + Email
- 生产环境推荐受限 API Token，Global API Key 作为后备兼容
- Provider 原生矩阵包含 Gemini
- Agent 主控始终是自研状态机
- 市场来源仅仓库内 manifests
- 不支持任意远程插件代码安装
- 不支持任意 shell 用户插件
- 向量 embeddings 优先模型 provider，其次 AI Search，最后本地 hash fallback
- 管理台必须支持移动端 Telegram WebView
- 所有高成本工具必须可在 profile 级禁用
- 所有外部写操作工具必须有 permission scope

