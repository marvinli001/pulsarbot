# 常见问题与排障

这份文档汇总当前仓库在本地联调和部署时最常见的问题。

## 1. 管理台提示 access token 无效

排查顺序：

1. 确认输入的是服务端启动时使用的 `PULSARBOT_ACCESS_TOKEN`
2. 确认没有在不同终端里混用旧值和新值
3. 如果做过 secret rewrap，确认服务端已经使用新的 access token 重启

## 2. 本地打开 `apps/admin` 的 Vite 页面后 API 请求失败

原因通常是：

- 当前 `apps/admin/vite.config.ts` 只有端口配置
- `apiFetch` 使用的是相对路径
- 没有默认 API 代理

建议：

- 完整联调时使用 `apps/server` 提供的 `/miniapp/`
- 单跑 Vite 时，把它当成纯前端开发模式

## 3. Cloudflare 已连接，但记忆、文档或导出无法写入 R2

通常是因为只配置了控制面凭证，没有配置 R2 数据面凭证。

需要补齐：

- `r2AccessKeyId`
- `r2SecretAccessKey`

没有这两个字段时，R2 对象读写不会真正可用。

## 4. Provider 保存后仍然无法正常对话

优先检查：

1. `Providers` 面板中的 API Key、模型、能力开关是否正确
2. `POST /api/providers/:id/test` 是否通过
3. `Profiles` 中使用的是否就是刚配置好的 provider
4. `Workspace` 中当前 active profile 是否正确

## 5. MCP Server 测试失败

检查点：

- `stdio` 模式下的命令、参数、环境变量是否正确
- `streamable_http` 模式下的 URL 与 Header 是否正确
- 目标 MCP 服务是否真的在线
- `GET /api/mcp/servers/:id/logs` 是否有错误输出

## 6. Document 或 Job 一直卡住

建议：

1. 查看 `GET /api/jobs`
2. 如果 job 已经失败，调用 `POST /api/jobs/:id/retry`
3. 如果 document 抽取失败，调用 `POST /api/documents/:id/re-extract`
4. 如果索引状态不对，调用 `POST /api/documents/:id/reindex` 或 `POST /api/memory/reindex`

## 7. 导出或导入失败

常见原因：

- `accessToken` 不匹配
- `exportPassphrase` / `importPassphrase` 不一致
- 当前 workspace 或 Cloudflare 绑定状态不完整

优先检查：

- `Import/Export` 面板
- `GET /api/system/logs`
- `GET /api/system/health`

## 8. 如何确认运行时到底启用了哪些能力

最直接的方法：

- 打开管理台对应 profile 的 runtime preview
- 或请求 `GET /api/runtime/preview?agentProfileId=<id>`

这比只看 install 或 profile 配置更可靠，因为它反映的是最终运行时装配结果。

## 9. 如何判断当前实例还在 bootstrap 阶段还是已经进入 D1 模式

查看：

- 管理台 `Health` 面板
- 或 `GET /api/system/health`

返回里的 `mode` 会显示当前是 `bootstrap` 还是 `d1`。
