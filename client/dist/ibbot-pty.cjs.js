/*! ibbot-pty-sdk v1.0.0 | MIT License */
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

class EventBus {
  constructor() {
    this._map = new Map();
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const set = this._map.get(event);
    if (set) set.delete(fn);
  }

  emit(event, payload) {
    const set = this._map.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); }
      catch (e) { console.error(`[EventBus] listener error on "${event}":`, e); }
    }
  }

  removeAll(event) {
    if (event) this._map.delete(event);
    else this._map.clear();
  }
}

function isNode() {
  return typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;
}

function generateReqId() {
  return Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);
}

class PtyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PtyError';
    this.code = code || 'PTY_ERROR';
  }
}

class PtyTimeoutError extends PtyError {
  constructor(message = 'Request timeout') {
    super(message, 'PTY_TIMEOUT');
    this.name = 'PtyTimeoutError';
  }
}

class PtyNotConnectedError extends PtyError {
  constructor(message = 'Transport not connected') {
    super(message, 'PTY_NOT_CONNECTED');
    this.name = 'PtyNotConnectedError';
  }
}

class PtyRpcError extends PtyError {
  constructor(message, payload) {
    super(message, 'PTY_RPC_ERROR');
    this.name = 'PtyRpcError';
    this.payload = payload;
  }
}

const DEFAULT_TIMEOUT = 15000;
const WS_OPEN = 1;

class Transport {
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
        this._ready;
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

class PtyTerminal {
  constructor(client, termId, info) {
    this.client = client;
    this.termId = termId;
    this.info = info || null;

    this._xterm = null;
    this._disposers = [];
    this._dataHandlers = [];
    this._exitHandlers = [];
    this._exited = false;

    // ★ 写入合并队列
    this._writeQueue = [];
    this._writeQueueBytes = 0;
    this._writeScheduled = false;
    this._WRITE_MAX_BYTES = 512 * 1024;   // 单次合并上限（防止一帧写太多）

    // 统计
    this._totalIn = 0;
    this._totalWritten = 0;
  }

  attachXterm(xterm, opts = {}) {
    const { autoResize = true, copyPaste = true } = opts;
    this._xterm = xterm;

    const d1 = xterm.onData(d => {
      this.client.write(this.termId, d).catch(err => {
        this.client.bus.emit('error', err);
      });
    });
    if (d1 && d1.dispose) this._disposers.push(() => d1.dispose());

    if (autoResize && xterm.onResize) {
      const d2 = xterm.onResize(({ cols, rows }) => {
        this.client.resize(this.termId, cols, rows).catch(() => {});
      });
      if (d2 && d2.dispose) this._disposers.push(() => d2.dispose());
    }

    if (copyPaste && xterm.attachCustomKeyEventHandler && typeof navigator !== 'undefined') {
      xterm.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if (e.ctrlKey && e.key === 'c' && xterm.hasSelection && xterm.hasSelection()) {
          navigator.clipboard.writeText(xterm.getSelection());
          return false;
        }
        if (e.ctrlKey && e.key === 'v') {
          navigator.clipboard.readText().then(text => {
            this.client.write(this.termId, text).catch(() => {});
          });
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
          if (xterm.hasSelection && xterm.hasSelection()) {
            navigator.clipboard.writeText(xterm.getSelection());
          }
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'V') {
          navigator.clipboard.readText().then(text => {
            this.client.write(this.termId, text).catch(() => {});
          });
          return false;
        }
        return true;
      });
    }

