'use strict';

// OpenAI 兼容接口（/v1/*）集成测试。
//
// 覆盖：
//   - /v1/models、/v1/chat/completions（M1 exec，非流式 / 流式 / 缓冲流式）
//   - 鉴权 401、端点未启用 404、未知端点 404、/v1/embeddings 501
//   - /v1/completions legacy 别名
//   - X-Pty-Session 会话粘滞（pty_create → write → read 复用同一终端）
//   - /v1/_selftest
//   - 工具定义转换、model 名解析
//
// 运行：node test/openai-compat.js

const assert = require('assert');
const path = require('path');

const DTNSAgent = require(path.join(__dirname, '..', 'js', 'sdk.js'));
global.Pty2Mcp = require(path.join(__dirname, '..', 'js', 'mcp-server.js'));
global.Pty2OpenAI = require(path.join(__dirname, '..', 'js', 'openai-compat.js'));
const { defineRoutes, Config } = require(path.join(__dirname, '..', 'js', 'pty2-agent.js'));

const TYPE_SSE_DATA = 0x0008;
const TYPE_SSE_END = 0x0009;

const API_KEY = 'sk-pty-testkey123456';

// ---------------- 假运行时 ----------------
function makeCtx() {
  const handlers = {};
  let termSeq = 0;

  const rt = {
    terminals: new Map(),
    activeTermId: null,
    backends: [],
    shells: [],
    client: {
      isConnected() { return true; },
      on() { },
      off() { },
      async listFiles() { return []; },
      async exec(command) {
        if (/^fail/.test(command)) {
          return { stdout: '', stderr: 'boom', exitCode: 2 };
        }
        return { stdout: 'OUT< ' + command + ' >', stderr: '', exitCode: 0 };
      },
      async createTerminal() {
        termSeq += 1;
        const termId = 't' + termSeq;
        return {
          termId,
          onData(fn) { handlers[termId] = fn; },
          onExit() { },
          dispose() { }
        };
      },
      write(termId, text) {
        const fn = handlers[termId];
        if (fn) {
          setTimeout(() => fn('\r\n$ ' + String(text).trim() + '\r\nsession-output\r\n$ '), 2);
        }
        return Promise.resolve();
      },
      resize() { },
      async downloadFileToBytes() { return new Uint8Array(0); }
    }
  };

  return {
    hosts: [{ id: 'h1', name: 'demo', url: 'ws://demo' }],
    runtime: new Map([['h1', rt]]),
    ensureConnected: async () => rt,
    closeTerm: null
  };
}

// ---------------- 帧解析（沿用 sse-integration.js 的格式） ----------------
function decodeFrame(frame) {
  const buf = Buffer.from(frame);
  assert.strictEqual(buf.slice(0, 4).toString('ascii'), 'DTNS');
  return { type: buf.readUInt16BE(5), payload: buf.slice(13) };
}

