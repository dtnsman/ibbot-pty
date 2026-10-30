# OpenAI 兼容接口 · 使用预览（阶段 1–4）

> 状态：**已实现**（`js/openai-compat.js` + `js/pty2-agent.js` 接线 + `test/openai-compat.js` 26 项断言）。  
> 用途：调用方契约——请求 / 响应长什么样、错误怎么判断、客户端怎么配。  
> 关联：[MCP-使用说明.md](./MCP-使用说明.md)、[agent.json](./agent.json)

## 先在面板里打开

「🤖 Agent」面板 → 底部「🔌 OpenAI 兼容接口（/v1）」：

1. 点「生成」拿到 `sk-pty-xxxx`（没生成 key 时一律 401）；
2. 勾选「启用 OpenAI 兼容接口」（默认关闭）；
3. 「只读模式」默认开启，只放行白名单命令；要用 M2/M3 再填上游 Base URL / Key / 模型名；
4. 点「连通性自检」查看五段结果（鉴权 / 主机 / 执行 / SSE / 上游）。

Base URL 就是面板那行 `https://<域名>/v1`。

## 0. 通用约定

```bash
export PTY="https://<你的域名>"          # 页面启动 HTTP-Proxy 后 apiBase
export SK="sk-pty-xxxxxxxx"              # 面板生成，Authorization: Bearer
```

| 约定       | 值                                                          |
| -------- | ---------------------------------------------------------- |
| base_url | `$PTY/v1`（OpenAI 客户端要带 `/v1` 后缀）                           |
| 鉴权       | `Authorization: Bearer <sk-pty-*>`；错误也返回 OpenAI 信封         |
| 模型名      | `pty-exec` / `pty-exec@<hostId>` / `pty-agent` / `<上游模型名>` |
| 错误格式     | `{"error":{"message","type","param","code"}}`              |
| 非标准字段    | 响应里可能有 `pty`、`upstream` 等附加字段，客户端会忽略                       |
| 默认状态     | 端点默认**关闭**，面板手动开启并生成 key                                   |

模型名决定后端：

| model                          | 阶段 | 后端行为                        |
| ------------------------------ | -- | --------------------------- |
| `pty-exec` / `pty-exec@hostId` | 1  | 消息即命令，直接 exec，不调 LLM        |
| `<上游模型名>`（如 `deepseek-chat`）   | 2  | 原样透传上游 LLM                  |
| `pty-agent`                    | 3  | 上游 LLM + 注入 PTY 工具 + 服务端跑循环 |



---

## 阶段 1 · 命令执行（M1）

### 1.1 列模型

```bash
curl -s "$PTY/v1/models" -H "Authorization: Bearer $SK"
```

```json
{
  "object": "list",
  "data": [
    { "id": "pty-exec", "object": "model", "created": 1730000000, "owned_by": "pty-agent" },
    { "id": "pty-exec@office-pc", "object": "model", "created": 1730000000, "owned_by": "pty-agent" }
  ]
}
```

### 1.2 非流式执行

```bash
curl -s "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{
    "model": "pty-exec",
    "messages": [{"role": "user", "content": "uname -a && df -h /"}]
  }'
```

```json
{
  "id": "chatcmpl-pty-7f3a1c",
  "object": "chat.completion",
  "created": 1730000123,
  "model": "pty-exec",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Linux office-pc 6.1.0-13-amd64 #1 SMP PREEMPT_DYNAMIC\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  476G  312G  140G  70% /"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 9, "completion_tokens": 42, "total_tokens": 51, "source": "estimated" },
  "pty": {
    "hostId": "office-pc",
    "command": "uname -a && df -h /",
    "exitCode": 0,
    "durationMs": 118,
    "risk": "safe"
  }
}
```

> `pty` 是附加字段：客户端看不见也无所谓，但脚本 / 你自己的工具可以拿 `exitCode` 判断成败。  
> 非零退出码**不报 HTTP 错误**（LLM 语义里这是一次成功的"生成"），失败信息进 `content` 和 `pty.exitCode`。

### 1.3 流式

```bash
curl -N "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{
    "model": "pty-exec",
    "stream": true,
    "stream_options": {"include_usage": true},
    "messages": [{"role": "user", "content": "ls -1 /etc | head -5"}]
  }'
```

```
data: {"id":"chatcmpl-pty-8b2d","object":"chat.completion.chunk","created":1730000123,"model":"pty-exec","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-pty-8b2d","object":"chat.completion.chunk","created":1730000123,"model":"pty-exec","choices":[{"index":0,"delta":{"content":"adduser\n"},"finish_reason":null}]}

data: {"id":"chatcmpl-pty-8b2d","object":"chat.completion.chunk","created":1730000123,"model":"pty-exec","choices":[{"index":0,"delta":{"content":"apt\n"},"finish_reason":null}]}

data: {"id":"chatcmpl-pty-8b2d","object":"chat.completion.chunk","created":1730000123,"model":"pty-exec","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-pty-8b2d","object":"chat.completion.chunk","created":1730000123,"model":"pty-exec","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14,"source":"estimated"}}

data: [DONE]
```

