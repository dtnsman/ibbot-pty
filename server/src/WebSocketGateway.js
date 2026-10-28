const WebSocket = require('ws');
const { checkSecret } = require('./security');

// 慢客户端丢弃阈值
const DROP_THRESHOLD = 1 * 1024 * 1024;   // 1MB

class WebSocketGateway {
  constructor({ server, manager, setting }) {
    this.manager = manager;
    this.setting = setting;

    this.wss = new WebSocket.Server({
      server,
      // 开启压缩（文本输出多时效果明显）
      perMessageDeflate: {
        zlibDeflateOptions: { level: 3 },
        threshold: 1024,
        serverNoContextTakeover: true
      },
      // 单个 WS 帧最大 4MB，避免大消息断开
      maxPayload: 4 * 1024 * 1024
    });

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this._bindManagerEvents();

    // 周期性打印 WS 缓冲状况（排查堆积用）
    this._statsTimer = setInterval(() => this._printStats(), 5000);
  }

  _printStats() {
    let total = 0, max = 0, dropped = 0;
    let n = 0;
    for (const c of this.wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      n++;
      const b = c.bufferedAmount || 0;
      total += b;
      if (b > max) max = b;
      dropped += c._droppedBytes || 0;
    }
    if (total > 0 || dropped > 0) {
      console.log(`[WS] clients=${n} bufferedTotal=${(total/1024).toFixed(1)}KB ` +
                  `bufferedMax=${(max/1024).toFixed(1)}KB dropped=${(dropped/1024).toFixed(1)}KB`);
    }
  }

  _bindManagerEvents() {
    this.manager.on('data', ({ termId, data }) => {
      this._broadcast(termId, {
        channel: 'rtterm', notify_type: termId,
        data, err_flag: false, ended: false
      });
    });
    this.manager.on('exit', ({ termId, exitCode, signal, backend }) => {
      // 退出事件强制发，无视 bufferedAmount
      this._broadcastCritical(termId, {
        channel: 'rtterm', notify_type: termId,
        data: exitCode, code: exitCode, signal, backend,
        err_flag: false, ended: true
      });
    });
  }

  /**
   * 普通广播：客户端积压超过阈值时丢弃
   */
  _broadcast(termId, payload) {
    const text = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!client._subscribedTermIds || !client._subscribedTermIds.has(termId)) continue;

      // ★ 关键：超过阈值就丢
      if (client.bufferedAmount > DROP_THRESHOLD) {
        client._droppedBytes = (client._droppedBytes || 0) + text.length;
        continue;
      }

      try { client.send(text); } catch (e) {
        console.error('[WS] send error:', e.message);
      }
    }
  }

  /**
   * 关键广播：无视 bufferedAmount（用于 exit / error）
   */
  _broadcastCritical(termId, payload) {
    const text = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!client._subscribedTermIds || !client._subscribedTermIds.has(termId)) continue;
      try { client.send(text); } catch (e) {
        console.error('[WS] critical send error:', e.message);
      }
    }
  }

  _onConnection(ws, req) {
    ws._subscribedTermIds = new Set();
    ws._clientInfo = { ip: req.socket.remoteAddress, connectedAt: Date.now() };
    ws._droppedBytes = 0;

    // 允许客户端升级为更大缓冲（默认 16KB → 提升发送吞吐）
    if (typeof ws._socket?.setNoDelay === 'function') {
      try { ws._socket.setNoDelay(true); } catch {}
    }

    console.log(`[Gateway] client connected: ${ws._clientInfo.ip}`);

    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => console.log(`[Gateway] client disconnected: ${ws._clientInfo.ip}`));
    ws.on('error', (err) => console.error('[Gateway] ws error:', err.message));
  }

  _onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return this._reply(ws, null, { ret: false, msg: 'invalid json' }); }

    const {
      req_id, action, secret_key,
      termId, data, cols, rows,
      backend, shellId, remoteShell, args, cwd
    } = msg;

    const sec = checkSecret(this.setting, secret_key);
    if (!sec.ok) return this._reply(ws, req_id, { ret: false, msg: sec.msg });

    try {
      switch (action) {
        case 'listBackends':
          return this._reply(ws, req_id, {
            ret: true, msg: 'success',
            backends: this.manager.listBackends(),
            default: this.setting.backend || null
          });

        case 'listShells':
          return this._reply(ws, req_id, {
            ret: true, msg: 'success',
            shells: this.manager.listShells()
          });

        case 'list':
          return this._reply(ws, req_id, {
            ret: true, msg: 'success',
            terminals: this.manager.list()
          });

        case 'create': {
          const session = this.manager.create({
            cols, rows, backend, shellId, remoteShell, args, cwd
          });
          ws._subscribedTermIds.add(session.termId);
          return this._reply(ws, req_id, {
            ret: true, msg: 'success',
            termId: session.termId,
            info: session.toJSON()
          });
        }

        case 'attach': {
          const session = this.manager.get(termId);
          if (!session) return this._reply(ws, req_id, { ret: false, msg: 'Terminal not found' });
          ws._subscribedTermIds.add(termId);
          const history = session.getHistory();
          if (history) {
            ws.send(JSON.stringify({
              channel: 'rtterm', notify_type: termId,
              data: history, err_flag: false, ended: false, replay: true
            }));
          }
          return this._reply(ws, req_id, {
            ret: true, msg: 'success', termId, info: session.toJSON()
          });
        }

        case 'detach':
          ws._subscribedTermIds.delete(termId);
          return this._reply(ws, req_id, { ret: true, msg: 'success' });

        case 'write':
          if (!termId || data === undefined) {
            return this._reply(ws, req_id, { ret: false, msg: 'termId and data are required' });
          }
          this.manager.write(termId, data);
          return this._reply(ws, req_id, { ret: true, msg: 'success' });

        case 'resize':
          if (!termId || !cols || !rows) {
            return this._reply(ws, req_id, { ret: false, msg: 'termId, cols and rows are required' });
          }
          this.manager.resize(termId, cols, rows);
          return this._reply(ws, req_id, { ret: true, msg: 'success' });

        case 'destroy':
          if (!termId) return this._reply(ws, req_id, { ret: false, msg: 'termId is required' });
          this.manager.destroy(termId);
          this._broadcastCritical(termId, {
            channel: 'rtterm', notify_type: termId,
            data: 0, code: 0, err_flag: false, ended: true
          });
          return this._reply(ws, req_id, { ret: true, msg: 'success' });

        default:
          return this._reply(ws, req_id, { ret: false, msg: 'unknown action: ' + action });
      }
    } catch (err) {
      return this._reply(ws, req_id, { ret: false, msg: err.message });
    }
  }

  _reply(ws, req_id, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(Object.assign({ req_id }, payload))); } catch {}
  }

  close() {
    clearInterval(this._statsTimer);
    // 主动断开客户端：否则 server.close() 会一直等这些 WS 结束，
    // systemd stop 要等到 TimeoutStopSec（默认 90s）才 SIGKILL。
    for (const client of this.wss.clients) {
      try { client.terminate(); } catch (e) {}
    }
    this.wss.close();
  }
}

module.exports = WebSocketGateway;