# IBBot PTY Manager

**浏览器里的多主机终端面板 + 可嵌入 SDK + 内网穿透。** 一个 Node 进程、一个 JSON 配置、没有数据库、不用在每个设备上装 Agent。

> ttyd / GoTTY 把「一条命令」挂到网页；ShellHub / Teleport 解决「企业级设备接入与审计」；
> 本项目解决另一件事——**人和 AI 怎么随手够到一堆机器，并且把终端能力嵌进自己的系统里**。

---

## 一、它解决什么痛点

| 痛点 | 常见做法 | 本项目 |
|---|---|---|
| 内网机器没有公网 IP，临时要看一眼 | 装 VPN / 搭跳板机 / 配 frp 端口映射 | 内置反向隧道，开箱得到一个 HTTPS 域名 |
| 在手机、平板上排障 | 装 App、配 SSH 客户端、导入私钥 | 纯浏览器打开就用，移动端自适应布局 |
| 十几台机器来回切 | 开一堆终端窗口，记 IP / 端口 / 密码 | 一个面板管所有设备，配置可导出导入 |
| 网络一抖终端就白屏、命令白跑 | 重新连、重新跑，输出找不回来 | 断线重连 + attach 回放最近输出 |
| 想把终端塞进自己的后台系统 | 只能 `iframe`，样式权限都别扭 | 前端 SDK（UMD/ESM/CJS + 类型声明） |
| 想让 AI Agent 直接操作服务器 | 没有标准接口，只能模拟点击 | 浏览器内 Agent 暴露 REST + WebSocket |
| Windows 机器在网页终端里中文乱码 | 换工具 / 忍 | 一次性命令自动按 GBK 解码，shell 自动发现 |

---

## 二、核心能力

- **多主机、多终端**：所有设备在同一个面板里，标签页切换不重建会话。
- **订阅制推送**：单个 WebSocket 连接按 `termId` 订阅，只有你正在看的终端才推数据。
- **断线回放**：每个终端维护环形缓冲，`attach` 时先回放历史再续流。
- **双后端**：`local`（本机 powershell / pwsh / cmd / bash / zsh / fish）+ `ssh`（密钥或密码）。
- **文件通道**：上传（支持保留目录结构、单文件 500MB）、下载、列表、删除，防路径穿越。
- **一次性命令**：`POST /exec` 直接拿 stdout / stderr / exitCode，不用开终端。
- **内网穿透**：内置 DTNS HTTP-Proxy 隧道客户端，把 HTTP + WebSocket 一起暴露到公网域名。
- **弱网优化**：16ms 输出合并、积压超限丢旧保新、`exit` 等关键帧强制送达。
- **内置 MCP 端点**：同一套终端能力以 MCP（Model Context Protocol）暴露，Claude Desktop / Cursor / 各类 Agent 框架可直接挂载，不用写胶水层。
- **OpenAI 兼容接口**：`/v1/chat/completions` 开箱可用。任何 OpenAI 客户端（Cherry Studio、Cline、LangChain、Shell 脚本）只要把 `base_url` 指过来，就能把终端当成「模型」调用——不用装 MCP 客户端，也不用写编排逻辑。
- **机器可读 API 说明**：`/agent.json`、`/api.json` 返回结构化接口文档，Agent 拿到域名即可自助接入。
- **可嵌入**：`ibbot-pty-sdk` 提供 `attachXterm()` 一行接入。

---

## 三、与同类项目对比

