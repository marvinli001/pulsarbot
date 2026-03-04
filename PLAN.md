# PLAN-3：Pulsarbot 下一阶段收口与 Beta 就绪计划

## 摘要

- 以 2026 年 3 月 4 日的仓库状态为基线：monorepo、Telegram Mini App 管理台、Cloudflare bootstrap、provider CRUD/test、Telegram 文本/语音/图片/文档/音频入站、MCP `stdio`/`streamable_http`、R2/Vectorize 记忆、导入导出、基础 health 已落地；`pnpm test` 与 `pnpm typecheck` 当前均通过。
- 下一阶段不再重做架构，目标是把“已经存在的能力”收敛成“运行时一致、管理台可操作、可部署可恢复、可排障的 beta 系统”。
- 本阶段的主线不是继续加大而全的新功能，而是完成四件事：运行时真联动、Agent 上下文与压缩闭环、多模态与文档链路可恢复、管理台与运维能力达到实机可用。

## 当前判断

### 已完成的底座

- `apps/server` 已具备 bootstrap、workspace、providers、profiles、market、MCP、memory、documents、import/export、system API。
- `packages/agent` 已具备多步 planner loop、memory tools、MCP tool 调用、search router、summary 生成。
- `packages/providers` 已具备 OpenAI、Anthropic、Gemini、OpenRouter、百炼、OpenAI-compatible 的请求体适配。
- `packages/telegram` 已支持私聊文本、语音、图片、文档、音频 update。
- `packages/memory` 已支持 Markdown memory、R2 对象、Vectorize fallback、reindex job。
- `apps/admin` 已有完整单页管理台，但实现仍是大文件集中式结构。

### 当前最关键的缺口

- market install state、agent profile、实际 runtime tool registry 还没有成为同一个事实源。
- `conversation_summary` 已写入，但后续 turn 没有真正把“已 compact 的历史”作为长期上下文装载策略使用。
- `profile.stream` 已存在，但 Telegram 回复仍是占位后一次性改写，不是受控流式回显。
- turn lock 主要依赖进程内 `Set`，崩溃恢复与锁超时不闭合。
- 多模态文档处理仍以 webhook 内联处理为主，缺少失败可见性、重试、后台作业观测。
- 管理台依旧要求输入 provider/profile/skill/plugin/MCP 的原始 ID 或逗号串，产品可用性不足。
- admin 无 E2E 覆盖，MCP 日志也没有真正稳定落盘到 `/data/mcp-logs`。

## 本阶段目标

### 目标

把当前仓库提升为一个“单 owner、单 workspace、仅 Telegram 私聊”的 beta 可用版本，满足：

- 配置与运行时来源一致，启用/禁用会真实影响 Agent。
- 长对话 compact 后，下一轮上下文真的变短且不丢关键状态。
- 语音、图片、文档进入系统后，失败可追踪、可重试、可重建索引。
- 管理台不再依赖手填内部 ID，390px 宽度下可完成全流程。
- Railway redeploy 后可恢复，健康页能说明真实故障位置。

### 明确不做

- 不做群组支持。
- 不做多租户或多 workspace。
- 不做任意远程插件/远程代码安装。
- 不做语音回复生成或图片生成回复。
- 不新增 Redis、外部队列或额外必填 env。

## 实施顺序

## Phase 1：统一运行时事实源

### 目标

把 market、install、profile、runtime 变成一条闭环链路。

### 实施

- 新增 `ResolvedRuntimeSnapshot` 作为唯一运行时装载对象，由以下数据交集生成：
  - `workspace`
  - `agent_profile`
  - 已安装且 `enabled=true` 的 `install_record`
  - 已启用且存在的 `mcp_server`
  - `search_settings`
- `packages/market` 新增 runtime resolver，负责把 manifest、install record、profile 选择合成为最终启用集。
- `packages/skills` 不再把 hardcoded skill 定义当作唯一事实源；skill 的提示片段、tool bindings 以 `market/skills/*.json` 为准，代码层只保留执行时所需的 builtin capability registry。
- `packages/plugins` 保留工具实现，但工具是否可见由 `ResolvedRuntimeSnapshot` 控制，不再仅靠 profile 中的 ID 字符串。
- `packages/agent` 只接收 `ResolvedRuntimeSnapshot`，不再直接消费裸 `enabledSkillIds` / `enabledPluginIds` / `enabledMcpServerIds`。
- `apps/server` 新增 runtime preview API，给管理台和测试直接查看某个 profile 最终会暴露哪些 tools、skills、plugins、MCP。
- `apps/admin` 的 profile 编辑器改成选择器驱动：
  - skill 只能从“已安装且可用”的 skill 中选择
  - plugin 只能从“已安装且有执行实现”的 plugin 中选择
  - MCP 只能从“已保存且 enabled=true”的 server 中选择

### 验收

- disable 某个 install 后，对应能力立即从 runtime preview 和真实 Agent tool 列表消失。
- profile 中引用未安装项时，API 返回 validation error，而不是静默忽略。
- `search_web` 的回退链只在对应 install 和权限都满足时出现。

