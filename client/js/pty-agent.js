// pty-agent.js
// PTY Agent HTTP-Proxy 单文件实现
// 依赖：宿主提供 runtime / hosts / ensureConnected / getActiveRt
// 用法：
//   const agent = new PtyAgent({ runtime, hosts, ensureConnected, getActiveRt });
//   agent.ui.mount();  // 自动注入按钮和面板
//   window.__ptyAgent = agent;
(function (global) {
  'use strict';

  // ============================================================
  // 1. Base64 工具（二进制安全）
  // ============================================================
  const Base64 = {
    encode(str) {
      try { return btoa(unescape(encodeURIComponent(str))); }
      catch (e) { return btoa(str); }
    },
    decode(b64) {
      try { return decodeURIComponent(escape(atob(b64))); }
      catch (e) { return atob(b64); }
    },
    encodeBytes(bytes) {
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    },
    decodeToBytes(b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },
  };

  // ============================================================
  // 2. 安全网关
  // ============================================================
  const DANGEROUS_PATTERNS = [
    { re: /rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, level: 'danger', reason: 'rm 删除根目录' },
    { re: /dd\s+[^|;]*of=\/dev\/(sd|hd|nvme|vd|xvd)/,   level: 'danger', reason: 'dd 直接写块设备' },
    { re: /\bmkfs(\.\w+)?\b/,                            level: 'danger', reason: '格式化文件系统' },
    { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,                  level: 'danger', reason: 'fork bomb' },
    { re: />\s*\/dev\/(sd|hd|nvme|vd|xvd)/,              level: 'danger', reason: '重定向到块设备' },
    { re: /chmod\s+(-R\s+)?777\s+\/(\s|$)/,               level: 'danger', reason: 'chmod 777 根目录' },
    { re: /curl\s+[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)/,    level: 'danger', reason: 'curl 直接管道到 shell' },
    { re: /wget\s+[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)/,    level: 'danger', reason: 'wget 直接管道到 shell' },
    { re: /\bsudo\s+rm\b/,                               level: 'warn',   reason: 'sudo rm 需要确认' },
    { re: /\brm\b[^|;]*\s-[a-zA-Z]*r[a-zA-Z]*f|\brm\b[^|;]*\s-[a-zA-Z]*f[a-zA-Z]*r/, level: 'warn', reason: 'rm -rf 会递归强制删除' },
    { re: /\brm\b[^|;]*\s-[a-zA-Z]*r/,                    level: 'warn',   reason: 'rm -r 会递归删除目录' },
    { re: /\b(shutdown|reboot|halt|poweroff)\b/,          level: 'warn',   reason: '关机/重启命令' },
    { re: />\s*\/(etc|boot|sys|proc)\//,                  level: 'warn',   reason: '写入系统关键目录' },
    { re: /\bcrontab\s+-r\b/,                             level: 'warn',   reason: '清空 crontab' },
    { re: /\b(userdel|groupdel)\b/,                       level: 'warn',   reason: '删除用户/组' },
    { re: /[;&|]\s*(sudo\s+)?(rm|dd|mkfs|shutdown|reboot)\b/, level: 'warn', reason: '组合命令含危险操作' },
    { re: /\$\([^)]*\)|`[^`]*`/,                          level: 'warn',   reason: '含命令替换，可能隐藏危险操作' },
    { re: /(^|[^>])>\s*[^>|&\s]/,                          level: 'warn',   reason: '重定向会覆盖文件' },
  ];

  const SAFE_COMMAND_PREFIXES = [
  // ===== 文件读取 =====
  'ls', 'cat', 'head', 'tail', 'tac', 'grep', 'find', 'file', 'stat',
  'wc', 'sort', 'uniq', 'cut', 'awk', 'sed', 'tr', 'tee',
  'readlink', 'realpath', 'basename', 'dirname', 'stat', 'du', 'df',
  'less', 'more', 'zcat', 'zgrep', 'tar -t', 'unzip -l',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum',

  // ===== 系统信息 =====
  'pwd', 'whoami', 'id', 'groups', 'uname', 'hostname', 'hostnamectl',
  'date', 'uptime', 'cal', 'w', 'who', 'last', 'lastlog',
  'free', 'vmstat', 'mpstat', 'iostat', 'sar',
  'top -b', 'htop -b', 'ps', 'pstree', 'pgrep', 'pidof',
  'env', 'printenv', 'echo', 'printf', 'which', 'whereis', 'type',
  'locale', 'timedatectl', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'lsmod',
  'dmidecode -t', 'lshw', 'hwinfo',

  // ===== 网络（只读） =====
  'ping', 'ping6', 'traceroute', 'traceroute6', 'tracepath',
  'nslookup', 'dig', 'host', 'getent',
  'ip', 'ifconfig', 'netstat', 'ss', 'route', 'arp',
  'ip addr', 'ip route', 'ip link', 'ip neigh', 'ip -s',
  'curl', 'wget',           // ★ 危险模式里已经有 curl|sh 拦截
  'nc -z', 'nc -vz', 'telnet',
  'nmap -sT', 'nmap -sV',   // 谨慎，允许有限 nmap
  'tcpdump -c', 'tcpdump -n',  // 有限抓包
  'mtr', 'mtr --report',

  // ===== 进程 / 服务 =====
  'systemctl status', 'systemctl list-units', 'systemctl list-unit-files',
  'systemctl is-active', 'systemctl is-enabled', 'systemctl show',
  'service --status-all',
  'journalctl', 'dmesg', 'last',
  'lsof', 'fuser', 'pstree',
  'crontab -l',             // 只读 crontab
  'atq',

  // ===== 容器 / 编排 =====
  'docker ps', 'docker images', 'docker logs', 'docker inspect',
  'docker stats --no-stream', 'docker version', 'docker info',
  'docker network ls', 'docker volume ls', 'docker container ls',
  'kubectl get', 'kubectl describe', 'kubectl logs', 'kubectl top',
  'kubectl version', 'kubectl cluster-info', 'kubectl config view',
  'podman ps', 'podman images',

  // ===== 开发工具 =====
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'git blame', 'git remote -v', 'git tag', 'git rev-parse',
  'git config --get', 'git config --list',
  'npm ls', 'npm list', 'npm view', 'npm outdated',
  'yarn list', 'pnpm list',
  'pip list', 'pip show', 'pip freeze',
  'python --version', 'python3 --version', 'node -v', 'node --version',
  'npm -v', 'go version', 'java -version', 'gcc --version',
  'make -n',                 // 只打印不执行
  'java -version', 'php -v',

  // ===== 文本处理（管道常用） =====
  'xargs -n', 'xargs -I',
];

// 允许 sudo 的只读命令（前缀匹配）
const SAFE_SUDO_PREFIXES = [
  'systemctl status', 'systemctl is-active', 'systemctl is-enabled',
  'systemctl list-units', 'journalctl', 'dmesg',
  'docker ps', 'docker images', 'docker logs', 'docker inspect',
  'kubectl get', 'kubectl describe', 'kubectl logs',
  'iptables -L', 'iptables-save', 'nft list',
  'lsof', 'ss', 'netstat',
  'cat /var/log', 'tail /var/log', 'head /var/log', 'grep /var/log',
];

  function checkCommandSafety(command) {
    if (!command || typeof command !== 'string') {
      return { safe: false, risk: 'warn', reason: '命令为空或格式错误' };
    }
    const trimmed = command.trim();
    if (!trimmed) return { safe: false, risk: 'warn', reason: '命令为空' };

    for (const p of DANGEROUS_PATTERNS) {
      if (p.re.test(trimmed)) {
        return { safe: false, risk: p.level, reason: p.reason, matched: p.re.toString() };
      }
    }

    const firstWord = trimmed.split(/\s+/)[0];
    const firstTwo = trimmed.split(/\s+/).slice(0, 2).join(' ');
    if (SAFE_COMMAND_PREFIXES.includes(firstWord) || SAFE_COMMAND_PREFIXES.includes(firstTwo)) {
      return { safe: true, risk: 'safe' };
    }
    return { safe: false, risk: 'warn', reason: '未在白名单中，需要确认' };
  }

  // ============================================================
  // 3. 配置管理
  // ============================================================
  const STORAGE_KEY = 'pty_agent_config_v1';
  const DEFAULT_CONFIG = {
    enabled: false,
    clientId: null,
    wsServerUrl: 'wss://res.dtns.top',
    wsPath: '/tunnel',
    autoStart: false,
    allowDanger: false,
    createdAt: null,
  };

  function genClientId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  const Config = {
    current: { ...DEFAULT_CONFIG },
    listeners: [],

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          this.current = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
        } else {
          this.current = { ...DEFAULT_CONFIG, clientId: genClientId(), createdAt: Date.now() };
          this.save();
        }
      } catch (e) {
        this.current = { ...DEFAULT_CONFIG, clientId: genClientId() };
      }
      return this.current;
    },

    save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current)); } catch (e) {}
    },

    get() { return { ...this.current }; },

    update(patch) {
      this.current = { ...this.current, ...patch };
      this.save();
      this.listeners.forEach(fn => { try { fn(this.get()); } catch (e) {} });
      return this.current;
    },

    reset() {
      this.current = { ...DEFAULT_CONFIG, clientId: genClientId(), createdAt: Date.now() };
      this.save();
      return this.current;
    },

    regenerateClientId() {
      return this.update({ clientId: genClientId() });
    },

    subscribe(fn) {
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter(f => f !== fn); };
    },

    getDomain(clientId) {
      return `ai.pty.${clientId || this.current.clientId}.html.dtns.top`;
    },

    getUrl(clientId) {
      return `http://${this.getDomain(clientId)}`;
    },
  };

  Config.load();

  // ============================================================
  // 4. 路由表
  // ============================================================
  function createRoutes(ctx) {
    const { runtime, hosts, ensureConnected } = ctx;

    // ★ 真实连接状态检测（唯一可信源）
    function isRtConnected(rt) {
      if (!rt || !rt.client) return false;
      // 优先用 client.isConnected()，退化到 client.connected
      if (typeof rt.client.isConnected === 'function') {
        return rt.client.isConnected() === true;
      }
      return rt.client.connected === true;
    }

    function parseParams(method, url, body, headers) {
      const urlObj = new URL(url, 'http://localhost');
      const getParams = {};
      for (const [k, v] of urlObj.searchParams) getParams[k] = v;

      let postParams = {};
      if (body && typeof body === 'string') {
        const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          try { postParams = JSON.parse(body); } catch (e) {}
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          for (const [k, v] of new URLSearchParams(body)) postParams[k] = v;
        }
      } else if (body && typeof body === 'object') {
        postParams = body;
      }
      return { pathname: urlObj.pathname, params: { ...postParams, ...getParams } };
    }

    function json(status, obj) {
      return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
    }

    function resolveRt(hostId) {
      if (hostId) {
        const rt = runtime.get(hostId);
        return isRtConnected(rt) ? rt : null;
      }
      for (const [, rt] of runtime.entries()) {
        if (isRtConnected(rt)) return rt;
      }
      return null;
    }

    function resolveHostId(hostId) {
      if (hostId) return hostId;
      for (const [id, rt] of runtime.entries()) {
        if (isRtConnected(rt)) return id;
      }
      return hosts[0]?.id || null;
    }

    function extractLastCommand(lines) {
      const re = /[\w.-]+@[\w.-]+:[^\$#]*[\$#]\s*(.+)$/;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(re);
        if (m) return m[1].trim();
      }
      return null;
    }
    function extractCwd(lines) {
      const re = /[\w.-]+@[\w.-]+:([^\$#]*)[\$#]/;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(re);
        if (m) return m[1].trim();
      }
      return null;
    }

    const routes = {
      // ============================================================
      // 健康检查 / 元信息
      // ============================================================
      'GET /health': async () => json(200, {
        status: 'ok', service: 'pty-agent', version: '1.0.0',
        clientId: Config.current.clientId, enabled: Config.current.enabled,
        timestamp: new Date().toISOString(),
      }),

      'GET /api/info': async () => {
        // ★ 找到默认 hostId（第一个真实连接的）
        let defaultHostId = null;
        for (const [id, rt] of runtime.entries()) {
          if (isRtConnected(rt)) { defaultHostId = id; break; }
        }
        if (!defaultHostId) defaultHostId = hosts[0]?.id || null;

        return json(200, {
          name: 'PTY Agent Service', version: '1.0.0',
          clientId: Config.current.clientId,
          domain: Config.getDomain(),
          defaultHostId,
          capabilities: [
            'pty_create', 'pty_write', 'pty_read', 'pty_resize', 'pty_destroy', 'pty_list',
            'exec_local', 'exec_ssh',
            'fs_list', 'fs_download', 'fs_upload', 'fs_delete',
            'ai_context', 'security_check',
          ],
          hosts: hosts.map(h => ({ id: h.id, name: h.name, url: h.url })),
          allowDanger: Config.current.allowDanger,
        });
      },

      // ============================================================
      // 主机
      // ============================================================
      'GET /api/hosts/list': async () => json(200, {
        success: true,
        hosts: hosts.map(h => {
          const rt = runtime.get(h.id);
          const realConnected = isRtConnected(rt);
          return {
            id: h.id,
            name: h.name,
            url: h.url,
            inRuntime: !!rt,                     // ★ 区分"没连过"和"连过但断了"
            connected: realConnected,             // ★ 实时状态
            clientConnected: rt?.client?.isConnected?.() === true ||
                             rt?.client?.connected === true,
            terminalCount: rt?.terminals?.size || 0,
          };
        }),
      }),

      'GET /api/hosts/status': async ({ params }) => {
        const hostId = params.hostId;
        if (!hostId) return json(400, { error: 'hostId is required' });
        const host = hosts.find(h => h.id === hostId);
        if (!host) return json(404, { error: 'host not found', hostId });

        const rt = runtime.get(hostId);
        const realConnected = isRtConnected(rt);
        return json(200, {
          success: true, hostId,
          inRuntime: !!rt,
          connected: realConnected,
          clientConnected: rt?.client?.isConnected?.() === true ||
                           rt?.client?.connected === true,
          terminalCount: rt?.terminals?.size || 0,
          activeTermId: rt?.activeTermId || null,
          backends: rt?.backends || [],
          shells: rt?.shells || [],
        });
      },

      // ============================================================
      // 终端/会话
      // ============================================================
      'GET /api/pty/list': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected', hostId });

        try {
            // 从服务端拿
            const serverList = await rt.client.listTerminals();
            // 从本地 runtime 拿 activeTermId
            const activeTermId = rt.activeTermId;

            const terminals = serverList.map(t => ({
            ...t,
            active: t.termId === activeTermId,     // ★ 加 active 标志
            inUI: rt.terminals.has(t.termId),       // ★ 是否在当前页面有 tab
            }));

            return json(200, {
            success: true,
            hostId,
            activeTermId,                            // ★ 全局也返回
            terminals,
            });
        } catch (e) {
            // 退化：从本地拿
            const list = Array.from(rt.terminals.values()).map(o => ({
            termId: o.termId,
            backend: o.backend || 'local',
            exited: o.exited || false,
            active: o.termId === rt.activeTermId,
            }));
            return json(200, {
            success: true,
            hostId,
            activeTermId: rt.activeTermId,
            terminals: list,
            fromLocal: true,
            });
        }
        },

      'POST /api/pty/create': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        let rt = runtime.get(hostId);
        if (!rt) return json(404, { error: 'host not found', hostId });
        if (!isRtConnected(rt)) {
          try { rt = await ensureConnected(hostId); }
          catch (e) { return json(503, { error: 'failed to connect: ' + e.message, hostId }); }
        }
        const backend = params.backend || 'local';
        const shellId = params.shellId || null;
        const cols = parseInt(params.cols) || 80;
        const rows = parseInt(params.rows) || 24;
        const opts = { cols, rows, backend };
        if (backend === 'local') opts.shellId = shellId;
        else opts.remoteShell = shellId;
        try {
          const term = await rt.client.createTerminal(opts);
          return json(200, { success: true, hostId, termId: term.termId, backend, shellId, cols, rows });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      'POST /api/pty/destroy': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(404, { error: 'host not found' });
        const termId = params.termId;
        if (!termId) return json(400, { error: 'termId is required' });
        try {
          await rt.client.destroy(termId);
          const obj = rt.terminals.get(termId);
          if (obj) {
            obj.disposers?.forEach(fn => { try { fn(); } catch (e) {} });
            try { obj.xterm?.dispose(); } catch (e) {}
            obj.paneEl?.remove();
            rt.terminals.delete(termId);
          }
          return json(200, { success: true, termId });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      // ============================================================
      // PTY IO
      // ============================================================
      'POST /api/pty/write': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        const { termId, data, dataBase64 } = params;
        if (!termId) return json(400, { error: 'termId is required' });
        let text;
        if (dataBase64) text = Base64.decode(dataBase64);
        else if (data !== undefined) text = String(data);
        else return json(400, { error: 'data or dataBase64 is required' });
        try {
          await rt.client.write(termId, text);
          return json(200, { success: true, termId, bytesWritten: text.length });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      'GET /api/pty/read': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        const termId = params.termId;
        if (!termId) return json(400, { error: 'termId is required' });
        const lines = parseInt(params.lines) || 50;
        const obj = rt.terminals.get(termId);
        if (!obj || !obj.xterm) {
          return json(404, {
            error: 'term not bound to xterm in this host',
            termId,
            hint: 'Agent 场景推荐直接用 /api/exec',
          });
        }
        const buf = obj.xterm.buffer.active;
        const start = Math.max(0, buf.length - lines);
        const out = [];
        for (let i = start; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) || '');
        return json(200, {
          success: true, termId, seq: Date.now(),
          lines: out, dataBase64: Base64.encode(out.join('\n')),
        });
      },

      'POST /api/pty/resize': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(404, { error: 'host not found' });
        const { termId, cols, rows } = params;
        if (!termId) return json(400, { error: 'termId is required' });
        const obj = rt.terminals.get(termId);
        if (!obj) return json(404, { error: 'term not found' });
        try {
          await obj.term.resize(parseInt(cols) || 80, parseInt(rows) || 24);
          try { obj.fitAddon?.fit(); } catch (e) {}
          return json(200, { success: true, termId, cols: parseInt(cols) || 80, rows: parseInt(rows) || 24 });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      // ============================================================
      // 命令执行（Agent 最常用）
      // ============================================================
      'POST /api/exec': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected', hostId });
        const { command, useSsh, timeout, confirm } = params;
        if (!command) return json(400, { error: 'command is required' });

        const safety = checkCommandSafety(command);
        const allowDanger = Config.current.allowDanger === true;
        const userConfirm = confirm === true || confirm === 'true';

        if (safety.risk === 'danger' && !allowDanger && !userConfirm) {
          return json(403, {
            success: false, error: '危险命令，默认禁止',
            reason: safety.reason, risk: safety.risk, needConfirm: true,
            hint: '设置 allowDanger=true 或传入 confirm=true 以强制执行',
          });
        }
        if (safety.risk === 'warn' && !userConfirm) {
          return json(403, {
            success: false, error: '命令需要确认',
            reason: safety.reason, risk: safety.risk, needConfirm: true,
          });
        }

        const useSshBool = useSsh === true || useSsh === 'true';
        const timeoutMs = parseInt(timeout) || 60000;
        try {
          const startTime = Date.now();
          const r = await rt.client.exec(command, { useSsh: useSshBool, timeout: timeoutMs });
          return json(200, {
            success: true,
            stdout: r.stdout || '', stderr: r.stderr || '',
            exitCode: r.exitCode, duration: Date.now() - startTime,
            command, useSsh: useSshBool, risk: safety.risk,
          });
        } catch (e) {
          return json(500, { success: false, error: e.message, command });
        }
      },

      // ============================================================
      // 文件
      // ============================================================
      'GET /api/fs/list': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        try {
          const files = await rt.client.listFiles();
          return json(200, { success: true, hostId, files });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      'GET /api/fs/download': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        const name = params.name;
        if (!name) return json(400, { error: 'name is required' });
        try {
          // 优先用 downloadFileToBytes（不触发浏览器下载）
          let bytes;
          if (typeof rt.client.downloadFileToBytes === 'function') {
            bytes = await rt.client.downloadFileToBytes(name);
          } else {
            return json(501, {
              error: 'downloadFileToBytes 未实现，请升级 PtyClient',
              name,
            });
          }
          const b64 = Base64.encodeBytes(bytes);
          return json(200, {
            success: true,
            hostId,
            name,
            size: bytes.length,
            dataBase64: b64,
          });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      'POST /api/fs/upload': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        const { name, rel, dataBase64 } = params;
        if (!name || !dataBase64) return json(400, { error: 'name and dataBase64 are required' });
        try {
          const bytes = Base64.decodeToBytes(dataBase64);
          const file = new File([bytes], name);
          await rt.client.uploadFile(file, { name, rel: rel || name });
          return json(200, { success: true, name, rel: rel || name, size: bytes.length });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      'POST /api/fs/delete': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(503, { error: 'host not connected' });
        const name = params.name;
        if (!name) return json(400, { error: 'name is required' });
        try {
          await rt.client.deleteFile(name);
          return json(200, { success: true, name });
        } catch (e) {
          return json(500, { success: false, error: e.message });
        }
      },

      // ============================================================
      // AI 上下文
      // ============================================================
      'GET /api/ai/context': async ({ params }) => {
        const hostId = resolveHostId(params.hostId);
        const rt = resolveRt(hostId);
        if (!rt) return json(404, { error: 'host not found' });
        const lines = parseInt(params.lines) || 50;
        const termId = params.termId || rt.activeTermId;
        if (!termId) return json(404, { error: 'no active term' });
        const obj = rt.terminals.get(termId);
        if (!obj || !obj.xterm) return json(404, { error: 'term not bound to xterm' });
        const buf = obj.xterm.buffer.active;
        const start = Math.max(0, buf.length - lines);
        const out = [];
        for (let i = start; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) || '');
        return json(200, {
          success: true, hostId, termId,
          recentOutput: out.join('\n'),
          lines: out.length,
          lastCommand: extractLastCommand(out),
          cwd: extractCwd(out),
          exitCode: null,
        });
      },

      // ============================================================
      // 安全
      // ============================================================
      'GET /api/security/check': async ({ params }) => {
        const command = params.command;
        if (!command) return json(400, { error: 'command is required' });
        return json(200, { success: true, command, ...checkCommandSafety(command) });
      },

      'POST /api/security/check': async ({ params }) => {
        const command = params.command;
        if (!command) return json(400, { error: 'command is required' });
        return json(200, { success: true, command, ...checkCommandSafety(command) });
      },
    };

    async function handle(request) {
      const { method, url, headers, body } = request;

      // OPTIONS 预检
      if (method === 'OPTIONS') {
        return {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Request-ID',
            'Access-Control-Max-Age': '86400',
          },
          body: '',
        };
      }

      const { pathname, params } = parseParams(method, url, body, headers);

      // ★ 路由查找：精确匹配优先，然后双向兜底
      // 让每个 API 同时支持 GET 和 POST
      let handler = routes[`${method} ${pathname}`];

      if (!handler) {
        // 退化到另一方法（GET ↔ POST）
        const otherMethod = method === 'GET' ? 'POST' : 'GET';
        handler = routes[`${otherMethod} ${pathname}`];
      }

      if (!handler) {
        // 最后兜底：忽略 method，按 path 匹配
        for (const key of Object.keys(routes)) {
          const spaceIdx = key.indexOf(' ');
          if (spaceIdx > 0 && key.slice(spaceIdx + 1) === pathname) {
            handler = routes[key];
            break;
          }
        }
      }

      if (!handler) {
        return json(404, {
          error: `Route not found: ${method} ${pathname}`,
          availableRoutes: Object.keys(routes),
        });
      }

      try {
        return await handler({ params, pathname, method, url, headers, body });
      } catch (e) {
        console.error('[PtyAgent] handler error:', e);
        return json(500, { success: false, error: e.message });
      }
    }

    return { handle, routes, listRoutes: () => Object.keys(routes) };
  }

  // ============================================================
  // 5. WebSocket 隧道
  // ============================================================
  class Tunnel {
    constructor(options = {}) {
      this.onRequest = options.onRequest || (async () => ({
        status: 404, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'no handler' }),
      }));
      this.ws = null;
      this.clientId = null;
      this.connected = false;
      this.registered = false;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 30;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      this.registeredDomains = new Set();
      this.stats = { requestsTotal: 0, requestsOk: 0, requestsError: 0, lastRequestAt: null, connectedAt: null };
      this.listeners = [];
    }

    on(event, fn) { this.listeners.push({ event, fn }); }
    emit(event, data) {
      this.listeners.filter(l => l.event === event).forEach(l => {
        try { l.fn(data); } catch (e) { console.warn(e); }
      });
    }

    async start() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      const config = Config.get();
      this.clientId = config.clientId;
      const url = `${config.wsServerUrl}${config.wsPath}?clientId=${this.clientId}`;
      console.log('[PtyAgent] connecting:', url);
      this.emit('connecting', { url });

      try { this.ws = new WebSocket(url); }
      catch (e) { this.emit('error', { error: e.message }); this._scheduleReconnect(); return; }

      this.ws.onopen = () => {
        console.log('[PtyAgent] connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.stats.connectedAt = Date.now();
        this._startHeartbeat();
        this._registerTunnel();
        this.emit('connected', { clientId: this.clientId });
      };
      this.ws.onmessage = (event) => this._handleMessage(event.data);
      this.ws.onclose = () => {
        console.log('[PtyAgent] closed');
        this.connected = false; this.registered = false;
        this._stopHeartbeat();
        this.emit('disconnected', {});
        this._scheduleReconnect();
      };
      this.ws.onerror = (e) => {
        console.warn('[PtyAgent] error:', e);
        this.emit('error', { error: 'websocket error' });
      };
    }

    stop() {
      this._stopHeartbeat();
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      if (this.ws) {
        this.ws.onopen = null; this.ws.onmessage = null;
        this.ws.onclose = null; this.ws.onerror = null;
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }
      this.connected = false; this.registered = false;
      this.registeredDomains.clear();
      this.emit('stopped', {});
    }

    _registerTunnel() {
      const domain = Config.getDomain(this.clientId);
      console.log('[PtyAgent] registering:', domain);
      this._send({
        type: 'register_tunnel',
        clientId: this.clientId,
        tunnel: {
          id: 'pty-agent-' + this.clientId,
          domain,
          localPort: 10998,
          localHost: 'pty-agent',
          protocol: 'http',
          description: 'PTY Agent - HTTP API',
          features: ['pty_create', 'pty_write', 'pty_read', 'exec_local', 'exec_ssh', 'fs_upload', 'fs_download', 'ai_context'],
        },
      });
    }

    _send(message) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
        return true;
      }
      return false;
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this._send({ type: 'heartbeat', clientId: this.clientId, timestamp: new Date().toISOString() });
      }, 30000);
    }
    _stopHeartbeat() {
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    _scheduleReconnect() {
      if (this.reconnectTimer) return;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.emit('reconnect_failed', {});
        return;
      }
      this.reconnectAttempts++;
      const delay = Math.min(5000 * this.reconnectAttempts, 60000);
      this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.start(); }, delay);
    }

    async _handleMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch (e) { return; }

      switch (message.type) {
        case 'welcome': this._registerTunnel(); break;
        case 'registered':
          this.registered = true;
          this.registeredDomains.add(message.domain);
          this.emit('registered', { domain: message.domain });
          break;
        case 'register_failed':
          this.emit('register_failed', { error: message.error, domain: message.domain });
          break;
        case 'http_request':
          this._handleHttpRequest(message);
          break;
        case 'heartbeat':
          this._send({ type: 'heartbeat_ack', clientId: this.clientId, timestamp: new Date().toISOString() });
          break;
        default: break;
      }
    }

    async _handleHttpRequest(message) {
      const { requestId, domain, method, url, headers, body } = message;
      this.stats.requestsTotal++;
      this.stats.lastRequestAt = Date.now();
      const startTime = Date.now();

      let response;
      try {
        let parsedBody = null;
        if (body) {
          try { parsedBody = Base64.decode(body); } catch (e) { parsedBody = body; }
        }
        response = await this.onRequest({
          requestId, domain, method, url,
          headers: headers || {}, body: parsedBody, rawBody: body,
        });
        response = this._applyCors(response);
        this.stats.requestsOk++;
      } catch (e) {
        console.error('[PtyAgent] handler error:', e);
        this.stats.requestsError++;
        response = this._applyCors({
          status: 500, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: e.message }),
        });
      }

      const duration = Date.now() - startTime;
      this._send({
        type: 'http_response', requestId, domain,
        status: response.status || 200,
        headers: { ...(response.headers || {}), 'X-Pty-Agent-Duration': String(duration) },
        body: response.body ? Base64.encode(String(response.body)) : null,
      });
      this.emit('request', { method, url, status: response.status || 200, duration });
    }

    _applyCors(response) {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Request-ID',
        'Access-Control-Expose-Headers': 'X-Pty-Agent-Duration',
        'Access-Control-Max-Age': '86400',
      };
      return { ...response, headers: { ...(response.headers || {}), ...cors } };
    }

    getStatus() {
      return {
        connected: this.connected, registered: this.registered,
        clientId: this.clientId,
        domain: Config.getDomain(this.clientId),
        url: Config.getUrl(this.clientId),
        registeredDomains: Array.from(this.registeredDomains),
        stats: { ...this.stats },
      };
    }
  }

  // ============================================================
  // 6. 核心
  // ============================================================
  class Core {
    constructor(hostCtx) {
      this.hostCtx = hostCtx;
      this.tunnel = null;
      this.routeHandler = null;
      this.started = false;
      this.listeners = [];
      this.routes = createRoutes(hostCtx);
    }

    on(event, fn) { this.listeners.push({ event, fn }); }
    emit(event, data) {
      this.listeners.filter(l => l.event === event).forEach(l => {
        try { l.fn(data); } catch (e) { console.warn(e); }
      });
    }

    async start() {
      if (this.started) return;
      Config.update({ enabled: true });

      this.routeHandler = this.routes.handle;
      this.tunnel = new Tunnel({ onRequest: (req) => this.routeHandler(req) });

      ['connecting', 'connected', 'registered', 'register_failed', 'disconnected', 'reconnecting', 'error', 'request']
        .forEach(ev => this.tunnel.on(ev, (d) => this.emit(ev, d)));

      await this.tunnel.start();
      this.started = true;
      console.log('[PtyAgent] ✅ started:', Config.getUrl());
      this.emit('started', { url: Config.getUrl(), domain: Config.getDomain() });
    }

    stop() {
      if (this.tunnel) { this.tunnel.stop(); this.tunnel = null; }
      Config.update({ enabled: false });
      this.started = false;
      this.emit('stopped', {});
    }

    async restart() {
      this.stop();
      await new Promise(r => setTimeout(r, 500));
      await this.start();
    }

    getStatus() {
      const config = Config.get();
      const t = this.tunnel ? this.tunnel.getStatus() : {
        connected: false, registered: false,
        clientId: config.clientId,
        domain: Config.getDomain(config.clientId),
        url: Config.getUrl(config.clientId),
        registeredDomains: [], stats: {},
      };
      return {
        started: this.started, enabled: config.enabled,
        clientId: config.clientId,
        domain: t.domain, url: t.url,
        connected: t.connected, registered: t.registered,
        stats: t.stats, allowDanger: config.allowDanger,
      };
    }

    listRoutes() { return this.routes.listRoutes(); }
  }

  // ============================================================
  // 7. UI
  // ============================================================
  class UI {
    constructor(core) {
      this.core = core;
      this.panelEl = null;
      this.logEl = null;
      this.logLines = [];
      this._bind();
    }

    _bind() {
      this.core.on('started', (d) => { this._log(`✅ 已启动: ${d.url}`, 'success'); this._refresh(); });
      this.core.on('stopped', () => { this._log('⏹️ 已停止', 'info'); this._refresh(); });
      this.core.on('connecting', () => this._refresh());
      this.core.on('connected', (d) => { this._log(`🔌 已连接 (${d.clientId})`, 'info'); this._refresh(); });
      this.core.on('registered', (d) => { this._log(`🌐 域名注册成功: ${d.domain}`, 'success'); this._refresh(); });
      this.core.on('register_failed', (d) => { this._log(`❌ 注册失败: ${d.error}`, 'error'); this._refresh(); });
      this.core.on('disconnected', () => { this._log('⚠️ 断开，重连中...', 'warn'); this._refresh(); });
      this.core.on('reconnecting', (d) => this._log(`🔄 重连中 (${d.attempt})...`, 'warn'));
      this.core.on('error', (d) => this._log(`❌ ${d.error}`, 'error'));
      this.core.on('request', (d) => {
        this._log(`→ ${d.method} ${d.url} [${d.status}] ${d.duration}ms`, d.status < 400 ? 'info' : 'error');
      });
    }

    mount() {
      const toolbar = document.getElementById('toolbar');
      if (!toolbar) { console.warn('[PtyAgent] #toolbar not found'); return; }

      const btn = document.createElement('button');
      btn.id = 'btnPtyAgent';
      btn.textContent = '🤖 Agent 代理';
      btn.title = '开启 HTTP-Proxy，让 AI-Agent 通过 HTTP 控制 PTY';
      btn.style.background = '#8e44ad';
      btn.style.color = '#fff';
      btn.onclick = () => this.show();
      toolbar.appendChild(btn);

      const panel = document.createElement('div');
      panel.id = 'ptyAgentPanel';
      panel.style.cssText = `
        display:none; position:fixed; right:12px; top:60px;
        width:520px; max-height:85vh; overflow:auto;
        background:#252526; border:1px solid #444;
        border-radius:8px; padding:14px;
        z-index:70; box-shadow:0 8px 32px rgba(0,0,0,0.6);
        font-family:Arial,sans-serif; font-size:13px; color:#eee;
      `;
      panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid #333; padding-bottom:8px;">
          <b style="font-size:15px;">🤖 PTY Agent HTTP-Proxy</b>
          <button id="paClose" style="padding:2px 10px;">×</button>
        </div>

        <div id="paStatus" style="background:#1e1e1e; padding:10px; border-radius:6px; margin-bottom:10px; font-size:12px; line-height:1.7;"></div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">Client ID</label>
          <div style="display:flex; gap:6px;">
            <input id="paClientId" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="paCopyId" style="padding:6px 10px;">📋</button>
            <button id="paRegenId" style="padding:6px 10px; background:#e67e22;">🔄</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">Agent URL</label>
          <div style="display:flex; gap:6px;">
            <input id="paUrl" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#8f8; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="paCopyUrl" style="padding:6px 10px;">📋</button>
            <button id="paOpenUrl" style="padding:6px 10px;">🔗</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="paAllowDanger" type="checkbox">
            允许 danger 级命令（rm -rf / dd / mkfs）—— 默认关闭
          </label>
        </div>

        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <button id="paStart" style="flex:1; padding:10px; background:#27ae60; color:#fff; font-size:14px; font-weight:bold;">▶️ 启动 HTTP-Proxy</button>
          <button id="paStop" style="flex:1; padding:10px; background:#c0392b; color:#fff; font-size:14px; font-weight:bold; display:none;">⏹️ 停止</button>
        </div>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">📚 可用 API 路由</summary>
          <div id="paRoutes" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:200px; overflow:auto; line-height:1.6;"></div>
        </details>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">🧪 curl 测试示例</summary>
          <div id="paCurl" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:220px; overflow:auto; line-height:1.6; white-space:pre-wrap; word-break:break-all;"></div>
        </details>

        <div style="margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
          <b style="color:#a5b4fc;">📋 日志</b>
          <button id="paClearLog" style="padding:2px 8px; font-size:11px;">清空</button>
        </div>
        <div id="paLog" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:200px; overflow:auto; line-height:1.6;"></div>
      `;
      document.body.appendChild(panel);

      this.panelEl = panel;
      this.logEl = document.getElementById('paLog');

      const $ = id => document.getElementById(id);
      $('paClose').onclick = () => this.hide();
      $('paStart').onclick = () => this._onStart();
      $('paStop').onclick = () => this.core.stop();
      $('paCopyId').onclick = () => this._copy(Config.current.clientId);
      $('paCopyUrl').onclick = () => this._copy(Config.getUrl());
      $('paOpenUrl').onclick = () => window.open(Config.getUrl() + '/api/info', '_blank');
      $('paRegenId').onclick = () => this._onRegenId();
      $('paClearLog').onclick = () => { this.logLines = []; this._renderLog(); };
      $('paAllowDanger').onchange = (e) => {
        Config.update({ allowDanger: e.target.checked });
        this._log(`allowDanger = ${e.target.checked}`, 'warn');
      };

      this._refresh();
      this._renderRoutes();
      this._renderCurl();
    }

    show() { this.panelEl.style.display = 'block'; this._refresh(); }
    hide() { this.panelEl.style.display = 'none'; }

    async _onStart() {
      try { this._log('启动中...', 'info'); await this.core.start(); }
      catch (e) { this._log('启动失败: ' + e.message, 'error'); }
    }

    async _onRegenId() {
      if (!confirm('重置 Client ID 会导致域名变化，Agent 需要重新配置。继续？')) return;
      Config.regenerateClientId();
      this._log('Client ID 已重置', 'warn');
      this._refresh();
      if (this.core.started) await this.core.restart();
    }

    async _copy(text) {
      try { await navigator.clipboard.writeText(text); this._log('已复制: ' + text, 'success'); }
      catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        this._log('已复制: ' + text, 'success');
      }
    }

    _refresh() {
      const status = this.core.getStatus();
      const config = Config.get();
      const $ = id => document.getElementById(id);

      $('paStart').style.display = status.started ? 'none' : 'block';
      $('paStop').style.display = status.started ? 'block' : 'none';
      $('paClientId').value = status.clientId || '';
      $('paUrl').value = status.url || '';
      $('paAllowDanger').checked = config.allowDanger === true;

      const dot = (ok) => ok ? '🟢' : '🔴';
      $('paStatus').innerHTML = `
        <div>${dot(status.started)} 服务: <b>${status.started ? '已启动' : '未启动'}</b></div>
        <div>${dot(status.connected)} 隧道: <b>${status.connected ? '已连接' : '未连接'}</b></div>
        <div>${dot(status.registered)} 域名: <b>${status.registered ? '已注册' : '未注册'}</b></div>
        <div>📊 请求: ${status.stats?.requestsTotal || 0} 次（成功 ${status.stats?.requestsOk || 0} / 失败 ${status.stats?.requestsError || 0}）</div>
        ${status.stats?.lastRequestAt ? `<div>🕐 最后请求: ${new Date(status.stats.lastRequestAt).toLocaleTimeString()}</div>` : ''}
      `;
    }

    _renderRoutes() {
      const el = document.getElementById('paRoutes');
      const routes = this.core.listRoutes();
      el.innerHTML = routes.map(r => {
        const [method, path] = r.split(' ');
        const color = method === 'GET' ? '#6ee7b7' : '#fbbf24';
        return `<div><span style="color:${color}; font-weight:bold;">ALL</span> ${path}</div>`;
      }).join('');
    }

    _renderCurl() {
      const url = Config.getUrl();
      document.getElementById('paCurl').textContent = [
        `# 1. 健康检查`,
        `curl ${url}/health`,
        ``,
        `# 2. 查看能力`,
        `curl ${url}/api/info`,
        ``,
        `# 3. 执行命令（最常用）`,
        `curl -X POST ${url}/api/exec \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"command": "uname -a && whoami"}'`,
        ``,
        `# 4. 安全检查`,
        `curl -G ${url}/api/security/check \\`,
        `  --data-urlencode "command=rm -rf /"`,
        ``,
        `# 5. 列出文件`,
        `curl ${url}/api/fs/list`,
        ``,
        `# 6. AI 上下文`,
        `curl "${url}/api/ai/context?lines=30"`,
      ].join('\n');
    }

    _log(msg, type = 'info') {
      this.logLines.unshift({ time: new Date().toLocaleTimeString(), msg, type });
      if (this.logLines.length > 100) this.logLines.pop();
      this._renderLog();
    }

    _renderLog() {
      if (!this.logEl) return;
      const colorMap = { info: '#93c5fd', success: '#6ee7b7', warn: '#fbbf24', error: '#f87171' };
      this.logEl.innerHTML = this.logLines.map(l => {
        const color = colorMap[l.type] || '#ccc';
        return `<div style="color:${color};"><span style="color:#666;">[${l.time}]</span> ${this._escape(l.msg)}</div>`;
      }).join('');
    }

    _escape(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }
  }

  // ============================================================
  // 8. 对外入口
  // ============================================================
  class PtyAgent {
    constructor(hostCtx) {
      this.core = new Core(hostCtx);
      this.ui = new UI(this.core);
      this.config = Config;
    }

    mount() { this.ui.mount(); }
    start() { return this.core.start(); }
    stop() { this.core.stop(); }
    restart() { return this.core.restart(); }
    getStatus() { return this.core.getStatus(); }
    listRoutes() { return this.core.listRoutes(); }
    on(event, fn) { this.core.on(event, fn); }
  }

  global.PtyAgent = PtyAgent;
  global.PtyAgentBase64 = Base64;
  global.PtyAgentSecurity = { checkCommandSafety, DANGEROUS_PATTERNS, SAFE_COMMAND_PREFIXES };
  global.PtyAgentConfig = Config;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PtyAgent;
  }
})(typeof self !== 'undefined' ? self : this);