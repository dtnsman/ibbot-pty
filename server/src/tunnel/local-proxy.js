// src/tunnel/local-proxy.js
//
// 把隧道里收到的请求反向代理到本机 pty-server（HTTP + WebSocket）。
//
// 设计：隧道客户端只负责编解码，真正的“打到本地端口”的逻辑放在这里，
// 这样 HTTP 与 WebSocket 两条链路可以单独测试，也便于以后替换本地目标。
'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const EMPTY = Buffer.alloc(0);

// 逐跳头：不能跨代理转发
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 发往本地 HTTP 时额外跳过的头（由本代理重新生成）
const REQUEST_SKIP = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'expect',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
]);

// 发往本地 WebSocket 时额外跳过的头（ws 客户端自己生成）
const WS_SKIP = new Set([
  ...REQUEST_SKIP,
  'origin',
  'sec-websocket-protocol',
]);

function toBuffer(input) {
  if (input == null) return EMPTY;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(String(input), 'utf8');
}

function normalizePath(url) {
  const value = String(url || '/');
  return value.charAt(0) === '/' ? value : '/' + value;
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    const name = String(key).toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 本地 WebSocket 桥接对象。
 *
 * open 之后、隧道 101 尚未发出之前，本地服务可能已经推送数据；
 * 这里先入队，等 setHandlers() 之后按顺序补发，避免丢帧。
 */
class LocalWsBridge extends EventEmitter {
  constructor(ws, upgradeHeaders) {
    super();
    this.ws = ws;
    this.upgradeHeaders = upgradeHeaders || {};
    this.protocol = ws.protocol || '';
    this.closed = false;
    this.handlers = null;
    this._queue = [];

    ws.on('message', (data, isBinary) => {
      this._deliver('message', toBuffer(data), !!isBinary);
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      this._deliver('close', code, reason ? reason.toString() : '');
    });
    ws.on('error', (error) => {
      this._deliver('error', error);
    });
  }

  _deliver(type, a, b) {
    if (!this.handlers) {
      this._queue.push([type, a, b]);
      return;
    }
    this._dispatch(type, a, b);
  }

  _dispatch(type, a, b) {
    const handlers = this.handlers || {};
    try {
      if (type === 'message' && typeof handlers.onMessage === 'function') {
        handlers.onMessage(a, b);
      } else if (type === 'close' && typeof handlers.onClose === 'function') {
        handlers.onClose(a, b);
      } else if (type === 'error' && typeof handlers.onError === 'function') {
        handlers.onError(a);
      }
    } catch (error) {
      this.emit('handler-error', error);
    }
  }

  /** 绑定消费者，并补发 open 之后积压的帧。 */
  setHandlers(handlers) {
    this.handlers = handlers || {};
    const queued = this._queue.splice(0);
    for (const [type, a, b] of queued) this._dispatch(type, a, b);
  }

  get readyState() {
    return this.ws.readyState;
  }

  send(data, isBinary) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      if (isBinary) this.ws.send(toBuffer(data), { binary: true });
      else this.ws.send(toBuffer(data).toString('utf8'), { binary: false });
      return true;
    } catch (error) {
      this.emit('handler-error', error);
      return false;
    }
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code === undefined ? 1000 : code, reason || '');
    } catch (error) {
      try { this.ws.terminate(); } catch (e) {}
    }
  }

  terminate() {
    this.closed = true;
    try { this.ws.terminate(); } catch (error) {}
  }
}

class LocalProxy {
  constructor(options) {
    const opts = options || {};
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port) || 80;
    // 0 / null 表示不设超时（/exec 最长可跑 10 分钟，避免误杀）
    this.requestTimeoutMs = opts.requestTimeoutMs === undefined
      ? 15 * 60 * 1000
      : Number(opts.requestTimeoutMs);
    this.wsConnectTimeoutMs = Number(opts.wsConnectTimeoutMs) || 8000;
    this.logger = opts.logger || console;