## Phase 2：补齐 Agent 上下文、compact 与 turn 生命周期

### 目标

让 compact、summary、memory refresh、turn lock 变成真正持久化的运行机制。

### 实施

- 新增 `conversation_turn` 表，记录：
  - `id`
  - `workspaceId`
  - `conversationId`
  - `profileId`
  - `status`
  - `stepCount`
  - `toolCallCount`
  - `compacted`
  - `summaryId`
  - `error`
  - `startedAt`
  - `finishedAt`
  - `lockExpiresAt`
- turn lock 改为“D1 持久锁 + 进程内快速锁”双层机制。
  - 默认锁 TTL 固定为 90 秒。
  - 服务启动时清理所有过期 lock。
- compact 策略固定为：
  - 软阈值命中：生成滚动摘要，写 `conversation_summary`，触发 `memory_refresh_before_compact`
  - 硬阈值命中：后续 turn 装载“最新 summary + 最近 8 条消息 + 命中的 memory + 当前 scratchpad”
- `packages/agent` 新增 conversation context loader：
  - 优先读取最新 `conversation_summary`
  - 只装载 compact cursor 之后的 tail messages
  - 不再简单固定截取最近 12 条
- `memory_refresh_before_compact` 改为后台 job 驱动；当前 turn 只负责 enqueue，不直接在主流程里长时间阻塞。
- Telegram 回复流式策略固定为：
  - 若 provider profile `stream=true` 且 adapter 支持文本流，使用 edit-message 增量更新
  - 更新节流 800ms，一回合最多 30 次 edit
  - 不支持流时保留当前占位后一次性改写

### 验收

- 连续长对话后，后续 turn 的上下文体积明显下降，但能保留用户目标、限制、未完成事项、持久记忆。
- 服务异常退出后，90 秒内不会永久卡死 conversation。
- Telegram 流式 provider 与非流式 provider 表现可区分。

## Phase 3：多模态与文档链路改为“可恢复作业管线”

### 目标

把现在偏同步的文件处理改成“可追踪、可失败、可重试”的稳定链路。

### 实施

- job worker 固定继续采用“进程内 worker + D1 `job` 表”，不引入外部队列。
- worker 轮询策略固定为：
  - 每 5 秒拉取一次
  - 单次最多处理 10 个 job
  - 最多重试 3 次
  - 回退间隔固定为 30 秒、2 分钟、10 分钟
- 文档/媒体流程拆成独立 job：
  - `telegram_file_fetch`
  - `telegram_voice_transcribe`
  - `telegram_image_describe`
  - `document_extract`
  - `memory_reindex_document`
  - `memory_reindex_all`
- webhook 的即时策略固定为：
  - 文本消息同步进入主 Agent
  - 语音/图片/文档/音频先同步生成“最小可用文本”
  - 若 8 秒内能完成抽取，则本轮直接用抽取结果
  - 超过 8 秒则先用 fallback 文本继续当前回合，同时后台 job 继续抽取并更新 document/memory
- `DocumentMetadata` 扩展字段：
  - `sourceObjectKey`
  - `derivedTextObjectKey`
  - `extractionStatus`
  - `extractionProviderProfileId`
  - `lastExtractionError`
  - `lastIndexedAt`
- 文档 API 新增 re-extract，而不是把“重新抽取”和“重新索引”混成一个动作。

### 验收

- 语音、图片、PDF、DOCX 任一处理失败时，管理台能看到失败原因并手动重试。
- 导入恢复后，memory reindex 和文档重建能重复执行且幂等。
- R2 中 source 与 derived artifact 路径稳定，不因 redeploy 漂移。

## Phase 4：管理台模块化与产品化

### 目标

把现有可用但粗糙的单文件管理台，改成真正能长期维护的 Mini App。

### 实施

- 将 `apps/admin/src/pages/dashboard.tsx` 拆成 feature modules：
  - `bootstrap`
  - `workspace`
  - `providers`
  - `profiles`
  - `market`
  - `mcp`
  - `search`
  - `memory`
  - `documents`
  - `import-export`
  - `system`
- 管理台所有“内部 ID 手填”改成选择器或列表：
  - provider/profile 关联改成 select
  - skills/plugins/MCP 改成多选组件
  - search priority 改成 drag-sort 或固定顺序多选
- 新增 `Runtime Preview` 面板，显示当前 profile 最终会启用：
  - prompt fragments
  - builtin tools
  - plugin tools
  - MCP tools
  - blocked reasons
- provider 页面增加 preset-driven 表单：
  - OpenAI
  - Anthropic
  - Gemini
  - OpenRouter
  - Bailian
  - Compatible Chat
  - Compatible Responses
- import/export 页面增加：
  - bundle metadata 预览
  - 导入前校验结果
  - rewrap secrets 结果反馈
- 所有高敏操作继续要求 `access_token` 二次确认，不改安全模型。

### 验收