    return this;
  }

  /**
   * ★ 收到服务端数据：进队列，rAF 合并写
   */
  _onData(data) {
    this._totalIn += data.length;
    this._writeQueue.push(data);
    this._writeQueueBytes += data.length;

    // 队列超限：丢弃旧数据，保留最新
    while (this._writeQueueBytes > this._WRITE_MAX_BYTES && this._writeQueue.length > 1) {
      const removed = this._writeQueue.shift();
      this._writeQueueBytes -= removed.length;
    }

    if (!this._writeScheduled) {
      this._writeScheduled = true;
      const schedule = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);

      schedule(() => {
        this._writeScheduled = false;
        this._flushWrite();
      });
    }

    // 数据事件照常 emit
    for (const fn of this._dataHandlers) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  _flushWrite() {
    if (this._writeQueue.length === 0) return;
    const chunk = this._writeQueue.join('');
    this._writeQueue = [];
    this._writeQueueBytes = 0;
    this._totalWritten += chunk.length;

    if (this._xterm) {
      try { this._xterm.write(chunk); } catch {}
    }
  }

  /** 由 client 内部调用：终端退出 */
  _onExit(info) {
    this._exited = true;
    // 先把队列刷完
    this._flushWrite();

    if (this._xterm && !info.replay) {
      const code = info.code != null ? info.code : '?';
      this._xterm.write(`\r\n[进程退出] code: ${code}\r\n`);
    }
    for (const fn of this._exitHandlers) {
      try { fn(info); } catch (e) { console.error(e); }
    }
  }

  onData(fn) { this._dataHandlers.push(fn); return this; }
  onExit(fn) { this._exitHandlers.push(fn); return this; }

  write(data) { return this.client.write(this.termId, data); }
  resize(cols, rows) { return this.client.resize(this.termId, cols, rows); }
  destroy() { return this.client.destroy(this.termId); }

  detach() {
    this._disposers.forEach(fn => { try { fn(); } catch {} });
    this._disposers = [];
    this._xterm = null;
  }

  dispose() {
    this.detach();
    this._writeQueue = [];
    this._writeQueueBytes = 0;
    this._dataHandlers = [];
    this._exitHandlers = [];
  }

  get exited() { return this._exited; }

  stats() {
    return {
      totalIn: this._totalIn,
      totalWritten: this._totalWritten,
      queueBytes: this._writeQueueBytes
    };
  }
}

// ============================================================
// 模块级工具函数
// ============================================================

/** ws://host:port → http://host:port */
function _wsToHttp(url) {
  return url.replace(/^ws/, 'http').replace(/\/$/, '');
}

