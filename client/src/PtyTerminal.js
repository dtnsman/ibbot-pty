export class PtyTerminal {
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