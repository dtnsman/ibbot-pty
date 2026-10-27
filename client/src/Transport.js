import { EventBus } from './EventBus.js';
import { generateReqId, isNode } from './utils.js';
import {
  PtyError,
  PtyTimeoutError,
  PtyNotConnectedError,
  PtyRpcError
} from './errors.js';

const DEFAULT_TIMEOUT = 15000;

// WebSocket readyState 常量（兼容浏览器/Node）
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export class Transport {
  /**
   * @param {Object} opts
   * @param {string} opts.url
   * @param {string} [opts.secretKey]
   * @param {string} [opts.userId]
   * @param {string} [opts.sessionId]
   * @param {number} [opts.timeout]
   * @param {boolean} [opts.autoReconnect]
   * @param {number} [opts.reconnectInterval]
   * @param {number} [opts.maxReconnectAttempts]
   */
  constructor(opts) {
    if (!opts || !opts.url) throw new PtyNotConnectedError('url is required');
    this.url = opts.url;
    this.secretKey = opts.secretKey || null;
    this.userId = opts.userId || 'sdk_user';
    this.sessionId = opts.sessionId || 'sdk_session';
    this.timeout = opts.timeout || DEFAULT_TIMEOUT;

    this.autoReconnect = !!opts.autoReconnect;
    this.reconnectInterval = opts.reconnectInterval || 3000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts || 10;
    this._reconnectAttempts = 0;
    this._manualClose = false;

    this.ws = null;
    this.bus = new EventBus();
    this._pending = new Map();  // req_id -> { resolve, reject, timer }
    this._ready = false;

    // ★ 新增：统一状态字段（外部查询用）
    this.state = 'idle';  // idle | connecting | open | closing | closed | reconnecting
  }

  /** 连接（返回 Promise） */
  connect() {
    this._manualClose = false;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      let WsCtor;
      if (isNode()) {
        try {
          WsCtor = require('ws');
        } catch (e) {
          return reject(new PtyError('ws module not found in Node env'));
        }
      } else {
        WsCtor = window.WebSocket || window.MozWebSocket;
      }
      if (!WsCtor) return reject(new PtyError('WebSocket not supported'));

      try {
        this.ws = new WsCtor(this.url);
      } catch (e) {
        this.state = 'closed';
        return reject(e);
      }

      let settled = false;

      const onOpen = () => {
        this._ready = true;
        this.state = 'open';
        this._reconnectAttempts = 0;
        this.bus.emit('open');
        if (!settled) { settled = true; resolve(true); }
      };

      const onError = (err) => {
        this._ready = false;
        this.bus.emit('error', err);
        // 首次连接失败 → reject
        if (!settled && this._pending.size === 0) {
          settled = true;
          reject(err && err.message ? err : new PtyError('ws connect failed'));
        }
      };

      const onClose = () => {
        const wasReady = this._ready;
        this._ready = false;
        this.state = 'closed';
        this.bus.emit('close');

        // 所有未完成请求拒绝
        for (const [reqId, { reject: rej, timer }] of this._pending) {
          clearTimeout(timer);
          rej(new PtyNotConnectedError('connection closed'));
          this._pending.delete(reqId);
        }

        // 首次连接就被关闭 → reject
        if (!settled) {
          settled = true;
          reject(new PtyNotConnectedError('connection closed before open'));
          return;
        }

        // 自动重连
        if (this.autoReconnect && !this._manualClose) {
          this._scheduleReconnect();
        }
      };

      const onMessage = (evt) => {
        let text = evt && evt.data !== undefined ? evt.data : evt;
        if (typeof text !== 'string') {
          try { text = text.toString('utf8'); } catch { return; }
        }
        this._onMessage(text);
      };

      // Node ws 用事件名，浏览器用属性
      if (typeof this.ws.on === 'function') {
        this.ws.on('open', onOpen);
        this.ws.on('error', onError);
        this.ws.on('close', onClose);
        this.ws.on('message', onMessage);
      } else {
        this.ws.onopen = onOpen;
        this.ws.onerror = onError;
        this.ws.onclose = onClose;
        this.ws.onmessage = onMessage;
      }
    });
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      this.state = 'closed';
      this.bus.emit('reconnect_failed');
      return;
    }
    this._reconnectAttempts++;
    this.state = 'reconnecting';
    const delay = this.reconnectInterval * Math.min(this._reconnectAttempts, 5);
    this.bus.emit('reconnecting', { attempt: this._reconnectAttempts, delay });
    setTimeout(() => {
      if (this._manualClose) return;
      this.connect().then(() => {
        this.bus.emit('reconnected');
      }).catch(() => {
        // connect 内部 onClose 会再次触发重连
      });
    }, delay);
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); }
    catch { return; }

    // 1. RPC 响应
    if (msg.req_id && this._pending.has(msg.req_id)) {
      const { resolve, reject, timer } = this._pending.get(msg.req_id);
      this._pending.delete(msg.req_id);
      clearTimeout(timer);
      if (msg.ret === false) {
        reject(new PtyRpcError(msg.msg || 'rpc error', msg));
      } else {
        resolve(msg);
      }
      return;
    }

    // 2. 终端推送
    if (msg.channel === 'rtterm') {
      this.bus.emit('rtterm', msg);
      return;
    }

    // 3. 其他通知
    this.bus.emit('notify', msg);
  }

  /**
   * ★ 修复：更可靠的 isReady
   * - 优先看 ws.readyState（真实网络状态）
   * - 退化到 _ready 标志
   */
  isReady() {
    if (!this.ws) return false;
    const rs = this.ws.readyState;
    if (rs !== undefined) {
      return rs === WS_OPEN;
    }
    return this._ready === true;
  }

  /**
   * ★ 新增：真实连接状态（供外部查询）
   */
  isConnected() {
    return this.isReady();
  }

  /**
   * 发起一次 RPC 请求。
   * @param {string} action
   * @param {Object} [params]
   * @returns {Promise<Object>}
   */
  request(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isReady()) return reject(new PtyNotConnectedError());

      const req_id = generateReqId();
      const payload = Object.assign({
        req_id,
        action,
        secret_key: this.secretKey,
        user_id: this.userId,
        s_id: this.sessionId
      }, params);

      const timer = setTimeout(() => {
        this._pending.delete(req_id);
        reject(new PtyTimeoutError(`request "${action}" timeout`));
      }, this.timeout);

      this._pending.set(req_id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(req_id);
        reject(e);
      }
    });
  }

  on(event, fn) { return this.bus.on(event, fn); }
  off(event, fn) { return this.bus.off(event, fn); }

  setSecretKey(key) { this.secretKey = key; }

  close() {
    this._manualClose = true;
    this.state = 'closing';
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this._ready = false;
    this.state = 'closed';
    this._pending.clear();
    this.bus.removeAll();
  }
}