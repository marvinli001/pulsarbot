# 管理台使用说明

Pulsarbot 的管理台入口默认由服务端同域提供，路径为 `/miniapp/`。这份文档按实际面板说明推荐使用顺序和重点功能。

## 推荐顺序

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

## Overview

这个面板负责首次接入和 bootstrap，通常是进入系统后的第一站。

你可以在这里完成：

- 输入 `PULSARBOT_ACCESS_TOKEN`
- 连接 Cloudflare
- 查看账号下的 D1、R2、Vectorize、AI Search 资源
- 选择创建新资源或接管现有资源

建议：

- 首次接管现有账号时优先使用 `globalApiKey + email`
- 如果要真正使用 R2 对象读写，补全 `r2AccessKeyId / r2SecretAccessKey`

## Workspace

用于维护工作区级设置，例如：

- workspace 名称
- 时区
- 默认 primary/background provider
- 当前 active agent profile

这里的配置会直接影响后续运行时默认行为。

## Providers

用于管理模型提供商配置。当前面板支持的 provider 类型包括：

- OpenAI
- Anthropic
- Gemini
- OpenRouter
- Bailian
- OpenAI-compatible Chat
- OpenAI-compatible Responses

建议操作：

1. 先确保默认 provider 可用
2. 填写 API Key
3. 根据模型能力开启 vision、audio、document 等选项
4. 运行 provider test
5. 查看最近 capability test 历史

## Profiles

用于配置 Agent Profile。这里决定：

- 系统提示词
- 主模型与后台模型
- 可用 skills / plugins / MCP servers
- 规划步数、工具调用上限、时长限制
- 是否允许网络、写入与 MCP 工具

如果 profile 引用了未安装或无效的对象，服务端会在保存时拒绝。

## Skills / Plugins / MCP Market

这三组面板用于查看官方 market manifests，并完成：

- install
- uninstall
- enable
- disable

推荐做法：

- 先安装，再启用
- 修改后立即去 `Profiles` 或 `Runtime Preview` 核对是否已进入运行时

## MCP Servers

这里管理实际要连接的 MCP 实例。

支持两种 transport：

- `stdio`
- `streamable_http`

常用操作：

- 保存 MCP server 配置
- 测试健康状态
- 列出远端 tools
- 查看 MCP 运行日志

## Search

用于配置搜索优先级和回退策略。当前管理台支持的优先级来源包括：

- `google_native`
- `bing_native`
- `exa_mcp`
- `web_browse`

## Memory

用于查看：

- long-term memory
- recent daily memory
- memory documents 与 chunk 数量
- 当前存储绑定状态
- pending jobs 数量

同时可以手动触发 `memory reindex`。

## Documents

用于查看已入库文档和抽取状态，并支持：

- 重新抽取 `re-extract`
- 重新索引 `reindex`

如果语音、图片、PDF 或其他文档类处理失败，优先来这里确认状态。

## Import/Export

用于工作区备份与恢复。

高敏操作会要求再次输入 `PULSARBOT_ACCESS_TOKEN`。建议：

- 导出前确认 provider 与 secrets 都已落库
- 恢复后检查 memory 和 documents 是否需要补跑 reindex

## Logs

用于查看结构化运行摘要，包括：

- recent jobs
- recent provider tests
- import/export runs
- MCP logs 摘要
- recent audit

## Health

用于总览系统健康状态，重点包含：

- 当前模式是 `bootstrap` 还是 `d1`
- workspace 是否存在
- provider / MCP server 数量
- active turn locks
- jobs 统计
- 最近 provider tests
- 最近 MCP health
- market counts
- Cloudflare 相关健康信息
