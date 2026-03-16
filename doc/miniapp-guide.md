# 管理台使用说明

Pulsarbot 的管理台入口默认由服务端同域提供，路径为 `/miniapp/`。这份文档按实际面板说明推荐使用顺序、关键职责和常见操作。

## 推荐使用顺序

1. `Overview`
2. `Workspace`
3. `Providers`
4. `Profiles`
5. `Tasks`
6. `Automations`
7. `Sessions`
8. `Executors`
9. `Skills / Plugins / MCP Market`
10. `MCP Servers`
11. `Search`
12. `Memory`
13. `Documents`
14. `Import/Export`
15. `Logs`
16. `Health`

## 1. Overview

这是首次接入和 bootstrap 的入口页，通常也是进入系统后的第一站。

你可以在这里完成：

- 输入 `PULSARBOT_ACCESS_TOKEN`
- 校验访问权限
- 绑定当前 Telegram 用户为 owner
- 连接 Cloudflare
- 读取账号下的 D1、R2、Vectorize、AI Search 资源
- 选择创建新资源或接管现有资源

建议：

- 首次接管现有账号时优先使用 `globalApiKey + email`
- 如需真正使用 R2 对象读写，补齐 `r2AccessKeyId / r2SecretAccessKey`

## 2. Workspace

这里维护工作区级设置，包括：

- workspace 名称
- 时区
- 默认 primary / background provider
- 当前 active agent profile

这些设置会直接影响后续运行时默认行为。

## 3. Providers

用于管理模型提供商配置。当前面板覆盖的 provider 类型包括：

- OpenAI
- Anthropic
- Gemini
- OpenRouter
- Bailian
- OpenAI-compatible Chat
- OpenAI-compatible Responses

推荐操作：

1. 先确保默认 provider 可用
2. 填写 API Key
3. 按实际模型能力配置 vision、audio、document 开关
4. 保存配置
5. 运行 provider test
6. 查看最近 capability test 结果

## 4. Profiles

这里决定 agent 的实际运行方式。主要配置项包括：

- 系统提示词
- 主模型与后台模型
- 可用 skills / plugins / MCP servers
- 规划步数、工具调用上限、时长限制
- 是否允许网络、写入和 MCP 工具

如果 profile 引用了未安装、未启用或不存在的对象，服务端会拒绝保存。

## 5. Tasks

这里是自动化控制面的主入口。当前面板已经不是 generic JSON 配置页，而是 workflow template 驱动的任务编辑器。

你可以在这里完成：

- 选择 workflow template
- 填写模板字段
- 选择默认 executor
- 设置 approval policy 和 approval checkpoints
- 设置 memory policy 与 workflow budget
- 查看 capability preview
- 手动触发一次 task run

当前模板固定为：

- `网页监控并汇报`
- `打开网页完成浏览器流程`
- `读 PDF/DOCX 并生成摘要+记忆`
- `从 Telegram 消息生成待办并定时跟进`
- `收到 webhook 后抓取、分析并回推 TG`

推荐操作：

1. 先选模板，再补字段
2. 看 `Workflow Capability Preview` 是否 ready
3. 再把 task 切到 `active`
4. 用 `Run` 先做一次手动闭环

## 6. Automations

这里管理 trigger，而不是 task 本体。

当前支持：

- `schedule`
- `webhook`
- `telegram_shortcut`

说明：

- `telegram_shortcut` 当前只支持 `/digest`
- 非手动 trigger 必须绑定一个 task
- schedule trigger 需要有效的 `intervalMinutes`

推荐做法：

1. 先把 task 配好并成功手动运行一次
2. 再给它挂上 schedule 或 webhook
3. webhook 创建后，把路径和 secret 保存到你自己的外部系统里

## 7. Sessions

这里用于看 task run 的运行历史与审批状态。

面板会直接读取：

- task run 基本信息
- 关联 approval
- `session state`
- `session events`

这个面板不是另一套独立日志，而是复用现有 turn timeline。

适合排查：

- 为什么 run 卡在 `waiting_approval`
- executor 有没有真正把 run 拉走
- internal document workflow 为什么失败

## 8. Executors

这里管理 owner 自己的执行端。当前面板支持两类 executor：

- `Chrome Extension`
  - browser-only
  - 需要 explicit `attach / detach`
  - 适合复用 owner 本机浏览器中的登录态
- `Companion`
  - 支持 `browser / http / fs / shell`
  - 适合 owner 自控机器上的高权限执行

`cloud_browser` 当前只是预留 kind，不会在这个面板里作为可用部署目标出现。

你可以在这里完成：

- 创建 executor
- 选择 kind
- 设置浏览器 host allowlist
- 对 companion 设置 `allowedPaths / allowedCommands`
- 生成 pairing code
- 查看在线状态、attach state、最近心跳、最近任务
- 对 Chrome extension 执行 `Force Detach`

推荐做法：

1. 先按最小权限创建 scope
2. 如果是 Chrome extension：
   - 配对扩展
   - 把目标网页切到前台
   - 显式 attach 当前窗口
3. 如果是 companion：
   - 配对本地 companion 进程