    this._activeRequests = new Set();
    this._bridges = new Set();
  }

  get origin() {
    return `http://${this.host}:${this.port}`;
  }

  _requestHeaders(headers, remoteAddress, bodyLength, method) {
    const incoming = lowerHeaders(headers);
    const out = {};

    for (const [key, value] of Object.entries(incoming)) {
      if (REQUEST_SKIP.has(key)) continue;
      out[key] = value;
    }

    out.host = `${this.host}:${this.port}`;

    const forwardedFor = incoming['x-forwarded-for'];
    out['x-forwarded-for'] = forwardedFor
      ? `${forwardedFor}, ${remoteAddress || 'unknown'}`
      : (remoteAddress || 'unknown');
    out['x-forwarded-proto'] = incoming['x-forwarded-proto'] || 'http';
    out['x-forwarded-host'] = incoming.host || '';
    out['x-real-ip'] = remoteAddress || '';

    const upper = String(method || 'GET').toUpperCase();
    if (bodyLength > 0 || (upper !== 'GET' && upper !== 'HEAD' && upper !== 'DELETE')) {
      out['content-length'] = String(bodyLength || 0);
    }

    return out;
  }

  /**
   * 代理一次一元 HTTP 请求，返回 { status, headers, body }。
   * body 恒为 Buffer（空响应为 EMPTY）。
   */
  request({ method, url, headers, body, remoteAddress }) {
    return new Promise((resolve, reject) => {
      const payload = toBuffer(body);
      const reqHeaders = this._requestHeaders(headers, remoteAddress, payload.length, method);
      const options = {
        host: this.host,
        port: this.port,
        method: String(method || 'GET').toUpperCase(),
        path: normalizePath(url),
        headers: reqHeaders,
      };
      if (this.requestTimeoutMs > 0) options.timeout = this.requestTimeoutMs;

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          finish(resolve, {
            status: res.statusCode || 200,
            headers: filterResponseHeaders(res.headers),
            body: chunks.length ? Buffer.concat(chunks) : EMPTY,
          });
        });
        res.on('error', (error) => finish(reject, error));
      });

      this._activeRequests.add(req);

      req.on('close', () => this._activeRequests.delete(req));

      req.on('timeout', () => {
        req.destroy(new Error(`local request timeout (${this.requestTimeoutMs}ms)`));
      });

      req.on('error', (error) => {
        finish(reject, error);
      });

      if (payload.length) req.write(payload);
      req.end();
    });
  }

  /**
   * 打开到本地 pty-server 的 WebSocket，成功返回 LocalWsBridge。
   * 本地拒绝握手时抛出的 Error 带 status / headers，便于原样回给隧道服务端。
   */
  openWebSocket({ url, headers }) {
    return new Promise((resolve, reject) => {
      const incoming = lowerHeaders(headers);
      const wsHeaders = {};

      for (const [key, value] of Object.entries(incoming)) {
        if (WS_SKIP.has(key)) continue;
        wsHeaders[key] = value;
      }
      const forwardedFor = incoming['x-forwarded-for'] || incoming['x-real-ip'];
      if (forwardedFor) wsHeaders['x-forwarded-for'] = forwardedFor;
      wsHeaders['x-forwarded-proto'] = incoming['x-forwarded-proto'] || 'http';
      if (incoming.host) wsHeaders['x-forwarded-host'] = incoming.host;

      const protocols = String(incoming['sec-websocket-protocol'] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const target = `ws://${this.host}:${this.port}${normalizePath(url)}`;
      const handshakeTimeout = Math.max(1000, Math.min(this.wsConnectTimeoutMs, 9000));

      let settled = false;
      let upgradeHeaders = {};
      let ws;
      try {
        ws = new WebSocket(target, protocols.length ? protocols : undefined, {
          headers: wsHeaders,
          handshakeTimeout,
          perMessageDeflate: false,
          followRedirects: false,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const fail = (error, status, responseHeaders) => {
        if (settled) return;
        settled = true;
        const err = error instanceof Error ? error : new Error(String(error));
        if (status) err.status = status;
        if (responseHeaders) err.headers = responseHeaders;
        try { ws.terminate(); } catch (e) {}
        reject(err);
      };

      const timer = setTimeout(() => {
        fail(new Error(`local websocket connect timeout (${handshakeTimeout}ms)`), 504);
      }, handshakeTimeout + 500);
      if (timer.unref) timer.unref();

      ws.on('upgrade', (res) => {
        upgradeHeaders = filterResponseHeaders(res.headers || {});
      });

      ws.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        res.resume();
        const status = res.statusCode || 502;
        const responseHeaders = filterResponseHeaders(res.headers || {});
        fail(new Error(`local websocket rejected with status ${status}`), status, responseHeaders);
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        fail(error, 502);
      });

      ws.on('open', () => {
        clearTimeout(timer);
        if (settled) {
          try { ws.close(); } catch (e) {}
          return;
        }
        settled = true;
        const bridge = new LocalWsBridge(ws, upgradeHeaders);
        this._bridges.add(bridge);
        ws.on('close', () => this._bridges.delete(bridge));
        resolve(bridge);
      });
    });
  }

  /** 隧道断开时，关掉所有指向本地服务的 WS，避免浏览器侧成为“僵尸连接”。 */
  closeAll(code, reason) {
    for (const req of this._activeRequests) {
      try { req.destroy(new Error('tunnel disconnected')); } catch (error) {}
    }
    this._activeRequests.clear();

    for (const bridge of this._bridges) {
      bridge.close(code === undefined ? 1012 : code, reason || 'tunnel disconnected');
    }
    this._bridges.clear();
  }
}

module.exports = { LocalProxy, LocalWsBridge, filterResponseHeaders, lowerHeaders };
