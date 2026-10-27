// test/test-tunnel.js
//
// 内网穿透 + 反向代理集成测试。
//
// 覆盖：
//   1. 启动一个带隧道的 pty-server（独立端口 + 独立 serverId）
//   2. 通过动态域名访问 HTTP 接口：/health /exec /upload /download /files /file
//   3. 通过动态域名访问 WebSocket 接口：listBackends -> create -> write -> destroy
//   4. 校验 secret_key 在隧道链路上依然生效
//
// 运行：node test/test-tunnel.js
// 前置：本机可以访问 wss://res2.dtns.top/tunnel 与 http://*.html.dtns.top
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');

const SERVER_DIR = path.join(__dirname, '..');
const SETTING = require(path.join(SERVER_DIR, 'setting', 'rtptyx_setting.json'));

const PORT = Number(process.env.TEST_PTY_PORT || 10311);
const SERVER_ID = process.env.TEST_SERVER_ID ||
  ('pty-test-' + crypto.randomBytes(6).toString('hex'));
const DOMAIN = `api.pty2.${SERVER_ID}.html.dtns.top`;
const PUBLIC_BASE = `http://${DOMAIN}`;
const SECRET = SETTING.secret_key;

const results = [];
let child = null;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout${lastError ? ': ' + lastError.message : ''}`);
}

function startServer() {
  const env = Object.assign({}, process.env, {
    PTY_PORT: String(PORT),
    PTY_SERVER_ID: SERVER_ID,
  });
  delete env.PTY_TUNNEL_DOMAIN;
  delete env.PTY_TUNNEL_URL;

  child = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (buf) => {
    const text = buf.toString('utf8').trimEnd();
    logs.push(text);
    if (process.env.TEST_VERBOSE === '1') console.log('[server]', text);
  });
  child.stderr.on('data', (buf) => {
    const text = buf.toString('utf8').trimEnd();
    logs.push('[stderr] ' + text);
    if (process.env.TEST_VERBOSE === '1') console.error('[server]', text);
  });
  child.on('exit', (code, signal) => {
    if (process.env.TEST_VERBOSE === '1') {
      console.log(`[server] exited code=${code} signal=${signal}`);
    }
  });
  return logs;
}

async function stopServer() {
  if (!child) return;
  const proc = child;
  child = null;
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    sleep(5000),
  ]);
  if (!proc.killed) {
    try { proc.kill('SIGKILL'); } catch (error) {}
  }
}

async function httpRequest(method, url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  const init = { method, headers };
  if (options.body !== undefined) init.body = options.body;
  const res = await fetch(url, init);
  const buffer = Buffer.from(await res.arrayBuffer());
  let json = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { json = JSON.parse(buffer.toString('utf8')); } catch (error) {}
  }
  return { status: res.status, headers: res.headers, buffer, json };
}

function authHeaders(extra) {
  return Object.assign({ Authorization: 'Bearer ' + SECRET }, extra || {});
}

// ---------------- WebSocket 测试客户端 ----------------

class WsTestClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.termData = new Map();
    this.notifications = [];
    this.seq = 0;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 20000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.on('message', (raw) => this._onMessage(raw));
      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on('close', (code, reason) => {
        this.closed = true;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`ws closed ${code} ${reason}`));
        }
        this.pending.clear();
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); }
    catch (error) { return; }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      const pending = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
      return;
    }

    if (msg.channel === 'rtterm') {
      const list = this.termData.get(msg.notify_type) || [];
      list.push(msg);
      this.termData.set(msg.notify_type, list);
      return;
    }
    this.notifications.push(msg);
  }

  request(action, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('ws not open'));
        return;
      }
      const req_id = `test-${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`rpc timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(Object.assign({
        req_id,
        action,
        secret_key: SECRET,
      }, params)));
    });
  }

  outputFor(termId) {
    return (this.termData.get(termId) || [])
      .map((msg) => (msg.data === undefined ? '' : String(msg.data)))
      .join('');
  }

  close() {
    if (!this.ws) return;
    try { this.ws.close(); } catch (error) {}
    this.ws = null;
  }
}

// ---------------- 测试步骤 ----------------

async function testHttpViaDomain(logs) {
  // 1) /health
  const health = await waitFor('/health via tunnel', async () => {
    const res = await httpRequest('GET', PUBLIC_BASE + '/health');
    if (res.status !== 200 || !res.json || !res.json.ok) return null;
    if (!res.json.tunnel || !res.json.tunnel.registered) return null;
    return res;
  }, 30000);
  record(
    'HTTP /health via dynamic domain',
    health.json.tunnel.domain === DOMAIN,
    `${health.json.tunnel.domain} registered=${health.json.tunnel.registered}`,
  );

  // 2) /exec 鉴权：不带 secret 必须 403
  const denied = await httpRequest('POST', PUBLIC_BASE + '/exec', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'echo should-not-run' }),
  });
  record('HTTP /exec rejects missing secret_key', denied.status === 403,
    `status=${denied.status}`);

  // 3) /exec 正常执行
  const exec = await httpRequest('POST', PUBLIC_BASE + '/exec', {
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ command: 'echo PTY_TUNNEL_EXEC_OK' }),
  });
  const execText = `${exec.json && exec.json.stdout || ''}${exec.buffer.toString('utf8')}`;
  record('HTTP /exec executes via tunnel',
    exec.status === 200 && exec.json && exec.json.ret === true &&
      execText.includes('PTY_TUNNEL_EXEC_OK'),
    `status=${exec.status} exit=${exec.json && exec.json.exitCode}`);

  // 4) /upload -> /download 往返
  const fileName = `tunnel-test-${Date.now()}.bin`;
  const payload = crypto.randomBytes(64 * 1024);
  const upload = await httpRequest(
    'POST',
    `${PUBLIC_BASE}/upload?name=${encodeURIComponent(fileName)}`,
    {
      headers: authHeaders({
        'content-type': 'application/octet-stream',
        'X-Filename': fileName,
      }),
      body: payload,
    },
  );
  record('HTTP /upload via tunnel',
    upload.status === 200 && upload.json && upload.json.ret === true,
    `status=${upload.status} size=${upload.json && upload.json.size}`);

  const download = await httpRequest(
    'GET',
    `${PUBLIC_BASE}/download?name=${encodeURIComponent(fileName)}`,
    { headers: authHeaders() },
  );
  record('HTTP /download via tunnel',
    download.status === 200 && download.buffer.length === payload.length &&
      download.buffer.equals(payload),
    `status=${download.status} bytes=${download.buffer.length}`);

  // 5) /files 列表
  const files = await httpRequest('GET', PUBLIC_BASE + '/files', {
    headers: authHeaders(),
  });
  const listed = files.json && Array.isArray(files.json.files) &&
    files.json.files.some((item) => item.name === fileName);
  record('HTTP /files via tunnel', files.status === 200 && listed,
    `status=${files.status} count=${files.json && files.json.files && files.json.files.length}`);

  // 6) DELETE /file
  const removed = await httpRequest(
    'DELETE',
    `${PUBLIC_BASE}/file?name=${encodeURIComponent(fileName)}`,
    { headers: authHeaders() },
  );
  record('HTTP DELETE /file via tunnel',
    removed.status === 200 && removed.json && removed.json.ret === true,
    `status=${removed.status}`);
}

async function testWebSocketViaDomain() {
  const wsUrl = `ws://${DOMAIN}`;
  const client = new WsTestClient(wsUrl);
  await client.connect();

  try {
    const backends = await client.request('listBackends');
    record('WS listBackends via tunnel',
      backends.ret === true && Array.isArray(backends.backends) &&
        backends.backends.length > 0,
      JSON.stringify(backends.backends));

    const shells = await client.request('listShells');
    const shell = (shells.shells || []).find((item) => item.backend === 'local') ||
      (shells.shells || [])[0];
    record('WS listShells via tunnel',
      shells.ret === true && !!shell,
      shell ? `${shell.backend}:${shell.id}` : 'no shells');

    if (!shell) return;

    const created = await client.request('create', {
      cols: 90,
      rows: 30,
      backend: shell.backend,
      shellId: shell.id,
    });
    record('WS create terminal via tunnel',
      created.ret === true && !!created.termId,
      created.termId || created.msg);

    if (!created.termId) return;

    const termId = created.termId;
    const marker = 'PTY_TUNNEL_WS_OK_' + crypto.randomBytes(3).toString('hex');
    await client.request('write', {
      termId,
      data: `echo ${marker}\r`,
    });

    const matched = await waitFor('terminal output via tunnel', async () => {
      return client.outputFor(termId).includes(marker);
    }, 20000, 300);

    record('WS terminal output via tunnel', matched, marker);

    const resized = await client.request('resize', {
      termId, cols: 100, rows: 40,
    });
    record('WS resize terminal via tunnel', resized.ret === true);

    const destroyed = await client.request('destroy', { termId });
    record('WS destroy terminal via tunnel', destroyed.ret === true);
  } finally {
    client.close();
  }
}

