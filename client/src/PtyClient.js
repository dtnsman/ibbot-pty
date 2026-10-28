import { Transport } from './Transport.js';
import { PtyTerminal } from './PtyTerminal.js';
import { EventBus } from './EventBus.js';

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
export class PtyClient {
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
    // ★ HTTP 头值必须是 ASCII（ByteString）。文件名/相对路径含中文时，
    //   直接塞进 X-Filename / X-Rel-Path 会让浏览器 setRequestHeader 抛
    //   TypeError，请求根本发不出去（表现为“上传失败”且 Network 面板为空）。
    const headerName = encodeURIComponent(name);
    const headerRel = encodeURIComponent(rel);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const k in headers) {
        try { xhr.setRequestHeader(k, headers[k]); } catch {}
      }
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', headerName);
      xhr.setRequestHeader('X-Rel-Path', headerRel);

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