- 390px 宽度下可以完成 bootstrap、provider 配置、profile 配置、market enable/disable、MCP 测试、memory reindex、export/import。
- 用户无需记任何内部 ID，即可完成完整配置。

## Phase 5：观测性、日志与 Beta 验收

### 目标

让系统在 Railway 上出现问题时可诊断、可恢复。

### 实施

- MCP stderr/stdout 日志真正持久化到 `/data/mcp-logs/<serverId>.log`。
- 新增 `provider_test_run` 表，保存 provider test 历史，供 health 页展示最近一次能力检测结果。
- `GET /api/system/health` 扩展返回：
  - bootstrap 状态
  - Cloudflare D1/R2/Vectorize/AI Search 状态
  - active turn locks
  - pending/running/failed jobs 数量
  - 最近 provider test 结果
  - 最近 MCP 健康检查结果
- `GET /api/system/logs` 继续返回结构化摘要，但以 D1 + `/data` 真实文件为准，不再仅依赖即时 healthcheck 结果。
- README 和 Railway 部署文档同步更新，增加：
  - 首次 bootstrap
  - volume 挂载
  - import/export/restore
  - 常见故障排查

### 验收

- Railway redeploy 后，Mini App 可恢复管理，memory/document/runtime 状态不丢。
- 任一 provider/MCP/Cloudflare 故障都能在管理台健康页定位到具体层。

## 需要新增或修改的公共 API

### 新增

- `GET /api/runtime/preview?agentProfileId=<id>`
- `GET /api/jobs?status=<pending|running|failed|completed>&kind=<kind>`
- `POST /api/jobs/:id/retry`
- `POST /api/documents/:id/re-extract`
- `GET /api/providers/:id/tests`

### 保持兼容但增强语义

- `POST /api/providers/:id/test`
  - 继续保留现有行为
  - 额外把结果写入 `provider_test_run`
- `POST /api/memory/reindex`
  - 改为 enqueue + 返回 job 摘要
  - 不再默认在请求内跑完整批处理
- `GET /api/system/health`
  - 返回更完整的运行态信息，而不是只做静态计数

## 需要新增或修改的核心类型

- 新增 `ResolvedRuntimeSnapshot`
- 新增 `ConversationTurn`
- 扩展 `ConversationRecord`
  - `lastTurnId`
  - `lastCompactedAt`
  - `lastSummaryId`
  - `activeTurnLockExpiresAt`
- 扩展 `DocumentMetadata`
  - `sourceObjectKey`
  - `derivedTextObjectKey`
  - `extractionStatus`
  - `extractionProviderProfileId`
  - `lastExtractionError`
  - `lastIndexedAt`
- 新增 `ProviderTestRun`
- `JobRecord.kind` 继续沿用现有枚举，不新增第二套并行 job 体系

## 数据迁移策略

- 继续沿用“绝大多数业务实体存 JSON”的方式，不重做 D1 模型。
- 只新增两个表：
  - `conversation_turn`
  - `provider_test_run`
- 其余 schema 扩展优先走 JSON payload 兼容升级。
- 所有新增字段都必须提供默认值，保证老 bundle 可以直接导入。

## 测试计划

### 单元测试

- runtime resolver 对 install/profile/MCP 的交集行为
- compact context loader 对 summary + tail message 的装载行为
- turn lock TTL 与过期回收
- job retry/backoff 规则
- document metadata 状态迁移
- provider test run 持久化

### 集成测试

- install disable 后 runtime preview 与真实工具集同步变化
- 长对话 compact 后下一轮真正用 summary 装载
- webhook 并发 turn 锁与崩溃恢复
- voice/image/document 入站的成功、失败、重试
- `POST /api/documents/:id/re-extract`
- `POST /api/jobs/:id/retry`
- import/export/restore 后 reindex 幂等

### E2E

- Playwright 跑 Mini App 首次 bootstrap
- provider/profile/market/MCP/search/memory/import-export 全流程
- 390px viewport
- provider runtime preview 页面
- 文档失败后重试恢复

## 完成标准

满足以下条件，本阶段视为完成：

- 管理台不再要求用户输入内部 ID 或逗号拼接的启用项。
- market install state、profile 选择、Agent 实际 tool registry 三者一致。
- 长对话会真正 compact，并在后续 turn 生效。
- 多模态文档链路失败可见、可重试、可重建。
- `/api/system/health` 能反映真实运行状态。
- `pnpm typecheck`、现有测试、扩展后的集成测试、Playwright E2E 全通过。
- Railway 预览部署可完成一次“新建实例 bootstrap -> 私聊对话 -> 导出 -> 新实例导入恢复”的闭环演练。

## 默认假设

- 继续维持单 owner、单 workspace、仅 Telegram 私聊。
- 继续保留 Gemini 适配，因为仓库里已经有 schema、UI、provider adapter 入口，不在本阶段删除。
- 继续维持 Cloudflare 为唯一业务事实源，Railway Volume 只做缓存、日志、暂存。
- 继续维持本地 hash embedding 为默认回退，不把独立 embedding provider 作为本阶段强依赖。
- 不新增新的部署环境变量。