async function main() {
  console.log(`[test] serverId : ${SERVER_ID}`);
  console.log(`[test] domain   : ${DOMAIN}`);
  console.log(`[test] local    : http://127.0.0.1:${PORT}`);
  console.log('');

  const logs = startServer();
  let failure = null;

  try {
    await waitFor('local server ready', async () => {
      const res = await httpRequest('GET', `http://127.0.0.1:${PORT}/health`);
      return res.status === 200;
    }, 30000);

    const local = await httpRequest('GET', `http://127.0.0.1:${PORT}/health`);
    record('local /health', local.status === 200 && local.json.ok === true);

    await waitFor('tunnel registered', async () => {
      const res = await httpRequest('GET', `http://127.0.0.1:${PORT}/health`);
      return !!(res.json && res.json.tunnel && res.json.tunnel.registered);
    }, 30000, 500);
    record('tunnel registered',
      true,
      `domain=${(await httpRequest('GET', `http://127.0.0.1:${PORT}/health`)).json.tunnel.domain}`);

    await testHttpViaDomain(logs);
    await testWebSocketViaDomain();
  } catch (error) {
    failure = error;
    console.error('\n[test] aborted:', error.message);
  } finally {
    await stopServer();
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n================ SUMMARY ================');
  console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
  for (const item of failed) console.log(`  FAIL ${item.name}: ${item.detail || ''}`);

  if (failure || failed.length) {
    console.log('\n---- server log (tail) ----');
    console.log(logs.slice(-60).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[test] fatal:', error);
  stopServer().finally(() => process.exit(1));
});