/** 触发浏览器下载 */
function _triggerDownload(blob, filename) {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/** 格式化文件大小 */
function _formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ============================================================
// PtyClient
// ============================================================
class PtyClient {
  constructor(opts) {
    if (!opts || !opts.url) throw new Error('url is required');
    this.opts = opts;
    this.url = opts.url;
    this.secretKey = opts.secretKey || null;
    this.userId = opts.userId || 'sdk_user';
    this.sessionId = opts.sessionId || 'sdk_session';

    this.transport = null;
    this.terminals = new Map();
    this.bus = new EventBus();

    this._connected = false;
    this._connectPromise = null;
  }

  // ============================================================
  // 生命周期
  // ============================================================
  async connect() {
    // ★ 短路：已经连接
    if (this.isConnected()) return this;
    // ★ 短路：正在连接
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      this.transport = new Transport({
        url: this.url,
        secretKey: this.secretKey,
        userId: this.userId,
        sessionId: this.sessionId,
        timeout: this.opts.timeout,
        autoReconnect: this.opts.autoReconnect,
        reconnectInterval: this.opts.reconnectInterval,
        maxReconnectAttempts: this.opts.maxReconnectAttempts
      });

      this.transport.on('open', () => {
        this._connected = true;
        this.bus.emit('open');
      });
      this.transport.on('close', () => {
        this._connected = false;
        this.bus.emit('close');
      });
      this.transport.on('error', (err) => this.bus.emit('error', err));
      this.transport.on('reconnecting', (info) => this.bus.emit('reconnecting', info));
      this.transport.on('reconnected', () => {
        this._connected = true;
        this.bus.emit('reconnected');
      });
      this.transport.on('reconnect_failed', () => this.bus.emit('reconnect_failed'));

      this.transport.on('rtterm', (msg) => this._dispatchRtterm(msg));
      this.transport.on('file', (msg) => this.bus.emit('file', msg));

      await this.transport.connect();
      this._connected = true;
      return this;
    })();

    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
    return this;
  }

  _dispatchRtterm(msg) {
    const termId = msg.notify_type;
    const term = this.terminals.get(termId);

    this.bus.emit('rtterm', msg);

    if (!term) return;

    if (msg.ended) {
      const info = {
        termId,
        code: msg.code,
        signal: msg.signal,
        backend: msg.backend,
        error: msg.err_flag ? msg.data : null,
        replay: !!msg.replay
      };
      term._onExit(info);
      this.bus.emit('exit', info);
      this.terminals.delete(termId);
    } else if (msg.data) {
      term._onData(msg.data);
    }
  }

  // ============================================================
  // 查询
  // ============================================================
  async listBackends() {
    const res = await this.transport.request('listBackends', {});
    return { backends: res.backends || [], default: res.default || null };
  }

  async listShells() {
    const res = await this.transport.request('listShells', {});
    return { shells: res.shells || [] };
  }

  async listTerminals() {
    const res = await this.transport.request('list', {});
    return res.terminals || [];
  }

  async checkPasswordRequired() {
    try {
      const res = await this.transport.request('create', {
        cols: 80, rows: 24
      });
      if (res && res.termId) {
        try { await this.destroy(res.termId); } catch {}
      }
      return false;
    } catch (e) {
      if (e && e.message === 'secret_key error!') return true;
      return false;
    }
  }

  // ============================================================
  // 终端操作
  // ============================================================
  async createTerminal(opts = {}, maybeRows) {
    let params;
    if (typeof opts === 'number') {
      params = { cols: opts, rows: maybeRows };
    } else {
      params = {
        cols: opts.cols,
        rows: opts.rows,
        backend: opts.backend,
        shellId: opts.shellId,
        remoteShell: opts.remoteShell,
        args: opts.args,
        cwd: opts.cwd
      };
    }
    Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

    const res = await this.transport.request('create', params);
    const term = new PtyTerminal(this, res.termId, res.info || null);
    this.terminals.set(res.termId, term);
    this.bus.emit('created', term);
    return term;
  }

  async attachTerminal(termId) {
    const res = await this.transport.request('attach', { termId });
    const existing = this.terminals.get(termId);
    if (existing) existing.dispose();

    const term = new PtyTerminal(this, termId, res.info || null);
    this.terminals.set(termId, term);
    this.bus.emit('attached', term);
    return term;
  }

  async detachTerminal(termId) {
    await this.transport.request('detach', { termId });
    const term = this.terminals.get(termId);
    if (term) {
      term.dispose();
      this.terminals.delete(termId);
    }
    this.bus.emit('detached', termId);
  }

  async write(termId, data) {
    return this.transport.request('write', { termId, data });
  }

  async resize(termId, cols, rows) {
    return this.transport.request('resize', { termId, cols, rows });
  }

  async destroy(termId) {
    const res = await this.transport.request('destroy', { termId });
    const term = this.terminals.get(termId);
    if (term) {
      term.dispose();
      this.terminals.delete(termId);
    }
    this.bus.emit('destroyed', termId);
    return res;
  }

  // ============================================================
  // HTTP 文件传输
  // ============================================================

  _httpUrl(p) {
    return _wsToHttp(this.url) + p;
  }

  _httpHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (this.secretKey) h['Authorization'] = 'Bearer ' + this.secretKey;
    return h;
  }

  /**
   * 上传文件（支持子目录）
   * @param {File|Blob} file
   * @param {Object} [opts]
   * @param {Function} [opts.onProgress]  (0~1)
   * @param {string}   [opts.name]        文件名，默认 file.name
   * @param {string}   [opts.rel]         相对路径（含目录），如 "myfolder/sub/file.txt"
   * @returns {Promise<{name, size, path}>}
   */
  uploadFile(file, opts = {}) {
    const name = opts.name || file.name || `upload-${Date.now()}.bin`;
    const rel = opts.rel || name;

    const url = this._httpUrl('/upload')
      + '?name=' + encodeURIComponent(name)
      + '&rel=' + encodeURIComponent(rel);
    const headers = this._httpHeaders();

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const k in headers) {
        try { xhr.setRequestHeader(k, headers[k]); } catch {}
      }
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', name);
      xhr.setRequestHeader('X-Rel-Path', rel);

      if (xhr.upload && opts.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress(e.loaded / e.total);
        };
      }

      xhr.onload = () => {
        let d;
        try { d = JSON.parse(xhr.responseText); }
        catch { return reject(new Error('invalid response')); }

        if (xhr.status === 403) return reject(new Error(d.msg || 'secret_key error!'));
        if (!d.ret) return reject(new Error(d.msg || ('HTTP ' + xhr.status)));
        resolve(d);
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.send(file);
    });
  }

  async downloadFile(filename, opts = {}) {
    const url = this._httpUrl('/download') + '?name=' + encodeURIComponent(filename);
    const headers = this._httpHeaders();

    if (opts.onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        for (const k in headers) {
          try { xhr.setRequestHeader(k, headers[k]); } catch {}
        }
        xhr.responseType = 'blob';

        xhr.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 403) {
            const fr = new FileReader();
            fr.onload = () => {
              try {
                const d = JSON.parse(fr.result);
                reject(new Error(d.msg || 'secret_key error!'));
              } catch { reject(new Error('secret_key error!')); }
            };
            fr.readAsText(xhr.response);
            return;
          }
          if (xhr.status !== 200) return reject(new Error('HTTP ' + xhr.status));
          const blob = xhr.response;
          const saveName = opts.saveAs || filename.split('/').pop();
          _triggerDownload(blob, saveName);
          resolve({ filename: saveName, size: blob.size, blob });
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send();
      });
    }

    const resp = await fetch(url, { headers });
    if (resp.status === 403) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.msg || 'secret_key error!');
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const blob = await resp.blob();
    const saveName = opts.saveAs || filename.split('/').pop();
    _triggerDownload(blob, saveName);
    return { filename: saveName, size: blob.size, blob };
  }

  /**
   * ★ 新增：下载文件到内存（不触发浏览器下载，返回 Uint8Array）
   * 用于 Agent 通过 HTTP-API 取文件内容
   */
  async downloadFileToBytes(filename) {
    const url = this._httpUrl('/download') + '?name=' + encodeURIComponent(filename);
    const headers = this._httpHeaders();
    const resp = await fetch(url, { headers });
    if (resp.status === 403) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.msg || 'secret_key error!');
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  async listFiles() {
    const url = this._httpUrl('/files');
    const headers = this._httpHeaders();
    const resp = await fetch(url, { headers });
    if (resp.status === 403) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.msg || 'secret_key error!');
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const d = await resp.json();
    if (!d.ret) throw new Error(d.msg);
    return d.files || [];
  }

  async deleteFile(filename) {
    const url = this._httpUrl('/file') + '?name=' + encodeURIComponent(filename);
    const headers = this._httpHeaders();
    const resp = await fetch(url, { method: 'DELETE', headers });
    const d = await resp.json().catch(() => ({}));
    if (!d.ret) throw new Error(d.msg || ('HTTP ' + resp.status));
    return d;
  }

  // ============================================================
  // 执行一次性命令
  // ============================================================
  async exec(command, opts = {}) {
    if (!command || typeof command !== 'string') {
      throw new Error('command required');
    }

    const url = this._httpUrl('/exec');
    const headers = this._httpHeaders({ 'Content-Type': 'application/json' });

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command,
        cwd: opts.cwd,
        timeout: opts.timeout || 300000,
        useSsh: !!opts.useSsh
      })
    });

    if (resp.status === 403) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.msg || 'secret_key error!');
    }

    let d;
    try { d = await resp.json(); }
    catch { throw new Error('invalid response (HTTP ' + resp.status + ')'); }

    if (opts.throwOnError && !d.ret) {
      const err = new Error(d.msg || 'exec failed');
      err.stdout = d.stdout;
      err.stderr = d.stderr;
      err.exitCode = d.exitCode;
      throw err;
    }

    return d;
  }

  // ============================================================
  // 工具 / 事件
  // ============================================================
  formatSize(n) { return _formatSize(n); }

  on(event, fn) { return this.bus.on(event, fn); }
  off(event, fn) { return this.bus.off(event, fn); }
  once(event, fn) { return this.bus.once(event, fn); }

  setSecretKey(key) {
    this.secretKey = key;
    if (this.transport) this.transport.setSecretKey(key);
  }

  get connected() { return this._connected; }

  /**
   * ★ 新增：真实连接状态（推荐外部用这个）
   * 综合 _connected 和 transport 的真实 ws.readyState
   */
  isConnected() {
    if (!this.transport) return false;
    return this.transport.isConnected();
  }

  /**
   * ★ 新增：状态快照（调试用）
   */
  getStats() {
    return {
      connected: this._connected,
      transportState: this.transport?.state || 'none',
      transportReady: this.transport?.isReady() || false,
      wsReadyState: this.transport?.ws?.readyState,
      terminalCount: this.terminals.size,
      pendingRequests: this.transport?._pending?.size || 0,
    };
  }

  disconnect() {
    for (const term of this.terminals.values()) {
      term.dispose();
    }
    this.terminals.clear();
    if (this.transport) this.transport.close();
    this.bus.removeAll();
    this._connected = false;
    this._connectPromise = null;
  }
}

// UMD 全局挂载
if (typeof window !== 'undefined') {
  window.IBotPty = {
    PtyClient,
    PtyTerminal,
    Transport,
    EventBus,
    PtyError,
    PtyTimeoutError,
    PtyNotConnectedError,
    PtyRpcError
  };
}

var index = {
  PtyClient,
  PtyTerminal,
  Transport,
  EventBus,
  PtyError,
  PtyTimeoutError,
  PtyNotConnectedError,
  PtyRpcError
};

exports.EventBus = EventBus;
exports.PtyClient = PtyClient;
exports.PtyError = PtyError;
exports.PtyNotConnectedError = PtyNotConnectedError;
exports.PtyRpcError = PtyRpcError;
exports.PtyTerminal = PtyTerminal;
exports.PtyTimeoutError = PtyTimeoutError;
exports.Transport = Transport;
exports.default = index;
//# sourceMappingURL=ibbot-pty.cjs.js.map
