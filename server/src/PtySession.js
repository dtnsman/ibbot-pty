const pty = require('node-pty');
const { EventEmitter } = require('events');
const { pickBackend, getBackend } = require('./backends');

class PtySession extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.termId
   * @param {Object} opts.setting
   * @param {string} [opts.backend]
   * @param {string} [opts.shellId]
   * @param {string} [opts.remoteShell]
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {number} [opts.cols]
   * @param {number} [opts.rows]
   * @param {number} [opts.bufferSize]
   */
  constructor(opts) {
    super();
    this.termId = opts.termId;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this.bufferSize = opts.bufferSize || 65536;

    const setting = opts.setting;
    const backendName = pickBackend(setting, opts.backend);
    const backend = getBackend(backendName);

    const spawnSpec = backend.buildSpawn(setting, {
      shellId: opts.shellId,
      remoteShell: opts.remoteShell,
      args: opts.args,
      cwd: opts.cwd
    });

    this.backend = backendName;
    this.bin = spawnSpec.bin;
    this.args = spawnSpec.args;
    this.shellId = spawnSpec.shellId || null;
    this.remoteShell = opts.remoteShell || null;
    this.cwd = spawnSpec.cwd || process.env.HOME || process.cwd();

    // 环形缓冲区（历史回放）
    this._buffer = [];
    this._bufferBytes = 0;

    // ★ 输出节流
    this.FLUSH_INTERVAL = 16;            // ~60fps
    this.MAX_PENDING = 256 * 1024;       // 256KB 上限
    this._pending = [];
    this._pendingBytes = 0;
    this._flushTimer = null;

    // 统计
    this.totalOut = 0;
    this.totalSent = 0;
    this.totalDropped = 0;

    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.exited = false;
    this.exitCode = null;

    // 真正 spawn
    this.term = pty.spawn(this.bin, this.args, {
      name: 'xterm-256color',
      cwd: this.cwd,
      env: Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }),
      cols: this.cols,
      rows: this.rows
    });

    this.pid = this.term.pid;

    this.term.onData((data) => {
      this._appendBuffer(data);
      this.lastActiveAt = Date.now();
      this._enqueueOut(data);
    });

    this.term.onExit(({ exitCode, signal }) => {
      // 退出前把剩余数据 flush 出去
      this._flushOut(true);
      this.exited = true;
      this.exitCode = exitCode;
      this.emit('exit', { exitCode, signal });
    });
  }

  _appendBuffer(data) {
    this._buffer.push(data);
    this._bufferBytes += Buffer.byteLength(data, 'utf8');
    while (this._bufferBytes > this.bufferSize && this._buffer.length > 1) {
      const removed = this._buffer.shift();
      this._bufferBytes -= Buffer.byteLength(removed, 'utf8');
    }
  }

  /**
   * 输出节流：16ms 合并一次；超过 MAX_PENDING 丢弃最旧的
   */
  _enqueueOut(data) {
    this.totalOut += data.length;
    this._pending.push(data);
    this._pendingBytes += data.length;

    // 超过上限：丢最旧的（终端场景最新输出才有价值）
    while (this._pendingBytes > this.MAX_PENDING && this._pending.length > 1) {
      const removed = this._pending.shift();
      this._pendingBytes -= removed.length;
      this.totalDropped += removed.length;
    }

    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flushOut(false), this.FLUSH_INTERVAL);
    }
  }

  _flushOut(immediate) {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pending.length === 0) return;

    const chunk = this._pending.join('');
    this._pending = [];
    this._pendingBytes = 0;
    this.totalSent += chunk.length;
    this.emit('data', chunk);
  }

  getHistory() { return this._buffer.join(''); }

  write(data) {
    if (this.exited) throw new Error('terminal already exited');
    this.lastActiveAt = Date.now();
    this.term.write(data);
  }

  resize(cols, rows) {
    if (this.exited) throw new Error('terminal already exited');
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    this.lastActiveAt = Date.now();
  }

  kill(signal) {
    if (this.exited) return;
    try { this.term.kill(signal); } catch {}
  }

  isIdle(timeoutMs) {
    return Date.now() - this.lastActiveAt > timeoutMs;
  }

  stats() {
    return {
      totalOut: this.totalOut,
      totalSent: this.totalSent,
      totalDropped: this.totalDropped
    };
  }

  toJSON() {
    return {
      termId: this.termId,
      pid: this.pid,
      backend: this.backend,
      shellId: this.shellId,
      remoteShell: this.remoteShell,
      bin: this.bin,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      exited: this.exited,
      exitCode: this.exitCode
    };
  }
}

module.exports = PtySession;