# 常见问题与排障

这份文档汇总 Pulsarbot 在本地联调、Railway 部署和运行时最常见的问题。

## 1. 管理台提示 access token 无效

排查顺序：

1. 确认输入的是服务端启动时使用的 `PULSARBOT_ACCESS_TOKEN`
2. 确认没有在不同终端或不同 Railway 服务里混用旧值和新值
3. 如果刚做过 `rewrap secrets`，确认服务端已经使用新的 access token 重启

## 2. 本地打开 `apps/admin` 的 Vite 页面后 API 请求失败

原因通常是：

- 当前 `apps/admin` 默认没有 API 代理
- 管理台请求使用相对路径
- 单独跑 `apps/admin` 时并没有同域 API

建议：

- 完整联调时使用 `apps/server` 提供的 `/miniapp/`
- 单跑 Vite 时，把它当成纯前端开发模式

## 3. Railway 导入仓库后自动出现两个服务

这是 monorepo 自动识别带来的常见现象。当前项目的推荐做法是：

- 保留 `@pulsarbot/server`
- 删除或停用 `@pulsarbot/admin`

原因：

- `apps/server` 已经托管 `/miniapp/`
- webhook 和 API 也都在同一个服务里
- 单独部署 admin 只会增加变量、域名和日志的维护复杂度

完整处理方式见 [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)。

## 4. 部署后 `/healthz` 失败，服务反复重启

优先检查当前部署服务里是否真的配置了以下变量：

- `TELEGRAM_BOT_TOKEN`
- `PULSARBOT_ACCESS_TOKEN`

当前服务在缺少必需环境变量时会直接启动失败。

## 5. Bot 不回消息

按这个顺序检查：

1. webhook URL 是否指向 `https://<your-domain>/telegram/webhook`
2. `GET /api/system/telegram-webhook` 返回的预期地址和实际地址是否一致
3. 是否已经执行 `setWebhook` 或调用 `/api/system/telegram-webhook/sync`
4. Provider 是否通过测试
5. 当前 active profile 是否有效
6. Railway 或本地服务日志里是否有 4xx / 5xx

## 6. Cloudflare 已连接，但记忆、文档或导出无法写入 R2

常见原因是只配置了控制面凭证，没有配置 R2 数据面凭证。

需要补齐：

- `r2AccessKeyId`
- `r2SecretAccessKey`

## 7. Provider 保存后仍然无法正常对话

优先检查：

1. API Key、模型、能力开关是否正确
2. `POST /api/providers/:id/test` 是否通过
3. `Profiles` 使用的是否就是刚配置好的 provider
4. `Workspace` 中当前 active profile 是否正确
5. 模型是否真的支持你启用的 vision / audio / document 能力

## 8. MCP Provider 拉取目录失败或无法添加 server

检查点：

1. MCP provider 的 API Key 是否保存成功
2. `POST /api/mcp/providers/:id/fetch` 是否返回错误
3. provider catalog 中的目标 server 是否仍存在
4. 当前条目是否为 `streamable_http`，因为 provider 导入目前只支持这种协议

## 9. MCP Server 测试失败

检查点：

1. `stdio` 模式下的命令、参数、环境变量是否正确
2. `streamable_http` 模式下的 URL 与 Header 是否正确
3. 目标 MCP 服务是否真的在线
4. `GET /api/mcp/servers/:id/logs` 是否有错误输出

## 10. Documents 或 Jobs 一直卡住

建议顺序：

1. 查看 `GET /api/documents`
2. 查看 `GET /api/jobs`
3. 如果 job 失败，调用 `POST /api/jobs/:id/retry`
4. 如果 document 抽取失败，调用 `POST /api/documents/:id/re-extract`
5. 如果索引异常，调用 `POST /api/documents/:id/reindex` 或 `POST /api/memory/reindex`

## 11. 导出或导入失败

常见原因：

- `accessToken` 不匹配
- `exportPassphrase` / `importPassphrase` 不一致
- 当前 workspace 或 Cloudflare 绑定状态不完整

优先检查：

- `Import/Export` 面板
- `GET /api/system/logs`
- `GET /api/system/health`

## 12. 如何确认当前实例还在 bootstrap 阶段还是已经进入 D1 模式

查看以下任一入口：

- 管理台 `Health` 面板
- `GET /api/system/health`

返回里的 `mode` 会显示当前是 `bootstrap` 还是 `d1`。

## 13. 如何确认运行时到底启用了哪些能力

最直接的方法：

- 在管理台查看 `Runtime Preview`
- 或请求 `GET /api/runtime/preview?agentProfileId=<id>`

