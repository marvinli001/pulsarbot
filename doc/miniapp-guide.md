# 管理台使用说明

Pulsarbot 的管理台入口默认由服务端同域提供，路径为 `/miniapp/`。这份文档按实际面板说明推荐使用顺序、关键职责和常见操作。

## 推荐使用顺序

1. `Overview`
2. `Workspace`
3. `Providers`
4. `Profiles`
5. `Skills / Plugins / MCP Market`
6. `MCP Servers`
7. `Search`
8. `Memory`
9. `Documents`
10. `Import/Export`
11. `Logs`
12. `Health`

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

## 5. Skills / Plugins / MCP Market

这几组面板用于查看官方 market manifests，并完成：

- install
- uninstall
- enable
- disable

推荐做法：

1. 先安装，再启用
2. 修改后立刻到 `Profiles` 或 `Runtime Preview` 核对是否进入最终运行时
3. 对于官方 MCP 条目，启用后再检查对应 server 是否已附着到 active profile

## 6. MCP Market 与 MCP Servers

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

## 7. Search

用于配置搜索优先级与回退顺序。当前管理台支持的来源包括：

- `google_native`
- `bing_native`
- `exa_mcp`
- `web_browse`

这里的设置会进入运行时装配结果，而不只是 UI 偏好项。

## 8. Memory

用于查看：

- long-term memory
- recent daily memory
- memory documents 数量
- chunk 数量
- 当前 Cloudflare 绑定状态
- pending jobs 数量

同时支持手动触发 `memory reindex`。

## 9. Documents

用于查看已入库文档与抽取状态，并支持：

- 查看 document 详情
- 重新抽取 `re-extract`
- 重新索引 `reindex`

如果语音、图片、PDF 或其他文档处理失败，优先来这里确认状态。

## 10. Import/Export

用于工作区备份与恢复，包括：

- 导出当前配置与数据包
- 导入历史 bundle
- 更换 `PULSARBOT_ACCESS_TOKEN` 后执行 `rewrap secrets`

高敏操作会要求再次输入 `PULSARBOT_ACCESS_TOKEN`。

## 11. Logs

用于查看结构化运行摘要，包括：

- recent jobs
- recent provider tests
- import/export runs
- recent audit
- MCP logs 摘要

如果你在排查“为什么刚才那次操作失败”，这个面板通常比直接翻控制台更快。

## 12. Health

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

## 推荐的首次上线流程

1. 用目标 owner 账号从 Telegram 打开 Mini App
2. 输入 `PULSARBOT_ACCESS_TOKEN`
3. 绑定 owner
4. 连接 Cloudflare
5. 初始化或接管资源
6. 配置 Provider API Key 并执行 provider test
7. 调整 `Workspace` 和 `Profiles`
8. 在 `Skills / Plugins / MCP Market` 中安装并启用需要的能力
9. 在 `Health` 和 `Logs` 面板确认系统状态
10. 回到 Telegram 私聊 Bot 发起真实对话

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
