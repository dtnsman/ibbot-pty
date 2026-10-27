const { EventEmitter } = require('events');
const PtySession = require('./PtySession');
const { listAllShells } = require('./backends');

class SessionManager extends EventEmitter {
  constructor(setting) {
    super();
    this.setting = setting;
    this.sessions = new Map();
    this._idSeq = 0;
    this._reaper = setInterval(() => this._reapIdle(), 60 * 1000);
  }

  _genId() {
    this._idSeq++;
    return 'rtptyx-' + Date.now().toString(36) +
      '-' + Math.random().toString(36).substr(2, 6);
  }

  /** 当前可用的 backend 信息（供前端展示） */
  listBackends() {
    const out = [];
    if (this.setting.ssh && this.setting.ssh.enabled) out.push('ssh');
    if (this.setting.local && this.setting.local.enabled) out.push('local');
    return out;
  }

  /** 汇总所有 shell（带 backend 字段） */
  listShells() {
    return listAllShells(this.setting);
  }

  get(termId) { return this.sessions.get(termId) || null; }
  list() { return Array.from(this.sessions.values()).map(s => s.toJSON()); }
  count() { return this.sessions.size; }

  create({ cols, rows, backend, shellId, remoteShell, args, cwd } = {}) {
    if (this.sessions.size >= (this.setting.max_terminals || 100)) {
      throw new Error('too many terminals');
    }

    const termId = this._genId();
    const session = new PtySession({
      termId,
      setting: this.setting,
      backend, shellId, remoteShell, args, cwd,
      cols, rows,
      bufferSize: this.setting.buffer_size
    });

    this.sessions.set(termId, session);
    session.on('data', (data) => this.emit('data', { termId, data }));
    session.on('exit', (info) => {
      this.emit('exit', Object.assign({ termId, backend: session.backend }, info));
      this.sessions.delete(termId);
      this.emit('closed', termId);
    });
    this.emit('created', session);
    return session;
  }

  write(termId, data) {
    const s = this.sessions.get(termId);
    if (!s) throw new Error('Terminal not found');
    s.write(data);
  }

  resize(termId, cols, rows) {
    const s = this.sessions.get(termId);
    if (!s) throw new Error('Terminal not found');
    s.resize(cols, rows);
  }

  destroy(termId, signal) {
    const s = this.sessions.get(termId);
    if (!s) throw new Error('Terminal not found');
    s.kill(signal);
  }

  _reapIdle() {
    const timeout = this.setting.idle_timeout_ms || 0;
    if (!timeout) return;
    for (const [id, s] of this.sessions) {
      if (s.isIdle(timeout) && !s.exited) {
        console.log(`[SessionManager] reaping idle terminal ${id}`);
        s.kill();
      }
    }
  }

  shutdown() {
    clearInterval(this._reaper);
    for (const [, s] of this.sessions) s.kill();
    this.sessions.clear();
  }
}

module.exports = SessionManager;