这比只看 install 记录或 profile 配置更可靠，因为它反映的是最终运行时装配结果。

## 14. 为什么从浏览器直接打开 Mini App 也能用

这是开发模式下的便利行为。`NODE_ENV=development` 或 `test` 时，管理台允许本地调试用户回退，因此你不必每次都从 Telegram 内部打开。

但要注意：

- 这只适合本地开发和 UI 联调
- 真正的 owner 绑定、Telegram 登录态和 Bot 私聊消息链路仍应以 Telegram 内实际行为为准

## 15. Chrome Extension Executor 配对失败

常见现象：

- 扩展 popup 里 `Pair` 后仍然是 `Unpaired`
- popup 提示 token 无效、pairing 失败或没有拿到 executor token
- Mini App 里的 executor 长时间停在 `pending_pairing`

排查顺序：

1. 确认 `apps/chrome-extension/dist` 是最新构建产物
2. 确认扩展 popup 里填的是：
   - 正确的 server URL
   - 正确的 executor id
   - 最新生成的 pairing code
3. pairing code 过期或使用过后，回到 `Executors` 面板重新点一次 `Pair`
4. 如果你刚改过扩展代码，回到 `chrome://extensions` 执行一次 `Reload`
5. 确认 Mini App 里的 executor kind 确实是 `Chrome Extension`，不是 `Companion`

额外说明：

- pairing code 是短时凭证，不是长期 token。
- server 端配对成功后，扩展会持久化 `executorToken`，后续心跳不再依赖 pairing code。

## 16. Chrome Extension attach 失败，提示 `Origin is not allowed`

这通常不是扩展坏了，而是 allowlist 或当前前台窗口不对。

优先检查：

1. `allowedHosts` 里写的是 hostname，不是完整 URL
2. 允许值示例：
   - `example.com`
   - `*.example.com`
   - `127.0.0.1`
3. 不要写成：
   - `https://example.com`
   - `https://example.com/path`
   - `example.com:443`
4. 点击 `Attach Current Window` 前，先把真正要交给 agent 的网页切到前台
5. 确认你 attach 的不是扩展 popup、Mini App 自己或别的无关标签页

如果已经 attach 错了：

1. 回 Mini App 的 `Executors` 面板
2. 对该 executor 执行 `Force Detach`
3. 把正确网页切到前台
4. 重新 attach

## 17. Chrome Extension 明明配对成功了，但 task run 仍然是 `waiting_retry`

这类问题优先看 `Tasks` 面板里的 `Workflow Capability Preview` 和 `Executors` 面板里的 browser attachment。

常见原因：

- `browser_not_attached`
  - 还没有显式 attach 浏览器窗口
- `attached_origin_not_allowed`
  - 当前附着的网页域名不在 `allowedHosts`
- `attached_origin_missing`
  - 当前附着标签页没有可读 URL
- executor 在线，但 attach 状态还是 `Detached`

建议顺序：

1. 先看 `Executors` 面板是否显示 `Attached`
2. 再看附着 origin 是否就是目标站点
3. 回 `Tasks` 看 preview 里的 blocker
4. 如果 attachment 明显陈旧，先 `Force Detach` 再重来
5. 去 `Sessions` 看是否已经出现 `task_run_waiting_retry` 和 `executor_log`

## 18. Chrome Extension attach 成功，但浏览器步骤没有执行

常见现象：

- run 最后变成 `failed`
- `Sessions` 里看不到预期的 browser step
- 没有 `DOM Snapshot` 或 `Screenshot`

优先检查：

1. 是否真的 attach 到了要操作的目标网页，而不是 Mini App 自己
2. 目标网页是否仍在 allowlist 内
3. 扩展是否已经重新加载到最新版本
4. 任务模板里的 selector 是否正确
5. `Sessions` 面板里是否有 `executor_log`

如果你是在本地调试：

1. 重新 `build`
2. 在 `chrome://extensions` 里 `Reload` 扩展
3. `Force Detach`
4. 重新 `Pair` 或重新 `Attach Current Window`
5. 再跑一次最小 `browser_workflow`

## 19. Companion 在线，但任务还是跑不起来

优先检查：

1. `Executors` 面板里的 capability 是否覆盖了任务需要的能力
2. `allowedHosts / allowedPaths / allowedCommands` 是否把目标操作拦掉了
3. task preview 是否提示 capability block
4. `Sessions` 里是否已有 `executor_log`
5. 如果是 `fs / shell`，确认 approval checkpoint 没把任务卡在 `waiting_approval`