function decodeSseData(payload) {
  let offset = 0;
  const idLen = payload.readUInt16BE(offset); offset += 2;
  const sseRequestId = payload.slice(offset, offset + idLen).toString('utf8'); offset += idLen;
  const dataLen = payload.readUInt32BE(offset); offset += 4;
  const data = payload.slice(offset, offset + dataLen).toString('utf8'); offset += dataLen;
  const eventLen = payload.readUInt16BE(offset); offset += 2;
  const event = payload.slice(offset, offset + eventLen).toString('utf8');
  return { sseRequestId, data, event };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

function jsonBody(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

// ---------------- 主流程 ----------------
(async function run() {
  const app = DTNSAgent.app({
    domain: 'ai.pty2.testclient.html.dtns.top',
    clientId: 'testclient',
    description: 'openai-compat test'
  });

  let frames = [];
  app.socket = {
    readyState: 1,
    send(frame) { frames.push(Buffer.from(frame)); },
    close() { }
  };
  app.connected = true;
  app.registered = true;
  app.serverVersion = 2;

  // 捕获普通（非 SSE）响应体
  let lastResponse = null;
  const originalSend = app._sendResponse.bind(app);
  app._sendResponse = function (message, status, headers, body) {
    lastResponse = {
      status: status,
      headers: headers || {},
      text: Buffer.from(body || new Uint8Array(0)).toString('utf8')
    };
    return originalSend(message, status, headers, body);
  };

  defineRoutes(app, makeCtx(), { log() { } });

  Config.update({
    openaiEnabled: true,
    openaiApiKey: API_KEY,
    openaiReadOnly: false,
    openaiAllowWarn: true,
    openaiAllowDanger: false,
    openaiUpstreamBase: '',
    openaiUpstreamKey: '',
    openaiUpstreamModel: ''
  });

  let passed = 0;
  const check = (name, fn) => {
    try { fn(); passed += 1; console.log('  ok  ' + name); }
    catch (error) { console.error('  FAIL ' + name); throw error; }
  };

  function sseData() {
    return frames.map(decodeFrame)
      .filter((f) => f.type === TYPE_SSE_DATA)
      .map((f) => {
        const raw = decodeSseData(f.payload).data;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      });
  }
  function sseEnded() {
    return frames.map(decodeFrame).some((f) => f.type === TYPE_SSE_END);
  }

  // 发一个请求，等非 SSE 响应
  async function request(opts) {
    lastResponse = null;
    app._handleRequest({
      requestId: opts.id || ('r-' + Math.random().toString(36).slice(2)),
      domain: app.domain,
      method: opts.method || 'POST',
      url: opts.url,
      headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
      body: opts.body === undefined ? new Uint8Array(0) : (typeof opts.body === 'string'
        ? new TextEncoder().encode(opts.body) : jsonBody(opts.body)),
      isSSE: false,
      sseRequestId: null
    });
    await waitFor(() => lastResponse !== null, 'http response for ' + opts.url);
    const res = lastResponse;
    let json = null;
    try { json = JSON.parse(res.text); } catch (e) { /* 非 JSON */ }
    return { status: res.status, headers: res.headers, text: res.text, json: json };
  }

  // 发一个 SSE 请求，等 sse_end
  async function streamRequest(opts) {
    frames = [];
    lastResponse = null;
    app._handleRequest({
      requestId: opts.id || ('s-' + Math.random().toString(36).slice(2)),
      domain: app.domain,
      method: opts.method || 'POST',
      url: opts.url,
      headers: Object.assign({
        'content-type': 'application/json',
        accept: 'text/event-stream'
      }, opts.headers || {}),
      body: opts.body === undefined ? new Uint8Array(0) : jsonBody(opts.body),
      isSSE: true,
      sseRequestId: opts.sseId || ('sse-' + Math.random().toString(36).slice(2))
    });
    await waitFor(() => sseEnded(), 'sse_end for ' + opts.url);
    return frames;
  }

  const auth = { authorization: 'Bearer ' + API_KEY };

  // ---------- 1. /v1/models ----------
  console.log('\n[v1] GET /v1/models');
  {
    const res = await request({ method: 'GET', url: '/v1/models', headers: auth });
    check('返回模型列表，含 pty-exec / pty-agent / pty-exec@h1', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.object, 'list');
      const ids = res.json.data.map((m) => m.id);
      assert(ids.includes('pty-exec'));
      assert(ids.includes('pty-agent'));
      assert(ids.includes('pty-exec@h1'));
    });
  }

  // ---------- 2. 鉴权 ----------
  console.log('\n[v1] 鉴权');
  {
    const res = await request({ url: '/v1/models', method: 'GET' });
    check('缺少 key → 401 OpenAI 信封', () => {
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.json.error.code, 'missing_api_key');
      assert.strictEqual(res.json.error.type, 'authentication_error');
      assert(typeof res.json.error.message === 'string');
    });

    const bad = await request({ url: '/v1/models', method: 'GET', headers: { authorization: 'Bearer nope' } });
    check('错误 key → 401 invalid_api_key', () => {
      assert.strictEqual(bad.status, 401);
      assert.strictEqual(bad.json.error.code, 'invalid_api_key');
    });
  }

  // ---------- 3. M1 非流式 ----------
  console.log('\n[v1] POST /v1/chat/completions（pty-exec 非流式）');
  {
    const res = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: {
        model: 'pty-exec',
        messages: [{ role: 'user', content: 'uname -a' }]
      }
    });
    check('返回标准 chat.completion + pty 元信息', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.object, 'chat.completion');
      assert.strictEqual(res.json.model, 'pty-exec');
      assert.strictEqual(res.json.choices[0].message.role, 'assistant');
      assert(res.json.choices[0].message.content.includes('uname -a'));
      assert.strictEqual(res.json.choices[0].finish_reason, 'stop');
      assert(res.json.usage.total_tokens > 0);
      assert.strictEqual(res.json.pty.command, 'uname -a');
      assert.strictEqual(res.json.pty.exitCode, 0);
    });
  }

  // ---------- 4. M1 流式（真 SSE） ----------
  console.log('\n[v1] POST /v1/chat/completions（pty-exec 流式 / SSE 通道）');
  {
    const framesGot = await streamRequest({
      url: '/v1/chat/completions',
      headers: Object.assign({}, auth, { accept: 'text/event-stream' }),
      body: {
        model: 'pty-exec',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'echo hello' }]
      }
    });

    check('首帧是 role 增量，末帧是 [DONE]', () => {
      assert(framesGot.length > 3);
      const data = sseData();
      assert.strictEqual(data[0].object, 'chat.completion.chunk');
      assert.strictEqual(data[0].choices[0].delta.role, 'assistant');
      assert.strictEqual(data[data.length - 1], '[DONE]');
    });

    check('include_usage 时最后一个 chunk 带 usage 且 choices 为空', () => {
      const data = sseData().filter((d) => d !== '[DONE]');
      const usageChunk = data[data.length - 1];
      assert.deepStrictEqual(usageChunk.choices, []);
      assert(usageChunk.usage.total_tokens > 0);
    });

    check('内容增量拼起来等于完整输出', () => {
      const text = sseData()
        .filter((d) => d !== '[DONE]')
        .map((d) => (d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || '')
        .join('');
      assert(text.includes('echo hello'));
    });
  }

  // ---------- 5. 缓冲流式（中继没走 SSE 通道） ----------
  console.log('\n[v1] POST /v1/chat/completions（stream 但非 SSE 通道 → 整包 SSE）');
  {
    const res = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: {
        model: 'pty-exec',
        stream: true,
        messages: [{ role: 'user', content: 'echo buffered' }]
      }
    });
    check('content-type 为 text/event-stream 且正文带 data: 前缀', () => {
      assert.strictEqual(res.status, 200);
      assert(/text\/event-stream/.test(res.headers['content-type']));
      assert(res.text.indexOf('data: {"id"') === 0);
      assert(res.text.trim().endsWith('data: [DONE]'));
      assert(res.text.includes('echo buffered'));
    });
  }

  // ---------- 6. 错误形状 ----------
  console.log('\n[v1] 错误形状');
  {
    const emb = await request({ url: '/v1/embeddings', headers: auth, body: { model: 'x', input: 'y' } });
    check('/v1/embeddings → 501 unsupported_endpoint', () => {
      assert.strictEqual(emb.status, 501);
      assert.strictEqual(emb.json.error.code, 'unsupported_endpoint');
    });

    const nf = await request({ url: '/v1/unknown/thing', headers: auth, body: {} });
    check('未知 /v1 路径 → 404 unknown_url（不是 success:false 信封）', () => {
      assert.strictEqual(nf.status, 404);
      assert.strictEqual(nf.json.error.code, 'unknown_url');
      assert.strictEqual(nf.json.success, undefined);
    });

    const bad = await request({ url: '/v1/chat/completions', headers: auth, body: { model: 'pty-exec' } });
    check('缺 messages → 400 messages_required', () => {
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.error.code, 'messages_required');
    });
  }

  // ---------- 7. 端点未启用 ----------
  console.log('\n[v1] 端点开关');
  {
    Config.update({ openaiEnabled: false });
    const res = await request({ url: '/v1/models', method: 'GET', headers: auth });
    check('未启用时返回 404 endpoint_disabled', () => {
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.json.error.code, 'endpoint_disabled');
    });
    Config.update({ openaiEnabled: true });
  }

  // ---------- 8. 主流程保持不变 ----------
  console.log('\n[v1] 不干扰既有接口');
  {
    const res = await request({ url: '/api/exec', body: { command: 'echo legacy' } });
    check('/api/exec 仍返回 {success:true} 信封', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert(res.json.stdout.includes('echo legacy'));
    });

    const nf = await request({ url: '/nope', method: 'GET' });
    check('非 /v1 的 404 仍是原来的 availableRoutes 信封', () => {
      assert.strictEqual(nf.status, 404);
      assert.strictEqual(nf.json.success, false);
      assert(Array.isArray(nf.json.availableRoutes));
    });
  }

  // ---------- 9. legacy /v1/completions ----------
  console.log('\n[v1] POST /v1/completions（legacy 别名）');
  {
    const res = await request({
      url: '/v1/completions',
      headers: auth,
      body: { model: 'pty-exec', prompt: 'echo legacy-completions' }
    });
    check('返回 text_completion 形状（choices[0].text）', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.object, 'text_completion');
      assert(res.json.choices[0].text.includes('echo legacy-completions'));
      assert.strictEqual(res.json.choices[0].logprobs, null);
      assert(res.json.usage.total_tokens > 0);
    });

    const bad = await request({
      url: '/v1/completions',
      headers: auth,
      body: { model: 'pty-agent', prompt: 'ls' }
    });
    check('pty-agent 走 completions → 400 并指路 chat', () => {
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.error.code, 'unsupported_model_for_completions');
    });
  }

  // ---------- 10. 会话粘滞 ----------
  console.log('\n[v1] X-Pty-Session 会话粘滞');
  {
    const first = await request({
      url: '/v1/chat/completions',
      headers: Object.assign({ 'x-pty-session': 'deploy-01' }, auth),
      body: { model: 'pty-exec', messages: [{ role: 'user', content: 'cd /srv/app' }] }
    });
    const second = await request({
      url: '/v1/chat/completions',
      headers: Object.assign({ 'x-pty-session': 'deploy-01' }, auth),
      body: { model: 'pty-exec', messages: [{ role: 'user', content: 'pwd' }] }
    });
    check('第一次建终端 reused=false', () => {
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.json.pty.reused, false);
      assert(first.json.pty.termId);
      assert.strictEqual(first.json.pty.session, 'deploy-01');
    });
    check('第二次复用同一终端 reused=true', () => {
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.json.pty.reused, true);
      assert.strictEqual(second.json.pty.termId, first.json.pty.termId);
    });
  }

  // ---------- 11. 自检 ----------
  console.log('\n[v1] GET /v1/_selftest');
  {
    const res = await request({ url: '/v1/_selftest', method: 'GET', headers: auth });
    check('返回 auth / host / exec / sse / upstream 五段', () => {
      assert.strictEqual(res.status, 200);
      const c = res.json.checks;
      assert.strictEqual(c.auth, 'ok');
      assert.strictEqual(c.host.id, 'h1');
      assert.strictEqual(c.exec.ok, true);
      assert.strictEqual(c.sse.transport, 'buffered');
      assert.strictEqual(c.sse.framing, 'data-prefixed');
      assert.strictEqual(c.upstream.configured, false);
    });
  }

  // ---------- 12. 纯函数 ----------
  console.log('\n[v1] 转换与解析');
  {
    const OAI = global.Pty2OpenAI;
    check('MCP 工具 → OpenAI tools', () => {
      const tools = OAI.toOpenAITools(global.Pty2Mcp.TOOLS, { names: ['exec', 'pty_read'] });
      assert.strictEqual(tools.length, 2);
      const exec = tools.filter((t) => t.function.name === 'exec')[0];
      assert.strictEqual(exec.type, 'function');
      assert.strictEqual(exec.function.parameters.type, 'object');
      assert(exec.function.parameters.properties.command);
      assert(tools.every((t) => t.type === 'function'));
    });

    check('model 名解析', () => {
      assert.strictEqual(OAI.classifyModel({}, 'pty-exec').kind, 'exec');
      assert.strictEqual(OAI.classifyModel({}, 'pty-exec@h2').hostId, 'h2');
      assert.strictEqual(OAI.classifyModel({}, 'pty-agent').kind, 'agent');
      assert.strictEqual(OAI.classifyModel({}, 'deepseek-chat').kind, 'proxy');
      assert.strictEqual(OAI.classifyModel({}, 'deepseek-chat').model, 'deepseek-chat');
    });

    check('客户端「模型切换通知」不被当作命令', () => {
      const notice = '[model changed: assistant turns above this point were generated by ' +
        'pty-exec@h1; the session continues with pty-exec@h2]';
      // 通知追加在命令之后（Cherry Studio 的行为）→ 必须回退到真正的命令
      assert.strictEqual(
        OAI.lastUserText([{ role: 'user', content: 'dir' }, { role: 'user', content: notice }]),
        'dir'
      );
      // 通知与命令同处一条消息 → 剥掉通知只留命令
      assert.strictEqual(
        OAI.lastUserText([{ role: 'user', content: 'echo hi\n' + notice }]),
        'echo hi'
      );
      // 整条只有通知 → 视为没有命令
      assert.strictEqual(OAI.lastUserText([{ role: 'user', content: notice }]), '');
      // 普通多轮仍取最后一条
      assert.strictEqual(
        OAI.lastUserText([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'a' },
          { role: 'user', content: 'b' }]),
        'b'
      );
      // 大小写 / 多空格容错
      assert.strictEqual(
        OAI.lastUserText([{ role: 'user', content: '[Model Changed:  x ]' }]),
        ''
      );
    });
  }

  // ---------- 13. M2 上游代理 / M3 agent 循环（假上游） ----------
  console.log('\n[v1] 上游代理与 agent 循环');
  {
    const before = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }
    });
    check('未配置上游时 proxy 模式 → 400 upstream_not_configured', () => {
      assert.strictEqual(before.status, 400);
      assert.strictEqual(before.json.error.code, 'upstream_not_configured');
    });

    Config.update({
      openaiUpstreamBase: 'https://up.example/v1',
      openaiUpstreamKey: 'up-key',
      openaiUpstreamModel: 'fake-model'
    });

    let calls = [];
    let failNext = false;
    global.fetch = async function (url, init) {
      const payload = JSON.parse(init.body);
      calls.push({ url: url, payload: payload, auth: init.headers.authorization });
      if (failNext) {
        throw new TypeError('Failed to fetch');
      }
      if (payload.messages.some((m) => m.role === 'tool')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            id: 'up-2', object: 'chat.completion', model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '最终结论：磁盘还有 140G。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 }
          }),
          text: async () => '',
          body: null
        };
      }
      if (payload.tools && payload.tools.length) {
        return {
          ok: true, status: 200,
          json: async () => ({
            id: 'up-1', object: 'chat.completion', model: payload.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'exec', arguments: JSON.stringify({ command: 'df -h /' }) }
                }]
              },
              finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }
          }),
          text: async () => '',
          body: null
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'up-0', object: 'chat.completion', model: payload.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '你好，我是上游模型。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
        }),
        text: async () => '',
        body: null
      };
    };

    const proxied = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }
    });
    check('proxy 模式转发到上游并回显 model', () => {
      assert.strictEqual(proxied.status, 200);
      assert(proxied.json.choices[0].message.content.includes('上游模型'));
      assert.strictEqual(proxied.json.model, 'deepseek-chat');
      assert.strictEqual(proxied.json.upstream.model, 'fake-model');
      assert.strictEqual(calls[calls.length - 1].auth, 'Bearer up-key');
      assert.strictEqual(calls[calls.length - 1].payload.model, 'fake-model');
    });

    calls = [];
    const agentRes = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: { model: 'pty-agent', messages: [{ role: 'user', content: '看看磁盘还剩多少' }] }
    });
    check('agent 模式：注入工具 → 执行 exec → 回灌 → 产出最终答案', () => {
      assert.strictEqual(agentRes.status, 200);
      assert(agentRes.json.choices[0].message.content.includes('最终结论'));
      assert.strictEqual(agentRes.json.pty.steps, 2);
      assert.strictEqual(agentRes.json.pty.trace.length, 1);
      assert.strictEqual(agentRes.json.pty.trace[0].tool, 'exec');
      assert.strictEqual(agentRes.json.pty.blocked.length, 0);
      assert.strictEqual(agentRes.json.usage.source, 'upstream');
    });
    check('agent 模式真的把工具结果回灌给了上游', () => {
      const second = calls[1];
      assert.strictEqual(second.payload.model, 'fake-model');
      const toolMsg = second.payload.messages.filter((m) => m.role === 'tool')[0];
      assert(toolMsg, '应该有一条 role=tool 的消息');
      assert(toolMsg.content.includes('df -h /'));
      assert.strictEqual(toolMsg.tool_call_id, 'call_1');
      const sys = second.payload.messages[0];
      assert.strictEqual(sys.role, 'system');
    });

    failNext = true;
    const corsErr = await request({
      url: '/v1/chat/completions',
      headers: auth,
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }] }
    });
    failNext = false;
    check('上游不可达 / 被 CORS 拦 → 502 upstream_unreachable', () => {
      assert.strictEqual(corsErr.status, 502);
      assert.strictEqual(corsErr.json.error.code, 'upstream_unreachable');
      assert(/CORS/.test(corsErr.json.error.message));
    });

    Config.update({ openaiUpstreamBase: '', openaiUpstreamKey: '', openaiUpstreamModel: '' });
    delete global.fetch;
  }

  console.log('\n✅ ' + passed + ' OpenAI 兼容接口检查通过');
})().catch((error) => {
  console.error('\n❌ OpenAI 兼容接口测试失败');
  console.error(error);
  process.exit(1);
});