**老实说清楚**：M1 的"流式"是按行切块，不是真 token 流——命令跑完才有输出，首块延迟 ≈ 命令耗时，之后瞬间刷完。有打字机效果，但没有"边说边想"的体感。

### 1.4 客户端代码

```python
from openai import OpenAI

client = OpenAI(base_url="https://<你的域名>/v1", api_key="sk-pty-xxxxxxxx")

r = client.chat.completions.create(
    model="pty-exec",
    messages=[{"role": "user", "content": "cat /etc/os-release"}],
)
print(r.choices[0].message.content)
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://<你的域名>/v1", apiKey: "sk-pty-xxxxxxxx", dangerouslyAllowBrowser: true });

const r = await client.chat.completions.create({
  model: "pty-exec",
  messages: [{ role: "user", content: "uptime" }],
});
console.log(r.choices[0].message.content);
```

---

## 阶段 2 · 上游代理（M2）

调用方**只换 model 名**，其余不变。

```bash
curl -s "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "用一句话解释什么是 PTY"}],
    "temperature": 0.3
  }'
```

```json
{
  "id": "chatcmpl-up-3c91",
  "object": "chat.completion",
  "created": 1730000200,
  "model": "deepseek-chat",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "PTY 是一个由内核提供的伪终端设备对，让程序以为自己连着真实终端。" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 18, "completion_tokens": 34, "total_tokens": 52, "source": "upstream" },
  "upstream": { "baseUrl": "https://api.deepseek.com/v1", "latencyMs": 640, "attempts": 1 }
}
```

调用方收益：`base_url` 指向你的页面，`api_key` 用 `sk-pty-*`。真 key 始终留在你浏览器 localStorage 里，同事 / 手机客户端拿不到。

```bash
# 客户端（Open WebUI / Cherry Studio / Continue）只需要填这两行
# API Base URL : https://<你的域名>/v1
# API Key      : sk-pty-xxxxxxxx
# Model        : deepseek-chat   （或 pty-exec / pty-agent）
```

---

## 阶段 3 · 工具注入（M3）

请求形态和普通对话完全一样，只是 `model` 换成 `pty-agent`：

```bash
curl -s "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "X-Pty-Trace: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pty-agent",
    "messages": [{"role": "user", "content": "看看 /var/log 下最大的三个文件，分别是什么"}],
    "stream": false
  }'
```

```json
{
  "id": "chatcmpl-agt-5e77",
  "object": "chat.completion",
  "created": 1730000300,
  "model": "pty-agent",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "/var/log 下最大的三个文件是：\n1. journal/5641f2/system.journal（412 MB）—— systemd 日志\n2. syslog（88 MB）—— 系统综合日志\n3. dpkg.log（12 MB）—— 包管理操作记录"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 1840, "completion_tokens": 260, "total_tokens": 2100, "source": "upstream" },
  "pty": {
    "steps": 2,
    "trace": [
      { "tool": "exec", "args": { "command": "du -ah /var/log | sort -rh | head -3" }, "exitCode": 0, "durationMs": 210 },
      { "tool": "exec", "args": { "command": "ls -lh /var/log/journal/*/system.journal" }, "exitCode": 0, "durationMs": 46 }
    ],
    "blocked": []
  }
}
```

流式时，中间步骤以 SSE 注释行下发——标准客户端自动忽略，你自己的客户端可以显示"正在执行…"：

```
: pty.tool exec du -ah /var/log | sort -rh | head -3
: pty.tool exec ls -lh /var/log/journal/*/system.journal
data: {"id":"chatcmpl-agt-5e77","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-agt-5e77",...,"choices":[{"index":0,"delta":{"content":"/var/log 下最大的三个文件是："}}]}
data: [DONE]
```

被安全策略拦下时，**不中断请求**，把拒绝原因回灌给模型，让它换条路：

```json
"pty": {
  "steps": 2,
  "trace": [
    { "tool": "exec", "args": { "command": "rm -rf /tmp/cache" }, "blocked": true, "reason": "danger 级命令，当前策略禁止" },
    { "tool": "exec", "args": { "command": "du -sh /tmp/cache" }, "exitCode": 0, "durationMs": 31 }
  ],
  "blocked": ["exec: rm -rf /tmp/cache"]
}
```

---

## 阶段 4 · 会话粘滞与 Responses

### 4.1 会话粘滞（`X-Pty-Session`）

