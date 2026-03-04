# 快速开始

这份文档用于把 Pulsarbot 在本地跑起来，并完成第一轮最小可用联调。

## 1. 环境要求

- Node.js `>= 22`
- `pnpm 10.6.3`
- 一个可用的 Telegram Bot Token
- 一个你自己定义的 `PULSARBOT_ACCESS_TOKEN`

## 2. 安装依赖

```bash
npm exec --yes pnpm@10.6.3 install
```

## 3. 设置环境变量

最小可用配置：

```bash
export TELEGRAM_BOT_TOKEN="123456:replace-me"
export PULSARBOT_ACCESS_TOKEN="replace-me"
export PORT=3000
export DATA_DIR="./data"
```

变量说明：

| 变量名 | 是否必需 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 必需 | Telegram Bot 的 Token，用于 webhook 和 Mini App 会话校验 |
| `PULSARBOT_ACCESS_TOKEN` | 必需 | 管理台访问口令，也用于部分高敏接口二次确认 |
| `PORT` | 可选 | 服务监听端口，默认 `3000` |
| `DATA_DIR` | 可选 | 本地数据目录，默认 `/data`，建议本地设为 `./data` |
| `BODY_LIMIT_BYTES` | 可选 | HTTP 请求体大小限制（字节），默认 `10485760`（10MB） |
| `CORS_ORIGIN` | 可选 | 逗号分隔的允许来源白名单；不设置时默认放开 |
| `NODE_ENV` | 可选 | `development` / `test` / `production` |

## 4. 构建项目

Pulsarbot 服务端会托管管理台静态资源，因此首次本地运行前建议先构建一次：

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

## 6. 首次使用顺序

### 6.1 打开 Mini App 管理台

本地联调时，直接打开 `http://localhost:3000/miniapp/` 即可。开发模式下，管理台会回退到本地调试用户，不要求真实 Telegram `initData`。

### 6.2 验证访问口令

在 `Overview` 面板输入 `PULSARBOT_ACCESS_TOKEN`，完成管理台访问校验。

### 6.3 连接 Cloudflare

优先建议填写：

- `accountId`
- `globalApiKey + email`

如需让记忆文件、导出包和文档真正写入 R2，还建议同时填写：

- `r2AccessKeyId`
- `r2SecretAccessKey`

### 6.4 初始化或接管资源

连接成功后可以二选一：

- `Create new resources`：初始化新的 D1、R2、Vectorize 等资源
- `Use existing resources`：接管已有 Pulsarbot 工作区资源

### 6.5 配置 Provider

进入 `Providers` 面板，至少完成：

1. 打开默认的 `Primary Provider`
2. 填入真实 API Key
3. 选择或确认默认模型
4. 保存
5. 调用 provider test

### 6.6 检查 Agent Profile

进入 `Profiles` 面板，确认：

- `primaryModelProfileId` 已指向可用 provider
- 已启用所需 skills / plugins / mcp servers
- `allowNetworkTools` / `allowWriteTools` / `allowMcpTools` 符合预期

### 6.7 用 Telegram 私聊 Bot

完成 provider 配置后，可以发送测试消息，例如：

- `你好，介绍一下你现在有哪些工具`
- `帮我搜索一下 Railway volume 的用法`
- `remember this: 我的项目代号是 nova`

## 7. 本地自检

```bash
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
```

如果需要跑 Mini App E2E：

```bash
npm exec --yes pnpm@10.6.3 test:e2e
```

## 8. 补充说明

- `apps/admin` 可以单独用 `npm exec --yes pnpm@10.6.3 --filter @pulsarbot/admin dev` 启动 Vite 服务，但默认没有 API 代理，更适合纯前端开发。
- 完整联调时，优先通过 `apps/server` 提供的 `/miniapp/` 访问管理台。
