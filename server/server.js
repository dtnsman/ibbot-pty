const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const SessionManager = require('./src/SessionManager');
const WebSocketGateway = require('./src/WebSocketGateway');
const { checkSecret } = require('./src/security');
const { startTunnel } = require('./src/tunnel');
const setting = require('./setting/rtptyx_setting.json');

const PORT = process.env.PTY_PORT || setting.port || 10310;

// DTNS 隧道（内网穿透 + 反向代理），在 server.listen 之后启动
let tunnel = null;

// ============================================================
// 上传目录 & 限制
// ============================================================
const UPLOAD_DIR = path.join(os.homedir(), 'ibbot-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_UPLOAD = 500 * 1024 * 1024;      // 单文件 500MB
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;  // 命令输出上限 10MB

// ============================================================
// 工具函数
// ============================================================
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function getSecretFromReq(req, url) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('secret_key');
}

function safeName(name) {
  if (!name) return null;
  const base = path.basename(name);
  if (!base || base === '.' || base === '..') return null;
  return base;
}

/**
 * 规范化相对路径（保留目录结构），并做防穿越校验
 * @returns {string|null} 规范化后的相对路径，或 null（非法）
 */
function safeRelPath(input) {
  if (!input || typeof input !== 'string') return null;
  // 统一分隔符，去掉开头 /，去掉 Windows 盘符
  let rel = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(rel)) return null;

  const parts = rel.split('/').filter(p => p && p !== '.' && p !== '..');
  if (parts.length === 0) return null;
  if (parts.length > 32) return null;   // 限制深度

  // 每个片段做基础校验
  for (const p of parts) {
    if (p.length > 255) return null;
    if (p.includes('\0')) return null;
  }
  return parts.join('/');
}

/**
 * 把相对路径解析为绝对路径，并确保落在 baseDir 下
 * @returns {string|null}
 */
function resolveInBase(baseDir, rel) {
  const abs = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// ============================================================
// 执行一次性命令（修复中文乱码）
// ============================================================
const iconv = require('iconv-lite');
const { spawn } = require('child_process');

function runCommand({ command, cwd, timeout = 300000, useSsh = false }) {
  return new Promise((resolve) => {
    const useSshExec = useSsh && setting.ssh && setting.ssh.enabled;
    const isWin = os.platform() === 'win32';

    // ---------- Buffer 解码：Windows 用 GBK，其他用 UTF-8 ----------
    function decodeBuffer(buf) {
      if (!buf || buf.length === 0) return '';
      try {
        if (isWin) return iconv.decode(buf, 'gbk');
        return buf.toString('utf8');
      } catch (e) {
        try { return buf.toString('utf8'); } catch { return ''; }
      }
    }

    let finished = false;
    let timer = null;

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    // ---------- SSH 模式 ----------
    if (useSshExec) {
      const sshCfg = setting.ssh;

      // SSH 前置校验
      const auth = sshCfg.auth || {};
      if (auth.type !== 'key') {
        return finish({
          ret: false,
          msg: 'ssh.auth.type must be "key"',
          stdout: '', stderr: '', exitCode: -1
        });
      }
      if (!auth.privateKeyPath || !fs.existsSync(auth.privateKeyPath)) {
        return finish({
          ret: false,
          msg: `private key not found: ${auth.privateKeyPath}`,
          stdout: '', stderr: '', exitCode: -1
        });
      }
      if (!sshCfg.user || !sshCfg.host) {
        return finish({
          ret: false,
          msg: 'ssh.user / ssh.host are required',
          stdout: '', stderr: '', exitCode: -1
        });
      }

      const args = ['-q'];
      if (sshCfg.port && sshCfg.port !== 22) args.push('-p', String(sshCfg.port));
      args.push('-tt');

      if (sshCfg.strictHostKeyChecking === false) {
        args.push('-o', 'StrictHostKeyChecking=no');
        args.push('-o', isWin ? 'UserKnownHostsFile=NUL' : 'UserKnownHostsFile=/dev/null');
      } else if (sshCfg.knownHostsPath) {
        args.push('-o', `UserKnownHostsFile=${sshCfg.knownHostsPath}`);
      }
      args.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
      args.push('-i', auth.privateKeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
      args.push(`${sshCfg.user}@${sshCfg.host}`, command);

      const child = spawn('ssh', args, {
        cwd: cwd || os.homedir(),
        windowsHide: true
      });

      const outChunks = [];
      const errChunks = [];

      child.stdout.on('data', c => outChunks.push(c));
      child.stderr.on('data', c => errChunks.push(c));

      if (timeout > 0) {
        timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          finish({
            ret: false,
            msg: `command timeout (${timeout}ms)`,
            stdout: decodeBuffer(Buffer.concat(outChunks)),
            stderr: decodeBuffer(Buffer.concat(errChunks)),
            exitCode: -1
          });
        }, timeout);
      }

      child.on('error', (err) => {
        finish({
          ret: false,
          msg: err.message,
          stdout: decodeBuffer(Buffer.concat(outChunks)),
          stderr: decodeBuffer(Buffer.concat(errChunks)),
          exitCode: -1
        });
      });

      child.on('close', (code) => {
        finish({
          ret: code === 0,
          msg: code === 0 ? 'success' : `exit code ${code}`,
          stdout: decodeBuffer(Buffer.concat(outChunks)),
          stderr: decodeBuffer(Buffer.concat(errChunks)),
          exitCode: code == null ? -1 : code
        });
      });

      return;
    }

    // ---------- 本地模式 ----------
    // Windows: cmd /c  其他: /bin/bash -c
    const shell = isWin ? 'cmd.exe' : '/bin/bash';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: cwd || os.homedir(),
      env: process.env,
      windowsHide: true
    });

    const outChunks = [];
    const errChunks = [];

    child.stdout.on('data', c => outChunks.push(c));
    child.stderr.on('data', c => errChunks.push(c));

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({
          ret: false,
          msg: `command timeout (${timeout}ms)`,
          stdout: decodeBuffer(Buffer.concat(outChunks)),
          stderr: decodeBuffer(Buffer.concat(errChunks)),
          exitCode: -1
        });
      }, timeout);
    }

    child.on('error', (err) => {
      finish({
        ret: false,
        msg: err.message,
        stdout: decodeBuffer(Buffer.concat(outChunks)),
        stderr: decodeBuffer(Buffer.concat(errChunks)),
        exitCode: -1
      });
    });

    child.on('close', (code) => {
      finish({
        ret: code === 0,
        msg: code === 0 ? 'success' : `exit code ${code}`,
        stdout: decodeBuffer(Buffer.concat(outChunks)),
        stderr: decodeBuffer(Buffer.concat(errChunks)),
        exitCode: code == null ? -1 : code
      });
    });
  });
}