无状态模式下每条消息都在新 shell 里跑，`cd` 不保留。加一个会话头即可复用同一个 PTY：

```bash
# 第一次：建会话
curl -s "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "X-Pty-Session: deploy-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"pty-exec","messages":[{"role":"user","content":"cd /srv/app && ls"}]}'
```

```json
"pty": { "hostId": "office-pc", "termId": "t-9f21", "session": "deploy-01", "reused": false, "exitCode": 0 }
```

```bash
# 第二次：cwd 仍在 /srv/app
curl -s "$PTY/v1/chat/completions" \
  -H "Authorization: Bearer $SK" -H "X-Pty-Session: deploy-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"pty-exec","messages":[{"role":"user","content":"pwd && git status --short"}]}'
```

```json
"pty": { "hostId": "office-pc", "termId": "t-9f21", "session": "deploy-01", "reused": true, "exitCode": 0 }
```

会话空闲 10 分钟回收；`X-Pty-Session` 与 `X-Pty-Host` 可组合，隔主机不串。

### 4.2 `/v1/responses`（OpenAI 新接口）

```bash
curl -s "$PTY/v1/responses" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{"model":"pty-agent","input":"检查 nginx 配置语法"}'
```

```json
{
  "id": "resp_pty_01",
  "object": "response",
  "created_at": 1730000400,
  "model": "pty-agent",
  "status": "completed",
  "output": [{
    "type": "message",
    "id": "msg_01",
    "role": "assistant",
    "status": "completed",
    "content": [{ "type": "output_text", "text": "配置语法正常，nginx -t 返回 syntax is ok / test is successful。", "annotations": [] }]
  }],
  "usage": { "input_tokens": 312, "output_tokens": 48, "total_tokens": 360 }
}
```

`stream: true` 时按 `response.output_text.delta` 事件下发，结尾 `response.completed`。

---

## 错误形态（四个阶段通用）

```bash
# 401 · 没生成 key / key 错误
{"error":{"message":"服务端尚未生成 API Key：请在页面「🤖 Agent」面板的 OpenAI 兼容区点「生成」并保存。","type":"authentication_error","param":null,"code":"no_api_key_configured"}}
{"error":{"message":"API Key 不正确。","type":"authentication_error","param":null,"code":"invalid_api_key"}}

# 404 · 端点没开（默认状态）
{"error":{"message":"OpenAI 兼容接口未启用：请在页面「🤖 Agent」面板的 OpenAI 兼容区勾选「启用」。","type":"invalid_request_error","param":null,"code":"endpoint_disabled"}}

# 404 · 未知 /v1 路径
{"error":{"message":"不支持的 OpenAI 端点：POST /v1/audio/speech","type":"invalid_request_error","param":null,"code":"unknown_url"}}

# 400 · 需要上游但没配
{"error":{"message":"未配置上游 LLM：请在面板填写 Base URL、API Key 与模型名，或改用 model=pty-exec / pty-agent。","type":"invalid_request_error","param":"model","code":"upstream_not_configured"}}

# 429 · 频率 / 并发超限
{"error":{"message":"请求过于频繁（上限 60 次/分钟），请稍后重试。","type":"rate_limit_error","param":null,"code":"rate_limited"}}

# 502 · 上游不可达或被 CORS 拦
{"error":{"message":"无法连接上游 https://api.xxx/v1：Failed to fetch。常见原因：地址填错、上游不支持浏览器跨域(CORS)、或网络不可达。","type":"api_error","param":null,"code":"upstream_unreachable"}}

# 501 · 明确不支持的端点
{"error":{"message":"/v1/embeddings 未实现：PTY Agent 不提供向量能力。","type":"invalid_request_error","param":null,"code":"unsupported_endpoint"}}
```

`openai` SDK 会按状态码抛 `AuthenticationError` / `NotFoundError` / `RateLimitError` / `APIStatusError`，调用方可以直接 `try/except`，不用解析文本。

> **命令执行失败不报 HTTP 错误。** 主机没连、命令被拦、退出码非 0，都算"一次成功的生成"——错误写进 `content`，同时 `pty.exitCode` / `pty.blocked` 给脚本判断。这是有意为之：LLM 语义里"模型说了句失败的话"不是传输层错误。

---

## 自检端点

```bash
curl -s "$PTY/v1/_selftest" -H "Authorization: Bearer $SK"
```

```json
{
  "ok": true,
  "checks": {
    "auth": "ok",
    "host": { "id": "office-pc", "connected": true },
    "exec": { "ok": true, "ms": 42, "sample": "Linux", "blocked": false, "risk": "safe" },
    "sse": { "transport": "sse", "framing": "data-prefixed", "note": "中继已走 SSE 通道，事件实时下发" },
    "upstream": { "configured": true, "reachable": true, "status": 200, "cors": "ok", "model": "deepseek-chat" },
    "config": { "mode": "exec", "readOnly": true, "allowWarn": true, "allowDanger": false, "tools": 9, "keySet": true }
  }
}
```

