# PTY Agent MCP 接入说明（已实现）

> 适用文件：`js/mcp-server.js`（MCP 协议实现）+ `js/pty2-agent.js`（路由挂载 + 安全策略）
> 协议：MCP 2026-07-28（modern）与 2025-11-25 / 2025-06-18 / 2025-03-26（legacy）
> 前置：Agent 已通过 `sdk.js` 接入 DTNS 隧道，Agent 域名对外可达（见 README「六、架构」）

## 1. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mcp` | JSON-RPC 主入口，返回 `application/json` 或 `text/event-stream` |
| GET | `/mcp` | 返回端点信息；`Accept: text/event-stream` 时走 SSE 流；也支持查询参数直接调用 |
| DELETE | `/mcp` | 405（本服务无协议级会话） |
| ALL | `/api/mcp/info` | 端点信息、协议版本、工具/资源/提示清单 |
| WS | `/api/pty/stream` | 原有终端实时流（MCP 不映射） |

CORS：`Access-Control-Allow-Origin: *`、`Allow-Methods: *`、`Allow-Headers` 含 `*` 与 `Authorization` / MCP 头，所有跨域请求放行。

> SSE 提示：SDK 已支持真流式；但中继 `websocket-server.js` 必须包含 6.1 的 `sse_end` 关闭修复，
> 否则 SSE 事件能收到、HTTP 连接却不关闭。判断方法：`POST /mcp` 带 `Accept: text/event-stream` 后
> 是否在收到 result 后立即结束。

认证：面板可设置 MCP Token；设置后所有 `/mcp` 请求需要 `Authorization: Bearer <token>`。默认不校验。

## 2. 快速验证

```bash
BASE=http://ai.pty2.<clientId>.html.dtns.top

# 端点信息
curl $BASE/mcp

# legacy：初始化 + 工具列表 + 调工具
curl -sS -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -sS -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"exec","arguments":{"command":"uname -a"}}}'

# modern 2026-07-28：必须带头，_meta 与头一致
curl -sS -X POST $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

# GET 直接调用
curl "$BASE/mcp?method=tools/list"
curl "$BASE/mcp?method=tools/call&params=%7B%22name%22%3A%22host_list%22%2C%22arguments%22%3A%7B%7D%7D"
curl "$BASE/mcp?method=tools/list&protocolVersion=2026-07-28&params=%7B%22_meta%22%3A%7B%22io.modelcontextprotocol%2FprotocolVersion%22%3A%222026-07-28%22%2C%22io.modelcontextprotocol%2FclientCapabilities%22%3A%7B%7D%7D%7D"
```

## 3. 工具清单（16 个）

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `host_list` | 主机列表 | — |
| `host_status` | 主机状态 | `hostId` |
| `pty_list` | 终端列表 | `hostId?` |
| `pty_create` | 新建 Agent 终端 | `hostId?`, `backend?`, `shellId?`, `cols?`, `rows?`, `cwd?` |
| `pty_write` | 写入终端 | `termId`, `data`/`dataBase64`, `enter?` |
| `pty_read` | 读取输出 | `termId?`, `lines?` |
| `pty_resize` | 调整尺寸 | `termId`, `cols`, `rows` |
| `pty_destroy` | 销毁终端 | `termId` |
| `exec` | 执行命令 | `command`, `hostId?`, `useSsh?`, `timeout?` |
| `fs_list` | 文件列表 | `hostId?` |
| `fs_download` | 下载文件 | `name`, `hostId?` |
| `fs_upload` | 上传文件 | `name`, `dataBase64`, `rel?`, `hostId?` |
| `fs_delete` | 删除文件 | `name`, `hostId?` |
| `ai_context` | 终端上下文 | `termId?`, `lines?` |
| `security_check` | 命令风险检查 | `command` |
| `service_info` | 服务信息 | — |

工具结果统一返回 `content` + `structuredContent`，业务失败用 `isError: true`（HTTP 仍为 200）。
`fs_download` 小于 2MB 时额外返回 `type: resource` 的 `blob` 内容块。

## 4. 资源与提示

资源：

- `pty://hosts`
- `pty://hosts/{hostId}`
- `pty://terminals`
- `pty://terminals/{hostId}`
- `pty://terminals/{hostId}/{termId}/buffer`
- `pty://files?name=<path>&hostId=<id>`

模板：`resources/templates/list`

提示：

- `diagnose_terminal`（`termId?`, `lines?`）
- `run_and_explain`（`command`）

## 5. 安全策略

- `exec` 的 MCP schema **不暴露** `confirm`；由 MCP 层先做安全检查，再决定是否调用。
- `mcpAllowWarn` 默认开启；`mcpAllowDanger` 默认关闭；`mcpRequireApproval` 默认关闭，开启后写/执行类工具会弹出页面确认框（60s 超时）。
- Token 可随时在面板生成/清除；清除后立即生效。
- 速率限制：默认 240 次/分钟；并发上限默认 4。
- 审计：MCP 调用写入面板日志，`/api/mcp/info` 与 `/health` 暴露统计。

可在 `localStorage['pty2_agent_config_v1']` 中调整的键：

