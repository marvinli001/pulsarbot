## LangGraph 风格增量重构蓝图（保持现有代码栈）

### 摘要
目标是在不替换现有技术栈（Fastify + grammY + D1/JSON schema + 现有 AgentRuntime）的前提下，把当前线性 `runTurn` 升级为“可恢复、可审计、可重放”的图执行模型。  
本蓝图采用你确认的策略：两期增量、状态+事件双轨持久化、现有 API 完全兼容、默认自动恢复、工具副作用尽量至多一次、事件日志保留 7 天。

---

## 1. 设计目标与边界

### 目标
- 引入统一 `TurnState` 作为单回合执行事实源（输入、上下文、工具结果、输出、错误）。
- 将执行流程升级为显式节点图（LangGraph 思路），支持节点级状态转移与恢复。
- 保持 Telegram webhook、管理台主流程、现有接口行为兼容。
- 提供可观测事件流，支持诊断“卡住、重复、失败、恢复”。

### 非目标
- 本次不引入 LangGraph 框架依赖。
- 本次不做多 Agent（CrewAI 风格）重构。
- 第一阶段不彻底重写 planner/tool loop，仅做图外壳包裹与持久化闭环。

---

## 2. 目标架构（LangGraph 思路映射到现有代码）

### 图执行器（新增）
在 `packages/agent` 新增 Graph Runner，不改调用入口签名（`runTurn` 对上层保持兼容）。

节点（Phase 1）固定为：
1. `ingest_input`
2. `acquire_turn_lock`
3. `preprocess_content`（复用 `registerDocument`）
4. `load_runtime`
5. `persist_user_message`
6. `run_agent_core`（包裹现有 `AgentRuntime` 规划循环）
7. `persist_assistant_message`
8. `persist_tool_runs`
9. `finalize_turn`
10. `emit_reply`

失败统一跳转：
- `fail_turn`（写错误、解锁、收敛状态）

### 节点转移规则
- 每个节点输入输出都通过 `TurnState` 读写，不直接跨节点共享局部变量。
- 节点成功后写 `turn_event(node_succeeded)` 并推进 `currentNode`。
- 节点失败写 `turn_event(node_failed)`，根据 `retryable` 决定重试或失败终止。

---

## 3. TurnState 与事件模型（决策完成版）

### 3.1 `TurnState`（新增 Schema）
新增 `TurnStateSchema`（`packages/shared/src/index.ts`）字段如下：

- `id`: string（`state_*`）
- `turnId`: string
- `workspaceId`: string
- `conversationId`: string
- `graphVersion`: `"v1"`
- `status`: `"running" | "waiting_retry" | "succeeded" | "failed" | "aborted"`
- `currentNode`: string
- `version`: number（每次状态写入 +1）
- `input`:  
  `updateId`, `chatId`, `threadId`, `userId`, `username`, `messageId`, `contentKind`, `normalizedText`, `rawMetadata`
- `context`:  
  `profileId`, `timezone`, `nowIso`, `runtimeSnapshot`, `searchSettings`, `historyWindow`, `summaryCursor`
- `budgets`:  
  `maxPlanningSteps`, `maxToolCalls`, `maxTurnDurationMs`, `stepsUsed`, `toolCallsUsed`, `deadlineAt`
- `toolResults`: array of  
  `callId`, `toolId`, `source`, `input`, `output`, `status`, `idempotencyKey`, `startedAt`, `finishedAt`, `error`
- `output`:  
  `replyText`, `telegramReplyMessageId`, `streamingEnabled`, `lastRenderedChars`
- `error`: nullable  
  `code`, `message`, `nodeId`, `retryable`, `raw`
- `recovery`:  
  `resumeEligible`, `resumeCount`, `lastRecoveredAt`
- `createdAt`, `updatedAt`

### 3.2 `TurnEvent`（新增 Schema）
新增 `TurnEventSchema` 字段：

- `id`: string（`tevt_*`）
- `turnId`: string
- `seq`: number（单 turn 单调递增）
- `nodeId`: string
- `eventType`:  
  `"turn_started" | "node_started" | "node_succeeded" | "node_failed" | "tool_started" | "tool_succeeded" | "tool_failed" | "turn_succeeded" | "turn_failed" | "turn_recovered"`
- `attempt`: number
- `payload`: object
- `occurredAt`: string

---

## 4. 持久化改造（状态+事件双轨）

### 4.1 数据表与索引
在 `packages/storage/src/index.ts` migration 中新增两表：

- `turn_state_snapshot(id TEXT PRIMARY KEY, data TEXT NOT NULL)`
- `turn_event(id TEXT PRIMARY KEY, data TEXT NOT NULL)`

新增索引：
- `idx_turn_event_turn_seq` on `json_extract(data,'$.turnId')`, `json_extract(data,'$.seq')`
- `idx_turn_event_occurred_at` on `json_extract(data,'$.occurredAt')`
- `idx_turn_state_turn_id` on `json_extract(data,'$.turnId')`
- `idx_turn_state_updated_at` on `json_extract(data,'$.updatedAt')`

### 4.2 现有 `conversation_turn` 扩展字段（JSON schema 扩展）
在 `ConversationTurnSchema` 扩展可选字段（默认值保证兼容导入）：
- `graphVersion: string | null`
- `stateSnapshotId: string | null`
- `lastEventSeq: number`
- `currentNode: string | null`
- `resumeEligible: boolean`

