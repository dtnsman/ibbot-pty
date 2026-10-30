// pty2-agent.js
// PTY Agent v2 —— 基于 DTNSAgent (sdk.js) 的 HTTP-Proxy Agent 单文件实现
//
// 与 v1 (pty-agent.js) 的区别：
//   - 不再手写 DTNS 隧道协议（JSON 帧、注册、心跳、重连），全部交给 sdk.js；
//   - 使用 new DTNSAgent.app({...}) + app.get/post/all/ws 的 Express 风格路由；
//   - 域名前缀改为 ai.pty2.<clientId>.html.dtns.top；
//   - 旧版 localStorage key（pty_agent_config_v1）保持不变之外另起 pty2_agent_config_v1，
//     两个版本可以同时打开、互不影响。
//
// 依赖（顺序很重要）：
//   <script src="./js/sdk.js"></script>        <!-- window.DTNSAgent -->
//   <script src="./js/pty2-agent.js"></script>  <!-- window.Pty2Agent -->
//   宿主提供 runtime / hosts / ensureConnected / getActiveRt / closeTerm ...
//
// 用法：
//   const agent = new Pty2Agent({ runtime, hosts, ensureConnected, getActiveRt, ... });
//   agent.mount();
//   await agent.start();
//   window.__pty2Agent = agent;
(function () {
  'use strict';

  var ROOT = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof self !== 'undefined' ? self : this);

  var SDK = ROOT.DTNSAgent || null;
  var SDK_VERSION = (SDK && SDK.version) || '2.0.0';

  var SERVICE_NAME = 'pty-agent';
  var SERVICE_VERSION = '2.2.1';

  var DEFAULT_WS_URL = 'wss://res2.dtns.top/tunnel';
  var DOMAIN_PREFIX = 'ai.pty2';
  var DOMAIN_SUFFIX = '.html.dtns.top';

  var STORAGE_KEY = 'pty2_agent_config_v1';

  // 与 DTNS 入口默认的 32MB 请求体上限保持一致
  var MAX_BODY_SIZE = 32 * 1024 * 1024;

  // 每个 Agent 终端的输出回放缓冲（字符）
  var TERM_BUFFER_LIMIT = 256 * 1024;

  var HOST_HINT = '请先在页面中选择设备并连接（点击「新建终端」会自动连接），或先调用 /api/pty/create';

  // ============================================================
  // 1. Base64 工具（二进制安全）
  // ============================================================
  var Base64 = {
    encode: function (str) {
      try {
        return Base64.encodeBytes(new TextEncoder().encode(String(str)));
      } catch (e) {
        try { return btoa(String(str)); } catch (e2) { return ''; }
      }
    },
    decode: function (b64) {
      try {
        var bytes = Base64.decodeToBytes(b64);
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        try { return atob(String(b64)); } catch (e2) { return ''; }
      }
    },
    encodeBytes: function (bytes) {
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    },
    decodeToBytes: function (b64) {
      var binary = atob(String(b64));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  };

  // ============================================================
  // 2. 安全网关（与 v1 规则保持一致）
  // ============================================================
  var DANGEROUS_PATTERNS = [
    { re: /rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, level: 'danger', reason: 'rm 删除根目录' },
    { re: /dd\s+[^|;]*of=\/dev\/(sd|hd|nvme|vd|xvd)/, level: 'danger', reason: 'dd 直接写块设备' },
    { re: /\bmkfs(\.\w+)?\b/, level: 'danger', reason: '格式化文件系统' },
    { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, level: 'danger', reason: 'fork bomb' },
    { re: />\s*\/dev\/(sd|hd|nvme|vd|xvd)/, level: 'danger', reason: '重定向到块设备' },
    { re: /chmod\s+(-R\s+)?777\s+\/(\s|$)/, level: 'danger', reason: 'chmod 777 根目录' },
    { re: /curl\s+[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)/, level: 'danger', reason: 'curl 直接管道到 shell' },
    { re: /wget\s+[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)/, level: 'danger', reason: 'wget 直接管道到 shell' },
    { re: /\bsudo\s+rm\b/, level: 'warn', reason: 'sudo rm 需要确认' },
    { re: /\brm\b[^|;]*\s-[a-zA-Z]*r[a-zA-Z]*f|\brm\b[^|;]*\s-[a-zA-Z]*f[a-zA-Z]*r/, level: 'warn', reason: 'rm -rf 会递归强制删除' },
    { re: /\brm\b[^|;]*\s-[a-zA-Z]*r/, level: 'warn', reason: 'rm -r 会递归删除目录' },
    { re: /\b(shutdown|reboot|halt|poweroff)\b/, level: 'warn', reason: '关机/重启命令' },
    { re: />\s*\/(etc|boot|sys|proc)\//, level: 'warn', reason: '写入系统关键目录' },
    { re: /\bcrontab\s+-r\b/, level: 'warn', reason: '清空 crontab' },
    { re: /\b(userdel|groupdel)\b/, level: 'warn', reason: '删除用户/组' },
    { re: /[;&|]\s*(sudo\s+)?(rm|dd|mkfs|shutdown|reboot)\b/, level: 'warn', reason: '组合命令含危险操作' },
    { re: /\$\([^)]*\)|`[^`]*`/, level: 'warn', reason: '含命令替换，可能隐藏危险操作' },
    { re: /(^|[^>])>\s*[^>|&\s]/, level: 'warn', reason: '重定向会覆盖文件' }
  ];

  var SAFE_COMMAND_PREFIXES = [
    // ===== 文件读取 =====
    'ls', 'cat', 'head', 'tail', 'tac', 'grep', 'find', 'file', 'stat',
    'wc', 'sort', 'uniq', 'cut', 'awk', 'sed', 'tr', 'tee',
    'readlink', 'realpath', 'basename', 'dirname', 'du', 'df',
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
    'curl', 'wget',
    'nc -z', 'nc -vz', 'telnet',
    'nmap -sT', 'nmap -sV',
    'tcpdump -c', 'tcpdump -n',
    'mtr', 'mtr --report',

    // ===== 进程 / 服务 =====
    'systemctl status', 'systemctl list-units', 'systemctl list-unit-files',
    'systemctl is-active', 'systemctl is-enabled', 'systemctl show',
    'service --status-all',
    'journalctl', 'dmesg',
    'lsof', 'fuser',
    'crontab -l',
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
    'make -n',
    'php -v',

    // ===== 文本处理（管道常用） =====
    'xargs -n', 'xargs -I'
  ];

  var SAFE_SUDO_PREFIXES = [
    'systemctl status', 'systemctl is-active', 'systemctl is-enabled',
    'systemctl list-units', 'journalctl', 'dmesg',
    'docker ps', 'docker images', 'docker logs', 'docker inspect',
    'kubectl get', 'kubectl describe', 'kubectl logs',
    'iptables -L', 'iptables-save', 'nft list',
    'lsof', 'ss', 'netstat',
    'cat /var/log', 'tail /var/log', 'head /var/log', 'grep /var/log'
  ];

  function checkCommandSafety(command) {
    if (!command || typeof command !== 'string') {
      return { safe: false, risk: 'warn', reason: '命令为空或格式错误' };
    }
    var trimmed = command.trim();
    if (!trimmed) return { safe: false, risk: 'warn', reason: '命令为空' };

    for (var i = 0; i < DANGEROUS_PATTERNS.length; i++) {
      var p = DANGEROUS_PATTERNS[i];
      if (p.re.test(trimmed)) {
        return { safe: false, risk: p.level, reason: p.reason, matched: p.re.toString() };
      }
    }

    var parts = trimmed.split(/\s+/);
    var firstWord = parts[0];
    var firstTwo = parts.slice(0, 2).join(' ');
    if (SAFE_COMMAND_PREFIXES.indexOf(firstWord) !== -1 ||
        SAFE_COMMAND_PREFIXES.indexOf(firstTwo) !== -1) {
      return { safe: true, risk: 'safe' };
    }
    return { safe: false, risk: 'warn', reason: '未在白名单中，需要确认' };
  }

  // ============================================================
  // 3. 配置管理（独立 localStorage key，避免与 v1 冲突）
  // ============================================================
  var DEFAULT_CONFIG = {
    enabled: false,
    autoStart: false,
    clientId: null,
    allowDanger: false,
    wsUrl: DEFAULT_WS_URL,
    createdAt: null,
    // ---- MCP ----
    mcpEnabled: true,
    mcpAllowWarn: true,
    mcpAllowDanger: false,
    mcpRequireApproval: false,
    mcpReadOnly: false,
    mcpApprovalTimeoutMs: 60000,
    mcpMaxConcurrent: 4,
    mcpRateLimitPerMin: 240,
    mcpToken: '',
    mcpAllowedOrigins: ['*'],
    mcpDisabledTools: [],
    mcpStrictHeaders: true,
    mcpRequireClientCapabilities: false,
    // ---- OpenAI 兼容接口（/v1/*） ----
    openaiEnabled: false,
    openaiApiKey: '',
    openaiMode: 'exec',
    openaiReadOnly: true,
    openaiAllowWarn: true,
    openaiAllowDanger: false,
    openaiRequireApproval: false,
    openaiApprovalTimeoutMs: 60000,
    openaiDisableTools: false,
    openaiSystemPrompt: '',
    openaiMaxSteps: 6,
    openaiMaxConcurrent: 2,
    openaiRateLimitPerMin: 60,
    openaiToolResultLimit: 16000,
    openaiProxyTimeoutMs: 120000,
    openaiAgentTimeoutMs: 180000,
    openaiSessionTimeoutMs: 30000,
    openaiTrace: false,
    openaiUpstreamBase: '',
    openaiUpstreamKey: '',
    openaiUpstreamModel: ''
  };

  function genClientId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 20; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  function isValidClientId(id) {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,39}$/.test(id);
  }

  // 生成 sk-pty-xxxx 形式的 API Key（优先用 crypto，退化到 Math.random）
  function genApiKey() {
    var hex = '';
    try {
      if (ROOT.crypto && typeof ROOT.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(18);
        ROOT.crypto.getRandomValues(bytes);
        hex = Array.prototype.map.call(bytes, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      }
    } catch (e) { hex = ''; }
    if (!hex) {
      hex = '';
      for (var i = 0; i < 6; i++) hex += Math.random().toString(36).slice(2, 8);
    }
    return 'sk-pty-' + hex.slice(0, 36);
  }

  var Config = {
    current: Object.assign({}, DEFAULT_CONFIG),
    listeners: [],

    load: function () {
      var raw = null;
      try {
        raw = ROOT.localStorage ? ROOT.localStorage.getItem(STORAGE_KEY) : null;
      } catch (e) { raw = null; }

      var stored = null;
      if (raw) {
        try { stored = JSON.parse(raw); } catch (e) { stored = null; }
      }

      this.current = Object.assign({}, DEFAULT_CONFIG, (stored && typeof stored === 'object') ? stored : {});

      if (!isValidClientId(this.current.clientId)) {
        this.current.clientId = genClientId();
        this.current.createdAt = Date.now();
        this.save();
      }
      return this.current;
    },

    save: function () {
      try {
        if (ROOT.localStorage) {
          ROOT.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
        }
      } catch (e) { /* localStorage 不可用时静默 */ }
    },

    get: function () { return Object.assign({}, this.current); },

    update: function (patch) {
      this.current = Object.assign({}, this.current, patch || {});
      this.save();
      for (var i = 0; i < this.listeners.length; i++) {
        try { this.listeners[i](this.get()); } catch (e) { /* ignore */ }
      }
      return this.current;
    },

    reset: function () {
      this.current = Object.assign({}, DEFAULT_CONFIG, {
        clientId: genClientId(),
        createdAt: Date.now()
      });
      this.save();
      return this.current;
    },

    regenerateClientId: function () {
      return this.update({ clientId: genClientId(), createdAt: Date.now() });
    },

    subscribe: function (fn) {
      var self = this;
      this.listeners.push(fn);
      return function () {
        self.listeners = self.listeners.filter(function (f) { return f !== fn; });
      };
    },

    getDomain: function (clientId) {
      return DOMAIN_PREFIX + '.' + (clientId || this.current.clientId) + DOMAIN_SUFFIX;
    },

    getUrl: function (clientId) {
      return 'http://' + this.getDomain(clientId);
    }
  };

  Config.load();

  // ============================================================
  // 4. 通用工具
  // ============================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isTruthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isFinite(n) ? n : fallback;
  }

  function ok(res, payload, status) {
    return res.status(status || 200).json(Object.assign({ success: true }, payload || {}));
  }

  function fail(res, status, error, extra) {
    return res.status(status || 500).json(Object.assign({
      success: false,
      error: String(error == null ? 'error' : error)
    }, extra || {}));
  }

  // 合并 body(JSON/form) + query + path params，query 优先级最高（与 v1 一致）
  function readParams(req) {
    var out = {};
    var body = req.body;
    if (body && typeof body === 'object' && !ArrayBuffer.isView(body) && !Array.isArray(body)) {
      Object.keys(body).forEach(function (k) { out[k] = body[k]; });
    }
    if (req.params && typeof req.params === 'object') {
      Object.keys(req.params).forEach(function (k) {
        if (out[k] === undefined) out[k] = req.params[k];
      });
    }
    if (req.query && typeof req.query === 'object') {
      Object.keys(req.query).forEach(function (k) { out[k] = req.query[k]; });
    }
    return out;
  }

  // 覆盖 range 的 ANSI 转义序列（CSI / OSC / 2-char）
  var ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

  function stripAnsi(text) {
    return String(text || '').replace(ANSI_RE, '');
  }

  function textLines(text, keep) {
    var clean = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var lines = clean.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (keep > 0) return lines.slice(-keep);
    return lines;
  }

  function readXtermLines(obj, keep) {
    var buf = obj.xterm.buffer.active;
    var start = Math.max(0, buf.length - keep);
    var out = [];
    for (var i = start; i < buf.length; i++) {
      var line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  function extractLastCommand(lines) {
    var re = /[\w.-]+@[\w.-]+:[^\$#]*[\$#]\s*(.+)$/;
    for (var i = lines.length - 1; i >= 0; i--) {
      var m = String(lines[i]).match(re);
      if (m) return m[1].trim();
    }
    return null;
  }

  function extractCwd(lines) {
    var re = /[\w.-]+@[\w.-]+:([^\$#]*)[\$#]/;
    for (var i = lines.length - 1; i >= 0; i--) {
      var m = String(lines[i]).match(re);
      if (m) return m[1].trim();
    }
    return null;
  }

  function safeFileName(name) {
    var base = String(name == null ? '' : name).split(/[\\/]/).pop() || 'download.bin';
    return base.replace(/["\r\n]/g, '_');
  }

  // ============================================================
  // 5. 主机 / 终端状态
  // ============================================================
  function isRtConnected(rt) {
    if (!rt || !rt.client) return false;
    if (typeof rt.client.isConnected === 'function') return rt.client.isConnected() === true;
    return rt.client.connected === true;
  }

  function resolveRt(runtime, hostId) {
    if (!runtime) return null;
    if (hostId) {
      var rt = runtime.get(hostId);
      return isRtConnected(rt) ? rt : null;
    }
    var found = null;
    runtime.forEach(function (candidate) {
      if (!found && isRtConnected(candidate)) found = candidate;
    });
    return found;
  }

  function resolveHostId(hosts, runtime, hostId) {
    if (hostId) return hostId;
    var id = null;
    if (runtime) {
      runtime.forEach(function (rt, key) {
        if (!id && isRtConnected(rt)) id = key;
      });
    }
    if (id) return id;
    return (hosts && hosts[0] && hosts[0].id) || null;
  }

  function uiTerm(rt, termId) {
    if (!rt || !rt.terminals || typeof rt.terminals.get !== 'function') return null;
    return rt.terminals.get(termId) || null;
  }

  // Agent 自己创建的终端（不触发页面上的 xterm，避免污染 UI）
  var AGENT_TERMS = new WeakMap();

  function agentTermsOf(rt) {
    var map = AGENT_TERMS.get(rt);
    if (!map) {
      map = new Map();
      AGENT_TERMS.set(rt, map);
    }
    return map;
  }

  function trackAgentTerm(rt, term, meta) {
    var entry = {
      termId: term.termId,
      term: term,
      backend: (meta && meta.backend) || 'local',
      shellId: (meta && meta.shellId) || null,
      buffer: '',
      exited: false,
      code: null,
      signal: null,
      error: null,
      createdAt: Date.now()
    };

    if (typeof term.onData === 'function') {
      term.onData(function (chunk) {
        if (!chunk) return;
        entry.buffer += chunk;
        if (entry.buffer.length > TERM_BUFFER_LIMIT) {
          entry.buffer = entry.buffer.slice(-TERM_BUFFER_LIMIT);
        }
      });
    }

    if (typeof term.onExit === 'function') {
      term.onExit(function (info) {
        info = info || {};
        entry.exited = true;
        entry.code = info.code;
        entry.signal = info.signal || null;
        entry.error = info.error || null;
      });
    }

    agentTermsOf(rt).set(entry.termId, entry);
    return entry;
  }

  function dropAgentTerm(rt, entry) {
    if (!entry) return;
    try { if (entry.term && typeof entry.term.dispose === 'function') entry.term.dispose(); } catch (e) { /* ignore */ }
    agentTermsOf(rt).delete(entry.termId);
  }

  // ctx.closeTerm 不存在时的兜底 UI 清理
  function cleanupUiTerm(rt, obj) {
    try {
      (obj.disposers || []).forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
    obj.disposers = [];
    try { if (obj.term && typeof obj.term.detach === 'function') obj.term.detach(); } catch (e) { /* ignore */ }
    try { if (obj.xterm && typeof obj.xterm.dispose === 'function') obj.xterm.dispose(); } catch (e) { /* ignore */ }
    try { if (obj.paneEl && obj.paneEl.remove) obj.paneEl.remove(); } catch (e) { /* ignore */ }
    try { if (obj.tabEl && obj.tabEl.remove) obj.tabEl.remove(); } catch (e) { /* ignore */ }
    if (rt.terminals) rt.terminals.delete(obj.termId);
    if (rt.activeTermId === obj.termId) rt.activeTermId = null;
  }

  // ============================================================
  // 6. 路由表（同时也是 UI / /api/routes 的文档来源）
  // ============================================================
  var ROUTE_INFO = [
    ['ALL', '/', '服务信息与端点索引'],
    ['ALL', '/health', '健康检查'],
    ['ALL', '/api/info', '能力、域名与主机信息'],
    ['ALL', '/api/routes', '路由列表'],
    ['GET', '/agent.json', '机器可读 API 说明（全部路由 / 参数 / 示例，源文件 agent.json）'],
    ['GET', '/api.json', 'API 说明副本（与 agent.json 内容一致）'],
    ['ALL', '/api/hosts/list', '主机列表'],
    ['ALL', '/api/hosts/status', '主机状态'],
    ['ALL', '/api/pty/list', '终端列表'],
    ['ALL', '/api/pty/create', '新建终端（Agent 专用，不占用页面 UI）'],
    ['ALL', '/api/pty/destroy', '销毁终端'],
    ['ALL', '/api/pty/write', '写入终端（支持 enter=true 自动回车）'],
    ['ALL', '/api/pty/read', '读取终端最近输出'],
    ['ALL', '/api/pty/resize', '调整终端尺寸'],
    ['ALL', '/api/exec', '执行一次性命令（local / ssh）'],
    ['ALL', '/api/fs/list', '文件列表'],
    ['ALL', '/api/fs/download', '下载文件（JSON base64 或 raw=1 二进制）'],
    ['ALL', '/api/fs/upload', '上传文件（JSON base64 或原始二进制 body）'],
    ['ALL', '/api/fs/delete', '删除文件'],
    ['ALL', '/api/ai/context', 'AI 上下文（最近输出 / 最后命令 / cwd）'],
    ['ALL', '/api/security/check', '命令安全检查'],
    ['ALL', '/api/mcp/info', 'MCP 端点信息、协议版本与工具清单'],
    ['MCP', '/mcp', 'MCP Streamable HTTP（POST 调用 / GET 信息 / DELETE 405）'],
    ['ALL', '/v1/models', 'OpenAI 兼容：模型列表（pty-exec / pty-agent / 上游模型）'],
    ['ALL', '/v1/chat/completions', 'OpenAI 兼容：对话补全（exec / proxy / agent 三种后端）'],
    ['ALL', '/v1/completions', 'OpenAI 兼容：legacy 文本补全（映射到 chat，不支持 pty-agent）'],
    ['ALL', '/v1/responses', 'OpenAI 兼容：Responses API'],
    ['ALL', '/v1/embeddings', 'OpenAI 兼容：不支持（固定返回 501）'],
    ['ALL', '/v1/_selftest', 'OpenAI 兼容：鉴权 / 主机 / 执行 / SSE / 上游连通自检'],
    ['WS', '/api/pty/stream', '终端实时输出流（WebSocket）']
  ];

  // ============================================================
  // 6.1 机器可读 API 说明（/agent.json · /api.json）
  //     数据源：agent.json（同目录静态文件，供 HTTP-API 调用方直接读取）
  //             页面内嵌副本：js/agent-doc.js（由 tools/build-agent-doc.js 生成）
  // ============================================================
  function agentDocFallback(app) {
    var base = (app && app.apiBase) || Config.getUrl();
    return {
      ok: true,
      schema: 'pty-agent-api/1',
      name: 'PTY Agent HTTP API',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      sdkVersion: SDK_VERSION,
      baseUrl: base,
      baseUrlTemplate: false,
      note: '未加载 js/agent-doc.js，以下仅为路由索引；完整说明见 agent.json / api.json',
      endpoints: ROUTE_INFO.map(function (r) {
        return { method: r[0], path: r[1], summary: r[2] };
      })
    };
  }

  // 返回文档副本，并把 baseUrl / mcp 端点等替换为运行时真实值（静态文件里是模板）
  function agentDocPayload(app) {
    var base = (app && app.apiBase) || Config.getUrl();
    var src = ROOT.Pty2AgentDoc;
    if (!src || typeof src !== 'object') return agentDocFallback(app);

    var doc;
    try {
      doc = JSON.parse(JSON.stringify(src));
    } catch (e) {
      return agentDocFallback(app);
    }

    doc.baseUrl = base;
    doc.baseUrlTemplate = false;
    doc.runtime = {
      clientId: app.clientId,
      domain: app.domain,
      apiBase: base,
      version: SERVICE_VERSION,
      sdkVersion: SDK_VERSION,
      allowDanger: Config.get().allowDanger === true,
      mcpEnabled: Config.get().mcpEnabled !== false,
      mcpEndpoint: base + '/mcp',
      wsEndpoint: base.replace(/^http/i, 'ws') + '/api/pty/stream',
      servedAt: new Date().toISOString()
    };

    if (doc.mcp && typeof doc.mcp === 'object') {
      doc.mcp.endpoint = base + '/mcp';
      if (doc.mcp.clientConfig && doc.mcp.clientConfig.mcpServers && doc.mcp.clientConfig.mcpServers.pty2) {
        var args = doc.mcp.clientConfig.mcpServers.pty2.args;
        if (Array.isArray(args) && args.length) args[args.length - 1] = base + '/mcp';
      }
    }
    if (doc.websocket && typeof doc.websocket === 'object') {
      doc.websocket.url = base.replace(/^http/i, 'ws') + '/api/pty/stream?termId=<termId>&lines=50';
    }
    return doc;
  }

  // ============================================================
  // 7. 路由实现
  // ============================================================
  function createHandlers(app, ctx) {
    function connectedRt(params) {
      var hostId = resolveHostId(ctx.hosts || [], ctx.runtime, params.hostId);
      return { hostId: hostId, rt: resolveRt(ctx.runtime, hostId) };
    }

    function terminalFor(rt, termId) {
      var entry = agentTermsOf(rt).get(termId);
      if (entry) return { kind: 'agent', entry: entry, ui: null };
      var obj = uiTerm(rt, termId);
      if (obj) return { kind: 'ui', entry: null, ui: obj };
      return { kind: 'none', entry: null, ui: null };
    }

    function snapshotLines(t, keep) {
      if (t.kind === 'ui' && t.ui && t.ui.xterm) return readXtermLines(t.ui, keep);
      if (t.kind === 'agent' && t.entry) return textLines(t.entry.buffer, keep);
      return null;
    }

    return {
      // ---------------- 元信息 ----------------
      '/': function (req, res) {
        var cfg = Config.get();
        return res.json({
          ok: true,
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          sdkVersion: SDK_VERSION,
          clientId: app.clientId,
          domain: app.domain,
          apiBase: app.apiBase,
          allowDanger: cfg.allowDanger === true,
          endpoints: ROUTE_INFO.map(function (r) {
            return { method: r[0], path: r[1], desc: r[2] };
          })
        });
      },

      '/health': function (req, res) {
        var st = app.status();
        var mcpStats = app.__mcpServer ? app.__mcpServer.stats() : null;
        return res.json({
          status: 'ok',
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          sdkVersion: SDK_VERSION,
          clientId: st.clientId,
          domain: st.domain,
          apiBase: st.apiBase,
          enabled: Config.get().enabled === true,
          connected: st.connected,
          registered: st.registered,
          requests: st.requests,
          errors: st.errors,
          uptimeMs: st.uptimeMs,
          mcp: mcpStats || { enabled: Config.get().mcpEnabled !== false, requests: 0, toolCalls: 0 },
          openai: app.__openaiServer ? app.__openaiServer.stats() : { enabled: Config.get().openaiEnabled === true, requests: 0, chatCalls: 0 },
          timestamp: new Date().toISOString()
        });
      },

      '/api/info': function (req, res) {
        var cfg = Config.get();
        var defaultHostId = null;
        if (ctx.runtime) {
          ctx.runtime.forEach(function (rt, id) {
            if (!defaultHostId && isRtConnected(rt)) defaultHostId = id;
          });
        }
        if (!defaultHostId) {
          defaultHostId = (ctx.hosts && ctx.hosts[0] && ctx.hosts[0].id) || null;
        }
        var mcpTools = ROOT.Pty2Mcp ? ROOT.Pty2Mcp.TOOLS.length : 0;
        return ok(res, {
          name: 'PTY Agent Service',
          version: SERVICE_VERSION,
          sdkVersion: SDK_VERSION,
          clientId: app.clientId,
          domain: app.domain,
          apiBase: app.apiBase,
          defaultHostId: defaultHostId,
          allowDanger: cfg.allowDanger === true,
          capabilities: [
            'pty_create', 'pty_write', 'pty_read', 'pty_resize', 'pty_destroy', 'pty_list', 'pty_stream',
            'exec_local', 'exec_ssh',
            'fs_list', 'fs_download', 'fs_download_raw', 'fs_upload', 'fs_upload_raw', 'fs_delete',
            'ai_context', 'security_check',
            'mcp', 'mcp_tools', 'mcp_resources', 'mcp_prompts',
            'openai_compat', 'openai_chat', 'openai_stream', 'openai_tools'
          ],
          mcp: {
            enabled: cfg.mcpEnabled !== false,
            endpoint: app.apiBase + '/mcp',
            transport: 'streamable-http',
            protocolVersions: ROOT.Pty2Mcp ? ROOT.Pty2Mcp.PROTOCOL_VERSIONS : [],
            tools: mcpTools
          },
          openai: app.__openaiServer ? Object.assign({ baseUrl: app.apiBase + '/v1' }, app.__openaiServer.info()) : {
            enabled: false,
            baseUrl: app.apiBase + '/v1',
            note: 'openai-compat.js 未加载或服务未启动'
          },
          hosts: (ctx.hosts || []).map(function (h) {
            return { id: h.id, name: h.name, url: h.url };
          }),
          routes: ROUTE_INFO.map(function (r) {
            return { method: r[0], path: r[1], desc: r[2] };
          })
        });
      },

      '/api/routes': function (req, res) {
        return ok(res, {
          routes: ROUTE_INFO.map(function (r) {
            return { method: r[0], path: r[1], desc: r[2] };
          })
        });
      },

      // 机器可读 API 说明：直接返回文档本身（不带 success 包装，方便按 schema 解析）
      '/agent.json': function (req, res) {
        return res.status(200).json(agentDocPayload(app));
      },

      '/api.json': function (req, res) {
        return res.status(200).json(agentDocPayload(app));
      },

      '/api/mcp/info': function (req, res) {
        var cfg = Config.get();
        if (app.__mcpServer) return ok(res, app.__mcpServer.info());
        return ok(res, {
          enabled: cfg.mcpEnabled !== false,
          started: false,
          endpoint: app.apiBase + '/mcp',
          protocolVersions: ROOT.Pty2Mcp ? ROOT.Pty2Mcp.PROTOCOL_VERSIONS : [],
          tools: ROOT.Pty2Mcp ? ROOT.Pty2Mcp.TOOLS.map(function (t) { return t.name; }) : []
        });
      },

      // ---------------- 主机 ----------------
      '/api/hosts/list': function (req, res) {
        var list = (ctx.hosts || []).map(function (h) {
          var rt = ctx.runtime ? ctx.runtime.get(h.id) : null;
          var realConnected = isRtConnected(rt);
          var agentCount = rt ? agentTermsOf(rt).size : 0;
          return {
            id: h.id,
            name: h.name,
            url: h.url,
            inRuntime: !!rt,
            connected: realConnected,
            clientConnected: !!(rt && rt.client &&
              ((typeof rt.client.isConnected === 'function' && rt.client.isConnected()) ||
                rt.client.connected === true)),
            terminalCount: (rt && rt.terminals ? rt.terminals.size : 0) + agentCount,
            uiTerminals: rt && rt.terminals ? rt.terminals.size : 0,
            agentTerminals: agentCount
          };
        });
        return ok(res, { hosts: list });
      },

      '/api/hosts/status': function (req, res) {
        var params = readParams(req);
        var hostId = params.hostId;
        if (!hostId) return fail(res, 400, 'hostId is required');
        var host = (ctx.hosts || []).find(function (h) { return h.id === hostId; });
        if (!host) return fail(res, 404, 'host not found', { hostId: hostId });

        var rt = ctx.runtime ? ctx.runtime.get(hostId) : null;
        var realConnected = isRtConnected(rt);
        var agentMap = rt ? agentTermsOf(rt) : new Map();
        return ok(res, {
          hostId: hostId,
          inRuntime: !!rt,
          connected: realConnected,
          clientConnected: !!(rt && rt.client &&
            ((typeof rt.client.isConnected === 'function' && rt.client.isConnected()) ||
              rt.client.connected === true)),
          terminalCount: (rt && rt.terminals ? rt.terminals.size : 0) + agentMap.size,
          uiTerminals: rt && rt.terminals ? rt.terminals.size : 0,
          agentTerminals: agentMap.size,
          activeTermId: rt ? (rt.activeTermId || null) : null,
          backends: (rt && rt.backends) || [],
          shells: (rt && rt.shells) || []
        });
      },

      // ---------------- 终端 ----------------
      '/api/pty/list': async function (req, res) {
        var params = readParams(req);
        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        var rt = found.rt;
        var activeTermId = rt.activeTermId || null;
        var agentMap = agentTermsOf(rt);

        var serverList = null;
        try {
          if (typeof rt.client.listTerminals === 'function') serverList = await rt.client.listTerminals();
        } catch (e) { serverList = null; }

        if (Array.isArray(serverList)) {
          return ok(res, {
            hostId: found.hostId,
            activeTermId: activeTermId,
            terminals: serverList.map(function (t) {
              return Object.assign({}, t, {
                active: t.termId === activeTermId,
                inUI: !!(rt.terminals && rt.terminals.has(t.termId)),
                agent: agentMap.has(t.termId)
              });
            })
          });
        }

        var local = [];
        if (rt.terminals && typeof rt.terminals.forEach === 'function') {
          rt.terminals.forEach(function (o) {
            local.push({
              termId: o.termId,
              backend: o.backend || 'local',
              exited: !!o.exited,
              active: o.termId === activeTermId,
              inUI: true,
              agent: false
            });
          });
        }
        agentMap.forEach(function (e) {
          local.push({
            termId: e.termId,
            backend: e.backend || 'local',
            exited: e.exited === true,
            code: e.code,
            active: false,
            inUI: false,
            agent: true
          });
        });
        return ok(res, {
          hostId: found.hostId,
          activeTermId: activeTermId,
          terminals: local,
          fromLocal: true
        });
      },

      '/api/pty/create': async function (req, res) {
        var params = readParams(req);
        var hostId = resolveHostId(ctx.hosts || [], ctx.runtime, params.hostId);
        var rt = ctx.runtime ? ctx.runtime.get(hostId) : null;
        if (!rt) return fail(res, 404, 'host not found', { hostId: hostId });

        if (!isRtConnected(rt)) {
          if (typeof ctx.ensureConnected !== 'function') {
            return fail(res, 503, 'host not connected', { hostId: hostId, hint: HOST_HINT });
          }
          try {
            rt = await ctx.ensureConnected(hostId);
          } catch (e) {
            return fail(res, 503, 'failed to connect: ' + ((e && e.message) || e), { hostId: hostId });
          }
        }

        var backend = params.backend || 'local';
        var shellId = params.shellId || null;
        var cols = toInt(params.cols, 80) || 80;
        var rows = toInt(params.rows, 24) || 24;

        var opts = { cols: cols, rows: rows, backend: backend };
        if (shellId) {
          if (backend === 'local') opts.shellId = shellId;
          else opts.remoteShell = shellId;
        }
        if (params.cwd) opts.cwd = params.cwd;

        try {
          var term = await rt.client.createTerminal(opts);
          trackAgentTerm(rt, term, { backend: backend, shellId: shellId });
          return ok(res, {
            hostId: hostId,
            termId: term.termId,
            backend: backend,
            shellId: shellId,
            cols: cols,
            rows: rows,
            session: 'agent',
            hint: '用 /api/pty/read 读取输出，/api/pty/write 写入，/api/pty/stream 订阅实时输出'
          });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { hostId: hostId });
        }
      },

      '/api/pty/destroy': async function (req, res) {
        var params = readParams(req);
        var termId = params.termId;
        if (!termId) return fail(res, 400, 'termId is required');

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        var rt = found.rt;
        var obj = uiTerm(rt, termId);
        var entry = agentTermsOf(rt).get(termId);

        try {
          if (obj && typeof ctx.closeTerm === 'function') {
            // 页面上已有的 tab：交给页面处理（释放 xterm / tab / 服务端会话）
            await ctx.closeTerm(rt, termId);
          } else {
            if (typeof rt.client.destroy === 'function') await rt.client.destroy(termId);
            if (obj) cleanupUiTerm(rt, obj);
            if (entry) dropAgentTerm(rt, entry);
          }
          return ok(res, { termId: termId });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { termId: termId });
        }
      },

      '/api/pty/write': async function (req, res) {
        var params = readParams(req);
        var termId = params.termId;
        if (!termId) return fail(res, 400, 'termId is required');

        var text;
        if (params.dataBase64 !== undefined && params.dataBase64 !== null && params.dataBase64 !== '') {
          text = Base64.decode(String(params.dataBase64));
        } else if (params.data !== undefined && params.data !== null) {
          text = String(params.data);
        } else {
          return fail(res, 400, 'data or dataBase64 is required');
        }
        if (isTruthy(params.enter)) text += '\r';

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        try {
          await found.rt.client.write(termId, text);
          return ok(res, { termId: termId, bytesWritten: text.length });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { termId: termId });
        }
      },

      '/api/pty/read': function (req, res) {
        var params = readParams(req);
        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        var rt = found.rt;
        var termId = params.termId || rt.activeTermId;
        if (!termId) return fail(res, 400, 'termId is required');

        var keep = toInt(params.lines, 50);
        if (!keep || keep < 1) keep = 50;
        if (keep > 5000) keep = 5000;

        var t = terminalFor(rt, termId);
        var lines = snapshotLines(t, keep);
        if (!lines) {
          return fail(res, 404, 'term not bound in this host', {
            termId: termId,
            hint: '该 termId 不属于当前页面；可用 /api/pty/create 新建 Agent 终端，或直接用 /api/exec'
          });
        }

        var text = lines.join('\n');
        return ok(res, {
          termId: termId,
          seq: Date.now(),
          lines: lines,
          text: text,
          dataBase64: Base64.encode(text),
          agent: t.kind === 'agent',
          exited: t.kind === 'agent' ? t.entry.exited === true : false
        });
      },

      '/api/pty/resize': async function (req, res) {
        var params = readParams(req);
        var termId = params.termId;
        if (!termId) return fail(res, 400, 'termId is required');

        var cols = toInt(params.cols, 80) || 80;
        var rows = toInt(params.rows, 24) || 24;

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        var rt = found.rt;
        var obj = uiTerm(rt, termId);

        try {
          if (obj && obj.term && typeof obj.term.resize === 'function') {
            await obj.term.resize(cols, rows);
            try { if (obj.fitAddon && typeof obj.fitAddon.fit === 'function') obj.fitAddon.fit(); } catch (e) { /* ignore */ }
          } else {
            await rt.client.resize(termId, cols, rows);
          }
          return ok(res, { termId: termId, cols: cols, rows: rows });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { termId: termId });
        }
      },

      // ---------------- 一次性命令 ----------------
      '/api/exec': async function (req, res) {
        var params = readParams(req);
        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        var command = params.command;
        if (!command) return fail(res, 400, 'command is required');

        var safety = checkCommandSafety(String(command));
        var allowDanger = Config.get().allowDanger === true;
        var userConfirm = isTruthy(params.confirm) || isTruthy(params.force);

        if (safety.risk === 'danger' && !allowDanger && !userConfirm) {
          return res.status(403).json({
            success: false,
            error: '危险命令，默认禁止',
            reason: safety.reason,
            risk: safety.risk,
            needConfirm: true,
            hint: '在面板勾选「允许 danger 级命令」，或传入 confirm=true 强制执行'
          });
        }
        if (safety.risk === 'warn' && !userConfirm) {
          return res.status(403).json({
            success: false,
            error: '命令需要确认',
            reason: safety.reason,
            risk: safety.risk,
            needConfirm: true,
            hint: '传入 confirm=true 强制执行'
          });
        }

        var useSsh = isTruthy(params.useSsh);
        var timeout = toInt(params.timeout, 60000) || 60000;
        var startedAt = Date.now();

        try {
          var r = await found.rt.client.exec(String(command), { useSsh: useSsh, timeout: timeout });
          return ok(res, {
            stdout: (r && r.stdout) || '',
            stderr: (r && r.stderr) || '',
            exitCode: r ? r.exitCode : null,
            duration: Date.now() - startedAt,
            command: String(command),
            useSsh: useSsh,
            risk: safety.risk
          });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { command: String(command) });
        }
      },

      // ---------------- 文件 ----------------
      '/api/fs/list': async function (req, res) {
        var found = connectedRt(readParams(req));
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        try {
          var files = await found.rt.client.listFiles();
          return ok(res, { hostId: found.hostId, files: files || [] });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { hostId: found.hostId });
        }
      },

      '/api/fs/download': async function (req, res) {
        var params = readParams(req);
        var name = params.name;
        if (!name) return fail(res, 400, 'name is required');

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }

        try {
          if (typeof found.rt.client.downloadFileToBytes !== 'function') {
            return fail(res, 501, 'downloadFileToBytes 未实现，请升级 PtyClient', { name: name });
          }
          var bytes = await found.rt.client.downloadFileToBytes(String(name));

          if (isTruthy(params.raw) || isTruthy(params.download)) {
            res.set('content-type', 'application/octet-stream');
            res.set('content-disposition', 'attachment; filename="' + safeFileName(name) + '"');
            res.set('content-length', String(bytes.length));
            return res.send(bytes);
          }

          return ok(res, {
            hostId: found.hostId,
            name: String(name),
            size: bytes.length,
            dataBase64: Base64.encodeBytes(bytes)
          });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { name: name });
        }
      },

      '/api/fs/upload': async function (req, res) {
        var params = readParams(req);
        var rawBody = req.rawBody || new Uint8Array(0);
        var name = params.name || req.get('x-filename') || null;
        var rel = params.rel || req.get('x-rel-path') || name;
        var bytes = null;
        var isJsonBody = /application\/json/i.test(String(req.get('content-type') || '')) &&
          req.body && typeof req.body === 'object' && !ArrayBuffer.isView(req.body);

        if (params.dataBase64) {
          try {
            bytes = Base64.decodeToBytes(String(params.dataBase64));
          } catch (e) {
            return fail(res, 400, 'invalid dataBase64');
          }
        } else if (isJsonBody) {
          return fail(res, 400, 'dataBase64 is required for JSON upload', { name: name || null });
        } else if (rawBody.length > 0) {
          bytes = rawBody;
        }

        if (!bytes || !bytes.length) {
          return fail(res, 400, 'dataBase64 or raw request body is required', { name: name || null });
        }
        if (!name) {
          name = 'upload-' + Date.now() + '.bin';
          rel = rel || name;
        }

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }

        try {
          var payload;
          if (typeof File !== 'undefined') {
            payload = new File([bytes], String(name));
          } else {
            payload = bytes;
          }
          await found.rt.client.uploadFile(payload, { name: String(name), rel: String(rel || name) });
          return ok(res, {
            name: String(name),
            rel: String(rel || name),
            size: bytes.length,
            mode: params.dataBase64 ? 'base64' : 'raw'
          });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { name: name });
        }
      },

      '/api/fs/delete': async function (req, res) {
        var params = readParams(req);
        var name = params.name;
        if (!name) return fail(res, 400, 'name is required');

        var found = connectedRt(params);
        if (!found.rt) {
          return fail(res, 503, 'host not connected', { hostId: found.hostId, hint: HOST_HINT });
        }
        try {
          await found.rt.client.deleteFile(String(name));
          return ok(res, { name: String(name) });
        } catch (e) {
          return fail(res, 500, (e && e.message) || e, { name: name });
        }
      },

      // ---------------- AI 上下文 ----------------
      '/api/ai/context': function (req, res) {
        var params = readParams(req);
        var found = connectedRt(params);
        if (!found.rt) return fail(res, 404, 'host not found', { hostId: found.hostId });

        var rt = found.rt;
        var keep = toInt(params.lines, 50);
        if (!keep || keep < 1) keep = 50;
        if (keep > 5000) keep = 5000;

        var termId = params.termId || rt.activeTermId;
        if (!termId) return fail(res, 404, 'no active term');

        var t = terminalFor(rt, termId);
        var lines = snapshotLines(t, keep);
        if (!lines) return fail(res, 404, 'term not bound in this host', { termId: termId });

        return ok(res, {
          hostId: found.hostId,
          termId: termId,
          recentOutput: lines.join('\n'),
          lines: lines.length,
          lastCommand: extractLastCommand(lines),
          cwd: extractCwd(lines),
          exitCode: t.kind === 'agent' ? t.entry.code : null
        });
      },

      // ---------------- 安全 ----------------
      '/api/security/check': function (req, res) {
        var params = readParams(req);
        var command = params.command;
        if (!command) return fail(res, 400, 'command is required');
        return ok(res, Object.assign({ command: String(command) }, checkCommandSafety(String(command))));
      }
    };
  }

  // ============================================================
  // 8. WebSocket：终端实时输出
  // ============================================================
  function handlePtyStream(app, ctx, ws, req) {
    var params = readParams(req);
    var send = function (payload) {
      try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
    };
    var closeWith = function (code, reason, payload) {
      if (payload) send(payload);
      try { ws.close(code, reason); } catch (e) { /* ignore */ }
    };

    var hostId = resolveHostId(ctx.hosts || [], ctx.runtime, params.hostId);
    var rt = resolveRt(ctx.runtime, hostId);
    if (!rt) {
      return closeWith(1011, 'host not connected', {
        type: 'error', error: 'host not connected', hostId: hostId, hint: HOST_HINT
      });
    }

    var termId = params.termId || rt.activeTermId;
    if (!termId) {
      return closeWith(1011, 'termId is required', { type: 'error', error: 'termId is required' });
    }

    var t = (function () {
      var entry = agentTermsOf(rt).get(termId);
      if (entry) return { kind: 'agent', entry: entry, ui: null };
      var obj = uiTerm(rt, termId);
      if (obj) return { kind: 'ui', entry: null, ui: obj };
      return { kind: 'none', entry: null, ui: null };
    })();

    if (t.kind === 'none') {
      return closeWith(1011, 'term not found', {
        type: 'error', error: 'term not found', termId: termId
      });
    }

    var closed = false;

    var onOutput = function (msg) {
      if (closed || !msg || msg.notify_type !== termId) return;
      if (msg.ended) {
        send({ type: 'exit', termId: termId, code: msg.code, signal: msg.signal, error: msg.err_flag ? msg.data : null });
        closed = true;
        try { if (typeof rt.client.off === 'function') rt.client.off('rtterm', onOutput); } catch (e) { /* ignore */ }
        try { ws.close(1000, 'terminal exited'); } catch (e) { /* ignore */ }
        return;
      }
      if (msg.data) send({ type: 'data', termId: termId, data: msg.data });
    };

    if (typeof rt.client.on === 'function') rt.client.on('rtterm', onOutput);

    send({
      type: 'ready',
      termId: termId,
      hostId: hostId,
      backend: (t.entry && t.entry.backend) || (t.ui && t.ui.backend) || 'local',
      inUI: t.kind === 'ui',
      agent: t.kind === 'agent',
      cols: t.kind === 'ui' && t.ui.xterm ? t.ui.xterm.cols : undefined,
      rows: t.kind === 'ui' && t.ui.xterm ? t.ui.xterm.rows : undefined,
      protocol: 'cdtty-ws/1'
    });

    var backfill = toInt(params.lines, 0);
    if (backfill > 0) {
      var snap = t.kind === 'ui' ? readXtermLines(t.ui, backfill) : textLines(t.entry.buffer, backfill);
      send({ type: 'snapshot', termId: termId, lines: snap });
    }

    ws.on('message', function (data, isBinary) {
      if (closed) return;
      if (isBinary) {
        send({ type: 'error', error: 'binary frames are not supported; send JSON text' });
        return;
      }

      var text = typeof data === 'string' ? data : String(data);
      var msg = null;
      if (text.charAt(0) === '{') {
        try { msg = JSON.parse(text); } catch (e) { msg = null; }
      }

      // 非 JSON：当作原始键盘输入
      if (!msg) {
        if (!text) return;
        var written = rt.client.write(termId, text);
        if (written && typeof written.catch === 'function') {
          written.catch(function (e) { send({ type: 'error', error: (e && e.message) || String(e) }); });
        }
        return;
      }

      var type = msg.type || (msg.data !== undefined ? 'input' : '');
      if (type === 'input' || type === 'write') {
        var input = msg.data === undefined || msg.data === null ? '' : String(msg.data);
        if (isTruthy(msg.enter)) input += '\r';
        var p = rt.client.write(termId, input);
        if (p && typeof p.catch === 'function') {
          p.catch(function (e) { send({ type: 'error', error: (e && e.message) || String(e) }); });
        }
      } else if (type === 'resize') {
        var cols = toInt(msg.cols, 80) || 80;
        var rows = toInt(msg.rows, 24) || 24;
        var pr = rt.client.resize(termId, cols, rows);
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function (e) { send({ type: 'error', error: (e && e.message) || String(e) }); });
        }
      } else if (type === 'read') {
        var n = toInt(msg.lines, 50);
        if (!n || n < 1) n = 50;
        if (n > 5000) n = 5000;
        var lines = t.kind === 'ui' ? readXtermLines(t.ui, n) : textLines(t.entry.buffer, n);
        send({ type: 'snapshot', termId: termId, lines: lines });
      } else if (type === 'ping') {
        send({ type: 'pong', t: Date.now() });
      } else {
        send({ type: 'error', error: 'unknown message type: ' + type });
      }
    });

    ws.on('close', function () {
      closed = true;
      try { if (typeof rt.client.off === 'function') rt.client.off('rtterm', onOutput); } catch (e) { /* ignore */ }
    });

    ws.on('error', function (err) {
      console.warn('[Pty2Agent] websocket error:', (err && err.message) || err);
    });
  }

  // ============================================================
  // 9. 挂载路由到 DTNSAgent app
  // ============================================================
  // 把 Express 风格 handler 包装成 (path, params) -> Promise<{status, body}>
  // 供 MCP 层复用既有业务逻辑，避免重复实现。
  function makeHandlerCaller(handlers) {
    return function (path, params) {
      return new Promise(function (resolve, reject) {
        var handler = handlers[path];
        if (typeof handler !== 'function') return reject(new Error('unknown handler: ' + path));

        var out = null;
        var req = {
          method: 'POST',
          path: path,
          query: {},
          params: {},
          body: Object.assign({}, params || {}),
          headers: {},
          rawBody: new Uint8Array(0),
          get: function (name) {
            return String(name).toLowerCase() === 'content-type' ? 'application/json' : undefined;
          }
        };
        var res = {
          statusCode: 200,
          headers: {},
          finished: false,
          status: function (code) { this.statusCode = Number(code) || 200; return this; },
          set: function (key, value) { this.headers[String(key).toLowerCase()] = String(value); return this; },
          json: function (value) { out = { status: this.statusCode, body: value }; this.finished = true; return this; },
          send: function (value) { out = { status: this.statusCode, body: value }; this.finished = true; return this; },
          end: function (value) {
            if (!out) out = { status: this.statusCode, body: value === undefined ? null : value };
            this.finished = true;
            return this;
          }
        };

        var result;
        try {
          result = handler(req, res);
        } catch (error) {
          return reject(error);
        }

        Promise.resolve(result).then(function () {
          if (!out) return reject(new Error('handler did not respond: ' + path));
          resolve(out);
        }, reject);
      });
    };
  }

  function defineMcpRoutes(app, ctx, handlers, options) {
    var MCP = ROOT.Pty2Mcp;
    if (!MCP) {
      console.warn('[Pty2Agent] mcp-server.js 未加载，/mcp 不可用');
      return;
    }

    var logger = (options && typeof options.log === 'function') ? options.log : null;

    var server = MCP.createServer({
      call: makeHandlerCaller(handlers),
      getConfig: function () { return Config.get(); },
      getService: function () {
        return {
          domain: app.domain,
          apiBase: app.apiBase,
          clientId: app.clientId,
          version: SERVICE_VERSION,
          sdkVersion: SDK_VERSION
        };
      },
      log: function (entry) {
        if (!logger) return;
        try {
          var parts = ['MCP ' + (entry.method || '')];
          if (entry.tool) parts.push(entry.tool);
          if (entry.isError) parts.push('❌');
          if (entry.reason) parts.push(entry.reason);
          if (entry.ms !== undefined) parts.push(entry.ms + 'ms');
          logger(parts.join(' '), entry.isError ? 'warn' : 'info');
        } catch (e) { /* ignore */ }
      }
    });

    app.__mcpServer = server;

    app.post('/mcp', function (req, res) {
      return server.handlePost(req, res);
    });
    app.get('/mcp', function (req, res) {
      return server.handleGet(req, res);
    });
    app.delete('/mcp', function (req, res) {
      return server.handleDelete(req, res);
    });
  }

  // ============================================================
  // 9.4b OpenAI 兼容接口（/v1/*）
  //      薄适配层：所有执行动作复用 handlers（通过 call 注入），
  //      本层只做 OpenAI 协议翻译，不重复实现任何执行逻辑。
  // ============================================================
  function defineOpenAICompatRoutes(app, ctx, handlers, options) {
    var OAI = ROOT.Pty2OpenAI;
    if (!OAI) {
      console.warn('[Pty2Agent] openai-compat.js 未加载，/v1/* 不可用');
      return;
    }

    var logger = (options && typeof options.log === 'function') ? options.log : null;
    var MCP = ROOT.Pty2Mcp;

    var server = OAI.createServer({
      call: makeHandlerCaller(handlers),
      getConfig: function () { return Config.get(); },
      getService: function () {
        return {
          domain: app.domain,
          apiBase: app.apiBase,
          clientId: app.clientId,
          version: SERVICE_VERSION,
          sdkVersion: SDK_VERSION
        };
      },
      getHosts: function () {
        return (ctx.hosts || []).map(function (h) {
          var rt = ctx.runtime ? ctx.runtime.get(h.id) : null;
          return { id: h.id, name: h.name, url: h.url, connected: isRtConnected(rt) };
        });
      },
      // 复用 MCP 的页面确认框，避免两套 UI
      confirm: MCP && typeof MCP.confirm === 'function' ? MCP.confirm : null,
      log: function (entry) {
        if (!logger) return;
        try {
          var parts = ['OpenAI ' + (entry.event || '')];
          if (entry.kind) parts.push(entry.kind);
          if (entry.model) parts.push(entry.model);
          if (entry.mode) parts.push(entry.mode);
          if (entry.blocked) parts.push('blocked');
          if (entry.message) parts.push(String(entry.message).slice(0, 160));
          logger(parts.join(' '), entry.event === 'error' || entry.blocked ? 'warn' : 'info');
        } catch (e) { /* ignore */ }
      }
    });

    app.__openaiServer = server;

    var KINDS = [
      ['/v1/models', 'models'],
      ['/v1/chat/completions', 'chat'],
      ['/v1/completions', 'completions'],
      ['/v1/responses', 'responses'],
      ['/v1/embeddings', 'embeddings'],
      ['/v1/_selftest', 'selftest']
    ];

    KINDS.forEach(function (item) {
      app.all(item[0], function (req, res) {
        return server.handle(item[1], req, res);
      });
    });

    // 其余 /v1/* 统一返回 OpenAI 风格 404；必须注册在 app.all('/*') 之前
    app.all('/v1/*', function (req, res) {
      return server.handle('notfound', req, res);
    });
  }

  function defineRoutes(app, ctx, options) {
    var handlers = createHandlers(app, ctx);

    // 9.1 CORS（按要求放开所有跨域；Access-Control-Allow-* 使用 *）
    app.use(function (req, res, next) {
      var startedAt = Date.now();

      res.set('access-control-allow-origin', '*');
      res.set('access-control-allow-methods', '*, GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
      res.set('access-control-allow-headers',
        '*, Authorization, Content-Type, Accept, X-Requested-With, X-Request-ID, X-Filename, X-Rel-Path, ' +
        'MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID');
      res.set('access-control-expose-headers', '*');
      res.set('access-control-max-age', '86400');

      var originalEnd = res.end;
      res.end = function (body) {
        try {
          if (!res.finished) res.set('x-pty-agent-duration', String(Date.now() - startedAt));
        } catch (e) { /* ignore */ }
        return originalEnd.call(res, body);
      };

      next();
    });

    // 9.2 预检必须优先于 app.all('/*')，否则 ALL 路由会吞掉 OPTIONS
    app.options('/*', function (req, res) {
      res.status(204).end();
    });

    // 9.3 所有 API 路由都接受任意方法（与 v1 的 GET/POST 双向兜底一致）
    ROUTE_INFO.forEach(function (info) {
      var path = info[1];
      if (info[0] === 'WS' || info[0] === 'MCP') return;
      var handler = handlers[path];
      if (typeof handler !== 'function') return;

      app.all(path, async function (req, res) {
        try {
          await handler(req, res);
        } catch (e) {
          console.error('[Pty2Agent] handler error:', e);
          if (!res.finished) {
            res.status(500).json({ success: false, error: (e && e.message) || String(e) });
          }
        }
      });
    });

    // 9.4 MCP Streamable HTTP（POST / GET / DELETE）
    defineMcpRoutes(app, ctx, handlers, options);

    // 9.4b OpenAI 兼容接口（/v1/*），必须在 9.5 的 404 兜底之前注册
    defineOpenAICompatRoutes(app, ctx, handlers, options);

    // 9.5 WebSocket 终端实时流
    app.ws('/api/pty/stream', function (ws, req) {
      try {
        handlePtyStream(app, ctx, ws, req);
      } catch (e) {
        console.error('[Pty2Agent] ws handler error:', e);
        try { ws.send(JSON.stringify({ type: 'error', error: (e && e.message) || String(e) })); } catch (err) { /* ignore */ }
        try { ws.close(1011, 'ws handler error'); } catch (err) { /* ignore */ }
      }
    });

    // 9.5 兜底 404（保留 v1 的 availableRoutes）
    app.all('/*', function (req, res) {
      res.status(404).json({
        success: false,
        error: 'Route not found: ' + req.method + ' ' + req.path,
        availableRoutes: ROUTE_INFO.map(function (r) { return r[0] + ' ' + r[1]; })
      });
    });
  }

  // ============================================================
  // 10. UI 面板
  // ============================================================
  class Pty2AgentUI {
    constructor(agent) {
      this.agent = agent;
      this.panelEl = null;
      this.logEl = null;
      this.logLines = [];
      this._bind();
    }

    _bind() {
      var self = this;

      this.agent.on('connecting', function (info) {
        self._log('正在连接隧道：' + (info.url || info.domain), 'info');
        self._refresh();
      });
      this.agent.on('started', function (status) {
        self._log('✅ 已启动：' + status.url, 'success');
        self._refresh();
        self._renderRoutes();
        self._renderCurl();
      });
      this.agent.on('stopped', function () {
        self._log('⏹️ 已停止 HTTP-Proxy', 'info');
        self._refresh();
      });
      this.agent.on('reconnected', function () {
        self._log('🔁 隧道已重连', 'success');
        self._refresh();
      });
      this.agent.on('disconnected', function () {
        self._log('⚠️ 隧道断开，等待重连...', 'warn');
        self._refresh();
      });
      this.agent.on('reconnecting', function (info) {
        self._log('🔄 重连中（第 ' + info.attempt + ' 次，' + info.delay + 'ms 后）', 'warn');
        self._refresh();
      });
      this.agent.on('error', function (info) {
        self._log('❌ ' + ((info && info.error) || info), 'error');
        self._refresh();
      });
      this.agent.on('request', function (info) {
        self._log('→ ' + info.method + ' ' + info.path + ' [' + info.status + '] ' + info.ms + 'ms',
          info.status < 400 ? 'info' : 'error');
      });
      this.agent.on('websocket', function (info) {
        self._log('🔌 WebSocket 已连接：' + info.path + ' (' + (info.remoteAddress || 'unknown') + ')', 'info');
        self._refresh();
      });
    }

    mount() {
      var self = this;
      var toolbar = document.getElementById('toolbar');

      if (toolbar && !document.getElementById('btnPty2Agent')) {
        var btn = document.createElement('button');
        btn.id = 'btnPty2Agent';
        btn.textContent = '🤖 Agent';
        btn.title = 'PTY Agent (sdk.js)：让 AI Agent 通过 HTTP / WebSocket / MCP 控制 PTY';
        btn.style.background = '#8e44ad';
        btn.style.color = '#fff';
        btn.onclick = function () { self.show(); };
        toolbar.appendChild(btn);
      } else if (!toolbar) {
        console.warn('[Pty2Agent] #toolbar not found');
      }

      if (document.getElementById('pty2AgentPanel')) {
        this.panelEl = document.getElementById('pty2AgentPanel');
        this.logEl = document.getElementById('p2aLog');
        return;
      }

      var panel = document.createElement('div');
      panel.id = 'pty2AgentPanel';
      panel.style.cssText = [
        'display:none', 'position:fixed', 'right:12px', 'top:60px',
        'width:min(560px, calc(100vw - 24px))',
        'max-height:85vh', 'max-height:calc(100dvh - 24px)', 'overflow:auto',
        'background:#252526', 'border:1px solid #444',
        'border-radius:8px', 'padding:14px',
        'z-index:70', 'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
        'font-family:Arial,sans-serif', 'font-size:13px', 'color:#eee',
        '-webkit-overflow-scrolling:touch'
      ].join(';');

      // 小屏 / 手机：Agent 面板铺满可视宽度，避免 560px 固定宽度溢出
      if (!document.getElementById('pty2AgentPanelStyles')) {
        var panelStyles = document.createElement('style');
        panelStyles.id = 'pty2AgentPanelStyles';
        panelStyles.textContent = [
          '@media (max-width: 640px) {',
          '  #pty2AgentPanel {',
          '    left: 8px !important;',
          '    right: 8px !important;',
          '    width: auto !important;',
          '    top: 8px !important;',
          '    max-height: calc(100dvh - 16px) !important;',
          '    padding: 12px !important;',
          '  }',
          '}',
          '@media (max-height: 480px) {',
          '  #pty2AgentPanel {',
          '    top: 6px !important;',
          '    max-height: calc(100dvh - 12px) !important;',
          '  }',
          '}',
          '@media (max-width: 640px) {',
          '  #pty2AgentPanel .p2a-row { flex-wrap: wrap; }',
          '  #pty2AgentPanel .p2a-row input {',
          '    flex: 1 1 100% !important;',
          '    min-width: 0 !important;',
          '    font-size: 11px !important;',
          '  }',
          '  #pty2AgentPanel .p2a-row button { flex: 1 1 0; }',
          '}'
        ].join('\n');
        document.head.appendChild(panelStyles);
      }

      panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid #333; padding-bottom:8px;">
          <b style="font-size:15px;">🤖 PTY Agent · sdk.js</b>
          <button id="p2aClose" style="padding:2px 10px;">×</button>
        </div>

        <div id="p2aStatus" style="background:#1e1e1e; padding:10px; border-radius:6px; margin-bottom:10px; font-size:12px; line-height:1.7;"></div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">Client ID</label>
          <div class="p2a-row" style="display:flex; gap:6px;">
            <input id="p2aClientId" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="p2aCopyId" style="padding:6px 10px;">📋</button>
            <button id="p2aRegenId" style="padding:6px 10px; background:#e67e22;">🔄</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">Agent URL</label>
          <div class="p2a-row" style="display:flex; gap:6px;">
            <input id="p2aUrl" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#8f8; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="p2aCopyUrl" style="padding:6px 10px;">📋</button>
            <button id="p2aOpenUrl" style="padding:6px 10px;">🔗</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">MCP 端点（Streamable HTTP）</label>
          <div class="p2a-row" style="display:flex; gap:6px;">
            <input id="p2aMcpUrl" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#8cf; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="p2aCopyMcp" style="padding:6px 10px;">📋</button>
            <button id="p2aOpenMcp" style="padding:6px 10px;">🔗</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">API 说明（agent.json · api.json 为其副本）</label>
          <div class="p2a-row" style="display:flex; gap:6px;">
            <input id="p2aAgentDocUrl" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#fbbf24; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="p2aCopyAgentDoc" title="复制 agent.json 地址" style="padding:6px 10px;">📋</button>
            <button id="p2aOpenAgentDoc" title="打开 agent.json" style="padding:6px 10px;">🔗</button>
            <button id="p2aOpenApiDoc" title="打开 api.json（内容与 agent.json 一致）" style="padding:6px 10px;">api.json</button>
          </div>
        </div>

        <div style="margin-bottom:10px; display:flex; flex-direction:column; gap:6px;">
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aMcpEnabled" type="checkbox">
            启用 MCP 端点 /mcp（默认开启）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aMcpWarn" type="checkbox">
            允许 MCP 执行 warn 级命令（默认开启）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aMcpDanger" type="checkbox">
            允许 MCP 执行 danger 级命令（默认关闭）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aMcpApproval" type="checkbox">
            MCP 写/执行前需页面确认（默认关闭）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aMcpReadOnly" type="checkbox">
            MCP 只读模式（禁用 exec / 写入 / 删除）
          </label>
        </div>

        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <input id="p2aMcpToken" type="text" placeholder="MCP Token（可选，留空则不校验）" style="flex:1; padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
          <button id="p2aMcpTokenGen" style="padding:6px 10px;">生成</button>
          <button id="p2aMcpTokenSave" style="padding:6px 10px;">保存</button>
        </div>

        <div style="margin:14px 0 10px; border-top:1px solid #333; padding-top:12px;">
          <b style="color:#a5b4fc; font-size:13px;">🔌 OpenAI 兼容接口（/v1）</b>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block; color:#bdc3c7; margin-bottom:4px;">Base URL（客户端填这个，注意带 /v1）</label>
          <div class="p2a-row" style="display:flex; gap:6px;">
            <input id="p2aOpenAIUrl" type="text" readonly style="flex:1; padding:6px; background:#1e1e1e; color:#8cf; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <button id="p2aCopyOpenAI" style="padding:6px 10px;">📋</button>
          </div>
        </div>

        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <input id="p2aOpenAIKey" type="text" placeholder="API Key（sk-pty-...）" style="flex:1; padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
          <button id="p2aOpenAIKeyGen" style="padding:6px 10px;">生成</button>
          <button id="p2aOpenAIKeySave" style="padding:6px 10px;">保存</button>
          <button id="p2aOpenAIKeyCopy" style="padding:6px 10px;">📋</button>
        </div>

        <div style="margin-bottom:10px; display:flex; flex-direction:column; gap:6px;">
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aOpenAIEnabled" type="checkbox">
            启用 OpenAI 兼容接口（默认关闭）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aOpenAIReadOnly" type="checkbox">
            只读模式：仅执行白名单内的安全命令（默认开启）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aOpenAIDanger" type="checkbox">
            允许 danger 级命令（默认关闭，风险极高）
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aOpenAIApproval" type="checkbox">
            执行前需页面确认（默认关闭）
          </label>
        </div>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">🔗 上游 LLM（M2 代理 / M3 agent 需要）</summary>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
            <input id="p2aOpenAIUpBase" type="text" placeholder="https://api.deepseek.com/v1" style="padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <input id="p2aOpenAIUpKey" type="text" placeholder="上游 API Key（只存在本机浏览器）" style="padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <input id="p2aOpenAIUpModel" type="text" placeholder="上游模型名，如 deepseek-chat" style="padding:6px; background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:4px; font-family:monospace; font-size:12px;">
            <div style="display:flex; gap:8px;">
              <button id="p2aOpenAIUpSave" style="flex:1; padding:6px 10px;">保存上游配置</button>
              <button id="p2aOpenAISelftest" style="flex:1; padding:6px 10px;">连通性自检</button>
            </div>
          </div>
        </details>

        <div id="p2aOpenAIHint" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; line-height:1.6; color:#9ca3af; margin-bottom:10px; white-space:pre-wrap; word-break:break-all;"></div>

        <div style="margin-bottom:10px; display:flex; flex-direction:column; gap:6px;">
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aAllowDanger" type="checkbox">
            允许 danger 级命令（rm -rf / dd / mkfs）—— 默认关闭
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#bdc3c7; cursor:pointer;">
            <input id="p2aAutoStart" type="checkbox">
            页面加载后自动启动（下次打开本页时生效）
          </label>
        </div>

        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <button id="p2aStart" style="flex:1; padding:10px; background:#27ae60; color:#fff; font-size:14px; font-weight:bold;">▶️ 启动 HTTP-Proxy</button>
          <button id="p2aStop" style="flex:1; padding:10px; background:#c0392b; color:#fff; font-size:14px; font-weight:bold; display:none;">⏹️ 停止</button>
        </div>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">📚 可用 API 路由</summary>
          <div id="p2aRoutes" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:220px; overflow:auto; line-height:1.6;"></div>
        </details>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">🧪 curl 测试示例</summary>
          <div id="p2aCurl" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:260px; overflow:auto; line-height:1.6; white-space:pre-wrap; word-break:break-all;"></div>
        </details>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">🔌 WebSocket 实时流协议</summary>
          <div id="p2aWsDoc" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:220px; overflow:auto; line-height:1.6; white-space:pre-wrap; word-break:break-all;"></div>
        </details>

        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer; color:#a5b4fc; margin-bottom:6px;">🧩 MCP 客户端配置</summary>
          <div id="p2aMcpConfig" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:260px; overflow:auto; line-height:1.6; white-space:pre-wrap; word-break:break-all;"></div>
        </details>

        <div style="margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
          <b style="color:#a5b4fc;">📋 日志</b>
          <button id="p2aClearLog" style="padding:2px 8px; font-size:11px;">清空</button>
        </div>
        <div id="p2aLog" style="background:#1e1e1e; padding:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:200px; overflow:auto; line-height:1.6;"></div>
      `;

      document.body.appendChild(panel);

      this.panelEl = panel;
      this.logEl = document.getElementById('p2aLog');

      var $ = function (id) { return document.getElementById(id); };

      $('p2aClose').onclick = function () { self.hide(); };
      $('p2aStart').onclick = function () { self._onStart(); };
      $('p2aStop').onclick = function () { self.agent.stop(); };
      $('p2aCopyId').onclick = function () { self._copy(Config.current.clientId); };
      $('p2aCopyUrl').onclick = function () { self._copy(Config.getUrl()); };
      $('p2aOpenUrl').onclick = function () { window.open(Config.getUrl() + '/api/info', '_blank'); };
      $('p2aCopyMcp').onclick = function () { self._copy(Config.getUrl() + '/mcp'); };
      $('p2aOpenMcp').onclick = function () { window.open(Config.getUrl() + '/mcp', '_blank'); };
      $('p2aCopyAgentDoc').onclick = function () { self._copy(Config.getUrl() + '/agent.json'); };
      $('p2aOpenAgentDoc').onclick = function () { window.open(Config.getUrl() + '/agent.json', '_blank'); };
      $('p2aOpenApiDoc').onclick = function () { window.open(Config.getUrl() + '/api.json', '_blank'); };
      $('p2aRegenId').onclick = function () { self._onRegenId(); };
      $('p2aClearLog').onclick = function () { self.logLines = []; self._renderLog(); };
      $('p2aMcpEnabled').onchange = function (e) {
        Config.update({ mcpEnabled: e.target.checked });
        self._log('mcpEnabled = ' + e.target.checked, e.target.checked ? 'info' : 'warn');
        self._refresh();
      };
      $('p2aMcpWarn').onchange = function (e) {
        Config.update({ mcpAllowWarn: e.target.checked });
        self._log('mcpAllowWarn = ' + e.target.checked, 'warn');
      };
      $('p2aMcpDanger').onchange = function (e) {
        Config.update({ mcpAllowDanger: e.target.checked });
        self._log('mcpAllowDanger = ' + e.target.checked, 'error');
      };
      $('p2aMcpApproval').onchange = function (e) {
        Config.update({ mcpRequireApproval: e.target.checked });
        self._log('mcpRequireApproval = ' + e.target.checked, 'warn');
      };
      $('p2aMcpReadOnly').onchange = function (e) {
        Config.update({ mcpReadOnly: e.target.checked });
        self._log('mcpReadOnly = ' + e.target.checked, e.target.checked ? 'warn' : 'info');
        self._refresh();
      };
      $('p2aMcpTokenGen').onclick = function () {
        var token;
        try {
          if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            var bytes = new Uint8Array(24);
            window.crypto.getRandomValues(bytes);
            token = 'mcp_' + Array.prototype.map.call(bytes, function (b) {
              return ('0' + b.toString(16)).slice(-2);
            }).join('');
          }
        } catch (e) { token = null; }
        if (!token) {
          token = 'mcp_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        }
        $('p2aMcpToken').value = token;
        Config.update({ mcpToken: token });
        self._log('已生成 MCP Token（所有 MCP 请求需带 Authorization: Bearer）', 'warn');
      };
      $('p2aMcpTokenSave').onclick = function () {
        Config.update({ mcpToken: $('p2aMcpToken').value.trim() });
        self._log('MCP Token 已保存', 'info');
      };

      // ---------------- OpenAI 兼容接口 ----------------
      $('p2aCopyOpenAI').onclick = function () { self._copy((self.agent.getStatus().url || Config.getUrl()) + '/v1'); };
      $('p2aOpenAIKeyGen').onclick = function () {
        var key = genApiKey();
        $('p2aOpenAIKey').value = key;
        Config.update({ openaiApiKey: key });
        self._log('已生成 OpenAI 兼容 API Key（客户端用 Authorization: Bearer ' + key.slice(0, 12) + '...）', 'warn');
        self._refresh();
      };
      $('p2aOpenAIKeyCopy').onclick = function () {
        var key = $('p2aOpenAIKey').value.trim() || Config.current.openaiApiKey || '';
        if (!key) {
          self._log('还没有 API Key，先点「生成」', 'error');
          return;
        }
        self._copy(key);
      };
      $('p2aOpenAIKeySave').onclick = function () {
        Config.update({ openaiApiKey: $('p2aOpenAIKey').value.trim() });
        self._log('OpenAI API Key 已保存', 'info');
        self._refresh();
      };
      $('p2aOpenAIEnabled').onchange = function (e) {
        var on = e.target.checked;
        var patch = { openaiEnabled: on };
        // 启用但没有 Key 是死胡同（客户端一律 401 no_api_key_configured），这里自动补一个
        if (on && !(Config.current.openaiApiKey || '').trim()) {
          var key = genApiKey();
          patch.openaiApiKey = key;
          $('p2aOpenAIKey').value = key;
          self._log('已启用，并自动生成 API Key：' + key, 'warn');
        } else {
          self._log('openaiEnabled = ' + on, on ? 'warn' : 'info');
        }
        Config.update(patch);
        self._refresh();
      };
      $('p2aOpenAIReadOnly').onchange = function (e) {
        Config.update({ openaiReadOnly: e.target.checked });
        self._log('openaiReadOnly = ' + e.target.checked, e.target.checked ? 'info' : 'warn');
      };
      $('p2aOpenAIDanger').onchange = function (e) {
        Config.update({ openaiAllowDanger: e.target.checked });
        self._log('openaiAllowDanger = ' + e.target.checked, 'error');
      };
      $('p2aOpenAIApproval').onchange = function (e) {
        Config.update({ openaiRequireApproval: e.target.checked });
        self._log('openaiRequireApproval = ' + e.target.checked, 'warn');
      };
      $('p2aOpenAIUpSave').onclick = function () {
        Config.update({
          openaiUpstreamBase: $('p2aOpenAIUpBase').value.trim(),
          openaiUpstreamKey: $('p2aOpenAIUpKey').value.trim(),
          openaiUpstreamModel: $('p2aOpenAIUpModel').value.trim()
        });
        self._log('上游 LLM 配置已保存（仅存本机浏览器）', 'info');
        self._refresh();
      };
      $('p2aOpenAISelftest').onclick = async function () {
        self._log('正在自检 OpenAI 兼容接口...', 'info');
        try {
          var res = await fetch((self.agent.getStatus().url || Config.getUrl()) + '/v1/_selftest', {
            headers: { authorization: 'Bearer ' + ($('p2aOpenAIKey').value.trim() || Config.current.openaiApiKey || '') }
          });
          var json = await res.json();
          var lines = [];
          var chk = json.checks || {};
          lines.push('鉴权：' + (chk.auth || '?'));
          if (chk.host) lines.push('主机：' + (chk.host.id || '-') + (chk.host.connected ? ' 已连接' : ' 未连接'));
          if (chk.exec) lines.push('执行：' + (chk.exec.ok ? 'ok ' + (chk.exec.sample || '') : '失败 ' + (chk.exec.reason || '')));
          if (chk.sse) lines.push('SSE：' + chk.sse.transport + ' / ' + chk.sse.framing);
          if (chk.upstream) lines.push('上游：' + (chk.upstream.reachable ? 'ok ' + (chk.upstream.status || '') : '不可用 ' + (chk.upstream.reason || '')));
          self._log('自检结果\n' + lines.join('\n'), json.ok ? 'success' : 'warn');
        } catch (e) {
          self._log('自检失败：' + ((e && e.message) || e), 'error');
        }
      };
      $('p2aAllowDanger').onchange = function (e) {
        Config.update({ allowDanger: e.target.checked });
        self._log('allowDanger = ' + e.target.checked, 'warn');
      };
      $('p2aAutoStart').onchange = function (e) {
        Config.update({ autoStart: e.target.checked });
        self._log('autoStart = ' + e.target.checked, 'info');
      };

      this._log('sdk.js v' + SDK_VERSION + ' 已就绪，点击「启动 HTTP-Proxy」开始', 'info');
      this._refresh();
      this._renderRoutes();
      this._renderCurl();
      this._renderWsDoc();
      this._renderMcpConfig();
    }

    show() {
      if (!this.panelEl) this.mount();
      if (!this.panelEl) return;
      this.panelEl.style.display = 'block';
      this._refresh();
    }

    hide() {
      if (this.panelEl) this.panelEl.style.display = 'none';
    }

    async _onStart() {
      try {
        this._log('正在启动 sdk.js 隧道...', 'info');
        await this.agent.start();
      } catch (e) {
        this._log('启动失败：' + ((e && e.message) || e), 'error');
        this._refresh();
      }
    }

    async _onRegenId() {
      if (!confirm('重置 Client ID 会改变 Agent URL（ai.pty2.<clientId>.html.dtns.top），AI 端需要重新配置。继续？')) {
        return;
      }
      var wasStarted = !!this.agent.app;
      Config.regenerateClientId();
      this._log('Client ID 已重置：' + Config.current.clientId, 'warn');
      this._refresh();
      if (wasStarted) {
        try {
          await this.agent.restart();
        } catch (e) {
          this._log('重启失败：' + ((e && e.message) || e), 'error');
        }
      }
    }

    async _copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        this._log('已复制：' + text, 'success');
      } catch (e) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          this._log('已复制：' + text, 'success');
        } catch (err) {
          this._log('复制失败，请手动复制', 'error');
        }
      }
    }

    _refresh() {
      if (!this.panelEl) return;

      var $ = function (id) { return document.getElementById(id); };
      var status = this.agent.getStatus();
      var cfg = Config.get();

      $('p2aStart').style.display = status.started ? 'none' : 'block';
      $('p2aStop').style.display = status.started ? 'block' : 'none';
      $('p2aClientId').value = status.clientId || '';
      $('p2aUrl').value = status.url || '';
      $('p2aMcpUrl').value = (status.url || Config.getUrl()) + '/mcp';
      $('p2aAgentDocUrl').value = (status.url || Config.getUrl()) + '/agent.json';
      $('p2aAllowDanger').checked = cfg.allowDanger === true;
      $('p2aAutoStart').checked = cfg.autoStart === true;
      $('p2aMcpEnabled').checked = cfg.mcpEnabled !== false;
      $('p2aMcpWarn').checked = cfg.mcpAllowWarn !== false;
      $('p2aMcpDanger').checked = cfg.mcpAllowDanger === true;
      $('p2aMcpApproval').checked = cfg.mcpRequireApproval === true;
      $('p2aMcpReadOnly').checked = cfg.mcpReadOnly === true;
      if (document.activeElement !== $('p2aMcpToken')) {
        $('p2aMcpToken').value = cfg.mcpToken || '';
      }

      var baseUrl = status.url || Config.getUrl();
      $('p2aOpenAIUrl').value = baseUrl + '/v1';
      $('p2aOpenAIEnabled').checked = cfg.openaiEnabled === true;
      $('p2aOpenAIReadOnly').checked = cfg.openaiReadOnly === true;
      $('p2aOpenAIDanger').checked = cfg.openaiAllowDanger === true;
      $('p2aOpenAIApproval').checked = cfg.openaiRequireApproval === true;
      if (document.activeElement !== $('p2aOpenAIKey')) {
        $('p2aOpenAIKey').value = cfg.openaiApiKey || '';
      }
      if (document.activeElement !== $('p2aOpenAIUpBase')) $('p2aOpenAIUpBase').value = cfg.openaiUpstreamBase || '';
      if (document.activeElement !== $('p2aOpenAIUpKey')) $('p2aOpenAIUpKey').value = cfg.openaiUpstreamKey || '';
      if (document.activeElement !== $('p2aOpenAIUpModel')) $('p2aOpenAIUpModel').value = cfg.openaiUpstreamModel || '';
      $('p2aOpenAIHint').textContent = [
        '# 客户端配置',
        'Base URL : ' + baseUrl + '/v1',
        'API Key  : ' + (cfg.openaiApiKey ? cfg.openaiApiKey.slice(0, 14) + '...' : '（未生成 —— 客户端会收到 401 no_api_key_configured）'),
        '',
        '# 模型',
        'pty-exec            消息即命令，不调 LLM',
        'pty-exec@<hostId>   指定主机',
        'pty-agent           上游 LLM + PTY 工具（需配置上游）',
        (cfg.openaiUpstreamModel || '<上游模型名>') + '    原样代理到上游',
        '',
        '# 试一下',
        'curl ' + baseUrl + '/v1/models -H "Authorization: Bearer <key>"'
      ].join('\n');

      var dot = function (ok) { return ok ? '🟢' : '🔴'; };
      var uptime = function (ms) {
        if (!ms) return '-';
        var sec = Math.floor(ms / 1000);
        var min = Math.floor(sec / 60);
        var hour = Math.floor(min / 60);
        if (hour > 0) return hour + 'h ' + (min % 60) + 'm';
        if (min > 0) return min + 'm ' + (sec % 60) + 's';
        return sec + 's';
      };
      var mcpStats = status.mcp || { toolCalls: 0, requests: 0, errors: 0, tools: 0 };

      $('p2aStatus').innerHTML = [
        '<div>' + dot(status.started) + ' 服务：<b>' + (status.started ? '运行中' : '未启动') + '</b>' +
          (status.sdkVersion ? ' <span style="color:#777;">sdk.js v' + escapeHtml(status.sdkVersion) + '</span>' : '') + '</div>',
        '<div>' + dot(status.connected) + ' 隧道：<b>' + (status.connected ? '已连接' : '未连接') + '</b></div>',
        '<div>' + dot(status.registered) + ' 域名：<b>' + (status.registered ? '已注册' : '未注册') + '</b></div>',
        '<div>🔌 MCP：<b>' + (cfg.mcpEnabled !== false ? (cfg.mcpReadOnly === true ? '只读' : '启用') : '关闭') + '</b> · 工具 ' +
          (mcpStats.tools || 0) + ' · 调用 ' + (mcpStats.toolCalls || 0) +
          ' 次 · 错误 ' + (mcpStats.errors || 0) + ' 次</div>',
        '<div>🤖 OpenAI：<b>' + (cfg.openaiEnabled === true ? (cfg.openaiReadOnly === true ? '只读' : '启用') : '关闭') + '</b>' +
          (cfg.openaiApiKey ? '' : ' · <span style="color:#e67e22;">未生成 Key</span>') +
          ' · ' + (status.openai && status.openai.chatCalls ? status.openai.chatCalls : 0) + ' 次调用' +
          (status.openai && status.openai.toolCalls ? ' · 工具 ' + status.openai.toolCalls + ' 次' : '') + '</div>',
        '<div>📊 请求 ' + (status.requests || 0) + ' 次 · 错误 ' + (status.errors || 0) +
          ' 次 · WebSocket ' + (status.websockets || 0) + ' 个</div>',
        status.started
          ? '<div>⏱️ 运行 <b>' + uptime(status.uptimeMs) + '</b> · 重连 ' + (status.reconnects || 0) + ' 次</div>'
          : '',
        '<div style="color:#888;">🔗 隧道服务：' + escapeHtml(cfg.wsUrl || DEFAULT_WS_URL) + '</div>'
      ].join('');

      this._renderMcpConfig();
    }

    _renderRoutes() {
      if (!this.panelEl) return;
      var el = document.getElementById('p2aRoutes');
      if (!el) return;

      el.innerHTML = this.agent.listRoutes().map(function (r) {
        var color = r.method === 'WS' ? '#c084fc'
          : (r.method === 'MCP' ? '#f472b6'
            : (r.path.indexOf('/v1/') === 0 ? '#34d399'
              : (r.method === 'GET' ? '#6ee7b7' : '#fbbf24')));
        return '<div><span style="color:' + color + '; font-weight:bold;">' + r.method + '</span> ' +
          escapeHtml(r.path) + '<span style="color:#777;"> — ' + escapeHtml(r.desc || '') + '</span></div>';
      }).join('');
    }

    _renderCurl() {
      if (!this.panelEl) return;
      var el = document.getElementById('p2aCurl');
      if (!el) return;

      var url = Config.getUrl();
      el.textContent = [
        '# 0. 端点索引',
        'curl ' + url + '/',
        '',
        '# 0.1 机器可读 API 说明（全部路由 / 参数 / 示例；api.json 内容相同）',
        'curl ' + url + '/agent.json',
        '',
        '# 1. 健康检查',
        'curl ' + url + '/health',
        '',
        '# 2. 能力与主机',
        'curl ' + url + '/api/info',
        '',
        '# 3. 执行命令（最常用）',
        'curl -X POST ' + url + '/api/exec \\',
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"command": "uname -a && whoami"}\'',
        '',
        '# 4. 危险命令 → 默认 403，需要 confirm=true',
        'curl -X POST ' + url + '/api/exec \\',
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"command": "rm -rf /tmp/x", "confirm": true}\'',
        '',
        '# 5. 安全检查',
        'curl -G ' + url + '/api/security/check \\',
        '  --data-urlencode "command=rm -rf /"',
        '',
        '# 6. 新建终端 → 写入 → 读取',
        'curl -X POST ' + url + '/api/pty/create \\',
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"backend": "local", "cols": 100, "rows": 30}\'',
        'curl -X POST ' + url + '/api/pty/write \\',
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"termId": "<termId>", "data": "ls -al", "enter": true}\'',
        'curl "' + url + '/api/pty/read?termId=<termId>&lines=50"',
        '',
        '# 7. 文件列表 / 原始二进制上传 / 下载',
        'curl ' + url + '/api/fs/list',
        'curl -X POST "' + url + '/api/fs/upload?name=a.txt&rel=a.txt" \\',
        "  -H 'Content-Type: application/octet-stream' --data-binary @a.txt",
        'curl -o a.txt "' + url + '/api/fs/download?name=a.txt&raw=1"',
        '',
        '# 8. AI 上下文',
        'curl "' + url + '/api/ai/context?lines=30"',
        '',
        '# 9. MCP：GET 端点信息（也可用 Accept: text/event-stream 取单条 SSE）',
        'curl ' + url + '/mcp',
        '',
        '# 10. MCP：legacy initialize（2025-06-18）',
        'curl -X POST ' + url + '/mcp \\',
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}\'',
        '',
        '# 11. MCP：modern tools/list（2026-07-28）',
        'curl -X POST ' + url + '/mcp \\',
        "  -H 'Content-Type: application/json' \\",
        "  -H 'Accept: application/json, text/event-stream' \\",
        "  -H 'MCP-Protocol-Version: 2026-07-28' \\",
        "  -H 'Mcp-Method: tools/list' \\",
        '  -d \'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}\'',
        '',
        '# 12. MCP：tools/call host_list',
        'curl -X POST ' + url + '/mcp \\',
        "  -H 'Content-Type: application/json' \\",
        "  -H 'MCP-Protocol-Version: 2026-07-28' \\",
        "  -H 'Mcp-Method: tools/call' \\",
        "  -H 'Mcp-Name: host_list' \\",
        '  -d \'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"host_list","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}\'',
        '',
        '# 13. OpenAI 兼容：模型列表',
        'curl ' + url + '/v1/models -H "Authorization: Bearer <sk-pty-key>"',
        '',
        '# 14. OpenAI 兼容：执行命令（pty-exec）',
        'curl -X POST ' + url + '/v1/chat/completions \\',
        "  -H 'Authorization: Bearer <sk-pty-key>' \\",
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"model":"pty-exec","messages":[{"role":"user","content":"uname -a"}]}\'',
        '',
        '# 15. OpenAI 兼容：流式（pty-agent，需先配上游）',
        'curl -N -X POST ' + url + '/v1/chat/completions \\',
        "  -H 'Authorization: Bearer <sk-pty-key>' \\",
        "  -H 'Content-Type: application/json' \\",
        '  -d \'{"model":"pty-agent","stream":true,"messages":[{"role":"user","content":"看看磁盘还剩多少"}]}\''
      ].join('\n');
    }

    _renderWsDoc() {
      if (!this.panelEl) return;
      var el = document.getElementById('p2aWsDoc');
      if (!el) return;

      var wsUrl = Config.getUrl().replace(/^http/, 'ws');
      el.textContent = [
        '# 连接（termId 可省略，默认当前页面激活的终端）',
        wsUrl + '/api/pty/stream?termId=<termId>&lines=50',
        '',
        '# 服务端 → 客户端（JSON 文本帧）',
        '{"type":"ready","termId":"...","backend":"local","inUI":true}',
        '{"type":"snapshot","termId":"...","lines":["..."]}',
        '{"type":"data","termId":"...","data":"...终端输出..."}',
        '{"type":"exit","termId":"...","code":0}',
        '{"type":"pong","t":1700000000000}',
        '',
        '# 客户端 → 服务端',
        '{"type":"input","data":"ls -al","enter":true}',
        '{"type":"resize","cols":120,"rows":40}',
        '{"type":"read","lines":100}',
        '{"type":"ping"}',
        '',
        '# 非 JSON 文本帧会被当成原始键盘输入直接写入 PTY'
      ].join('\n');
    }

    _log(msg, type) {
      this.logLines.unshift({
        time: new Date().toLocaleTimeString(),
        msg: String(msg),
        type: type || 'info'
      });
      if (this.logLines.length > 100) this.logLines.pop();
      this._renderLog();
    }

    _renderMcpConfig() {
      if (!this.panelEl) return;
      var el = document.getElementById('p2aMcpConfig');
      if (!el) return;

      var endpoint = Config.getUrl() + '/mcp';
      var config = {
        mcpServers: {
          pty2: {
            command: 'npx',
            args: ['-y', 'mcp-remote', endpoint]
          }
        }
      };

      el.textContent = [
        '# Claude Desktop / Cursor（经 mcp-remote 桥接）',
        JSON.stringify(config, null, 2),
        '',
        '# MCP Inspector',
        'npx @modelcontextprotocol/inspector',
        '# Transport: Streamable HTTP',
        '# URL: ' + endpoint,
        '',
        '# 说明',
        '# - GET  /mcp 返回端点信息；Accept: text/event-stream 时走 SSE 流',
        '# - POST /mcp 支持 JSON 或 SSE 响应（SSE 逐条推送，由隧道旧 SSE 旁路承载）',
        '# - subscriptions/listen 会保持 SSE 连接并返回 acknowledged',
        '# - modern 2026-07-28 需要 MCP-Protocol-Version / Mcp-Method / Mcp-Name 头',
        '# - legacy 2025-06-18 直接 initialize + tools/list + tools/call'
      ].join('\n');
    }

    _renderLog() {
      if (!this.logEl) return;
      var colors = { info: '#93c5fd', success: '#6ee7b7', warn: '#fbbf24', error: '#f87171' };
      this.logEl.innerHTML = this.logLines.map(function (line) {
        var color = colors[line.type] || '#ccc';
        return '<div style="color:' + color + ';"><span style="color:#666;">[' +
          escapeHtml(line.time) + ']</span> ' + escapeHtml(line.msg) + '</div>';
      }).join('');
    }
  }

  // ============================================================
  // 11. 对外入口
  // ============================================================
  class Pty2Agent {
    constructor(ctx) {
      this.ctx = ctx || {};
      this.config = Config;
      this.app = null;
      this._events = {};
      this.ui = new Pty2AgentUI(this);
    }

    on(event, fn) {
      if (typeof fn === 'function') {
        (this._events[event] = this._events[event] || []).push(fn);
      }
      return this;
    }

    off(event, fn) {
      var list = this._events[event];
      if (!list) return this;
      if (!fn) { delete this._events[event]; return this; }
      this._events[event] = list.filter(function (item) { return item !== fn; });
      return this;
    }

    emit(event, data) {
      var list = (this._events[event] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch (e) { console.warn('[Pty2Agent] listener error:', e); }
      }
      return this;
    }

    mount() {
      this.ui.mount();
      return this;
    }

    getDomain() { return Config.getDomain(Config.current.clientId); }
    getUrl() { return Config.getUrl(Config.current.clientId); }

    async start() {
      if (this.app) return this.app;

      if (!SDK) {
        throw new Error('DTNSAgent 未加载：请确认 ./js/sdk.js 在 pty2-agent.js 之前引入');
      }

      var cfg = Config.get();
      var domain = Config.getDomain(cfg.clientId);

      Config.update({ enabled: true });

      var app;
      try {
        app = SDK.app({
          domain: domain,
          clientId: cfg.clientId,
          wsUrl: cfg.wsUrl || DEFAULT_WS_URL,
          description: 'PTY Agent - HTTP API (sdk.js)',
          maxBodySize: MAX_BODY_SIZE,
          heartbeatInterval: 25000,
          reconnect: true,
          exposeErrors: true
        });
      } catch (e) {
        Config.update({ enabled: false });
        throw e;
      }

      this.emit('connecting', {
        domain: domain,
        url: app.apiBase,
        apiBase: app.apiBase,
        clientId: cfg.clientId
      });

      var self = this;
      defineRoutes(app, this.ctx, {
        log: function (msg, level) { self.ui._log(msg, level || 'info'); }
      });

      app.on('reconnected', function () { self.emit('reconnected', self.getStatus()); });
      app.on('disconnected', function (info) { self.emit('disconnected', info); });
      app.on('reconnecting', function (info) { self.emit('reconnecting', info); });
      app.on('error', function (err) {
        self.emit('error', { error: (err && err.message) || String(err), code: err && err.code });
      });
      app.on('request', function (info) { self.emit('request', info); });
      app.on('websocket', function (info) { self.emit('websocket', info); });

      this.app = app;

      try {
        await app.listen();
      } catch (e) {
        this.app = null;
        Config.update({ enabled: false });
        try { app.close(); } catch (err) { /* ignore */ }
        this.emit('error', { error: (e && e.message) || String(e), code: e && e.code });
        throw e;
      }

      var status = this.getStatus();
      this.emit('started', status);
      return app;
    }

    stop() {
      var app = this.app;
      this.app = null;

      if (app) {
        try { app.close(); } catch (e) { /* ignore */ }
      }
      Config.update({ enabled: false });
      this.emit('stopped', this.getStatus());
    }

    async restart() {
      this.stop();
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      return this.start();
    }

    listRoutes() {
      return ROUTE_INFO.map(function (r) {
        return { method: r[0], path: r[1], desc: r[2] };
      });
    }

    getStatus() {
      var cfg = Config.get();
      var mcpStats = this.app && this.app.__mcpServer ? this.app.__mcpServer.stats() : {
        enabled: cfg.mcpEnabled !== false,
        requests: 0,
        errors: 0,
        denied: 0,
        toolCalls: 0,
        active: 0,
        tools: ROOT.Pty2Mcp ? ROOT.Pty2Mcp.TOOLS.length : 0,
        resources: 0,
        prompts: 0,
        uptimeMs: 0,
        toolCounts: {},
        recent: []
      };
      var base = {
        started: !!this.app,
        enabled: cfg.enabled === true,
        autoStart: cfg.autoStart === true,
        allowDanger: cfg.allowDanger === true,
        clientId: cfg.clientId,
        domain: Config.getDomain(cfg.clientId),
        url: Config.getUrl(cfg.clientId),
        wsUrl: cfg.wsUrl || DEFAULT_WS_URL,
        sdkVersion: SDK ? SDK.version : null,
        mcp: mcpStats,
        openai: this.app && this.app.__openaiServer ? this.app.__openaiServer.stats() : {
          enabled: cfg.openaiEnabled === true,
          requests: 0,
          chatCalls: 0,
          toolCalls: 0,
          errors: 0,
          keySet: !!cfg.openaiApiKey,
          mode: cfg.openaiMode || 'exec'
        }
      };

      if (!this.app) {
        return Object.assign(base, {
          connected: false,
          registered: false,
          listening: false,
          requests: 0,
          errors: 0,
          reconnects: 0,
          uptimeMs: 0,
          websockets: 0,
          routes: ROUTE_INFO.length
        });
      }

      return Object.assign(base, this.app.status(), {
        started: true,
        allowDanger: cfg.allowDanger === true,
        autoStart: cfg.autoStart === true,
        sdkVersion: SDK ? SDK.version : null,
        mcp: mcpStats
      });
    }
  }

  ROOT.Pty2Agent = Pty2Agent;
  ROOT.Pty2AgentConfig = Config;
  ROOT.Pty2AgentBase64 = Base64;
  ROOT.Pty2AgentRoutes = ROUTE_INFO;
  ROOT.Pty2AgentUtil = { genApiKey: genApiKey, checkCommandSafety: checkCommandSafety };
  ROOT.Pty2AgentSecurity = {
    checkCommandSafety: checkCommandSafety,
    DANGEROUS_PATTERNS: DANGEROUS_PATTERNS,
    SAFE_COMMAND_PREFIXES: SAFE_COMMAND_PREFIXES,
    SAFE_SUDO_PREFIXES: SAFE_SUDO_PREFIXES
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Pty2Agent;
    module.exports.Pty2Agent = Pty2Agent;
    module.exports.defineRoutes = defineRoutes;
    module.exports.defineOpenAICompatRoutes = defineOpenAICompatRoutes;
    module.exports.Config = Config;
    module.exports.ROUTE_INFO = ROUTE_INFO;
    module.exports.Security = ROOT.Pty2AgentSecurity;
  }
})();