| 键 | 默认 | 说明 |
|---|---|---|
| `mcpEnabled` | `true` | 是否启用 `/mcp` |
| `mcpAllowWarn` | `true` | 允许 warn 级命令 |
| `mcpAllowDanger` | `false` | 允许 danger 级命令 |
| `mcpRequireApproval` | `false` | 写/执行前弹页面确认 |
| `mcpReadOnly` | `false` | 只读模式：禁用 exec / pty_write / pty_destroy / fs_upload / fs_delete |
| `mcpApprovalTimeoutMs` | `60000` | 确认超时 |
| `mcpMaxConcurrent` | `4` | 工具并发上限 |
| `mcpRateLimitPerMin` | `240` | 每分钟请求上限 |
| `mcpToken` | `''` | Bearer Token，空则不校验 |
| `mcpDisabledTools` | `[]` | 禁用的工具名数组 |
| `mcpStrictHeaders` | `true` | modern 下严格校验 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` |
| `mcpRequireClientCapabilities` | `false` | modern 下是否强制 `_meta.clientCapabilities` |

## 6. SSE 流式支持

`sdk.js` 已补齐中继的旧 SSE 旁路：

- 收到 `http_request { isSSE: true, sseRequestId }` 时，路由继续正常执行，但响应走 `sse_data` / `sse_end` 帧；
- 每个 `res.write()` 对应一条 SSE `event: message`，由中继实时写给浏览器；
- `res.end()` 发送 `sse_end`，中继关闭 SSE 连接；
- 浏览器断开时中继回 `sse_close`，SDK 清理 `sseStreams` 并触发 `close` 事件。

因此：

- POST `/mcp` 的 SSE 是**逐条推送**（进度通知 + 最终响应）；
- `subscriptions/listen` 会返回 `notifications/subscriptions/acknowledged` 并保持连接，直到客户端断开；
- `GET /mcp` 带 `Accept: text/event-stream` 会保持 SSE 流并返回端点信息；
- `Last-Event-ID` 续传仍不支持（2026-07-28 已移除）；
- 2024-11-05 的旧 HTTP+SSE 传输（独立 `/sse` + `/message` 端点）仍不支持。

> 说明：由于客户端注册能力仍是 `stream:false`，中继走的是旧 SSE 旁路，而不是新的 STREAM_* 流式通道；
> 对 MCP 的请求级 SSE 已经足够。若要支持任意长连接的高吞吐流，可再把 SDK 升级到 STREAM_* 通道。

### 6.1 中继必须同步的修复

旧 SSE 旁路里，SDK 发 `sse_end` 后，中继的 `websocket-server.js` 只删除了内部 `sseStreams`，
没有调用 `proxyServer.cleanupSSEConnection()`，因此浏览器侧的 SSE 响应不会 `res.end()`，请求会一直挂着。

本地已修复中继侧 `websocket-server.js`（DTNS HTTP-Proxy 服务端）：

```js
closeSseResponse(sseRequestId) {
  if (this.proxyServer && typeof this.proxyServer.cleanupSSEConnection === 'function') {
    this.proxyServer.cleanupSSEConnection(sseRequestId);
  } else {
    this.handleSSEConnectionClose(sseRequestId);
  }
}
// handleSSEEnd / handleSSEError / handleSSEClose 改为调用 closeSseResponse
```

> 中继服务端不在本仓库内。自建 DTNS HTTP-Proxy 时需同步上述修复：SSE 收到 result 后立即结束，
> `subscriptions/listen` 断开后能清理；升级前建议备份并保留可回滚的中继版本。

另外两处中继配套修复（同一次部署）：

- `handleSSEConnectionClose()` 清理 pending 请求时要 `resolve()`，否则 `handleSSERequest()` 的 `await` 永久挂起；
- `handleSSERequest()` 除 `req.on('close')` 外还要监听 `res.on('close')`，确保浏览器刷新/断开时能清理订阅流。

## 7. 客户端配置

Claude Desktop / Cursor（经 `mcp-remote` 桥接）：

```json
{
  "mcpServers": {
    "pty2": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://ai.pty2.<clientId>.html.dtns.top/mcp"]
    }
  }
}
```

MCP Inspector：

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: http://ai.pty2.<clientId>.html.dtns.top/mcp
```

> Inspector 若先尝试 `GET` 打开 SSE，会收到一条端点信息事件后关闭；这是预期行为。

## 8. 测试

```bash
cd client
node test/mcp-smoke.js

# 真实中继 E2E：先启动自建的 DTNS HTTP-Proxy 服务端（node index.js）
node test/relay-e2e.js
```

覆盖：路由注册、legacy initialize、tools/list、tools/call（host/exec/pty/fs）、danger 拦截、
通知 202、批处理拒绝、modern 头部校验、GET 直接调用、SSE 流式帧、resources、prompts、
Token、CORS、DELETE 405、只读模式等 41 项；另有 7 项基于真实 `sdk.js` 的集成检查
（路由匹配、body 解析、CORS 预检、404 兜底）和 7 项 SSE 帧级检查
（`sse_data` / `sse_end` / progress / subscriptions/listen），以及 6 项真实中继 E2E 检查。
