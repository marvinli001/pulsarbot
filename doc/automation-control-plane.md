# 自动化控制面设计

这份文档描述 Pulsarbot 当前已经落地的自动化控制面，也就是路线文档里对应的 Phase 1-4 实现。它只覆盖仓库中已经存在的能力，不提前描述尚未实现的泛化 workflow 引擎。

## 目标与边界

当前自动化控制面的目标是：

- 让 owner 能从 Telegram 或 Mini App 创建和运行任务
- 用统一的 task runtime 复用现有 turn state / turn event 观测链路
- 把高权限执行收口到 owner 自控的 `companion` 节点
- 在 Telegram-first 产品表达下提供 schedule、webhook、manual 和 `/digest` 快捷入口

当前明确的边界是：

- 单 owner、单 workspace、Telegram 私聊主线
- `telegram_shortcut` 目前只支持 `/digest`
- workflow template 已经存在，但还不是开放式 DSL

## 控制面对象

自动化控制面由 5 个核心对象组成：

- `Task`
  - 描述一个长期存在的自动化目标和默认策略
- `TaskRun`
  - 描述一次具体运行
- `Trigger`
  - 描述触发源，当前支持 `manual / schedule / webhook / telegram_shortcut`
- `ApprovalRequest`
  - 描述 owner 审批动作
- `ExecutorNode`
  - 描述一个可接任务的 companion 执行器

这些对象的 schema 位于 `packages/shared/src/index.ts`，持久化实现位于 `packages/storage/src/index.ts`。

## 运行时模型

### Task 状态

- `draft`
- `active`
- `paused`
- `archived`

### TaskRun 状态

- `queued`
- `running`
- `waiting_approval`
- `waiting_retry`
- `completed`
- `failed`
- `aborted`

### Trigger 类型

- `manual`
- `schedule`
- `webhook`
- `telegram_shortcut`

## Session Timeline 复用

Task run 不新建平行日志系统，而是把 `sessionId` 映射到现有 turn timeline：

- `trigger_fired`
- `task_run_queued`
- `task_run_started`
- `task_run_completed`
- `task_run_failed`
- `approval_requested`
- `approval_resolved`

因此 Mini App 的 `Sessions` 面板直接复用 `/api/system/turns/:turnId/state` 和 `/api/system/turns/:turnId/events`。

## Workflow Templates

当前模板固定为 5 个：

- `web_watch_report`
- `browser_workflow`
- `document_digest_memory`
- `telegram_followup`
- `webhook_fetch_analyze_push`

模板注册在 `apps/server/src/app.ts`，每个模板定义了：

- 标题与描述
- `executionMode`
  - `executor` 或 `internal`
- 默认配置
- 字段定义
- 默认 approval checkpoints

### Internal Workflow

当前 internal workflow 只实现了 `document_digest_memory`：

- 从已导入 document 读取派生文本
- 本地生成简要摘要
- 可选择写回 summary memory
- 可通过 Telegram 状态卡片回推结果

## Approval Checkpoints

当前支持的 checkpoint：

- `before_executor`
- `before_memory_writeback`
- `before_telegram_push`
- `before_fs_write`
- `before_shell`

审批不是靠 prompt 约定，而是在 task runtime 的 stage-run 过程中判断：

- executor-backed run 是否要先审批
- memory writeback 是否真的会发生
- `approval_for_write` 是否应映射到 `fs` 或 `shell`

## Workflow Capability Preview

Mini App 的 `Tasks` 面板会调用 `/api/workflow/preview`，preview 当前会返回：

- 模板与归一化后的 config
- 派生出的 `executionPlan`
- executor 可用性和 capability block
- `blockers`
- `taskRunStatus`
- `approvalRequired`
- `approvalReason`
- `requestedCapabilities`

这不是纯静态检查，而是一次不落库的 stage-run 预演，因此比单纯展示模板默认值更接近真实行为。

## Companion Executor

`apps/companion` 当前支持四类 capability：

- `browser`
- `http`
- `fs`
- `shell`

安全约束：

- executor 先在服务端创建，再生成 pairing code
- companion 主动 heartbeat，不做服务端直连 SSH
- `allowedHosts / allowedPaths / allowedCommands` 做最小权限约束
- `fsRequiresApproval / shellRequiresApproval` 可与 `approval_for_write` 联动

日志约定：

- companion 在本地执行 assignment 时会产出细粒度结构化日志
- heartbeat payload 可带两类日志：
  - `companionLogs`: 进程级和 heartbeat 级日志
  - `completedRuns[].logs`: 单次 assignment 执行日志
- server 接收后会做两次写入：
  - 追加到对应 task session 的 timeline，事件类型为 `executor_log`
  - 进入 internal log ring buffer，供 Health 页导出 `json` 或 `text`
- 当前 companion v1 已覆盖：
  - `http_request_started/completed`
  - `browser_session_started`
  - `browser_step_started/completed`
  - `browser_screenshot_captured`
  - `fs_operation_started/completed`
  - `shell_command_started/completed`
  - `executor_action_started/completed/failed`

## Telegram 与 Mini App 表达

### Telegram

固定命令：

- `/tasks`
- `/approve <approvalId>`
- `/pause <taskId>`
- `/digest`

固定状态卡片：

- `Started`
- `Waiting Approval`
- `Running`
- `Completed`
- `Failed`

卡片上的 callback 按钮当前支持：

- `Approve`
- `Reject`
- `Pause Task`

### Mini App

当前新增面板：

- `Tasks`
  - 选择模板、填字段、查看 capability preview、手动触发 run
- `Automations`
  - 管理 schedule、webhook 和 `/digest` shortcut
- `Sessions`
  - 查看 task run、approval 和 session timeline
- `Executors`
  - 管理 companion executor、pairing、scope 和最近运行

## 当前约束与下一步

当前实现已经能形成真实闭环，但仍有几个明确收口：

- `telegram_shortcut` 只承诺 `/digest`
- preview 目前是 JSON-first，可读但不是最终形态的 explain UI
- template runtime 已可用，但尚未升级成开放式 workflow node 编排系统

如果继续往下推进，最合理的下一阶段是：

1. 泛化 workflow node 和 checkpoint node
2. 把 `/digest` 扩成可配置的 Telegram slash router
3. 给 capability preview 加更强的 explain 文案和模板向导
