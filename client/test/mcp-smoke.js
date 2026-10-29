'use strict';

// Node smoke tests for js/mcp-server.js + js/pty2-agent.js route wiring.
// Run: node test/mcp-smoke.js

const assert = require('assert');
const path = require('path');

global.Pty2Mcp = require(path.join(__dirname, '..', 'js', 'mcp-server.js'));
const Pty2AgentModule = require(path.join(__dirname, '..', 'js', 'pty2-agent.js'));

const { defineRoutes, Config, ROUTE_INFO } = Pty2AgentModule;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name);
    throw error;
  }
}

function makeApp() {
  const routes = { post: {}, get: {}, delete: {}, all: {}, options: {}, ws: {}, use: [] };
  return {
    domain: 'ai.pty2.testclient.html.dtns.top',
    apiBase: 'http://ai.pty2.testclient.html.dtns.top',
    clientId: 'testclient',
    routes,
    use(fn) { routes.use.push(fn); },
    options(p, fn) { routes.options[p] = fn; },
    all(p, fn) { routes.all[p] = fn; },
    ws(p, fn) { routes.ws[p] = fn; },
    post(p, fn) { routes.post[p] = fn; },
    get(p, fn) { routes.get[p] = fn; },
    delete(p, fn) { routes.delete[p] = fn; }
  };
}

function makeCtx() {
  const calls = [];
  const rt = {
    terminals: new Map(),
    activeTermId: 't1',
    backends: [{ id: 'local', name: 'Local' }],
    shells: [{ id: 'bash', name: 'bash' }],
    client: {
      isConnected() { return true; },
      on() { },
      off() { },
      async createTerminal() {
        const term = {
          termId: 'agent1',
          onData(fn) { this._onData = fn; },
          onExit(fn) { this._onExit = fn; },
          dispose() { }
        };
        rt.terminals.set(term.termId, term);
        return term;
      },
      async write(termId, text) { calls.push(['write', termId, text]); },
      async resize() { },
      async destroy() { },
      async exec(command, options) {
        calls.push(['exec', command, options]);
        return { stdout: 'OUT:' + command, stderr: '', exitCode: 0 };
      },
      async listFiles() { return [{ name: 'a.txt', size: 3, isDir: false }]; },
      async downloadFileToBytes() { return new Uint8Array([104, 105]); },
      async uploadFile() { calls.push(['upload']); },
      async deleteFile() { calls.push(['delete']); }
    }
  };

  return {
    hosts: [{ id: 'h1', name: 'demo', url: 'ws://demo' }],
    runtime: new Map([['h1', rt]]),
    calls
  };
}

async function invoke(app, method, pathName, options) {
  options = options || {};
  const handler = app.routes[method][pathName];
  assert(handler, 'missing route: ' + method + ' ' + pathName);

  const headers = {};
  Object.keys(options.headers || {}).forEach((key) => {
    headers[String(key).toLowerCase()] = String(options.headers[key]);
  });

  const req = {
    method: method.toUpperCase(),
    path: pathName,
    query: options.query || {},
    params: {},
    body: options.body,
    rawBody: new Uint8Array(0),
    headers,
    get(name) { return headers[String(name).toLowerCase()]; }
  };

  let out = null;
  const res = {
    statusCode: 200,
    headers: {},
    finished: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[String(key).toLowerCase()] = String(value); return this; },
    json(value) {
      if (!this.headers['content-type']) this.headers['content-type'] = 'application/json; charset=utf-8';
      out = { status: this.statusCode, headers: this.headers, body: value };
      this.finished = true;
      return this;
    },
    send(value) {
      if (typeof value === 'string' && !this.headers['content-type']) {
        this.headers['content-type'] = 'text/plain; charset=utf-8';
      }
      out = { status: this.statusCode, headers: this.headers, body: value };
      this.finished = true;
      return this;
    },
    end(value) { out = { status: this.statusCode, headers: this.headers, body: value }; this.finished = true; return this; }
  };

  await handler(req, res);
  assert(out, 'route did not respond: ' + method + ' ' + pathName);
  return out;
}

function modernHeaders(method, name) {
  const headers = {
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method
  };
  if (name) headers['mcp-name'] = name;
  return headers;
}

function modernParams(extra) {
  return Object.assign({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '1.0.0' }
    }
  }, extra || {});
}