4. 回到 `Tasks` 选择默认 executor
5. 用一个最小的 `browser_workflow` 或 `web_watch_report` 做验证

排障说明：

- 如果 task run 看起来“卡住”，先到 `System Health` 导出 internal logs。
- Health 页里的 `Download logs as...` 和 `Copy logs as...` 会包含 server internal logs，也包含 executor 通过 heartbeat 回传并被 server 摄取的执行日志。
- 如果要看某个 task run 的细节，再去 `Sessions` 面板查看对应的 `executor_log` 事件流。

## 9. Skills / Plugins / MCP Market

这几组面板用于查看官方 market manifests，并完成：

- install
- uninstall
- enable
- disable

推荐做法：

1. 先安装，再启用
2. 修改后立刻到 `Profiles` 或 `Runtime Preview` 核对是否进入最终运行时
3. 对于官方 MCP 条目，启用后再检查对应 server 是否已附着到 active profile

## 10. MCP Market 与 MCP Servers

`MCP Market` 面板本身除了官方 marketplace 条目外，也承载了 “MCP provider” 这条链路。目前代码已经支持：

- provider catalog 列表读取
- provider API key 保存
- 从 provider 拉取远端服务目录
- 把目录中的 server 加入本地 MCP Servers

`MCP Servers` 面板则负责管理真正参与运行时的实例，支持两种 transport：

- `stdio`
- `streamable_http`

常用操作：

- 保存 MCP server 配置
- 执行 health test
- 列出远端 tools
- 查看 MCP 运行日志

## 11. Search

用于配置搜索优先级与回退顺序。当前管理台支持的来源包括：

- `google_native`
- `bing_native`
- `exa_mcp`
- `web_browse`

这里的设置会进入运行时装配结果，而不只是 UI 偏好项。

## 12. Memory

用于查看：

- long-term memory
- recent daily memory
- memory documents 数量
- chunk 数量
- 当前 Cloudflare 绑定状态
- pending jobs 数量

同时支持手动触发 `memory reindex`。

## 13. Documents

用于查看已入库文档与抽取状态，并支持：

- 查看 document 详情
- 重新抽取 `re-extract`
- 重新索引 `reindex`

如果语音、图片、PDF 或其他文档处理失败，优先来这里确认状态。

## 14. Import/Export

用于工作区备份与恢复，包括：

- 导出当前配置与数据包
- 导入历史 bundle
- 更换 `PULSARBOT_ACCESS_TOKEN` 后执行 `rewrap secrets`

高敏操作会要求再次输入 `PULSARBOT_ACCESS_TOKEN`。

## 15. Logs

用于查看结构化运行摘要，包括：

- recent jobs
- recent provider tests
- import/export runs
- recent audit
- MCP logs 摘要

如果你在排查“为什么刚才那次操作失败”，这个面板通常比直接翻控制台更快。

## 16. Health

用于总览系统健康状态，重点包括：

- 当前模式是 `bootstrap` 还是 `d1`
- workspace 是否存在
- provider / MCP provider / MCP server 数量
- active turn locks
- jobs 统计
- 最近 provider tests
- 最近 MCP health
- 当前 active profile 的 runtime 诊断
- Telegram webhook 的预期地址和实际状态
- `System Health (Raw JSON)` 面板支持：
  - `Download logs as...`
  - `Copy logs as...`

这里导出的不是单纯的 health JSON，而是服务端最近保留的 internal log buffer，适合在排障时直接发给维护者。

## 推荐的首次上线流程

1. 用目标 owner 账号从 Telegram 打开 Mini App
2. 输入 `PULSARBOT_ACCESS_TOKEN`
3. 绑定 owner
4. 连接 Cloudflare
5. 初始化或接管资源
6. 配置 Provider API Key 并执行 provider test
7. 调整 `Workspace` 和 `Profiles`
8. 在 `Executors` 里创建并配对一个 executor
9. 在 `Tasks` 里创建一个模板化 task，并先手动运行一次
10. 在 `Automations` 里挂 schedule 或 webhook
11. 在 `Health`、`Logs` 和 `Sessions` 面板确认系统状态
12. 回到 Telegram 私聊 Bot 发起真实对话

## 两个典型排查动作

### 为什么 Agent 看起来没有拿到我启用的能力

优先检查：

1. 对应条目是否已经 install
2. 是否已经 enable
3. 当前 active profile 是否引用了它
4. `Runtime Preview` 里是否真的出现

### 为什么 Telegram Bot 不回消息

优先检查：

1. `Health` 面板里的 webhook 预期地址与实际地址
2. `Logs` 面板中的最近 turn / job / provider test 信息
3. Provider 是否通过测试
4. 当前 active profile 是否有效

### 为什么自动化任务一直不开始

优先检查：

1. `Tasks` 面板里的 capability preview 是否 ready
2. `Sessions` 面板里 run 当前是 `queued`、`waiting_approval` 还是 `waiting_retry`
3. `Approvals` 或 Telegram 卡片里是否还没审批
4. `Executors` 面板里的 executor 是否在线、attach 状态是否正确、capability 是否匹配