两个字段值得记住：

- `sse.transport` 为 `buffered` 时说明**这次请求没走 SSE 通道**（客户端没带 `Accept: text/event-stream`），流式内容会整包返回——客户端解析方式不变，只是失去逐块到达的体感。
- `sse.framing` 固定为 `data-prefixed`：中继会给每次 `res.write()` 自动加 `data: ` 前缀，所以代码里只写纯 JSON 事件体。这是实现前必须先确认的事实，写错就变成 `data: data: {...}`。

---

## 实现边界（重要，别踩）

| 事项 | 现状 |
|---|---|
| M1 流式 | **按行切块**，不是 token 流。命令跑完才有输出，首块延迟 ≈ 命令耗时 |
| M3 流式 | 只流最终答案，上游推理过程不流（工具循环是非流式的）。`X-Pty-Trace: 1` 可看到每步 `pty.tool` 进度 chunk |
| M3 成本 | 每轮工具调用都是一次完整上游请求，token 约为单轮对话的 2–3 倍；`openaiMaxSteps` 默认 6 |
| 并发 | 单页面实例，默认 `openaiMaxConcurrent=2`，超出直接 429 |
| 会话 | `X-Pty-Session` 复用同一 PTY，空闲 10 分钟回收，单条命令最多等 30s |
| 上游 CORS | 页面直连上游，上游不给 CORS 就无解；先用 `_selftest` 的 `upstream.cors` 判定 |
| 不支持 | `/v1/embeddings`（501）、`/v1/audio/*`、`/v1/images/*`、completions 走 `pty-agent`（400） |

---

## 常见问题（实测踩过的坑）

### 1. 返回 `[被安全策略阻止] 未在白名单中`，而命令内容是 `[model changed: ...]`

Cherry Studio 等客户端在**切换模型后会追加一条 user 消息**，形如：

```
[model changed: assistant turns above this point were generated by pty-exec@h-a;
 the session continues with pty-exec@h-b]
```

它不是命令。v2.2.1 起适配层会跳过这类通知行（`stripClientNotices`），取上一条真正的 user 消息作为命令。
如果你的客户端用的是别的通知格式，把原文发给维护者加进 `NOTICE_LINE_RE` 即可。

### 2. `'ls' 不是内部或外部命令` / `'pwd' 不是内部或外部命令`

这说明**主机是 Windows，默认 shell 是 cmd.exe**，没有 POSIX 命令。v2.2.1 起会在 stderr 后追加 `[hint]` 行并给出替代命令。
对照表：

| POSIX | cmd.exe |
|---|---|
| `ls` / `ll` | `dir` |
| `pwd` | `cd`（不带参数即显示当前目录） |
| `cat` | `type` |
| `grep` | `findstr` |
| `which` | `where` |
| `rm` | `del` |
| `cp` / `mv` | `copy` / `move` |
| `ps` / `kill` | `tasklist` / `taskkill /PID` |
| `clear` | `cls` |

想用 bash：在该主机安装 Git Bash 或 WSL，然后改走 `pty-agent`；或直接用 `pty-exec@<那台 Linux 主机的 hostId>`。

### 3. 只读模式下命令被拦

`openaiReadOnly` 默认 `true`，只有白名单内的安全命令（`dir`/`ls`/`cat`/`pwd` 一类）能跑。
要放行写操作：面板取消勾选「只读模式」；风险更高时再考虑「允许 danger 级命令」。
OpenAI 接口没有确认弹窗，所以 `openaiRequireApproval` 在 `/v1/*` 下等同拒绝——这点和 MCP 不同。

### 4. 客户端点「获取可用模型」报 401

先看错误码，不要盯着 key 本身：

| code | 真正原因 | 处理 |
|---|---|---|
| `no_api_key_configured` | 页面从来没生成过 key | 面板点「生成」（勾选启用时会自动生成） |
| `invalid_api_key` | 生成了，但客户端传的不匹配 | 用面板 📋 重新复制 |
| `endpoint_disabled` | 开关没打开 | 勾选「启用 OpenAI 兼容接口」 |

---

## 一句话对照

| 阶段 | 调用方改什么 | 拿到什么 |
|---|---|---|
| 1 | 只填 base_url + key | 任何 OpenAI 客户端能跑命令，零 LLM 延迟 |
| 2 | 只把 model 换成上游模型名 | 一个受你控制的 LLM 入口 |
| 3 | 只把 model 换成 `pty-agent` | 客户端会自己"干活"，不用装 MCP |
| 4 | 加一个 `X-Pty-Session` 头 | 多轮交互式命令保留上下文 |
