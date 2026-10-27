# 内网穿透（DTNS Tunnel）

`dtns.pty-server` 内置基于 DTNS HTTP-Proxy 协议 2.0 的反向隧道客户端，
把本机 PTY HTTP/WebSocket 服务暴露到公网域名，无需公网 IP 或端口映射。

## 工作原理

```
浏览器 ──> https://api.pty2.<serverId>.html.dtns.top
            │  (nginx: *.html.dtns.top -> 18386)
            ▼
     dtns.http-proxy 服务端 (res2.dtns.top:18385)
            │  二进制帧隧道 (WebSocket)
            ▼
     tunnel-client.js  ──>  local-proxy.js  ──>  http://127.0.0.1:10310
```

- **tunnel-client.js**：维护到 `wss://res2.dtns.top/tunnel` 的长连接，
  负责注册隧道、心跳、请求/响应的二进制编解码。
- **local-proxy.js**：把隧道里下发的 HTTP 请求与 WebSocket 升级请求
  转发到本机 HTTP 服务，并把响应回写。
- **dtns-protocol.js**：协议 2.0 二进制编解码（与 `dtns.http-proxy/server/protocol.js` 对齐）。
- **index.js**：装配层，解析配置与稳定的 `serverId`，生成域名并启动隧道。

## serverId 解析顺序

1. 环境变量 `PTY_SERVER_ID`
2. `setting/rtptyx_setting.json` 的 `tunnel.serverId` 或顶层 `serverId`
3. `setting/server-id` 持久化文件
4. 自动生成 `pty-<20位hex>` 并落盘

> serverId 决定公网域名，保持稳定才能让书签/白名单不失效。

## 配置项

`setting/rtptyx_setting.json` 的 `tunnel` 块：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用隧道 |
| `serverUrl` | `wss://res2.dtns.top/tunnel` | 隧道服务端地址 |
| `domainPrefix` | `api.pty2` | 域名前缀 |
| `domainSuffix` | `.html.dtns.top` | 域名后缀 |
| `serverId` | `""` | 留空则自动生成/读取 |
| `localHost` | `127.0.0.1` | 本地转发目标 |
| `localPort` | `PTY_PORT` | 本地转发端口 |
| `description` | `ibbot-pty-server (HTTP + WebSocket)` | 服务端展示名 |

## 运行

```bash
npm start                 # 启动服务（含隧道）
npm run test:tunnel       # 端到端集成测试
```

测试会拉起临时实例，注册隧道后用公网域名访问 `/health`、
创建 PTY 会话、跑通 WebSocket 交互，最后注销隧道并关闭进程。

## 安全提示

隧道开启后，`secret_key` 是唯一的访问门槛。请：

- 使用足够长的随机 `secret_key`；
- 不要把含 `secret_key` 的 URL 提交到代码仓库或公开渠道；
- 不需要公网访问时设 `tunnel.enabled = false`。
