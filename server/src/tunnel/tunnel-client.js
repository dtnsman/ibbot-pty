// src/tunnel/tunnel-client.js
//
// pty-server 的 DTNS 隧道客户端：
//   1. 连接 http-proxy 服务端（默认 wss://res2.dtns.top/tunnel）
//   2. 注册动态域名（默认 api.pty2.<serverId>.html.dtns.top）
//   3. 把域名上的 HTTP 请求反向代理到本机 pty-server
//   4. 把域名上的 WebSocket 升级请求反向代理到本机 pty-server 的 WS 网关
//
// 协议参考：E:\dtns.dsh-http\src\tunnel.js（同一套 DTNS 2.0 二进制协议）。
'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const P = require('./dtns-protocol');
const { LocalProxy } = require('./local-proxy');

const RECONNECT_BASE_MS = 1500;
const RECONNECT_FACTOR = 1.7;
const RECONNECT_MAX_MS = 20000;
const DEFAULT_HEARTBEAT_MS = 25000;
const REGISTER_RETRY_MS = 5000;

function backoffDelay(attempt) {
  const base = Math.min(
    RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, Math.max(0, attempt - 1)),
    RECONNECT_MAX_MS,
  );
  // 抖动，避免多台机器同时重连
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

class TunnelClient extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    if (!opts.serverUrl) throw new Error('tunnel.serverUrl is required');
    if (!opts.clientId) throw new Error('tunnel.clientId is required');
    if (!opts.domain) throw new Error('tunnel.domain is required');

    this.serverUrl = opts.serverUrl;
    this.clientId = opts.clientId;
    this.domain = opts.domain;
    this.tunnelId = opts.tunnelId || 'ibbot-pty-server';
    this.description = opts.description || 'ibbot-pty-server (HTTP + WebSocket)';
    this.localHost = opts.localHost || '127.0.0.1';
    this.localPort = Number(opts.localPort) || 80;
    this.reconnect = opts.reconnect !== false;
    this.heartbeatIntervalMs = Number(opts.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_MS;
    this.logger = opts.logger || console;

    this.proxy = new LocalProxy({
      host: this.localHost,
      port: this.localPort,
      requestTimeoutMs: opts.requestTimeoutMs,
      wsConnectTimeoutMs: opts.wsConnectTimeoutMs,
      logger: this.logger,
    });

    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.serverVersion = P.VERSION_2;
    this.lastError = null;

    this._stopped = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._registerRetryTimer = null;
    // wsRequestId -> { bridge, closed }
    this._wsStates = new Map();

    this.stats = {
      requestsTotal: 0,
      requestsOk: 0,
      requestsError: 0,
      wsOpened: 0,
      wsActive: 0,
      registeredCount: 0,
      connectedAt: null,
      lastRequestAt: null,
    };
  }

  // ==================== 生命周期 ====================

  start() {
    this._stopped = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN ||
                    this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const separator = this.serverUrl.indexOf('?') === -1 ? '?' : '&';
    const url = `${this.serverUrl}${separator}clientId=${encodeURIComponent(this.clientId)}`;

    let ws;
    try {
      ws = new WebSocket(url, {
        handshakeTimeout: 15000,
        perMessageDeflate: false,
        followRedirects: true,
      });
    } catch (error) {
      this.lastError = error.message;
      this.logger.error('[tunnel] connect failed:', error.message);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;
    this.emit('connecting', { url });

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.registered = false;
      this._reconnectAttempts = 0;
      this.stats.connectedAt = Date.now();

      this.logger.log(`[tunnel] connected: ${this.serverUrl}`);
      this._sendCapabilities();
      this._sendRegister();
      this._startHeartbeat();
      this.emit('connected', { clientId: this.clientId, domain: this.domain });
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      this._onFrame(raw);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.registered = false;
      this.stats.registeredCount = 0;
      this._stopHeartbeat();
      this._clearRegisterRetry();
      this._closeAllWs(1012, 'tunnel disconnected');
      this.logger.warn(`[tunnel] disconnected (${code}${reason ? ' ' + reason : ''})`);
      this.emit('disconnected', { code, reason: reason ? reason.toString() : '' });
      this._scheduleReconnect();
    });

    ws.on('error', (error) => {
      this.lastError = error.message || String(error);
      // close 事件会负责重连，这里只记录，避免重复调度
      this.logger.warn('[tunnel] socket error:', this.lastError);
      this.emit('error', error);
    });
  }

  stop() {
    this._stopped = true;
    this._stopHeartbeat();
    this._clearRegisterRetry();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._closeAllWs(1012, 'tunnel stopped');

    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.stats.registeredCount = 0;
    if (ws) {
      ws.removeAllListeners();
      try { ws.close(1000, 'server shutdown'); } catch (error) {}
    }
    this.proxy.closeAll(1012, 'tunnel stopped');
    this.emit('stopped', {});
  }

  _scheduleReconnect() {
    if (this._stopped || !this.reconnect || this._reconnectTimer) return;
    this._reconnectAttempts += 1;
    const delay = backoffDelay(this._reconnectAttempts);
    this.emit('reconnecting', { attempt: this._reconnectAttempts, delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.start();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  // ==================== 注册 / 心跳 ====================

  _sendCapabilities() {
    // stream:false -> 服务端走经典 HTTP_REQUEST/HTTP_RESPONSE 路径
    // multiValueHeaders:true -> Set-Cookie 等多值头用换行编码
    this._send(P.encodeCapabilities({
      clientId: this.clientId,
      stream: false,
      multiValueHeaders: true,
    }));
  }

  _sendRegister() {
    this._send(P.encodeRegisterTunnel({
      clientId: this.clientId,
      tunnel: {
        id: this.tunnelId,
        domain: this.domain,
        localPort: this.localPort,
        localHost: this.localHost,
        protocol: 'http',
        description: this.description,
      },
    }));
  }

  _retryRegister() {
    if (this._stopped || this._registerRetryTimer) return;
    this._registerRetryTimer = setTimeout(() => {
      this._registerRetryTimer = null;
      if (!this.connected || this.registered) return;
      // 断开重连会重新走 welcome -> capabilities -> register
      const ws = this.ws;
      this.ws = null;
      if (ws) {
        ws.removeAllListeners();
        try { ws.close(4002, 'retry register'); } catch (error) {}
      }
      this.connected = false;
      this._scheduleReconnect();
    }, REGISTER_RETRY_MS);
    if (this._registerRetryTimer.unref) this._registerRetryTimer.unref();
  }

  _clearRegisterRetry() {
    if (this._registerRetryTimer) {
      clearTimeout(this._registerRetryTimer);
      this._registerRetryTimer = null;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._sendHeartbeat();
    this._heartbeatTimer = setInterval(
      () => this._sendHeartbeat(),
      this.heartbeatIntervalMs,
    );
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _sendHeartbeat() {
    this._send(P.encodeHeartbeat({
      clientId: this.clientId,
      timestamp: new Date().toISOString(),
      stats: {
        tunnelCount: 1,
        registeredCount: this.registered ? 1 : 0,
        sseConnections: 0,
        totalRequests: this.stats.requestsTotal,
        totalErrors: this.stats.requestsError,
      },
    }));
  }

  _send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(frame);
        return true;
      } catch (error) {
        this.logger.warn('[tunnel] send failed:', error.message);
      }
    }
    return false;
  }

  // ==================== 入站帧 ====================

  _onFrame(raw) {
    let message;
    try {
      const frame = P.decodeFrame(raw);
      message = P.decodeMessage(frame);
    } catch (error) {
      this.logger.warn('[tunnel] frame decode failed:', error.message);
      return;
    }

    switch (message.type) {
      case 'welcome':
        this.serverVersion = message.protocolVersion >= P.VERSION_2 ? P.VERSION_2 : P.VERSION;
        this.emit('welcome', { clientId: message.clientId, protocolVersion: this.serverVersion });
        break;

      case 'registered':
        this._onRegistered(message);
        break;

      case 'heartbeat_ack':
        break;

      case 'http_request':
        this._onHttpRequest(message);
        break;

      case 'websocket_data':
      case 'websocket_data_from_server':
        this._onWsData(message);
        break;

      case 'websocket_close':
      case 'websocket_close_from_server':
        this._onWsClose(message, message.code);
        break;

      case 'websocket_end':
        this._onWsClose(message, 1000);
        break;

      case 'websocket_error':
        this._onWsClose(message, 1011);
        break;

      case 'stream_cancel':
        // 未声明流式能力，正常不会收到；忽略即可
        break;

      case 'error':
        this.logger.warn('[tunnel] server reported error:', message.error || message.payload);
        break;

      default:
        if (process.env.PTY_TUNNEL_VERBOSE === '1') {
          this.logger.log('[tunnel] ignore frame:', message.type);
        }
    }
  }

  _onRegistered(message) {
    if (message.success) {
      this.registered = true;
      this.stats.registeredCount = 1;
      this._clearRegisterRetry();
      this.lastError = null;
      this.logger.log(`[tunnel] domain registered: http://${message.domain}`);
      this.emit('registered', { domain: message.domain });
      return;
    }

    this.registered = false;
    this.stats.registeredCount = 0;
    this.lastError = message.error || 'tunnel registration failed';
    this.logger.error(`[tunnel] register failed: ${message.error || 'unknown error'} (${this.domain})`);
    this.emit('register_failed', { domain: this.domain, error: this.lastError });
    this._retryRegister();
  }

  // ==================== HTTP ====================

  _onHttpRequest(message) {
    if (message.isWebSocket && message.wsRequestId) {
      this._onWsUpgrade(message);
      return;
    }
    this._handleHttp(message);
  }

  async _handleHttp(message) {
    const started = Date.now();
    this.stats.requestsTotal += 1;
    this.stats.lastRequestAt = started;

    let response;
    try {
      response = await this.proxy.request({
        method: message.method,
        url: message.url,
        headers: message.headers,
        body: message.body,
        remoteAddress: message.remoteAddress,
      });
      this.stats.requestsOk += 1;
    } catch (error) {
      this.stats.requestsError += 1;
      const status = error && error.code === 'ECONNREFUSED' ? 502 : 500;
      response = {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({
          ok: false,
          error: 'local proxy failed',
          message: error.message,
        }), 'utf8'),
      };
      this.logger.warn(`[tunnel] ${message.method} ${message.url} -> ${error.message}`);
    }

    const duration = Date.now() - started;
    this._send(P.encodeHttpResponse({
      requestId: message.requestId,
      domain: message.domain || this.domain,
      status: response.status || 200,
      headers: response.headers || {},
      body: response.body,
      isSSE: false,
      isWebSocket: false,
      sseRequestId: null,
      wsRequestId: null,
      error: null,
    }, this.serverVersion));

    this.emit('request', {
      method: message.method,
      url: message.url,
      status: response.status || 200,
      duration,
    });
  }

  // ==================== WebSocket ====================

  async _onWsUpgrade(message) {
    const { requestId, domain, wsRequestId, url, headers } = message;
    this.stats.requestsTotal += 1;
    this.stats.lastRequestAt = Date.now();

    let bridge;
    try {
      bridge = await this.proxy.openWebSocket({ url, headers });
    } catch (error) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
      const body = Buffer.from(JSON.stringify({
        ok: false,
        error: 'local websocket rejected',
        message: error.message,
      }), 'utf8');
      this.logger.warn(`[tunnel] ws ${url} rejected: ${error.message}`);
      this._send(P.encodeHttpResponse({
        requestId,
        domain: domain || this.domain,
        status,
        headers: error.headers || { 'content-type': 'application/json; charset=utf-8' },
        body,
        isWebSocket: true,
        wsRequestId,
        error: error.message,
      }, this.serverVersion));
      return;
    }

    const upgradeHeaders = { upgrade: 'websocket', connection: 'Upgrade' };
    if (bridge.protocol) upgradeHeaders['sec-websocket-protocol'] = bridge.protocol;

    const sent = this._send(P.encodeHttpResponse({
      requestId,
      domain: domain || this.domain,
      status: 101,
      headers: upgradeHeaders,
      body: null,
      isWebSocket: true,
      wsRequestId,
      error: null,
    }, this.serverVersion));

    if (!sent) {
      bridge.terminate();
      return;
    }

    const state = { bridge, closed: false };
    this._wsStates.set(wsRequestId, state);
    this.stats.wsOpened += 1;
    this.stats.wsActive = this._wsStates.size;
    this.logger.log(`[tunnel] ws opened: ${url} (${wsRequestId})`);

    bridge.setHandlers({
      onMessage: (data, isBinary) => {
        this._send(P.encodeWebSocketData({
          wsRequestId,
          data,
          binary: isBinary,
        }));
      },
      onClose: (code, reason) => {
        if (state.closed) return;
        state.closed = true;
        this._wsStates.delete(wsRequestId);
        this.stats.wsActive = this._wsStates.size;
        this._send(P.encodeWebSocketClose({ wsRequestId, code, reason }));
        this.logger.log(`[tunnel] ws closed: ${wsRequestId} (${code}${reason ? ' ' + reason : ''})`);
      },
      onError: (error) => {
        this.logger.warn(`[tunnel] ws error ${wsRequestId}:`, error && error.message);
        if (state.closed) return;
        state.closed = true;
        this._wsStates.delete(wsRequestId);
        this.stats.wsActive = this._wsStates.size;
        this._send(P.encodeWebSocketClose({
          wsRequestId,
          code: 1011,
          reason: String((error && error.message) || 'local websocket error').slice(0, 120),
        }));
      },
    });
  }

  _onWsData(message) {
    const state = this._wsStates.get(message.wsRequestId);
    if (!state || state.closed) return;
    state.bridge.send(message.data, message.isBinary);
  }

  _onWsClose(message, code) {
    const state = this._wsStates.get(message.wsRequestId);
    if (!state) return;
    state.closed = true;
    this._wsStates.delete(message.wsRequestId);
    this.stats.wsActive = this._wsStates.size;
    state.bridge.close(
      code === undefined ? message.code : code,
      message.reason || '',
    );
    this.logger.log(`[tunnel] ws close from server: ${message.wsRequestId} (${code || message.code})`);
  }

  _closeAllWs(code, reason) {
    for (const state of this._wsStates.values()) state.closed = true;
    this._wsStates.clear();
    this.stats.wsActive = 0;
    this.proxy.closeAll(code, reason);
  }

  // ==================== 状态 ====================

  getStatus() {
    return {
      enabled: true,
      serverUrl: this.serverUrl,
      clientId: this.clientId,
      domain: this.domain,
      url: `http://${this.domain}`,
      localOrigin: this.proxy.origin,
      connected: this.connected,
      registered: this.registered,
      protocol: this.serverVersion >= P.VERSION_2 ? 'dtns-v2' : 'dtns-v1',
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }
}

module.exports = { TunnelClient };