(async function run() {
  const app = makeApp();
  const ctx = makeCtx();
  defineRoutes(app, ctx, { log() { } });

  console.log('\n[1] 路由注册');
  check('POST/GET/DELETE /mcp 已注册', () => {
    assert(typeof app.routes.post['/mcp'] === 'function');
    assert(typeof app.routes.get['/mcp'] === 'function');
    assert(typeof app.routes.delete['/mcp'] === 'function');
  });
  check('ROUTE_INFO 含 MCP', () => {
    assert(ROUTE_INFO.some((r) => r[0] === 'MCP' && r[1] === '/mcp'));
    assert(ROUTE_INFO.some((r) => r[1] === '/api/mcp/info'));
  });

  console.log('\n[2] legacy 2025-06-18');
  let res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }
    }
  });
  check('initialize 返回协议版本与能力', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.protocolVersion, '2025-06-18');
    assert(res.body.result.capabilities.tools);
    assert(res.body.result.serverInfo.name);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  });
  check('tools/list 返回全部工具', () => {
    assert.strictEqual(res.status, 200);
    assert(res.body.result.tools.length >= 16);
    assert(res.body.result.tools.some((t) => t.name === 'exec'));
    assert(res.body.result.tools.some((t) => t.name === 'pty_read'));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_list', arguments: {} } }
  });
  check('tools/call host_list', () => {
    assert.strictEqual(res.body.result.isError, false);
    assert.strictEqual(res.body.result.structuredContent.hosts[0].id, 'h1');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'exec', arguments: { command: 'whoami' } } }
  });
  check('tools/call exec（safe 命令）', () => {
    assert.strictEqual(res.body.result.isError, false);
    assert.strictEqual(res.body.result.structuredContent.stdout, 'OUT:whoami');
    assert.strictEqual(res.body.result.structuredContent.exitCode, 0);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'exec', arguments: { command: 'rm -rf /' } } }
  });
  check('danger 命令默认被拒（isError）', () => {
    assert.strictEqual(res.body.result.isError, true);
    assert(/danger/.test(res.body.result.content[0].text));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }
  });
  check('通知返回 202 且无 body', () => {
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body, undefined);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]
  });
  check('批处理被拒 -32600', () => {
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, -32600);
  });

  console.log('\n[3] modern 2026-07-28');
  res = await invoke(app, 'post', '/mcp', {
    headers: modernHeaders('tools/list'),
    body: { jsonrpc: '2.0', id: 10, method: 'tools/list', params: modernParams() }
  });
  check('tools/list 带 resultType/ttlMs/_meta', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.resultType, 'complete');
    assert.strictEqual(res.body.result.ttlMs, 60000);
    assert.strictEqual(res.body.result.cacheScope, 'private');
    assert(res.body.result._meta['io.modelcontextprotocol/serverInfo']);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: modernHeaders('server/discover'),
    body: { jsonrpc: '2.0', id: 11, method: 'server/discover', params: modernParams() }
  });
  check('server/discover 返回 supportedVersions', () => {
    assert(res.body.result.supportedVersions.includes('2026-07-28'));
    assert(res.body.result.capabilities.tools);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: modernHeaders('tools/call', 'host_list'),
    body: {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: modernParams({ name: 'host_list', arguments: {} })
    }
  });
  check('modern tools/call host_list', () => {
    assert.strictEqual(res.body.result.resultType, 'complete');
    assert.strictEqual(res.body.result.structuredContent.hosts[0].id, 'h1');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
    body: { jsonrpc: '2.0', id: 13, method: 'tools/list', params: modernParams() }
  });
  check('Mcp-Method 与 body 不一致 → -32020', () => {
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, -32020);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json', 'mcp-method': 'tools/list' },
    body: { jsonrpc: '2.0', id: 14, method: 'tools/list', params: modernParams() }
  });
  check('缺 MCP-Protocol-Version → -32020', () => {
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, -32020);
  });

  console.log('\n[4] GET / SSE');
  res = await invoke(app, 'get', '/mcp', { headers: {} });
  check('GET /mcp 返回端点信息', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.endpoint, 'http://ai.pty2.testclient.html.dtns.top/mcp');
    assert(res.body.tools.length >= 16);
  });

  res = await invoke(app, 'get', '/mcp', { headers: { accept: 'text/event-stream' } });
  check('GET /mcp + Accept SSE 返回单条 SSE', () => {
    assert.strictEqual(res.status, 200);
    assert(/text\/event-stream/.test(res.headers['content-type']));
    assert(/^event: message\ndata: /.test(res.body));
  });

  res = await invoke(app, 'get', '/mcp', { headers: {}, query: { method: 'tools/list' } });
  check('GET /mcp?method=tools/list 直接调用', () => {
    assert.strictEqual(res.status, 200);
    assert(res.body.result.tools.length >= 16);
  });

  res = await invoke(app, 'get', '/mcp', {
    headers: {},
    query: {
      method: 'tools/call',
      id: '7',
      params: JSON.stringify({ name: 'host_list', arguments: {} })
    }
  });
  check('GET /mcp?method=tools/call 直接调用', () => {
    assert.strictEqual(res.body.id, '7');
    assert.strictEqual(res.body.result.structuredContent.hosts[0].id, 'h1');
  });

  res = await invoke(app, 'get', '/mcp', {
    headers: {},
    query: {
      method: 'tools/list',
      protocolVersion: '2026-07-28',
      params: JSON.stringify({
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      })
    }
  });
  check('GET /mcp + protocolVersion 走 modern', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.resultType, 'complete');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: Object.assign(modernHeaders('tools/list'), { accept: 'text/event-stream' }),
    body: { jsonrpc: '2.0', id: 20, method: 'tools/list', params: modernParams() }
  });
  check('POST + Accept SSE 返回 SSE 帧', () => {
    assert.strictEqual(res.status, 200);
    assert(/text\/event-stream/.test(res.headers['content-type']));
    assert(res.body.includes('"resultType":"complete"'));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: Object.assign(modernHeaders('tools/list'), { accept: 'application/json, text/event-stream' }),
    body: { jsonrpc: '2.0', id: 21, method: 'tools/list', params: modernParams() }
  });
  check('同时接受 JSON/SSE 时优先 JSON', () => {
    assert.strictEqual(res.status, 200);
    assert(/application\/json/.test(res.headers['content-type']));
    assert(res.body.result);
  });

  console.log('\n[5] resources / prompts');
  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 30, method: 'resources/list', params: {} }
  });
  check('resources/list', () => {
    assert(res.body.result.resources.length >= 3);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 31, method: 'resources/read', params: { uri: 'pty://hosts' } }
  });
  check('resources/read pty://hosts', () => {
    const text = res.body.result.contents[0].text;
    assert(JSON.parse(text).hosts[0].id === 'h1');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 32, method: 'prompts/list', params: {} }
  });
  check('prompts/list', () => {
    assert(res.body.result.prompts.length >= 2);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: {
      jsonrpc: '2.0', id: 33, method: 'prompts/get',
      params: { name: 'run_and_explain', arguments: { command: 'uname -a' } }
    }
  });
  check('prompts/get run_and_explain', () => {
    assert(res.body.result.messages[0].content.text.includes('uname -a'));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 34, method: 'subscriptions/listen', params: {} }
  });
  check('subscriptions/listen 明确不支持', () => {
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.code, -32601);
  });

  console.log('\n[6] 安全与 CORS');
  Config.update({ mcpToken: 'secret-token' });
  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} }
  });
  check('启用 Token 后无凭据 → 401', () => {
    assert.strictEqual(res.status, 401);
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
    body: { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} }
  });
  check('Bearer Token 通过', () => {
    assert.strictEqual(res.status, 200);
  });
  Config.update({ mcpToken: '' });

  res = await invoke(app, 'get', '/mcp', { headers: {} });
  check('CORS 全开（allow-origin: *）', () => {
    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  });

  check('全局 CORS 中间件允许 Authorization 与 MCP 头', () => {
    const headers = {};
    let nextCalled = false;
    app.routes.use[0]({ get() { return undefined; } }, {
      finished: false,
      set(key, value) { headers[String(key).toLowerCase()] = String(value); },
      end() { this.finished = true; }
    }, () => { nextCalled = true; });
    assert.strictEqual(headers['access-control-allow-origin'], '*');
    assert(headers['access-control-allow-headers'].includes('Authorization'));
    assert(headers['access-control-allow-headers'].includes('Mcp-Method'));
    assert(nextCalled);
  });

  Config.update({ mcpReadOnly: true });
  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 43, method: 'tools/list', params: {} }
  });
  check('只读模式隐藏写/执行工具', () => {
    assert(!res.body.result.tools.some((t) => t.name === 'exec'));
    assert(res.body.result.tools.some((t) => t.name === 'pty_read'));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'exec', arguments: { command: 'whoami' } } }
  });
  check('只读模式拒绝 exec', () => {
    assert.strictEqual(res.body.result.isError, true);
    assert(res.body.result.content[0].text.includes('禁用'));
  });
  Config.update({ mcpReadOnly: false });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'pty_create', arguments: { backend: 'local' } } }
  });
  check('tools/call pty_create', () => {
    assert.strictEqual(res.body.result.isError, false);
    assert.strictEqual(res.body.result.structuredContent.termId, 'agent1');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: {
      jsonrpc: '2.0', id: 36, method: 'tools/call',
      params: { name: 'pty_write', arguments: { termId: 'agent1', data: 'ls', enter: true } }
    }
  });
  check('tools/call pty_write', () => {
    assert.strictEqual(res.body.result.isError, false);
    assert(ctx.calls.some((c) => c[0] === 'write' && c[2] === 'ls\r'));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 37, method: 'tools/call', params: { name: 'pty_read', arguments: { termId: 'agent1' } } }
  });
  check('tools/call pty_read', () => {
    assert.strictEqual(res.body.result.isError, false);
    assert(Array.isArray(res.body.result.structuredContent.lines));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 38, method: 'tools/call', params: { name: 'fs_download', arguments: { name: 'a.txt' } } }
  });
  check('tools/call fs_download（含 resource blob）', () => {
    assert.strictEqual(res.body.result.structuredContent.dataBase64, 'aGk=');
    assert(res.body.result.content.some((c) => c.type === 'resource' && c.resource.blob === 'aGk='));
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 39, method: 'resources/read', params: { uri: 'pty://terminals/h1/agent1/buffer' } }
  });
  check('resources/read 终端缓冲', () => {
    assert(res.body.result.contents[0].uri === 'pty://terminals/h1/agent1/buffer');
  });

  res = await invoke(app, 'post', '/mcp', {
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 42, method: 'resources/read', params: { uri: 'pty://files?name=a.txt' } }
  });
  check('resources/read 文件（blob）', () => {
    assert.strictEqual(res.body.result.contents[0].blob, 'aGk=');
  });

  console.log('\n[7] 其它端点');
  res = await invoke(app, 'all', '/api/mcp/info', { headers: {}, body: undefined });
  check('/api/mcp/info 返回工具与版本', () => {
    assert.strictEqual(res.body.success, true);
    assert(res.body.tools.length >= 16);
    assert(res.body.protocolVersions.includes('2026-07-28'));
  });

  res = await invoke(app, 'all', '/api/info', { headers: {}, body: undefined });
  check('/api/info 暴露 mcp 能力', () => {
    assert(res.body.capabilities.includes('mcp'));
    assert.strictEqual(res.body.mcp.enabled, true);
    assert(res.body.mcp.tools >= 16);
  });

  res = await invoke(app, 'delete', '/mcp', { headers: {} });
  check('DELETE /mcp → 405', () => {
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.body.error, 'method_not_allowed');
  });

  console.log('\n[8] agent.json / api.json');
  require(path.join(__dirname, '..', 'js', 'agent-doc.js'));

  check('ROUTE_INFO 含 agent.json / api.json', () => {
    assert(ROUTE_INFO.some((r) => r[1] === '/agent.json'));
    assert(ROUTE_INFO.some((r) => r[1] === '/api.json'));
    assert(typeof app.routes.all['/agent.json'] === 'function');
    assert(typeof app.routes.all['/api.json'] === 'function');
  });

  res = await invoke(app, 'all', '/agent.json', { headers: {} });
  check('/agent.json 返回文档并注入运行时地址', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.schema, 'pty-agent-api/1');
    assert(res.body.endpoints.length >= 15);
    assert.strictEqual(res.body.baseUrl, 'http://ai.pty2.testclient.html.dtns.top');
    assert.strictEqual(res.body.baseUrlTemplate, false);
    assert.strictEqual(res.body.runtime.clientId, 'testclient');
    assert(res.body.mcp.endpoint.indexOf('/mcp') > 0);
    assert(/^ws:\/\//.test(res.body.websocket.url));
    assert(res.body.endpoints.some((e) => e.path === '/api/exec'));
    assert(res.body.endpoints.some((e) => e.path === '/api/pty/create' && e.params.some((p) => p.name === 'backend')));
  });

  const agentDocEndpoints = JSON.stringify(res.body.endpoints);
  res = await invoke(app, 'all', '/api.json', { headers: {} });
  check('/api.json 与 /agent.json 同构', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.stringify(res.body.endpoints), agentDocEndpoints);
    assert.strictEqual(res.body.schema, 'pty-agent-api/1');
  });

  check('静态文件 agent.json / api.json 内容一致', () => {
    const fs = require('fs');
    const rootDir = path.join(__dirname, '..');
    const agentRaw = fs.readFileSync(path.join(rootDir, 'agent.json'), 'utf8');
    const apiRaw = fs.readFileSync(path.join(rootDir, 'api.json'), 'utf8');
    assert.strictEqual(agentRaw, apiRaw);
    const parsed = JSON.parse(agentRaw);
    assert.strictEqual(parsed.schema, 'pty-agent-api/1');
    assert(parsed.endpoints.length >= 15);
  });

  console.log('\n✅ ' + passed + ' checks passed');
})().catch((error) => {
  console.error('\n❌ smoke test failed');
  console.error(error);
  process.exit(1);
});
