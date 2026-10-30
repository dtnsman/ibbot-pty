// openai-compat.js
// OpenAI 兼容接口适配层（/v1/*）—— 把 PTY Agent 包装成"OpenAI 模型"。
//
// 设计要点：
//   - 薄适配层：所有执行动作都复用 pty2-agent.js 已注册的 /api/* handler
//     （通过 deps.call 注入），本文件只做协议翻译，不重复实现任何执行逻辑。
//   - 三种后端，按 model 名分流：
//       pty-exec[@host]  → 消息即命令，直接 exec，不调 LLM
//       pty-agent[@host] → 上游 LLM + 注入 PTY 工具 + 本层跑 agent 循环
//       <任意模型名>      → 原样透传上游 LLM
//   - 流式：sdk.js 的 SseResponse 每个 res.write() 会被中继包成一条 `data:` 帧，
//     所以 SSE 模式下只写纯 JSON 事件体（不自己加 "data: " 前缀）；
//     若中继没有走 SSE 通道（客户端没带 Accept: text/event-stream），
//     则整包缓冲后一次性以 text/event-stream 返回，客户端仍能正确解析。
//   - 错误统一为 OpenAI 信封 {error:{message,type,param,code}}。
//
// 依赖：无（浏览器挂 window.Pty2OpenAI，Node 下同时挂 globalThis）。

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof globalThis !== 'undefined') globalThis.Pty2OpenAI = api;
  } else {
    root.Pty2OpenAI = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var SERVER_NAME = 'pty2-openai';
  var DEFAULT_TOOL_TEXT = 16000;
  var DEFAULT_RATE = 60;
  var MAX_FRAMES = 600;

  // M3 允许注入给上游模型的工具（不含二进制上传下载，避免撑爆上下文）
  var AGENT_TOOL_NAMES = [
    'exec', 'pty_list', 'pty_create', 'pty_write', 'pty_read',
    'fs_list', 'host_list', 'host_status', 'ai_context'
  ];

  // ============================================================
  // 基础工具
  // ============================================================
  function now() { return Date.now(); }

  function uid(prefix) {
    return (prefix || '') + now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function truncate(text, limit) {
    var s = String(text == null ? '' : text);
    var max = limit || DEFAULT_TOOL_TEXT;
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…[已截断 ' + (s.length - max) + ' 字符]';
  }

  function safeStringify(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (e) { return String(value); }
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
  }

  function safeEqual(a, b) {
    var s1 = String(a == null ? '' : a);
    var s2 = String(b == null ? '' : b);
    if (s1.length !== s2.length) return false;
    var diff = 0;
    for (var i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
    return diff === 0;
  }

  function trimSlash(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  function toolError(message) {
    var err = new Error(String(message));
    err.toolError = true;
    return err;
  }

  // 粗略 token 估算：CJK 约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token
  var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

  function estimateTokens(text) {
    var s = String(text == null ? '' : text);
    if (!s) return 0;
    var cjk = (s.match(CJK_RE) || []).length;
    var rest = s.length - cjk;
    return Math.max(1, Math.round(cjk * 1.05 + rest / 4));
  }

  function estimateMessagesTokens(messages) {
    var total = 0;
    (messages || []).forEach(function (m) {
      total += 4;
      total += estimateTokens(typeof m.content === 'string' ? m.content : safeStringify(m.content));
    });
    return total;
  }

  function usageOf(messages, text, source) {
    var p = estimateMessagesTokens(messages);
    var c = estimateTokens(text);
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, source: source || 'estimated' };
  }

  // ============================================================
  // 消息归一化
  // ============================================================
  function contentToText(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var parts = [];
      content.forEach(function (p) {
        if (typeof p === 'string') { parts.push(p); return; }
        if (!isObject(p)) return;
        if (typeof p.text === 'string') { parts.push(p.text); return; }
        if (typeof p.content === 'string') { parts.push(p.content); return; }
        if (p.type === 'image_url' || p.type === 'image') parts.push('[图片已忽略]');
      });
      return parts.join('\n');
    }
    if (isObject(content) && typeof content.text === 'string') return content.text;
    return safeStringify(content);
  }

  function normalizeMessages(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!isObject(m)) continue;
      var role = String(m.role || 'user').toLowerCase();
      if (role === 'tool' || role === 'function') continue;
      if (role === 'developer') role = 'system';
      var text = contentToText(m.content);
      if (!text) continue;
      out.push({ role: role, content: text });
    }
    return out;
  }

  // 有些客户端（Cherry Studio 等）在切换模型后会**追加一条 user 消息**告知上下文变化，形如：
  //   [model changed: assistant turns above this point were generated by A; the session continues with B]
  // 这条不是指令。exec 模式若把它当命令执行，就会出现「被安全策略阻止」的莫名其妙结果。
  var NOTICE_LINE_RE = /^\s*\[\s*(?:model changed|system notice|context (?:reset|cleared)|note)\s*:[^\]]*\]\s*$/i;

  function stripClientNotices(text) {
    var lines = String(text || '').split(/\r?\n/);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      if (!NOTICE_LINE_RE.test(lines[i])) kept.push(lines[i]);
    }
    return kept.join('\n').trim();
  }

  function lastUserText(messages) {
    for (var i = (messages || []).length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      var raw = String(messages[i].content || '').trim();
      if (!raw) continue;
      var text = stripClientNotices(raw);
      if (text) return text;
    }
    return '';
  }

  function historyContext(messages, limit) {
    var history = (messages || []).filter(function (m) { return m.role !== 'system'; });
    if (history.length <= 1) return '';
    var prev = history.slice(0, -1).slice(-4);
    var lines = prev.map(function (m) {
      return '[' + m.role + '] ' + truncate(m.content, 400);
    });
    return truncate(lines.join('\n'), limit || 2000);
  }

  // ============================================================
  // 流式输出器
  // ============================================================
  function makeEmitter(res) {
    var progressive = !!(res && res.isSse === true);
    var buffer = '';
    var closed = false;
    var started = false;

    function writeRaw(text) {
      if (closed) return;
      if (progressive) {
        try { res.write(text); } catch (e) { closed = true; }
      } else {
        buffer += text;
      }
    }

    return {
      progressive: progressive,
      started: function () { return started; },
      start: function () {
        if (started) return;
        started = true;
        try {
          res.status(200);
          res.set('content-type', 'text/event-stream; charset=utf-8');
          res.set('cache-control', 'no-cache');
          res.set('x-accel-buffering', 'no');
        } catch (e) { /* ignore */ }
      },
      // SSE 事件体：progressive 模式由中继补 "data: "，缓冲模式自己补
      data: function (payload) {
        this.start();
        var text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        writeRaw(progressive ? text : 'data: ' + text + '\n\n');
      },
      // 具名事件（Responses API）：缓冲模式能写 event: 行，progressive 模式只能靠 payload.type
      named: function (name, payload) {
        this.start();
        var text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (progressive) writeRaw(text);
        else writeRaw('event: ' + name + '\ndata: ' + text + '\n\n');
      },
      end: function () {
        if (closed) return;
        closed = true;
        if (progressive) {
          try { res.end(); } catch (e) { /* ignore */ }
        } else {
          try { res.status(200).end(buffer); } catch (e) { /* ignore */ }
        }
      }
    };
  }

  function splitChunks(text, maxChars) {
    var limit = maxChars || 240;
    var lines = String(text == null ? '' : text).split('\n');
    var out = [];
    var cur = '';
    for (var i = 0; i < lines.length; i++) {
      var piece = lines[i] + (i < lines.length - 1 ? '\n' : '');
      if (cur && cur.length + piece.length > limit) { out.push(cur); cur = ''; }
      cur += piece;
    }
    if (cur) out.push(cur);
    if (!out.length) out.push('');
    if (out.length > MAX_FRAMES) {
      var head = out.slice(0, MAX_FRAMES - 1);
      head.push(out.slice(MAX_FRAMES - 1).join(''));
      out = head;
    }
    return out;
  }

  // ============================================================
  // OpenAI tools 转换
  // ============================================================
  function toOpenAITools(mcpTools, options) {
    var opts = options || {};
    var allow = opts.names || null;
    var list = [];
    (mcpTools || []).forEach(function (tool) {
      if (allow && allow.indexOf(tool.name) === -1) return;
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: String(tool.description || tool.title || tool.name),
          parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
      });
    });
    return list;
  }

  // ============================================================
  // 模型名解析
  // ============================================================
  function classifyModel(cfg, name) {
    var raw = String(name == null ? '' : name).trim();
    var at = raw.indexOf('@');
    var base = at >= 0 ? raw.slice(0, at) : raw;
    var hostId = at >= 0 ? raw.slice(at + 1) : null;

    if (base === 'pty-exec') return { kind: 'exec', model: raw, hostId: hostId };
    if (base === 'pty-agent') return { kind: 'agent', model: raw, hostId: hostId };
    if (base === 'pty-proxy') return { kind: 'proxy', model: raw, hostId: hostId };

    if (!raw) {
      var fallback = String(cfg.openaiMode || 'exec');
      if (fallback === 'agent') return { kind: 'agent', model: 'pty-agent', hostId: null };
      if (fallback === 'proxy') return { kind: 'proxy', model: cfg.openaiUpstreamModel || '', hostId: null };
      return { kind: 'exec', model: 'pty-exec', hostId: null };
    }
    return { kind: 'proxy', model: raw, hostId: hostId };
  }

  // ============================================================
  // createServer
  // ============================================================
  function createServer(options) {
    options = options || {};

    var call = typeof options.call === 'function' ? options.call : function () {
      return Promise.reject(new Error('openai: call() not configured'));
    };
    var getConfig = typeof options.getConfig === 'function' ? options.getConfig : function () { return {}; };
    var getService = typeof options.getService === 'function' ? options.getService : function () { return {}; };
    var getHosts = typeof options.getHosts === 'function' ? options.getHosts : function () { return []; };
    var log = typeof options.log === 'function' ? options.log : function () { };
    var confirm = typeof options.confirm === 'function' ? options.confirm : function () { return Promise.resolve(false); };
    var fetchImpl = typeof options.fetch === 'function' ? options.fetch : null;

    // 延迟解析 fetch：既支持注入，也允许运行时替换 global.fetch（测试 / polyfill）
    function getFetch() {
      if (fetchImpl) return fetchImpl;
      return typeof fetch === 'function' ? fetch : null;
    }

    var state = {
      requests: 0,
      errors: 0,
      denied: 0,
      chatCalls: 0,
      toolCalls: 0,
      blocked: 0,
      active: 0,
      startedAt: now(),
      toolCounts: {},
      recent: []
    };
    var rateBucket = [];

    function cfg() { return getConfig() || {}; }

    function enabled() { return cfg().openaiEnabled === true; }

    function logEvent(entry) {
      var item = Object.assign({ time: new Date().toISOString() }, entry || {});
      state.recent.push(item);
      if (state.recent.length > 40) state.recent.shift();
      try { log(item); } catch (e) { /* ignore */ }
    }

    // ---------------- 响应工具 ----------------
    function sendError(res, status, code, message, type, param) {
      state.errors += 1;
      return res.status(status || 500).json({
        error: {
          message: String(message || 'error'),
          type: type || 'invalid_request_error',
          param: param === undefined ? null : param,
          code: code || null
        }
      });
    }

    function preflight(req, res) {
      if (!req) return null;
      if (String(req.method).toUpperCase() === 'OPTIONS') {
        res.status(204).end();
        return true;
      }
      return null;
    }

    // ---------------- 鉴权 / 限流 ----------------
    function pickKey(req) {
      var auth = String((req.get && req.get('authorization')) || '');
      var m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m) return m[1].trim();
      var alt = req.get && (req.get('x-api-key') || req.get('api-key'));
      if (alt) return String(alt).trim();
      if (req.query && typeof req.query.api_key === 'string') return req.query.api_key;
      return '';
    }

    // 返回 null 表示通过，否则返回 [status, code, message]
    function checkAuth(req) {
      var c = cfg();
      var expected = String(c.openaiApiKey || '');
      if (!expected) {
        return [401, 'no_api_key_configured', '服务端尚未生成 API Key：请在页面「🤖 Agent」面板的 OpenAI 兼容区点「生成」并保存。'];
      }
      var provided = pickKey(req);
      if (!provided) return [401, 'missing_api_key', '缺少 Authorization: Bearer <key>。'];
      if (!safeEqual(provided, expected)) return [401, 'invalid_api_key', 'API Key 不正确。'];
      return null;
    }

    function checkRate() {
      var perMin = Number(cfg().openaiRateLimitPerMin) || DEFAULT_RATE;
      if (perMin <= 0) return null;
      var t = now();
      rateBucket = rateBucket.filter(function (ts) { return t - ts < 60000; });
      if (rateBucket.length >= perMin) {
        return [429, 'rate_limited', '请求过于频繁（上限 ' + perMin + ' 次/分钟），请稍后重试。'];
      }
      rateBucket.push(t);
      return null;
    }

    function checkConcurrency() {
      var max = Number(cfg().openaiMaxConcurrent) || 2;
      if (state.active >= max) {
        return [429, 'too_many_concurrent_requests', '并发请求超过上限（' + max + '），请串行调用。'];
      }
      return null;
    }

    // ---------------- 策略视图 ----------------
    // 把 OpenAI 侧的安全开关映射成 MCP 工具认得的字段，
    // 这样 exec / pty_write 等工具的校验逻辑只有一份实现。
    function policyView(c) {
      var conf = c || cfg();
      var readOnly = conf.openaiReadOnly === true;
      return Object.assign({}, conf, {
        mcpAllowWarn: readOnly ? false : conf.openaiAllowWarn !== false,
        mcpAllowDanger: readOnly ? false : conf.openaiAllowDanger === true,
        mcpRequireApproval: conf.openaiRequireApproval === true,
        mcpApprovalTimeoutMs: Number(conf.openaiApprovalTimeoutMs) || 60000,
        mcpReadOnly: readOnly
      });
    }

    function guard(info) {
      if (cfg().openaiRequireApproval !== true) return Promise.resolve(true);
      return Promise.resolve(confirm(info)).then(function (ok) {
        if (!ok) {
          state.denied += 1;
          throw toolError('用户拒绝了该操作');
        }
        return true;
      });
    }

    function toolApi() {
      return {
        call: call,
        config: function () { return policyView(); },
        guard: guard,
        confirm: confirm,
        denied: function () { state.denied += 1; }
      };
    }

    // ---------------- 上游 LLM ----------------
    function upstreamConfig(c) {
      var base = trimSlash(c.openaiUpstreamBase);
      var key = String(c.openaiUpstreamKey || '');
      return {
        base: base,
        key: key,
        model: String(c.openaiUpstreamModel || ''),
        ready: !!(base && key)
      };
    }

    function upstreamError(res, c, error) {
      var up = upstreamConfig(c);
      var msg = (error && error.message) || String(error);
      var isType = error && error.name === 'TypeError';
      if (isType) {
        return sendError(res, 502, 'upstream_unreachable',
          '无法连接上游 ' + up.base + '：' + msg +
          '。常见原因：地址填错、上游不支持浏览器跨域(CORS)、或网络不可达。',
          'api_error');
      }
      return sendError(res, 502, 'upstream_error', '上游请求失败：' + msg, 'api_error');
    }

    async function upstreamFetch(c, path, payload, opts) {
      var up = upstreamConfig(c);
      var doFetch = getFetch();
      if (!doFetch) throw new Error('当前环境没有 fetch()，无法调用上游');
      if (!up.base) throw new Error('未配置上游 Base URL');
      if (!up.key) throw new Error('未配置上游 API Key');

      var timeoutMs = Number((opts && opts.timeoutMs) || c.openaiProxyTimeoutMs) || 120000;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      if (controller) timer = setTimeout(function () { controller.abort(); }, timeoutMs);

      var headers = {
        'content-type': 'application/json',
        authorization: 'Bearer ' + up.key
      };
      if (opts && opts.accept) headers.accept = opts.accept;

      try {
        var resp = await doFetch(up.base + path, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined
        });
        return resp;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('上游超时（' + timeoutMs + 'ms）');
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function readUpstreamError(resp) {
      try {
        var text = await resp.text();
        try {
          var json = JSON.parse(text);
          if (json && json.error) {
            return { message: json.error.message || safeStringify(json.error), code: json.error.code || null, raw: json };
          }
          return { message: truncate(text, 500), code: null, raw: json };
        } catch (e) {
          return { message: truncate(text, 500), code: null, raw: null };
        }
      } catch (e) {
        return { message: 'HTTP ' + resp.status, code: null, raw: null };
      }
    }

    // ---------------- 执行命令（M1） ----------------
    async function execCommand(command, hostId, c) {
      var startedAt = now();
      var checkOut = await call('/api/security/check', { command: command });
      var safety = (checkOut && checkOut.body) || {};
      var risk = String(safety.risk || 'warn');
      var reason = String(safety.reason || '');

      var pv = policyView(c);
      var allowed = risk === 'safe' ||
        (risk === 'warn' && pv.mcpAllowWarn === true) ||
        (risk === 'danger' && pv.mcpAllowDanger === true);

      if (pv.mcpReadOnly === true && risk !== 'safe') allowed = false;

      if (!allowed) {
        state.blocked += 1;
        logEvent({ event: 'exec-blocked', command: truncate(command, 200), risk: risk, reason: reason });
        return {
          blocked: true,
          risk: risk,
          reason: reason || (pv.mcpReadOnly === true ? '只读模式下仅允许白名单命令' : '安全策略禁止'),
          command: command,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: now() - startedAt
        };
      }

      if (pv.mcpRequireApproval === true) {
        var ok = await confirm({
          tool: 'exec',
          title: '执行命令',
          risk: risk,
          reason: reason,
          summary: command,
          timeoutMs: pv.mcpApprovalTimeoutMs
        });
        if (!ok) {
          state.denied += 1;
          return {
            blocked: true, risk: risk, reason: '用户拒绝了该命令',
            command: command, stdout: '', stderr: '', exitCode: null,
            durationMs: now() - startedAt
          };
        }
      }

      var params = { command: command, confirm: true };
      if (hostId) params.hostId = hostId;

      var out = await call('/api/exec', params);
      var body = (out && out.body) || {};
      var status = (out && out.status) || 200;
      if (status >= 400 || body.success === false) {
        return {
          blocked: false, failed: true, risk: risk,
          reason: String(body.error || ('HTTP ' + status)),
          hint: body.hint || '',
          command: command, stdout: '', stderr: '', exitCode: null,
          durationMs: now() - startedAt
        };
      }
      return {
        blocked: false,
        risk: risk,
        hostId: body.hostId || hostId || null,
        command: command,
        stdout: String(body.stdout || ''),
        stderr: String(body.stderr || ''),
        exitCode: body.exitCode === undefined ? null : body.exitCode,
        durationMs: body.duration || (now() - startedAt)
      };
    }

    // Windows cmd.exe 的「命令不存在」提示（中英文），用来判断主机默认 shell 是 cmd
    var CMD_NOT_FOUND_RE = /(不是内部或外部命令|is not recognized as an internal or external command)/i;
    var CMD_MISSING_NAME_RE = /'([^'\r\n]{1,40})'\s*(?:不是内部或外部命令|is not recognized)/i;

    // POSIX → cmd.exe 常用替代，仅用于给出提示，**不自动改写命令**
    var POSIX_TO_CMD = {
      ls: 'dir', ll: 'dir', pwd: 'cd', cat: 'type', rm: 'del', rmdir: 'rmdir /s',
      cp: 'copy', mv: 'move', grep: 'findstr', mkdir: 'md', touch: 'type nul > 文件名',
      clear: 'cls', ps: 'tasklist', kill: 'taskkill /PID', which: 'where',
      head: 'more', tail: 'more', env: 'set', uname: 'ver', whoami: 'whoami',
      df: 'wmic logicaldisk get caption,freespace,size', du: 'dir'
    };

    function cmdHint(stderr) {
      if (!stderr || !CMD_NOT_FOUND_RE.test(stderr)) return '';
      var m = CMD_MISSING_NAME_RE.exec(stderr);
      var name = m ? m[1].trim().toLowerCase() : '';
      var tip = POSIX_TO_CMD[name];
      var lines = ['[hint] 该主机默认 shell 是 Windows cmd.exe，没有 ls / pwd / cat 这类 POSIX 命令。'];
      if (tip) lines.push('[hint] 这里可以用 `' + tip + '` 代替 `' + name + '`。');
      lines.push('[hint] 常用替代：dir（列目录）、cd（当前目录 / 切换）、type（看文件）、');
      lines.push('       findstr（等价 grep）、where（等价 which）、cls（清屏）、tasklist（等价 ps）。');
      lines.push('[hint] 想直接用 bash，请在该主机安装 Git Bash 或 WSL，再用 pty-agent 模式执行。');
      return lines.join('\n');
    }

    function formatExecOutput(r) {
      if (r.blocked) {
        var why = r.reason || '安全策略禁止';
        var out = '[被安全策略阻止] ' + why + '\n命令：' + r.command;
        if (/白名单/.test(why)) {
          out += '\n[hint] 当前是「只读模式」，只有白名单内的安全命令能执行。';
          out += '\n[hint] 要放行：在页面「🤖 Agent」→「🔌 OpenAI 兼容接口」取消勾选「只读模式」；';
          out += '\n[hint] 或改用 pty-agent 模型，让模型自己挑安全写法。';
        }
        return out;
      }
      if (r.failed) {
        return '[执行失败] ' + r.reason + (r.hint ? '\n' + r.hint : '') + '\n命令：' + r.command;
      }
      var text = r.stdout || '';
      if (r.stderr) text += (text ? '\n\n' : '') + '[stderr]\n' + r.stderr;
      if (!text) text = '(无输出, exitCode=' + r.exitCode + ')';
      if (r.exitCode !== null && r.exitCode !== 0) text += '\n[exit code: ' + r.exitCode + ']';
      var h = cmdHint(r.stderr);
      if (h) text += '\n' + h;
      return text;
    }

    function ptyMeta(r, extra) {
      return Object.assign({
        hostId: r.hostId || null,
        command: r.command,
        exitCode: r.exitCode === undefined ? null : r.exitCode,
        durationMs: r.durationMs,
        risk: r.risk,
        blocked: r.blocked === true
      }, extra || {});
    }

    // ---------------- M1：exec 模式的对话 ----------------
    async function runExecChat(ctx) {
      var req = ctx.req, res = ctx.res, c = ctx.cfg, body = ctx.body;
      var command = ctx.command;
      if (!command) {
        return sendError(res, 400, 'invalid_request_error',
          'messages 中缺少用户指令（exec 模式把最后一条 user 消息当作命令）。', 'invalid_request_error', 'messages');
      }

      var result = await execCommand(command, ctx.target.hostId, c);
      var text = formatExecOutput(result);
      var model = String(body.model || 'pty-exec');

      if (!ctx.stream) {
        return res.status(200).json({
          id: uid('chatcmpl-pty-'),
          object: 'chat.completion',
          created: Math.floor(now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }],
          usage: usageOf(ctx.messages, text, 'estimated'),
          pty: ptyMeta(result)
        });
      }

      var em = ctx.emitter;
      var id = uid('chatcmpl-pty-');
      var created = Math.floor(now() / 1000);
      var head = { id: id, object: 'chat.completion.chunk', created: created, model: model };

      em.data(Object.assign({}, head, {
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      }));

      var frames = splitChunks(text);
      for (var i = 0; i < frames.length; i++) {
        em.data(Object.assign({}, head, {
          choices: [{ index: 0, delta: { content: frames[i] }, finish_reason: null }]
        }));
      }

      var tail = Object.assign({}, head, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      if (ctx.trace) tail.pty = ptyMeta(result);
      em.data(tail);

      if (ctx.includeUsage) {
        em.data(Object.assign({}, head, { choices: [], usage: usageOf(ctx.messages, text, 'estimated') }));
      }
      em.data('[DONE]');
      em.end();
    }

    // ---------------- M2：纯代理 ----------------
    var PASSTHROUGH_FIELDS = [
      'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens',
      'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'user', 'n',
      'response_format', 'tools', 'tool_choice', 'parallel_tool_calls',
      'logprobs', 'top_logprobs', 'reasoning_effort', 'service_tier'
    ];

    function proxyPayload(c, body, wantStream, withTools) {
      var up = upstreamConfig(c);
      var payload = {
        model: up.model || String(body.model || ''),
        messages: body.messages,
        stream: wantStream === true
      };
      PASSTHROUGH_FIELDS.forEach(function (key) {
        if (body[key] !== undefined) payload[key] = body[key];
      });
      if (withTools) payload.tools = withTools;
      if (wantStream && body.stream_options) payload.stream_options = body.stream_options;
      if (wantStream && payload.stream_options === undefined) {
        payload.stream_options = { include_usage: false };
      }
      return payload;
    }

    async function runProxyChat(ctx) {
      var req = ctx.req, res = ctx.res, c = ctx.cfg, body = ctx.body;
      var up = upstreamConfig(c);
      if (!up.ready) {
        return sendError(res, 400, 'upstream_not_configured',
          '未配置上游 LLM：请在面板填写 Base URL、API Key 与模型名，或改用 model=pty-exec / pty-agent。',
          'invalid_request_error', 'model');
      }

      var wantStream = ctx.stream;
      var payload = proxyPayload(c, body, wantStream);
      if (!payload.model && up.model) payload.model = up.model;
      if (!payload.model) {
        return sendError(res, 400, 'model_required', '请求缺少 model，且未配置默认上游模型。',
          'invalid_request_error', 'model');
      }

      var resp;
      try {
        resp = await upstreamFetch(c, '/chat/completions', payload, {
          accept: wantStream ? 'text/event-stream' : 'application/json'
        });
      } catch (error) {
        return upstreamError(res, c, error);
      }

      if (!resp.ok) {
        var info = await readUpstreamError(resp);
        state.errors += 1;
        return res.status(resp.status).json({
          error: {
            message: info.message,
            type: resp.status === 401 ? 'authentication_error' : 'api_error',
            param: null,
            code: info.code || ('upstream_' + resp.status)
          },
          upstream: { status: resp.status, baseUrl: up.base }
        });
      }

      var echoed = String(body.model || payload.model);

      if (!wantStream) {
        var json = null;
        try { json = await resp.json(); }
        catch (e) { return sendError(res, 502, 'upstream_bad_json', '上游返回的不是合法 JSON', 'api_error'); }
        if (json && typeof json === 'object') {
          json.model = echoed;
          json.upstream = { baseUrl: up.base, model: payload.model, attempts: 1 };
        }
        return res.status(200).json(json);
      }

      var em = ctx.emitter;
      em.start();
      var reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (!reader) {
        return sendError(res, 502, 'upstream_no_stream', '上游没有返回可读流', 'api_error');
      }

      var decoder = new TextDecoder('utf-8');
      var buf = '';
      var done = false;

      function handleBlock(block) {
        var lines = block.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data:') !== 0) continue;
          var payloadText = line.slice(5).trim();
          if (!payloadText) continue;
          if (payloadText === '[DONE]') { done = true; continue; }
          try {
            var chunk = JSON.parse(payloadText);
            if (chunk && typeof chunk === 'object') {
              chunk.model = echoed;
              if (!chunk.object && chunk.choices) chunk.object = 'chat.completion.chunk';
            }
            em.data(chunk);
          } catch (e) {
            em.data(payloadText);
          }
        }
      }

      try {
        while (!done) {
          var step = await reader.read();
          if (step.done) break;
          buf += decoder.decode(step.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleBlock(block);
            if (done) break;
          }
        }
        if (!done && buf.trim()) handleBlock(buf);
      } catch (error) {
        logEvent({ event: 'proxy-stream-error', message: (error && error.message) || String(error) });
      }

      em.data('[DONE]');
      em.end();
    }

    // ---------------- M3：工具注入 + agent 循环 ----------------
    function mcpTools() {
      var MCP = (typeof globalThis !== 'undefined' ? globalThis : {}).Pty2Mcp;
      return (MCP && Array.isArray(MCP.TOOLS)) ? MCP.TOOLS : [];
    }

    function findTool(name) {
      var list = mcpTools();
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
      return null;
    }

    function agentTools(c) {
      var pv = policyView(c);
      var names = AGENT_TOOL_NAMES.slice();
      if (pv.mcpReadOnly === true) {
        names = names.filter(function (n) { return n !== 'pty_write' && n !== 'pty_create'; });
      }
      if (c.openaiDisableTools === true) return [];
      return toOpenAITools(mcpTools(), { names: names });
    }

    function systemPrompt(c, hostId) {
      var custom = String(c.openaiSystemPrompt || '').trim();
      var base = custom ||
        '你是运行在用户浏览器页面中的 PTY Agent。你可以通过工具在用户已连接的主机上执行命令、管理终端、查看文件。\n' +
        '规则：\n' +
        '1. 先观察再动手，用最少的命令拿到需要的信息；不要臆造输出。\n' +
        '2. 命令可能被安全策略拦截，此时换一条更保守的做法，不要重试同一条被拒的命令。\n' +
        '3. 不要执行删除、格式化、重启等破坏性操作，除非用户明确要求。\n' +
        '4. 用中文回答，简洁给出结论 + 关键证据（命令与输出要点）。';
      if (hostId) base += '\n当前目标主机：' + hostId;
      return base;
    }

    async function runToolCalls(toolCalls, c) {
      var results = [];
      var api = toolApi();
      for (var i = 0; i < toolCalls.length; i++) {
        var tc = toolCalls[i] || {};
        var fn = tc.function || {};
        var name = String(fn.name || '');
        var args = {};
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch (e) {
          results.push({ id: tc.id, name: name, text: '参数不是合法 JSON：' + truncate(fn.arguments, 300), isError: true });
          continue;
        }

        var tool = findTool(name);
        if (!tool) {
          results.push({ id: tc.id, name: name, text: '未知工具：' + name, isError: true });
          continue;
        }

        state.toolCalls += 1;
        state.toolCounts[name] = (state.toolCounts[name] || 0) + 1;
        var startedAt = now();
        var text = '';
        var isError = false;

        try {
          var out = await tool.run(args, api);
          var status = (out && out.status) || 200;
          var payload = (out && out.body) || {};
          var failed = status >= 400 || payload.success === false;
          isError = failed;
          if (failed) {
            text = String(payload.error || ('HTTP ' + status));
            if (payload.reason) text += '：' + payload.reason;
            if (payload.hint) text += '\n' + payload.hint;
          } else if (name === 'exec') {
            text = String(payload.stdout || '');
            if (payload.stderr) text += (text ? '\n\n' : '') + '[stderr]\n' + payload.stderr;
            if (!text) text = '(无输出, exitCode=' + payload.exitCode + ')';
          } else if (name === 'pty_read' && typeof payload.text === 'string') {
            text = payload.text;
          } else if (typeof payload === 'string') {
            text = payload;
          } else {
            text = safeStringify(payload);
          }
        } catch (error) {
          isError = true;
          if (error && error.toolError) state.denied += 0;
          text = '工具执行失败：' + ((error && error.message) || String(error));
        }

        results.push({
          id: tc.id,
          name: name,
          args: args,
          text: truncate(text, Number(c.openaiToolResultLimit) || DEFAULT_TOOL_TEXT),
          isError: isError,
          durationMs: now() - startedAt,
          blocked: /被.*禁止|拒绝了|需确认/.test(text)
        });
      }
      return results;
    }

    async function runAgentChat(ctx) {
      var res = ctx.res, c = ctx.cfg, body = ctx.body;
      var up = upstreamConfig(c);
      if (!up.ready) {
        return sendError(res, 400, 'upstream_not_configured',
          'pty-agent 模式需要上游 LLM：请在面板填写 Base URL、API Key 与模型名。',
          'invalid_request_error', 'model');
      }

      var tools = agentTools(c);
      var model = up.model || String(body.model || '');
      var hostId = ctx.target.hostId;
      var messages = [{ role: 'system', content: systemPrompt(c, hostId) }].concat(ctx.messages);
      var maxSteps = Math.max(1, Math.min(Number(c.openaiMaxSteps) || 6, 12));
      var deadline = now() + (Number(c.openaiAgentTimeoutMs) || 180000);
      var trace = [];
      var usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      var finalText = '';
      var steps = 0;
      var stopped = false;

      while (steps < maxSteps) {
        if (now() > deadline) { stopped = true; break; }
        steps += 1;

        var payload = {
          model: model,
          messages: messages,
          stream: false,
          temperature: body.temperature
        };
        if (payload.temperature === undefined) delete payload.temperature;
        if (tools.length) {
          payload.tools = tools;
          payload.tool_choice = 'auto';
        }

        var resp;
        try {
          resp = await upstreamFetch(c, '/chat/completions', payload, { timeoutMs: 90000 });
        } catch (error) {
          return upstreamError(res, c, error);
        }

        if (!resp.ok) {
          var errInfo = await readUpstreamError(resp);
          var hint = /tool|function/i.test(errInfo.message)
            ? '\n提示：该上游模型可能不支持 function calling，可在面板关闭「工具注入」后重试。'
            : '';
          return sendError(res, resp.status === 401 ? 401 : 502,
            'upstream_error', errInfo.message + hint,
            resp.status === 401 ? 'authentication_error' : 'api_error');
        }

        var json = null;
        try { json = await resp.json(); }
        catch (e) { return sendError(res, 502, 'upstream_bad_json', '上游返回的不是合法 JSON', 'api_error'); }

        if (json && json.usage) {
          usage.prompt_tokens += Number(json.usage.prompt_tokens) || 0;
          usage.completion_tokens += Number(json.usage.completion_tokens) || 0;
          usage.total_tokens += Number(json.usage.total_tokens) || 0;
        }

        var choice = json && json.choices && json.choices[0];
        var msg = (choice && choice.message) || {};
        var toolCalls = msg.tool_calls || [];

        if (toolCalls.length) {
          messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: toolCalls
          });
          var results = await runToolCalls(toolCalls, c);
          results.forEach(function (r) {
            messages.push({
              role: 'tool',
              tool_call_id: r.id,
              content: r.text
            });
            trace.push({
              tool: r.name,
              args: r.args,
              exitCode: r.isError ? null : undefined,
              blocked: r.blocked === true,
              durationMs: r.durationMs,
              error: r.isError ? truncate(r.text, 200) : undefined
            });
            if (ctx.trace && ctx.emitter) {
              ctx.emitter.data({
                id: ctx.responseId,
                object: 'chat.completion.chunk',
                created: ctx.created,
                model: ctx.modelName,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                pty: { step: steps, tool: r.name, args: r.args, blocked: r.blocked === true }
              });
            }
          });
          continue;
        }

        finalText = String(msg.content || '');
        break;
      }

      if (!finalText) {
        finalText = stopped
          ? '（已超时，未能在时限内完成；已完成 ' + steps + ' 步）'
          : '（未能在 ' + maxSteps + ' 步内得出结果）';
      }

      var ptyStat = {
        steps: steps,
        trace: trace,
        blocked: trace.filter(function (t) { return t.blocked; }).map(function (t) { return t.tool; })
      };
      var outUsage = usage.total_tokens
        ? Object.assign({ source: 'upstream' }, usage)
        : usageOf(ctx.messages, finalText, 'estimated');

      if (!ctx.stream) {
        return res.status(200).json({
          id: uid('chatcmpl-agt-'),
          object: 'chat.completion',
          created: Math.floor(now() / 1000),
          model: ctx.modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
          usage: outUsage,
          pty: ptyStat
        });
      }

      var em = ctx.emitter;
      var head = { id: ctx.responseId, object: 'chat.completion.chunk', created: ctx.created, model: ctx.modelName };
      em.data(Object.assign({}, head, {
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      }));
      splitChunks(finalText).forEach(function (piece) {
        em.data(Object.assign({}, head, {
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
        }));
      });
      var tail = Object.assign({}, head, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (ctx.trace) tail.pty = ptyStat;
      em.data(tail);
      if (ctx.includeUsage) em.data(Object.assign({}, head, { choices: [], usage: outUsage }));
      em.data('[DONE]');
      em.end();
    }

    // ---------------- 会话粘滞 ----------------
    // X-Pty-Session: 同一 session 复用同一个 Agent 终端，cd / 环境变量得以保留。
    var sessions = new Map();
    var SESSION_IDLE_MS = 10 * 60 * 1000;

    function sessionKey(req, c) {
      var raw = String((req.get && req.get('x-pty-session')) || (req.query && req.query.session) || '').trim();
      if (!raw) return null;
      return raw.slice(0, 64);
    }

    async function ensureSessionTerm(key, hostId, c) {
      if (!key) return null;
      var t = now();
      sessions.forEach(function (v, k) {
        if (t - v.usedAt > SESSION_IDLE_MS) sessions.delete(k);
      });

      var entry = sessions.get(key);
      if (entry) {
        // 用一次 read 做存活探测：比解析 /api/pty/list 的返回结构更可靠
        var probe = await call('/api/pty/read', { termId: entry.termId, lines: 1 });
        var alive = probe && probe.status < 400 && probe.body && probe.body.success !== false;
        if (alive) {
          entry.usedAt = t;
          return { termId: entry.termId, reused: true, hostId: entry.hostId };
        }
        sessions.delete(key);
      }

      var params = { backend: 'local', cols: 100, rows: 30 };
      if (hostId) params.hostId = hostId;
      var created = await call('/api/pty/create', params);
      var body = (created && created.body) || {};
      if ((created && created.status) >= 400 || !body.termId) {
        return { error: String(body.error || '创建终端失败'), status: (created && created.status) || 500 };
      }
      sessions.set(key, { termId: body.termId, hostId: body.hostId || hostId || null, usedAt: t });
      return { termId: body.termId, reused: false, hostId: body.hostId || hostId || null };
    }

    async function runSessionExec(ctx) {
      var res = ctx.res, c = ctx.cfg;
      var sess = await ensureSessionTerm(ctx.sessionKey, ctx.target.hostId, c);
      if (sess && sess.error) {
        return sendError(res, sess.status || 500, 'session_failed', '会话终端不可用：' + sess.error, 'api_error');
      }

      var command = ctx.command;
      var checkOut = await call('/api/security/check', { command: command });
      var safety = (checkOut && checkOut.body) || {};
      var risk = String(safety.risk || 'warn');
      var pv = policyView(c);
      var allowed = risk === 'safe' ||
        (risk === 'warn' && pv.mcpAllowWarn === true) ||
        (risk === 'danger' && pv.mcpAllowDanger === true);
      if (pv.mcpReadOnly === true && risk !== 'safe') allowed = false;

      if (!allowed) {
        state.blocked += 1;
        var blockedText = '[被安全策略阻止] ' + (safety.reason || risk) + '\n命令：' + command;
        return replyText(ctx, blockedText, {
          hostId: sess.hostId, termId: sess.termId, session: ctx.sessionKey,
          reused: sess.reused, exitCode: null, risk: risk, blocked: true
        });
      }

      var marker = '__PTY_DONE_' + Math.random().toString(36).slice(2, 10) + '__';
      var writeOut = await call('/api/pty/write', {
        termId: sess.termId,
        data: command,
        enter: true
      });
      if ((writeOut && writeOut.status) >= 400) {
        return sendError(res, 502, 'session_write_failed', '写入终端失败', 'api_error');
      }

      var text = '';
      var waitUntil = now() + (Number(c.openaiSessionTimeoutMs) || 30000);
      var stable = 0;
      while (now() < waitUntil) {
        await new Promise(function (r) { setTimeout(r, 220); });
        var readOut = await call('/api/pty/read', { termId: sess.termId, lines: 200 });
        var bodyText = (readOut && readOut.body && readOut.body.text) || '';
        if (bodyText.length > text.length) {
          text = bodyText;
          stable = 0;
        } else {
          stable += 1;
          if (stable >= 4) break;
        }
      }

      var cleaned = cleanTerminalOutput(text, command);
      return replyText(ctx, cleaned || '(无输出)', {
        hostId: sess.hostId, termId: sess.termId, session: ctx.sessionKey,
        reused: sess.reused, exitCode: null, risk: risk, blocked: false
      });
    }

    function cleanTerminalOutput(raw, command) {
      var text = String(raw || '');
      text = text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
      text = text.replace(/\r/g, '');
      var lines = text.split('\n');
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.trim() === command.trim()) continue;
        if (!line.trim() && out.length && !out[out.length - 1].trim()) continue;
        out.push(line);
      }
      while (out.length && !out[0].trim()) out.shift();
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out.join('\n');
    }

    function replyText(ctx, text, meta) {
      var res = ctx.res;
      if (!ctx.stream) {
        return res.status(200).json({
          id: uid('chatcmpl-pty-'),
          object: 'chat.completion',
          created: Math.floor(now() / 1000),
          model: ctx.modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: usageOf(ctx.messages, text, 'estimated'),
          pty: meta
        });
      }
      var em = ctx.emitter;
      var head = { id: ctx.responseId, object: 'chat.completion.chunk', created: ctx.created, model: ctx.modelName };
      em.data(Object.assign({}, head, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
      splitChunks(text).forEach(function (piece) {
        em.data(Object.assign({}, head, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
      });
      em.data(Object.assign({}, head, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], pty: meta }));
      if (ctx.includeUsage) em.data(Object.assign({}, head, { choices: [], usage: usageOf(ctx.messages, text, 'estimated') }));
      em.data('[DONE]');
      em.end();
    }

    // ---------------- 路由入口 ----------------
    async function dispatch(req, res, kind) {
      if (preflight(req, res)) return;

      state.requests += 1;
      var c = cfg();

      if (!enabled()) {
        return sendError(res, 404, 'endpoint_disabled',
          'OpenAI 兼容接口未启用：请在页面「🤖 Agent」面板的 OpenAI 兼容区勾选「启用」。');
      }

      var authErr = checkAuth(req);
      if (authErr) return sendError(res, authErr[0], authErr[1], authErr[2], 'authentication_error');

      var rateErr = checkRate();
      if (rateErr) return sendError(res, rateErr[0], rateErr[1], rateErr[2], 'rate_limit_error');

      var conErr = checkConcurrency();
      if (conErr) return sendError(res, conErr[0], conErr[1], conErr[2], 'rate_limit_error');

      state.active += 1;
      try {
        if (kind === 'models') return await handleModels(req, res, c);
        if (kind === 'selftest') return await handleSelftest(req, res, c);
        if (kind === 'embeddings') {
          return sendError(res, 501, 'unsupported_endpoint',
            '/v1/embeddings 未实现：PTY Agent 不提供向量能力。', 'invalid_request_error');
        }
        if (kind === 'completions') return await handleCompletions(req, res, c);
        if (kind === 'responses') return await handleResponses(req, res, c);
        if (kind === 'notfound') {
          return sendError(res, 404, 'unknown_url',
            '不支持的 OpenAI 端点：' + String(req.method) + ' ' + String(req.path),
            'invalid_request_error');
        }
        return await handleChat(req, res, c);
      } catch (error) {
        state.errors += 1;
        logEvent({ event: 'error', kind: kind, message: (error && error.message) || String(error) });
        if (!res.finished) {
          return sendError(res, 500, 'internal_error',
            '内部错误：' + ((error && error.message) || String(error)), 'api_error');
        }
      } finally {
        state.active -= 1;
      }
    }

    // ---------------- /v1/models ----------------
    function modelList(c) {
      var created = Math.floor(now() / 1000);
      var list = [
        { id: 'pty-exec', object: 'model', created: created, owned_by: SERVER_NAME, mode: 'exec' },
        { id: 'pty-agent', object: 'model', created: created, owned_by: SERVER_NAME, mode: 'agent' }
      ];
      (getHosts() || []).forEach(function (h) {
        if (!h || !h.id) return;
        list.push({
          id: 'pty-exec@' + h.id, object: 'model', created: created,
          owned_by: SERVER_NAME, mode: 'exec', hostId: h.id, hostName: h.name || h.id
        });
      });
      var up = upstreamConfig(c);
      if (up.ready && up.model) {
        list.push({ id: up.model, object: 'model', created: created, owned_by: 'upstream', mode: 'proxy' });
      }
      return list;
    }

    async function handleModels(req, res, c) {
      return res.status(200).json({ object: 'list', data: modelList(c) });
    }

    // ---------------- /v1/chat/completions ----------------
    async function handleChat(req, res, c) {
      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!isObject(body)) {
        return sendError(res, 400, 'invalid_request_error', '请求体必须是 JSON 对象。', 'invalid_request_error');
      }

      var messages = normalizeMessages(body.messages);
      if (!messages.length) {
        return sendError(res, 400, 'messages_required', 'messages 不能为空。', 'invalid_request_error', 'messages');
      }

      var target = classifyModel(c, body.model);
      var stream = body.stream === true;
      var trace = c.openaiTrace === true ||
        String((req.get && req.get('x-pty-trace')) || '') === '1';

      state.chatCalls += 1;

      var ctx = {
        req: req,
        res: res,
        cfg: c,
        body: body,
        messages: messages,
        target: target,
        stream: stream,
        trace: trace,
        includeUsage: !!(body.stream_options && body.stream_options.include_usage),
        command: lastUserText(messages),
        modelName: String(body.model || target.model || 'pty-exec'),
        responseId: uid('chatcmpl-'),
        created: Math.floor(now() / 1000),
        sessionKey: sessionKey(req, c)
      };

      if (stream) {
        ctx.emitter = makeEmitter(res);
        ctx.emitter.start();
      }

      logEvent({
        event: 'chat',
        model: ctx.modelName,
        kind: target.kind,
        stream: stream,
        messages: messages.length,
        session: ctx.sessionKey || undefined
      });

      if (target.kind === 'exec') {
        if (ctx.sessionKey) return await runSessionExec(ctx);
        return await runExecChat(ctx);
      }
      if (target.kind === 'agent') return await runAgentChat(ctx);
      return await runProxyChat(ctx);
    }

    // ---------------- /v1/completions（legacy 别名） ----------------
    async function handleCompletions(req, res, c) {
      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!isObject(body)) {
        return sendError(res, 400, 'invalid_request_error', '请求体必须是 JSON 对象。');
      }

      var target = classifyModel(c, body.model);
      if (target.kind === 'agent') {
        return sendError(res, 400, 'unsupported_model_for_completions',
          '/v1/completions 不支持 pty-agent（工具调用没有承载字段），请改用 /v1/chat/completions。',
          'invalid_request_error', 'model');
      }

      var prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt];
      if (!prompts.length || prompts[0] === undefined || prompts[0] === null) {
        return sendError(res, 400, 'prompt_required', 'prompt 不能为空。', 'invalid_request_error', 'prompt');
      }

      var stream = body.stream === true;
      var echo = body.echo === true;
      var results = [];
      var firstText = '';

      for (var i = 0; i < prompts.length; i++) {
        var promptText = contentToText(prompts[i]);
        var messages = [{ role: 'user', content: promptText }];

        var ctx = {
          req: req, res: res, cfg: c, body: Object.assign({}, body, { messages: messages }),
          messages: messages, target: target, stream: false, trace: false, includeUsage: false,
          command: promptText, modelName: String(body.model || target.model || 'pty-exec'),
          responseId: uid('cmpl-'), created: Math.floor(now() / 1000),
          sessionKey: sessionKey(req, c),
          emitter: null
        };

        var captured = null;
        var fakeRes = {
          status: function () { return this; },
          set: function () { return this; },
          json: function (value) { captured = value; return this; },
          send: function (value) { captured = value; return this; },
          end: function () { return this; }
        };
        ctx.res = fakeRes;

        try {
          if (target.kind === 'exec') {
            if (ctx.sessionKey) await runSessionExec(ctx);
            else await runExecChat(ctx);
          } else {
            await runProxyChat(ctx);
          }
        } catch (error) {
          return sendError(res, 502, 'completion_failed', (error && error.message) || String(error), 'api_error');
        }

        if (captured && captured.error) {
          return res.status(400).json({ error: captured.error });
        }

        var text = (captured && captured.choices && captured.choices[0] &&
          captured.choices[0].message && captured.choices[0].message.content) || '';
        if (echo) text = promptText + text;
        if (i === 0) firstText = text;
        results.push({ text: text, index: i, finish_reason: 'stop' });
      }

      var id = uid('cmpl-');
      var created = Math.floor(now() / 1000);
      var model = String(body.model || target.model || 'pty-exec');

      if (!stream) {
        var totalTokens = results.reduce(function (sum, r) { return sum + estimateTokens(r.text); }, 0);
        return res.status(200).json({
          id: id,
          object: 'text_completion',
          created: created,
          model: model,
          choices: results.map(function (r) {
            return { text: r.text, index: r.index, logprobs: null, finish_reason: r.finish_reason };
          }),
          usage: {
            prompt_tokens: estimateTokens(prompts.join('\n')),
            completion_tokens: totalTokens,
            total_tokens: estimateTokens(prompts.join('\n')) + totalTokens,
            source: 'estimated'
          }
        });
      }

      var em = makeEmitter(res);
      em.start();
      splitChunks(firstText).forEach(function (piece) {
        em.data({
          id: id, object: 'text_completion', created: created, model: model,
          choices: [{ text: piece, index: 0, logprobs: null, finish_reason: null }]
        });
      });
      em.data({
        id: id, object: 'text_completion', created: created, model: model,
        choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }]
      });
      em.data('[DONE]');
      em.end();
    }

    // ---------------- /v1/responses ----------------
    function toResponseObject(ctx, text, usage) {
      return {
        id: ctx.responseId,
        object: 'response',
        created_at: Math.floor(now() / 1000),
        model: ctx.modelName,
        status: 'completed',
        output: [{
          type: 'message',
          id: uid('msg_'),
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: text, annotations: [] }]
        }],
        output_text: text,
        usage: {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      };
    }

    async function handleResponses(req, res, c) {
      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!isObject(body)) {
        return sendError(res, 400, 'invalid_request_error', '请求体必须是 JSON 对象。');
      }

      var messages = normalizeMessages(body.messages || body.input);
      if (!messages.length && typeof body.input === 'string') {
        messages = [{ role: 'user', content: body.input }];
      }
      if (!messages.length) {
        return sendError(res, 400, 'input_required', 'input 不能为空。', 'invalid_request_error', 'input');
      }

      var target = classifyModel(c, body.model);
      var stream = body.stream === true;
      var chatBody = {
        model: body.model,
        messages: messages,
        stream: false,
        temperature: body.temperature,
        max_output_tokens: body.max_output_tokens
      };

      var ctx = {
        req: req, res: res, cfg: c, body: chatBody, messages: messages, target: target,
        stream: false, trace: false, includeUsage: false, emitter: null,
        command: lastUserText(messages),
        modelName: String(body.model || target.model || 'pty-exec'),
        responseId: uid('resp_'),
        created: Math.floor(now() / 1000),
        sessionKey: sessionKey(req, c)
      };

      var captured = null;
      var fakeRes = {
        status: function () { return this; },
        set: function () { return this; },
        json: function (value) { captured = value; return this; },
        send: function (value) { captured = value; return this; },
        end: function () { return this; }
      };
      ctx.res = fakeRes;

      if (target.kind === 'exec') {
        if (ctx.sessionKey) await runSessionExec(ctx);
        else await runExecChat(ctx);
      } else if (target.kind === 'agent') {
        await runAgentChat(ctx);
      } else {
        await runProxyChat(ctx);
      }

      if (captured && captured.error) {
        return res.status(400).json({ error: captured.error });
      }
      if (!captured || !captured.choices) {
        return sendError(res, 502, 'response_failed', '未能生成响应', 'api_error');
      }

      var text = String(captured.choices[0].message.content || '');
      var usage = captured.usage || usageOf(messages, text, 'estimated');
      var obj = toResponseObject(ctx, text, usage);
      if (captured.pty) obj.pty = captured.pty;

      if (!stream) return res.status(200).json(obj);

      var em = makeEmitter(res);
      em.start();
      em.named('response.created', {
        type: 'response.created', response: Object.assign({}, obj, { status: 'in_progress', output: [] })
      });
      splitChunks(text).forEach(function (piece) {
        em.named('response.output_text.delta', {
          type: 'response.output_text.delta', item_id: obj.output[0].id, output_index: 0, delta: piece
        });
      });
      em.named('response.completed', { type: 'response.completed', response: obj });
      em.end();
    }

    // ---------------- /v1/_selftest ----------------
    async function handleSelftest(req, res, c) {
      var checks = { auth: 'ok' };
      var hosts = getHosts() || [];

      var hostId = null;
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i] && hosts[i].connected === true) { hostId = hosts[i].id; break; }
      }
      if (!hostId && hosts.length) hostId = hosts[0].id;

      checks.host = { id: hostId, connected: hosts.some(function (h) { return h && h.connected === true; }) };

      if (hostId) {
        var startedAt = now();
        var result = await execCommand('uname -s 2>/dev/null || echo unknown', hostId, c);
        checks.exec = {
          ok: !result.blocked && !result.failed,
          ms: now() - startedAt,
          sample: truncate(String(result.stdout || result.reason || '').trim(), 120),
          blocked: result.blocked === true,
          risk: result.risk
        };
      } else {
        checks.exec = { ok: false, reason: '没有已连接的主机' };
      }

      checks.sse = {
        transport: res && res.isSse === true ? 'sse' : 'buffered',
        framing: 'data-prefixed',
        note: res && res.isSse === true
          ? '中继已走 SSE 通道，事件实时下发'
          : '本次请求未走 SSE（客户端未带 Accept: text/event-stream），流式内容会整包返回'
      };

      var up = upstreamConfig(c);
      var upFetch = getFetch();
      if (!up.ready) {
        checks.upstream = { configured: false, reason: '未配置上游 Base URL / API Key（M1 不受影响）' };
      } else if (!upFetch) {
        checks.upstream = { configured: true, reachable: false, reason: '当前环境没有 fetch()' };
      } else {
        var t0 = now();
        try {
          var controller = typeof AbortController === 'function' ? new AbortController() : null;
          var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
          var r = await upFetch(up.base + '/models', {
            method: 'GET',
            headers: { authorization: 'Bearer ' + up.key },
            signal: controller ? controller.signal : undefined
          });
          if (timer) clearTimeout(timer);
          checks.upstream = {
            configured: true,
            reachable: true,
            status: r.status,
            cors: 'ok',
            ms: now() - t0,
            model: up.model || null,
            note: r.status === 401 ? '上游 Key 可能无效（M1/M3 之外的代理调用会被拒绝）' : undefined
          };
        } catch (error) {
          var isType = error && error.name === 'TypeError';
          checks.upstream = {
            configured: true,
            reachable: false,
            ms: now() - t0,
            cors: isType ? 'blocked' : 'unknown',
            reason: isType
              ? '浏览器跨域被拦截或地址不可达（M2 依赖上游 CORS）'
              : ((error && error.message) || String(error))
          };
        }
      }

      checks.config = {
        mode: String(c.openaiMode || 'exec'),
        readOnly: c.openaiReadOnly === true,
        allowWarn: c.openaiAllowWarn !== false,
        allowDanger: c.openaiAllowDanger === true,
        requireApproval: c.openaiRequireApproval === true,
        tools: agentTools(c).length,
        keySet: !!String(c.openaiApiKey || '')
      };

      return res.status(200).json({ ok: true, version: VERSION, service: getService(), checks: checks });
    }

    // ---------------- 元信息 ----------------
    function stats() {
      var c = cfg();
      var up = upstreamConfig(c);
      return {
        enabled: c.openaiEnabled === true,
        version: VERSION,
        requests: state.requests,
        errors: state.errors,
        denied: state.denied,
        blocked: state.blocked,
        chatCalls: state.chatCalls,
        toolCalls: state.toolCalls,
        active: state.active,
        mode: c.openaiMode || 'exec',
        keySet: !!String(c.openaiApiKey || ''),
        readOnly: c.openaiReadOnly === true,
        upstream: { baseUrl: up.base, model: up.model, keySet: !!up.key },
        sessions: sessions.size,
        uptimeMs: now() - state.startedAt,
        recent: state.recent.slice(-8)
      };
    }

    function info() {
      var c = cfg();
      var base = (getService() || {}).apiBase || '';
      return {
        enabled: c.openaiEnabled === true,
        version: VERSION,
        baseUrl: base + '/v1',
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings', '/v1/_selftest'],
        models: modelList(c).map(function (m) { return m.id; }),
        modes: {
          exec: 'pty-exec[@hostId]：消息即命令，不调 LLM',
          proxy: '<上游模型名>：原样透传上游 LLM',
          agent: 'pty-agent[@hostId]：上游 LLM + PTY 工具 + 服务端循环'
        },
        auth: 'Authorization: Bearer <openaiApiKey>',
        keySet: !!String(c.openaiApiKey || '')
      };
    }

    return {
      version: VERSION,
      handle: function (kind, req, res) { return dispatch(req, res, kind); },
      models: handleModels,
      chat: handleChat,
      completions: handleCompletions,
      responses: handleResponses,
      selftest: handleSelftest,
      info: info,
      stats: stats,
      modelList: function () { return modelList(cfg()); },
      resetSessions: function () { sessions.clear(); return 0; }
    };
  }

  return {
    version: VERSION,
    SERVER_NAME: SERVER_NAME,
    AGENT_TOOL_NAMES: AGENT_TOOL_NAMES,
    toOpenAITools: toOpenAITools,
    classifyModel: classifyModel,
    estimateTokens: estimateTokens,
    lastUserText: lastUserText,
    stripClientNotices: stripClientNotices,
    createServer: createServer
  };
});
