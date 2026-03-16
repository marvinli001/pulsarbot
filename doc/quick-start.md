# 快速开始

这份文档用于把 Pulsarbot 在本地跑起来，并完成第一轮最小可用联调。

## 1. 前置条件

- Node.js `>= 22`
- `pnpm 10.6.3`
- 一个可用的 Telegram Bot Token
- 一个你自己生成的 `PULSARBOT_ACCESS_TOKEN`

如果你还没有看过项目概览，建议先读 [根目录 README](../README.md)。

## 2. 安装依赖

```bash
npm exec --yes pnpm@10.6.3 install
```

## 3. 设置最小环境变量

```bash
export TELEGRAM_BOT_TOKEN="123456:replace-me"
export PULSARBOT_ACCESS_TOKEN="replace-me"
export PORT=3000
export DATA_DIR="./data"
```

变量说明：

| 变量名 | 是否必需 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 必需 | Telegram Bot Token，用于 webhook 和 Mini App `initData` 校验 |
| `PULSARBOT_ACCESS_TOKEN` | 必需 | 管理台访问口令，也用于部分高敏接口二次确认 |
| `PORT` | 可选 | 服务监听端口，默认 `3000` |
| `DATA_DIR` | 可选 | 本地运行数据目录，开发环境建议设为 `./data` |
| `BODY_LIMIT_BYTES` | 可选 | HTTP 请求体大小限制，默认 `10485760` |
| `CORS_ORIGIN` | 可选 | 逗号分隔的允许来源白名单 |
| `PUBLIC_BASE_URL` | 可选 | 对外访问基准 URL，部署环境建议设置 |
| `TELEGRAM_WEBHOOK_URL` | 可选 | 显式覆盖 Telegram webhook URL |
| `NODE_ENV` | 可选 | `development` / `test` / `production` |

## 4. 首次构建

Pulsarbot 的服务端会托管管理台静态资源，因此首次本地运行前建议先构建一次：

```bash
npm exec --yes pnpm@10.6.3 build
```

## 5. 启动服务端

```bash
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/server dev
```

启动后可访问：

- `http://localhost:3000/`
- `http://localhost:3000/miniapp/`
- `http://localhost:3000/healthz`

快速自检：

```bash
curl -sS http://localhost:3000/healthz
```

预期可以看到包含 `"ok": true` 的结果。

## 6. 推荐的首次使用顺序

### 6.1 打开 Mini App 管理台

本地联调时直接访问 `http://localhost:3000/miniapp/`。开发模式下，管理台允许回退到本地调试用户，因此不要求你先从 Telegram 中打开。

### 6.2 验证访问口令

在 `Overview` 面板输入 `PULSARBOT_ACCESS_TOKEN` 完成访问校验。

### 6.3 绑定 owner

如果当前实例还是 bootstrap 状态，管理台会引导你把当前 Telegram 用户绑定为 owner。这个步骤完成后，后续管理接口才会切换到 owner 受保护模式。

### 6.4 连接 Cloudflare

建议至少准备：

- `accountId`
- `globalApiKey + email`

如果你希望 R2 文档对象、导出包和记忆文件真正写入对象存储，还应补充：

- `r2AccessKeyId`
- `r2SecretAccessKey`

### 6.5 初始化或接管资源

Cloudflare 连接完成后可以二选一：

- `Create new resources`：初始化新的 D1、R2、Vectorize、AI Search 资源
- `Use existing resources`：接管已有 Pulsarbot 工作区资源

### 6.6 配置 Provider

进入 `Providers` 面板，至少完成以下动作：

1. 打开默认的 `Primary Provider`
2. 填入真实 API Key
3. 选择或确认默认模型
4. 保存配置
5. 运行 provider test

### 6.7 检查 Agent Profile

进入 `Profiles` 面板，确认：

- `primaryModelProfileId` 指向可用 provider
- 已启用所需 skills / plugins / MCP servers
- `allowNetworkTools` / `allowWriteTools` / `allowMcpTools` 符合预期

### 6.8 验证 Telegram 私聊

本地 UI 可以直接调试，但真正的 Bot 消息链路需要公网 HTTPS webhook。要完成从 Telegram 私聊到服务端的闭环，请继续阅读 [部署总览](deployment.md) 或 [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)。

## 7. 常用本地命令

```bash
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
npm exec --yes pnpm@10.6.3 test:e2e
```

如果只想做纯前端界面开发，也可以单独启动管理台：

```bash
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/admin dev
```

但要注意：

- `apps/admin` 默认没有 API 代理
- `apiFetch` 使用相对路径
- 因此完整业务联调仍应优先通过 `apps/server` 提供的 `/miniapp/`

## 8. 可选：接入本地执行端

当前本地联调时，云端 control plane 仍然是 `apps/server`。如果你要测试 executor-backed workflow，还可以把下面两类本地执行端接进来。

### 8.1 Chrome Extension Executor

适合操作本机浏览器里已经登录的网页。

1. 先执行一次根目录 `build`
2. 打开 `http://localhost:3000/miniapp/`
3. 在 `Executors` 创建 kind=`Chrome Extension`
4. 填 `allowedHosts`
5. 点击 `Pair`
6. 打开 `chrome://extensions`
7. 启用 `Developer mode`
8. `Load unpacked` -> `apps/chrome-extension/dist`
9. 在扩展 popup 中填入：
   - `http://localhost:3000`
   - executor id
   - pairing code
10. `Pair`
11. 把目标网页切到前台，点击 `Attach Current Window`

说明：

- 扩展 phase1 只有 `browser` capability。
- 推荐单独使用 dedicated Chrome profile。

### 8.2 Native Companion

适合测试 `browser / http / fs / shell` 这类高权限执行。

1. 在 `Executors` 创建 kind=`Companion`
2. 点击 `Pair`
3. 在本机运行：

```bash
PULSARBOT_SERVER_URL=http://localhost:3000 \
PULSARBOT_EXECUTOR_ID=<executor-id> \
PULSARBOT_PAIRING_CODE=<pairing-code> \
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/companion dev
```

说明：

- pairing code 有有效期，过期后重新生成即可。
- `cloud_browser` 当前只是预留 kind，本地快速开始里不启用。

## 9. 下一步阅读

- [管理台使用说明](miniapp-guide.md)
- [仓库结构与架构](project-structure.md)
- [开发、测试与运维](development-and-ops.md)