/**
 * 读取 JSON 请求体
 */
function readJsonBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxSize) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename, X-Rel-Path');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Filename');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const secret = getSecretFromReq(req, url);

  // ============================================================
  // 健康检查
  // ============================================================
  if (url.pathname === '/' || url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'ibbot-pty-server',
      backend: setting.backend,
      ssh: !!(setting.ssh && setting.ssh.enabled),
      local: !!(setting.local && setting.local.enabled),
      uploadDir: UPLOAD_DIR,
      tunnel: tunnel ? tunnel.getStatus() : { enabled: false }
    });
  }

  // ============================================================
  // 执行命令
  // ============================================================
  if (req.method === 'POST' && url.pathname === '/exec') {
    const sec = checkSecret(setting, secret);
    if (!sec.ok) return json(res, 403, { ret: false, msg: sec.msg });

    readJsonBody(req, 64 * 1024).then(async (params) => {
      const command = params.command;
      if (!command || typeof command !== 'string') {
        return json(res, 400, { ret: false, msg: 'command required' });
      }
      if (command.length > 8192) {
        return json(res, 400, { ret: false, msg: 'command too long' });
      }

      const cwd = params.cwd;
      const timeout = Math.max(1000, Math.min(10 * 60 * 1000, params.timeout || 300000));
      const useSsh = !!params.useSsh;

      try {
        const result = await runCommand({ command, cwd, timeout, useSsh });
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { ret: false, msg: e.message, stdout: '', stderr: '', exitCode: -1 });
      }
    }).catch(e => json(res, 400, { ret: false, msg: e.message }));

    return;
  }

  // ============================================================
  // 上传（支持 rel 相对路径 → 子目录）
  // POST /upload?name=xxx&rel=sub/dir/file.txt
  // ============================================================
  if (req.method === 'POST' && url.pathname === '/upload') {
    const sec = checkSecret(setting, secret);
    if (!sec.ok) return json(res, 403, { ret: false, msg: sec.msg });

    // ★ 优先用 rel（保留目录结构），否则用 name
    const rawRel = url.searchParams.get('rel') || req.headers['x-rel-path'];
    const rawName = url.searchParams.get('name') || req.headers['x-filename'];

    let relPath;
    if (rawRel) {
      relPath = safeRelPath(rawRel);
      if (!relPath) {
        return json(res, 400, { ret: false, msg: 'invalid rel path' });
      }
    } else {
      const safe = safeName(rawName);
      if (!safe) return json(res, 400, { ret: false, msg: 'name required' });
      relPath = safe;
    }

    const savePath = resolveInBase(UPLOAD_DIR, relPath);
    if (!savePath) {
      return json(res, 400, { ret: false, msg: 'path traversal detected' });
    }

    const saveDir = path.dirname(savePath);
    try {
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }
    } catch (e) {
      return json(res, 500, { ret: false, msg: 'mkdir failed: ' + e.message });
    }

    const writeStream = fs.createWriteStream(savePath);

    let received = 0;
    let aborted = false;
    let responded = false;

    const cleanup = () => {
      try { writeStream.destroy(); } catch {}
      try { fs.unlinkSync(savePath); } catch {}
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD && !aborted) {
        aborted = true;
        cleanup();
        if (!responded) {
          responded = true;
          json(res, 413, { ret: false, msg: 'file too large' });
        }
      }
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      if (aborted || responded) return;
      responded = true;
      json(res, 200, {
        ret: true, msg: 'success',
        name: relPath,
        size: received,
        path: savePath
      });
    });

    writeStream.on('error', (err) => {
      if (responded) return;
      responded = true;
      json(res, 500, { ret: false, msg: err.message });
    });

    req.on('aborted', () => {
      aborted = true;
      cleanup();
    });

    return;
  }

  // ============================================================
  // 下载（支持子目录）
  // ============================================================
  if (req.method === 'GET' && url.pathname === '/download') {
    const sec = checkSecret(setting, secret);
    if (!sec.ok) return json(res, 403, { ret: false, msg: sec.msg });

    const rawName = url.searchParams.get('name');
    if (!rawName) return json(res, 400, { ret: false, msg: 'name required' });

    const rel = safeRelPath(rawName);
    if (!rel) return json(res, 400, { ret: false, msg: 'invalid name' });

    const filePath = resolveInBase(UPLOAD_DIR, rel);
    if (!filePath) return json(res, 400, { ret: false, msg: 'path traversal detected' });

    if (!fs.existsSync(filePath)) {
      return json(res, 404, { ret: false, msg: 'file not found' });
    }
    let st;
    try { st = fs.statSync(filePath); } catch (e) {
      return json(res, 500, { ret: false, msg: e.message });
    }
    if (!st.isFile()) {
      return json(res, 400, { ret: false, msg: 'not a file' });
    }

    const basename = path.basename(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(basename)}"`,
      'X-Filename': basename
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ============================================================
  // 文件列表（递归）
  // ============================================================
  if (req.method === 'GET' && url.pathname === '/files') {
    const sec = checkSecret(setting, secret);
    if (!sec.ok) return json(res, 403, { ret: false, msg: sec.msg });

    const files = [];
    const MAX_FILES = 20000;

    function walk(dir, base) {
      if (files.length >= MAX_FILES) return;
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (files.length >= MAX_FILES) return;
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const rel = base ? base + '/' + name : name;
        if (st.isDirectory()) {
          walk(p, rel);
        } else if (st.isFile()) {
          files.push({ name: rel, size: st.size, mtime: st.mtimeMs });
        }
      }
    }
    walk(UPLOAD_DIR, '');

    return json(res, 200, { ret: true, files, truncated: files.length >= MAX_FILES });
  }

  // ============================================================
  // 删除文件（支持子目录）
  // ============================================================
  if (req.method === 'DELETE' && url.pathname === '/file') {
    const sec = checkSecret(setting, secret);
    if (!sec.ok) return json(res, 403, { ret: false, msg: sec.msg });

    const rawName = url.searchParams.get('name');
    if (!rawName) return json(res, 400, { ret: false, msg: 'name required' });

    const rel = safeRelPath(rawName);
    if (!rel) return json(res, 400, { ret: false, msg: 'invalid name' });

    const filePath = resolveInBase(UPLOAD_DIR, rel);
    if (!filePath) return json(res, 400, { ret: false, msg: 'path traversal detected' });

    if (!fs.existsSync(filePath)) {
      return json(res, 404, { ret: false, msg: 'file not found' });
    }
    try {
      const st = fs.statSync(filePath);
      if (st.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      // 顺带清理空父目录
      try {
        let dir = path.dirname(filePath);
        while (dir !== UPLOAD_DIR) {
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      } catch {}
      return json(res, 200, { ret: true, msg: 'deleted' });
    } catch (e) {
      return json(res, 500, { ret: false, msg: e.message });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
});

// ============================================================
// WebSocket 挂到 HTTP server 上
// ============================================================
const manager = new SessionManager(setting);
new WebSocketGateway({ server, manager, setting });

server.listen(PORT, () => {
  console.log(`[PTY Server] listening on ws://0.0.0.0:${PORT}`);
  console.log(`[PTY Server] http://0.0.0.0:${PORT}  (CORS: *)`);
  console.log(`[PTY Server] uploadDir: ${UPLOAD_DIR}`);
  console.log(`[PTY Server] default backend: ${setting.backend || 'ssh'}`);
  console.log(`[PTY Server] ssh enabled: ${!!(setting.ssh && setting.ssh.enabled)}`);
  console.log(`[PTY Server] local enabled: ${!!(setting.local && setting.local.enabled)}`);
  console.log(`[PTY Server] secret_key: ${setting.secret_key ? '***' : '(none)'}`);
  console.log(`[PTY Server] endpoints: /health /exec /upload /download /files /file`);

  // ============================================================
  // DTNS 隧道：把 HTTP + WebSocket 暴露到动态域名
  //   api.pty2.<serverId>.html.dtns.top
  // ============================================================
  tunnel = startTunnel({ setting, port: PORT, logger: console });
  if (tunnel) {
    const status = tunnel.getStatus();
    console.log(`[PTY Server] tunnel domain: ${status.domain}`);
    console.log(`[PTY Server] tunnel local : ${status.localOrigin}`);
  }
});

process.on('SIGINT', () => {
  console.log('\n[PTY Server] shutting down...');
  if (tunnel) tunnel.stop();
  manager.shutdown();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  if (tunnel) tunnel.stop();
  manager.shutdown();
  server.close(() => process.exit(0));
});