| 项目 | 形态 | 多主机聚合 | 断线回放 | 文件传输 | 内置穿透 | 可嵌入 SDK | 浏览器内 Agent | MCP 端点 | 多用户 / RBAC | 部署成本 |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| [ttyd](https://github.com/tsl0922/ttyd) | C 单二进制 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 极低 |
| [GoTTY](https://github.com/yudai/gotty) | Go 单二进制 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 极低 |
| [Wetty](https://github.com/butlerx/wetty) | Node 服务 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 低 |
| [ShellHub](https://github.com/shellhub-io/shellhub) | 中心服务器 + 每设备 Agent | ✅ | 服务端录制* | ✅ SFTP/SCP | ❌ 需自建可达 | ⚠️ HTTP API | ❌ 需装 Agent | ❌ | ✅ | 高 |
| [Apache Guacamole](https://guacamole.apache.org/) | Java 网关 + Tomcat | ✅ | 会话录制 | ✅ SFTP | ❌ | ❌ | ❌ | ❌ | ✅ | 高 |
| [Teleport](https://github.com/gravitational/teleport) | Go 集群 | ✅ | 会话录制 | ✅ | ✅ 反向隧道 | ⚠️ API | ❌ | ❌ | ✅ SSO | 高 |
| [code-server](https://github.com/coder/code-server) | Node 应用 | ❌ | ❌ | ✅ 编辑器 | ❌ 需反代 | ❌ | ❌ | ❌ | ⚠️ 单用户 | 中 |
| **IBBot PTY Manager** | **Node 服务 + 浏览器 SDK** | **✅** | **✅ 环形缓冲** | **✅ HTTP 直传** | **✅ 内置** | **✅ 完整 SDK** | **✅ 一个网页即 Agent** | **✅ 内置 MCP** | **❌ 单密钥** | **低** |

\* ShellHub 社区版为浏览器本地录制，服务端集中存储属于 Cloud / Enterprise 版。

> 这张表只比「能力有无」，不比工程质量与生态成熟度。ShellHub、Teleport、Guacamole 在多租户、审计、SSO 上远超本项目，那是它们的战场。

**一句话定位差异：**

- ttyd / GoTTY / Wetty = 「**一条命令 / 一个 SSH 连接**」的网页化，轻但单点。
- ShellHub / Teleport / Guacamole = 「**企业设备接入**」，强但要装 Agent、要运维数据库与证书体系。
- 本项目 = 「**终端中台**」：面板给人用，SDK 给系统用，隧道解决可达性，且没有额外基础设施。

---

## 四、差异化竞争点

### 1. 一个网页标签页，就是一台服务器

`client/js/sdk.js` + `pty2-agent.js` 让**浏览器页面本身**成为隧道 Agent：把它挂在任意能开网页的环境里，就能通过隧道暴露一整套 `POST /api/pty/*` REST 接口和 WebSocket 流。

其他方案要么需要在目标机装二进制 Agent（ShellHub），要么要求目标端口本身可达（ttyd）。这里不需要——**浏览器能上网就行**。

### 2. 多主机 + 多终端 + 订阅隔离

一个 WebSocket 连接可以订阅多个 `termId`，切换标签不重连、不重建 PTY。服务端只把数据推给你正在看的终端，其余终端的输出留在环形缓冲里等你 `attach` 回放。ttyd / GoTTY / Wetty 都是「一进程一会话」，做多机只能开多个窗口。

### 3. 为弱网和慢终端设计

三处背压控制，是拿手机 4G 排障练出来的：

| 位置 | 策略 | 效果 |
|---|---|---|
| PTY 输出 | 16ms 合并，超 256KB 丢最旧 | 刷屏日志不撑爆内存 |
| WebSocket | 客户端积压 > 1MB 丢普通帧 | 慢客户端不拖垮服务端 |
| 关键帧 | `exit` / `error` 无视积压强制送达 | 进程退出一定看得到 |

### 4. SDK 优先，不是「顺便提供个 API」

`ibbot-pty-sdk` 同时产出 UMD / ESM / CJS，带完整 `.d.ts`：

```js
const client = new PtyClient({ url: 'ws://127.0.0.1:10310', secretKey });
await client.connect();
const term = await client.createTerminal({ cols, rows });
term.attachXterm(xtermInstance);   // 一行接管键盘与尺寸
```

想嵌到自己后台、工单系统、IDE 插件里，直接引库即可，不用 `iframe`。

### 5. 零依赖部署

没有数据库、没有 Redis、没有容器编排、没有证书体系要维护。`npm install && npm start` 就是一个可用的服务，配置文件是**一个 JSON**。

### 6. AI-native 接口

浏览器内 Agent（`client/js/pty2-agent.js`）把页面变成一套给机器调的 API，不是给人点的：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/info` | GET | 能力、域名、主机信息 |
| `/api/routes` | GET | 自描述路由列表 |
| `/api/pty/list` | GET | 终端列表 |
| `/api/pty/create` | POST | 新建 Agent 专用终端（不占用页面 UI） |
| `/api/pty/write` | POST | 写入输入，`enter=true` 自动回车 |
| `/api/pty/read` | GET | 读取最近 N 行输出（`?termId=&lines=`） |
| `/api/pty/resize` | POST | 调整尺寸 |
| `/api/pty/destroy` | POST | 销毁终端 |
| `/api/pty/stream` | WebSocket | 实时输出流 |
| `/api/exec` | POST | 一次性命令（local / ssh） |

LLM Agent 用 `create → write → read` 就能驱动一台设备，完全不需要理解终端渲染或 WebSocket 帧。

#### 6.1 MCP 端点：Agent 直接挂载，不用写胶水层

`client/js/mcp-server.js` 把上面这套 HTTP API 包装成标准 **MCP（Streamable HTTP）** 端点，协议兼容 MCP `2026-07-28`（modern）与 `2025-11-25` / `2025-06-18` / `2025-03-26`（legacy）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/mcp` | JSON-RPC 主入口，返回 `application/json` 或 `text/event-stream` |
| `GET` | `/mcp` | 端点信息；带 `Accept: text/event-stream` 走 SSE 流；也支持 `?method=` 直接调用 |
| `DELETE` | `/mcp` | 405（本服务无协议级会话） |
| `ALL` | `/api/mcp/info` | 端点信息、协议版本、工具 / 资源 / 提示清单 |

暴露 16 个工具（`host_list`、`pty_create`、`pty_write`、`pty_read`、`exec`、`fs_upload`、`security_check` …）、6 类 `pty://` 资源与 2 个提示。

接进 Claude Desktop / Cursor：

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

安全策略默认保守：`warn` 级命令放行、`danger` 级默认拒绝、可开只读模式（禁用 `exec` / `pty_write` / `fs_upload` / `fs_delete`）、可设 Bearer Token、默认 240 次/分 + 4 并发限流，所有调用写入面板日志。完整说明见 [`client/MCP-使用说明.md`](client/MCP-使用说明.md)。

#### 6.2 机器可读 API 说明：`/agent.json` · `/api.json`

Agent URL 下直接返回结构化接口文档（schema `pty-agent-api/1`，含全部路由、参数、请求响应示例、错误码与 quickstart），调用方不必依赖人类文档：

```bash
curl http://ai.pty2.<clientId>.html.dtns.top/agent.json
```

- `client/agent.json` 是**单一数据源**，`client/api.json` 与 `client/js/agent-doc.js`（页面内嵌副本）由 `node client/tools/build-agent-doc.js` 生成，改文档只改 `agent.json`。
- 即使静态文件未部署，路由也会用内嵌副本兜底，并注入运行时 `baseUrl` / `clientId` / MCP 端点。

#### 6.3 OpenAI 兼容接口：任何聊天客户端都能「长出终端」

`client/js/openai-compat.js` 把终端能力包成标准 OpenAI 协议，客户端只改两样东西——`base_url` 和 `model` 名：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | 可用「模型」列表 |
| `POST` | `/v1/chat/completions` | 主入口，支持 `stream: true`（SSE） |
| `POST` | `/v1/completions` | legacy 别名，`prompt → messages → text` 双向翻译 |
| `POST` | `/v1/responses` | OpenAI 新版接口形状 |
| `POST` | `/v1/embeddings` | 固定 501（明确不支持优于假装支持） |
| `GET` | `/v1/_selftest` | 鉴权 / 主机 / 执行 / SSE / 上游五段体检 |

按 `model` 名分流三种后端：

| 模型名 | 行为 | 需要上游 LLM |
|---|---|---|
| `pty-exec` | **消息内容就是命令**，直接返回 stdout/stderr/exitCode | ❌ |
| `pty-exec@<hostId>` | 同上，指定主机 | ❌ |
| `<上游模型名>` | 原样转发到上游 LLM，页面变成一个带鉴权与审计的 LLM 网关 | ✅ |
| `pty-agent` | 把 `exec` / `pty_*` / `fs_*` 以 function calling 注入上游，**工具循环在服务端跑**，客户端只收到文本 | ✅ |

`pty-agent` 是差异最大的一项：MCP 要求客户端自己实现工具循环，而这里把循环搬到页面内，所以一个只会聊天的客户端也能让模型在你机器上执行多步任务。

客户端配置示例（三行）：

```text
Base URL : http://ai.pty2.<clientId>.html.dtns.top/v1
API Key  : sk-pty-xxxxxxxx   # 面板一键生成，只存本机浏览器
Model    : pty-exec
```

设计上它是 `/api/*` 的**薄适配层**——所有执行走同一批处理函数，不存在"同一个 `rm` 在 `/api/exec` 被拦、在 `/v1` 放行"的可能。默认 `openaiEnabled=false`、`openaiReadOnly=true`，未生成 Key 一律 401。完整契约（请求/响应、错误信封、常见问题）见 [`client/OpenAI兼容接口-使用预览.md`](client/OpenAI兼容接口-使用预览.md)。

---

## 五、适用边界（先说清楚不做什么）

**适合：**

- 个人 / 小团队的远程运维面板，几台到几十台机器
- 把终端能力嵌进自有 Web 系统的开发者
- 内网设备临时对外暴露（演示、联调、远程支持）
- 给 AI Agent 提供一台可执行命令的机器

**不适合：**

- 需要多租户、RBAC、SSO、服务端审计录像的**企业堡垒机**场景 → 用 ShellHub / Teleport
- 需要 RDP / VNC 图形桌面 → 用 Guacamole
- 面向公网的高危生产环境裸奔 → 至少要加反向代理 + TLS + IP 白名单

---

## 六、架构

```
┌──────────────┐    WebSocket (JSON-RPC)     ┌────────────────────────────┐
│  浏览器面板   │ ──────────────────────────► │  IBBot PTY Server (Node)   │
│ demo-hosts   │ ◄────────────────────────── │  ├─ WebSocketGateway       │
└──────────────┘   rtterm 频道推送            │  ├─ SessionManager         │
                                              │  ├─ PtySession × N         │
┌──────────────┐   HTTP /exec /upload /files  │  └─ backends: local | ssh  │
│ 脚本 / 后端   │ ──────────────────────────► │                            │
└──────────────┘                              └─────────────┬──────────────┘
                                                            │ node-pty
                                              ┌─────────────▼──────────────┐
                                              │ powershell / pwsh / cmd    │
                                              │ bash / zsh / fish / ssh    │
                                              └────────────────────────────┘

可选：DTNS 反向隧道
公网 ──► https://<prefix>.<serverId>.<domain> ──► 127.0.0.1:10310
```

---

## 七、快速开始

要求：Node.js 16+。

### 服务端

```bash
cd server
npm install
# Windows
copy setting\rtptyx_setting.template.json setting\rtptyx_setting.json
# macOS / Linux
cp setting/rtptyx_setting.template.json setting/rtptyx_setting.json

# 编辑 setting/rtptyx_setting.json，填一个足够长的 secret_key
npm start
```

启动后监听 `http://127.0.0.1:10310`（HTTP + WebSocket 同端口）。

### 客户端

```bash
cd client
npm install
npm run build      # 重建 dist（需要改源码时）
```

直接用浏览器打开 `client/demo-hosts.html`；xterm.js 走 CDN，本地只依赖 `dist/ibbot-pty.umd.js`。

首次使用点「🖥️ 设备管理」→ 填入 `ws://127.0.0.1:10310` 与 `secret_key` → 保存 → 「新建终端」。

---

## 八、配置

配置文件：`server/setting/rtptyx_setting.json`（从模板复制，**不要提交真实密钥**）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `10310` | HTTP + WebSocket 端口，环境变量 `PTY_PORT` 可覆盖 |
| `closed` | `false` | `true` 时拒绝所有操作（维护开关） |
| `secret_key` | `""` | 连接密钥。**留空等于不校验**，仅限本机调试 |
| `max_terminals` | `50` | 并发终端上限 |
| `idle_timeout_ms` | `1800000` | 空闲回收（毫秒），`0` 关闭 |
| `buffer_size` | `65536` | 每终端回放缓冲（字节） |
| `backend` | `"local"` | 默认后端：`local` 或 `ssh` |
| `local.enabled` / `local.allowedShells` | | 本机 shell 白名单 |
| `ssh.enabled` / `host` / `port` / `user` | | SSH 连接参数 |
| `ssh.auth.type` | `"key"` | `key`（`privateKeyPath` 用**绝对路径**）或 `password` |
| `ssh.strictHostKeyChecking` | `true` | `false` 时跳过主机指纹校验（仅调试） |
| `ssh.allowedShells` | | 远端可用 shell 白名单 |
| `tunnel.enabled` | `false` | 是否启用反向隧道 |
| `tunnel.serverUrl` | | 隧道服务端地址（`wss://.../tunnel`），可自建 |
| `tunnel.domainPrefix` / `domainSuffix` | | 公网域名前缀 / 后缀 |
| `tunnel.serverId` | `""` | 留空则自动生成并持久化到 `setting/server-id` |
| `tunnel.localHost` / `localPort` | `127.0.0.1` / `port` | 隧道回源地址 |

**环境变量覆盖**：`PTY_PORT`、`PTY_SERVER_ID`、`PTY_TUNNEL_ENABLED`、`PTY_TUNNEL_URL`、`PTY_TUNNEL_DOMAIN`、`PTY_TUNNEL_VERBOSE=1`（打印隧道重连细节）。

---

## 九、客户端 SDK

```js
const { PtyClient } = require('ibbot-pty-sdk');

const client = new PtyClient({
  url: 'ws://127.0.0.1:10310',
  secretKey: process.env.PTY_KEY,
  autoReconnect: true
});

await client.connect();

const { backends, default: def } = await client.listBackends(); // ['local'], 'local'
const { shells } = await client.listShells();                  // [{id,label,backend,path}]

const term = await client.createTerminal({ cols: 120, rows: 30, backend: 'local', shellId: 'pwsh' });
term.attachXterm(xterm);          // 浏览器
term.onData(d => process.stdout.write(d));  // Node
term.onExit(({ code }) => client.disconnect());

await client.uploadFile(file, { rel: 'logs/2026/app.log', onProgress: p => console.log(p) });
await client.listFiles();
await client.downloadFile('logs/2026/app.log');
await client.exec('uname -a');    // 一次性命令
```

完整类型见 [`client/dist/index.d.ts`](client/dist/index.d.ts)。可运行示例：[`client/node-demo.js`](client/node-demo.js)。

---

## 十、服务端接口

鉴权：`Authorization: Bearer <secret_key>` 或 `?secret_key=<secret_key>`。

### HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查（无需鉴权） |
| `POST` | `/exec` | 执行一次性命令，body：`{command, cwd?, timeout?, useSsh?}` |
| `POST` | `/upload` | 上传，`?name=` 或 `?rel=`（保留目录）；请求体即文件内容（Raw，上限 500MB） |
| `GET` | `/download` | 下载，`?name=`（支持子目录） |
| `GET` | `/files` | 递归列出上传目录 |
| `DELETE` | `/file` | 删除文件或目录，`?name=` |

### WebSocket

消息格式 `{req_id, action, ...}`，响应带同一 `req_id`；输出走 `channel: "rtterm"` 推送帧。

| action | 参数 | 说明 |
|---|---|---|
| `listBackends` | — | 可用的后端列表 |
| `listShells` | — | 可用 shell 列表 |
| `list` | — | 当前所有终端 |
| `create` | `cols, rows, backend?, shellId?, remoteShell?, args?, cwd?` | 新建终端，返回 `termId` |
| `attach` | `termId` | 订阅并回放历史输出 |
| `detach` | `termId` | 退订，PTY 继续运行 |
| `write` | `termId, data` | 写入键盘输入 |
| `resize` | `termId, cols, rows` | 调整窗口尺寸 |
| `destroy` | `termId` | 结束终端 |

---

## 十一、安全模型

- **单密钥鉴权**：所有 HTTP / WebSocket 操作校验 `secret_key`；`GET /health` 除外。
- **路径防穿越**：上传 / 下载 / 删除统一做 `safeRelPath` + `resolveInBase` 校验，拒绝 `..`、盘符、空字节。
- **主机指纹**：`strictHostKeyChecking` 默认开启，调试可关。
- **隧道即暴露**：开启隧道后 `secret_key` 是唯一门槛，务必用长随机值；不需要公网访问时设 `tunnel.enabled = false`。

> ⚠️ `secret_key` 为空时**不做校验**，任何人都能连。生产环境必须设置。

**不要提交**：`server/setting/rtptyx_setting.json`、`server/setting/server-id`（已在 `.gitignore` 中排除）。

---

## 十二、项目结构

```
.
├── client/                     # 前端 SDK（ibbot-pty-sdk）
│   ├── src/                    # ES Module 源码
│   ├── dist/                   # 构建产物（UMD / ESM / CJS + d.ts）
│   ├── js/                     # 独立脚本：sdk / pty-agent / pty2-agent / mcp-server / openai-compat / agent-doc
│   ├── agent.json              # 机器可读 API 说明（单一数据源）
│   ├── api.json                # agent.json 的完整副本（生成物）
│   ├── tools/
│   │   └── build-agent-doc.js  # 由 agent.json 生成 api.json 与 js/agent-doc.js
│   ├── test/
│   │   ├── mcp-smoke.js        # MCP + agent.json 冒烟测试（45 项，无外部依赖）
│   │   └── openai-compat.js    # OpenAI 兼容接口测试（27 项：流式 / 鉴权 / 会话 / agent 循环）
│   ├── MCP-使用说明.md          # MCP 端点、工具清单、安全策略、客户端配置
│   ├── OpenAI兼容接口-使用预览.md # /v1 接口契约、错误形态、常见问题
│   ├── demo-hosts.html         # 演示面板（唯一发布的静态文件）
│   ├── node-demo.js            # Node.js 用法示例
│   ├── package.json
│   └── rollup.config.js
├── server/                     # 后端服务（ibbot-pty-server）
│   ├── server.js               # HTTP 入口（/exec /upload /files ...）
│   ├── src/
│   │   ├── WebSocketGateway.js # JSON-RPC 网关 + 背压控制
│   │   ├── SessionManager.js   # 终端生命周期 + 空闲回收
│   │   ├── PtySession.js       # node-pty 封装 + 环形缓冲
│   │   ├── backends/           # local / ssh 后端
│   │   └── tunnel/             # DTNS 隧道客户端
│   ├── setting/
│   │   └── rtptyx_setting.template.json
│   ├── test/test-tunnel.js     # 隧道端到端测试
│   └── package.json
├── LICENSE
└── README.md
```

---

## 十三、常见问题

**Q：和 ttyd 比，重吗？**
重一点，但换来的是多主机、多终端、文件通道和 SDK。如果只需要「把一条命令挂到网页」，ttyd 更合适。

**Q：必须要用你们提供的隧道服务吗？**
不必须。`tunnel.enabled = false` 就是纯本地服务；要穿透可自建兼容 DTNS HTTP-Proxy 协议 2.0 的服务端，填 `tunnel.serverUrl` 即可。

**Q：支持 Linux / macOS 吗？**
支持。`local` 后端会自动发现 `bash` / `zsh` / `fish` / `sh`；`ssh` 后端跨平台。

**Q：能多用户吗？**
不能。当前是单密钥模型，没有账号体系。多用户请用 ShellHub / Teleport。

**Q：MCP 端点和 HTTP API 是两套实现吗？**
一套。`js/mcp-server.js` 只是把 `js/pty2-agent.js` 已有的 HTTP 能力按 MCP 协议包装（工具内部调用同一批处理函数），所以权限、限流、审计、只读模式对两边同时生效。

**Q：OpenAI 兼容接口和 MCP 该用哪个？**
看调用方。要「能力发现 + 工具清单」用 MCP（IDE、Cline、Claude Desktop 这类）；要「零改造接进现成聊天客户端」用 `/v1`。两者共用同一批执行函数与安全策略，不存在第二套权限逻辑。

**Q：`/v1` 里输入 `ls` 报「不是内部或外部命令」？**
那台主机是 Windows，默认 shell 是 cmd.exe，没有 POSIX 命令——用 `dir` / `cd` / `type`。适配层会追加 `[hint]` 提示替代命令，想用 bash 请在该主机装 Git Bash 或 WSL。

**Q：商用可以吗？**
GPLv3。可以商用，但分发或提供修改版服务时需按 GPLv3 开源你的修改。

---

## 十四、参与贡献

欢迎 Issue 与 PR。提交前请确认：

1. 没有把真实 `secret_key`、`server-id`、私钥路径带进提交；
2. 新增静态文件需说明用途后一并评审；
3. 改动涉及协议时，同步更新 `server/src/tunnel/README.md` 与本文接口章节；
4. 改动 HTTP API 时只改 `client/agent.json`，再执行 `node client/tools/build-agent-doc.js` 生成 `api.json` 与 `js/agent-doc.js`（不要手改生成物），最后跑 `npm test`。

---

## 十五、许可证与仓库

[GNU General Public License v3.0](LICENSE)（GPLv3）—— 衍生作品需以相同协议开源并保留版权声明。

- Gitee：https://gitee.com/dtnsman/ibbot-pty
- GitHub：https://github.com/dtnsman/ibbot-pty

### 发布纪录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0.0 | 2026-10-27 | 首次开源发布并同步至 Gitee 与 GitHub；许可证 GPLv3 |
| v1.0.1 | 2026-10-27 | README 重写：补充同类项目对比、差异化竞争点、适用边界、完整接口与配置说明；配置模板对齐代码字段 |
| v1.1.0 | 2026-10-29 | 新增 MCP 端点：`js/mcp-server.js` 实现 MCP Streamable HTTP（含 16 工具 / 6 资源 / 2 提示、Token、只读模式、限流、确认闸门），`pty2-agent.js` 挂载 `/mcp` 与 `/api/mcp/info`，附 `MCP-使用说明.md` 与 `test/mcp-smoke.js` |
| v1.1.0 | 2026-10-29 | 新增机器可读 API 说明 `agent.json` / `api.json` 及生成工具 `tools/build-agent-doc.js`；Agent 域名下可直接 `GET /agent.json`、`GET /api.json` 自助接入 |
| v1.2.0 | 2026-10-30 | 新增 OpenAI 兼容接口：`js/openai-compat.js` 提供 `/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/_selftest`，支持 `pty-exec`（消息即命令）/ 上游代理 / `pty-agent`（服务端跑工具循环）三种后端与 SSE 流式；附 `OpenAI兼容接口-使用预览.md` 与 `test/openai-compat.js`（27 项）；修正客户端模型切换通知被误当命令执行的问题 |