### 4.3 Repository 接口新增（D1 + InMemory 同步）
在 `AppRepository` 增加：
- `getLatestTurnState(turnId)`
- `saveTurnStateSnapshot(state)`
- `appendTurnEvent(event)`
- `listTurnEvents(turnId, { cursorSeq, limit })`
- `pruneTurnEventsOlderThan(cutoffIso)`

---

## 5. 副作用与恢复语义（按你选择的“尽量至多一次”）

### 5.1 副作用幂等键
为每个副作用节点定义 `idempotencyKey = turnId:nodeId:attempt[:subKey]`：
- `persist_user_message`: `msg:${turnId}:user`
- `persist_assistant_message`: `msg:${turnId}:assistant`
- `persist_tool_runs`: `tool:${turnId}:${callId}`

执行策略：
- 先查询事件流是否已有 `*_succeeded`，有则跳过（幂等重放）。
- 写库用“幂等 upsert”语义（新增 `saveConversationMessage` / `saveToolRun` upsert 变体，保留旧接口兼容）。

### 5.2 自动恢复策略（服务启动）
新增 `recoverInterruptedTurns()`：
- 扫描 `conversation_turn.status=running`。
- 若 `resumeEligible=true` 且 `currentNode` 为可恢复节点：从最近 `TurnState` 自动继续。
- 若 `currentNode` 属于 Phase 1 的不可恢复节点（`run_agent_core` 中途崩溃）：标记 failed，错误码 `TURN_INTERRUPTED_NON_RESUMABLE`，释放 lock。
- 每次恢复写 `turn_recovered` 事件。

### 5.3 事件保留（7天）
新增后台清理任务：
- 每日执行 `pruneTurnEventsOlderThan(now-7d)`。
- 保留 `conversation_turn` 与最新 `turn_state_snapshot`，仅清理历史事件。

---

## 6. 对外 API / 接口变化（兼容优先）

### 6.1 保持不变
- `POST /telegram/webhook` 行为不变。
- 现有管理台关键接口不破坏。
- `AgentRuntime.runTurn` 入参/主返回保持兼容。

### 6.2 新增只读诊断 API（owner 权限）
- `GET /api/system/turns/:turnId/state`
- `GET /api/system/turns/:turnId/events?cursorSeq=&limit=`

### 6.3 扩展健康信息（可选字段，不破坏）
`GET /api/system/health` 增加 `graph`：
- `enabled`
- `runningTurns`
- `resumableTurns`
- `stuckTurns`
- `recentTurnFailures`

---

## 7. 两期实施计划（决策完成）

### Phase 1（图外壳 + 持久化 + 恢复框架）
改动文件：
- [packages/shared/src/index.ts](/Users/marvin/Documents/pulsarbot/packages/shared/src/index.ts)
- [packages/storage/src/index.ts](/Users/marvin/Documents/pulsarbot/packages/storage/src/index.ts)
- [packages/agent/src/index.ts](/Users/marvin/Documents/pulsarbot/packages/agent/src/index.ts)
- 新增 `packages/agent/src/graph/*`
- [apps/server/src/app.ts](/Users/marvin/Documents/pulsarbot/apps/server/src/app.ts)

交付内容：
- `TurnState` / `TurnEvent` schema + repo 实现 + migration。
- Graph Runner 包裹现有线性流程。
- 节点事件写入、状态快照写入。
- 自动恢复框架（含不可恢复节点降级失败逻辑）。
- 新增 turn 诊断 API。

### Phase 2（拆解 `run_agent_core` 成可恢复节点）
节点拆分：
- `plan_step`
- `execute_tool_call`
- `persist_tool_result`
- `update_scratchpad`
- `final_response_generate`

交付内容：
- 工具调用粒度事件与幂等更精细。
- `run_agent_core` 从黑盒变为可恢复子图。
- 崩溃后“工具前/后”恢复正确性覆盖。

---

## 8. 测试与验收场景

### 单元测试
- `TurnState` reducer 状态迁移合法性。
- `TurnEvent.seq` 单调递增与分页 cursor。
- 幂等键重复执行不产生重复消息/tool_run。
- 7天保留清理逻辑。

### 集成测试
- 同一 `update_id` 重投仅一次有效执行（已存在逻辑继续覆盖）。
- 每个图节点失败时 `TurnState.error` 与 `turn_event` 一致。
- 模拟崩溃后自动恢复：  
  可恢复节点可继续；不可恢复节点正确 fail 并解锁。
- `GET /api/system/turns/:turnId/state/events` 数据完整且顺序正确。

### E2E
- Telegram thread 内连续消息：单条可见回复、无重复副作用。
- 长对话 compact 后状态与 summary 持续可追踪。
- 重启后 pending/running turn 收敛正确。

### 验收标准
- 任一 turn 都能通过 `state + events` 解释“执行到哪一步、为何失败/恢复”。
- 不破坏现有 API 与管理台主路径。
- `pnpm typecheck`、现有测试、新增图执行测试全部通过。

---

## 9. 关键默认假设（已锁定）
- 重构范围：两期增量。
- 持久化：状态+事件双轨。
- 兼容性：完全兼容现有 API/管理台。
- 副作用语义：尽量至多一次（通过幂等键 + 事件去重）。
- 故障恢复：自动恢复。
- 事件日志保留：7天。

