// mcp-server.js
// MCP (Model Context Protocol) Streamable HTTP adapter for the PTY Agent.
//
// 设计要点：
//   - 单端点 /mcp：POST 处理 JSON-RPC；GET 返回端点信息（也可返回单条 SSE 信息帧）；
//     DELETE 返回 405（无协议级会话）。
//   - 双协议时代：
//       * modern 2026-07-28：无握手、每请求带 _meta、必须实现 server/discover；
//       * legacy 2025-11-25 / 2025-06-18 / 2025-03-26：initialize + tools/list/tools/call。
//   - 传输层是 sdk.js 的“整包响应”，所以：
//       * 支持 application/json；
//       * 支持 text/event-stream，但整包一次性送达（不是长连接）；
//       * 不支持 subscriptions/listen 的长通知流。
//   - 工具全部复用 pty2-agent.js 里已有的 /api/* handler（通过 deps.call 注入）。
//
// 依赖：无。浏览器下挂到 window.Pty2Mcp；Node 下 module.exports 同时挂 globalThis。

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof globalThis !== 'undefined') globalThis.Pty2Mcp = api;
  } else {
    root.Pty2Mcp = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var SERVER_NAME = 'pty2-agent';
  var MODERN = '2026-07-28';
  var PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
  var LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
  var META = 'io.modelcontextprotocol/';
  var MAX_TEXT = 200 * 1024;
  var MAX_RESOURCE_BLOB = 2 * 1024 * 1024;
  var READ_ONLY_TOOL_NAMES = ['exec', 'pty_write', 'pty_destroy', 'fs_upload', 'fs_delete'];

  var INSTRUCTIONS =
    '这是运行在浏览器页面里的 PTY Agent。用 exec 执行一次性命令；用 pty_create/pty_write/pty_read ' +
    '管理交互式终端；用 fs_* 管理远程文件；用 ai_context 读取当前终端上下文。' +
    '实时输出请轮询 pty_read。危险命令受页面策略限制。';

  // ============================================================
  // 基础工具
  // ============================================================
  function now() { return Date.now(); }

  function safeStringify(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (e) { return String(value); }
  }

  function truncate(text, limit) {
    var s = String(text == null ? '' : text);
    var max = limit || MAX_TEXT;
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…[truncated ' + (s.length - max) + ' chars]';
  }

  function decodeBytes(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  function b64DecodeUtf8(value) {
    try {
      if (typeof atob === 'function') {
        var bin = atob(value);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return decodeBytes(bytes);
      }
      if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
    } catch (e) { /* ignore */ }
    return value;
  }

  function decodeHeaderValue(value) {
    var m = /^=\?base64\?([\s\S]*)\?=$/.exec(String(value == null ? '' : value));
    if (!m) return String(value == null ? '' : value);
    return b64DecodeUtf8(m[1]);
  }

  function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      !(typeof Uint8Array !== 'undefined' && value instanceof Uint8Array);
  }

  function paramsName(message) {
    var params = message && message.params;
    if (!isObject(params)) return '';
    if (params.name) return String(params.name);
    if (params.uri) return String(params.uri);
    return '';
  }

  function prop(type, description, extra) {
    var out = { type: type, description: description };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  function objectSchema(props, required) {
    return {
      type: 'object',
      properties: props || {},
      required: required || [],
      additionalProperties: false
    };
  }

  function toolError(message) {
    var err = new Error(String(message));
    err.toolError = true;
    return err;
  }

  function toolErrText(text) {
    return { content: [{ type: 'text', text: String(text) }], isError: true };
  }

  // ============================================================
  // 工具定义（全部复用 /api/*）
  // ============================================================
  var READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  var WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  var SESSION = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  var TOOLS = [
    {
      name: 'host_list',
      title: '主机列表',
      description: '列出页面中配置的所有 PTY 主机及其连接状态。',
      inputSchema: objectSchema({}, []),
      annotations: Object.assign({ title: '主机列表' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/hosts/list', {}); }
    },
    {
      name: 'host_status',
      title: '主机状态',
      description: '查询单个主机的连接状态、终端数量、可用 backend / shell。',
      inputSchema: objectSchema({
        hostId: prop('string', '主机 id')
      }, ['hostId']),
      annotations: Object.assign({ title: '主机状态' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/hosts/status', { hostId: args.hostId }); }
    },
    {
      name: 'pty_list',
      title: '终端列表',
      description: '列出主机上的终端（页面 UI 终端 + Agent 创建的终端）。',
      inputSchema: objectSchema({
        hostId: prop('string', '主机 id；省略时使用当前连接的主机')
      }, []),
      annotations: Object.assign({ title: '终端列表' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/pty/list', args.hostId ? { hostId: args.hostId } : {}); }
    },
    {
      name: 'pty_create',
      title: '新建终端',
      description: '创建一个不占用页面 UI 的 Agent 终端，返回 termId。',
      inputSchema: objectSchema({
        hostId: prop('string', '主机 id'),
        backend: prop('string', 'local 或 ssh', { default: 'local' }),
        shellId: prop('string', 'shell / 远程 shell id'),
        cols: prop('integer', '列数', { default: 80, minimum: 1, maximum: 1000 }),
        rows: prop('integer', '行数', { default: 24, minimum: 1, maximum: 1000 }),
        cwd: prop('string', '工作目录')
      }, []),
      annotations: Object.assign({ title: '新建终端' }, SESSION),
      run: function (args, api) { return api.call('/api/pty/create', args); }
    },
    {
      name: 'pty_write',
      title: '写入终端',
      description: '向终端写入文本或按键；enter=true 会自动追加回车。',
      inputSchema: objectSchema({
        termId: prop('string', '终端 id'),
        data: prop('string', '要写入的文本'),
        dataBase64: prop('string', 'base64 编码的写入内容（与 data 二选一）'),
        enter: prop('boolean', '是否追加回车', { default: false })
      }, ['termId']),
      annotations: Object.assign({ title: '写入终端' }, WRITE),
      run: async function (args, api) {
        if (!args.data && !args.dataBase64) throw toolError('data 或 dataBase64 至少提供一个');
        await api.guard({ tool: 'pty_write', title: '向终端写入输入', summary: args.data || '[base64]' });
        return api.call('/api/pty/write', args);
      }
    },
    {
      name: 'pty_read',
      title: '读取终端输出',
      description: '读取终端最近的输出（默认 50 行，最多 5000 行）。实时输出请轮询本工具。',
      inputSchema: objectSchema({
        termId: prop('string', '终端 id；省略时使用当前激活终端'),
        lines: prop('integer', '读取行数', { default: 50, minimum: 1, maximum: 5000 })
      }, []),
      annotations: Object.assign({ title: '读取终端输出' }, READ_ONLY),
      run: function (args, api) {
        var p = {};
        if (args.termId) p.termId = args.termId;
        if (args.lines) p.lines = args.lines;
        return api.call('/api/pty/read', p);
      }
    },
    {
      name: 'pty_resize',
      title: '调整终端尺寸',
      description: '调整终端 cols/rows。',
      inputSchema: objectSchema({
        termId: prop('string', '终端 id'),
        cols: prop('integer', '列数', { default: 80, minimum: 1, maximum: 1000 }),
        rows: prop('integer', '行数', { default: 24, minimum: 1, maximum: 1000 })
      }, ['termId']),
      annotations: Object.assign({ title: '调整终端尺寸' }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      run: function (args, api) { return api.call('/api/pty/resize', args); }
    },
    {
      name: 'pty_destroy',
      title: '销毁终端',
      description: '销毁指定终端；页面 UI 终端会交给页面关闭。',
      inputSchema: objectSchema({
        termId: prop('string', '终端 id')
      }, ['termId']),
      annotations: Object.assign({ title: '销毁终端' }, WRITE),
      run: async function (args, api) {
        await api.guard({ tool: 'pty_destroy', title: '销毁终端', summary: args.termId });
        return api.call('/api/pty/destroy', args);
      }
    },
    {
      name: 'exec',
      title: '执行一次性命令',
      description:
        '在已连接主机上执行一条命令，返回 stdout/stderr/exitCode。默认超时 60s。' +
        '危险命令受 MCP 策略与页面确认控制。',
      inputSchema: objectSchema({
        command: prop('string', '要执行的 shell 命令'),
        hostId: prop('string', '目标主机 id'),
        useSsh: prop('boolean', '是否通过 SSH 执行', { default: false }),
        timeout: prop('integer', '超时毫秒', { default: 60000, minimum: 1000, maximum: 300000 })
      }, ['command']),
      outputSchema: objectSchema({
        stdout: prop('string', '标准输出'),
        stderr: prop('string', '标准错误'),
        exitCode: prop('integer', '退出码'),
        duration: prop('integer', '耗时毫秒'),
        command: prop('string', '实际执行的命令'),
        risk: prop('string', '安全等级')
      }, ['stdout', 'stderr']),
      annotations: Object.assign({ title: '执行命令' }, WRITE),
      run: async function (args, api) {
        var command = String(args.command == null ? '' : args.command);
        if (!command) throw toolError('command is required');

        var check = await api.call('/api/security/check', { command: command });
        if (!check || check.status >= 400 || !check.body || check.body.success === false) {
          throw toolError('命令安全检查失败，拒绝执行');
        }
        var safety = check.body;
        var risk = safety.risk || 'warn';
        var reason = safety.reason || risk;
        var cfg = api.config() || {};

        if (risk === 'danger') {
          if (cfg.mcpAllowDanger !== true) {
            throw toolError('danger 级命令被 MCP 策略禁止：' + reason + '（可在 Agent 面板开启）');
          }
        } else if (risk === 'warn') {
          if (cfg.mcpAllowWarn === false) {
            throw toolError('warn 级命令被 MCP 策略禁止：' + reason);
          }
        }

        if (cfg.mcpRequireApproval === true) {
          var ok = await api.confirm({
            tool: 'exec',
            title: '执行命令',
            risk: risk,
            reason: reason,
            summary: command,
            timeoutMs: cfg.mcpApprovalTimeoutMs
          });
          if (!ok) {
            api.denied();
            throw toolError('用户拒绝了该命令');
          }
        }

        var params = { command: command, confirm: true };
        if (args.hostId) params.hostId = args.hostId;
        if (args.useSsh !== undefined) params.useSsh = args.useSsh;
        if (args.timeout !== undefined) {
          params.timeout = Math.min(Math.max(Number(args.timeout) || 60000, 1000), 300000);
        }
        return api.call('/api/exec', params);
      }
    },
    {
      name: 'fs_list',
      title: '文件列表',
      description: '列出远程主机的文件。',
      inputSchema: objectSchema({
        hostId: prop('string', '主机 id')
      }, []),
      annotations: Object.assign({ title: '文件列表' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/fs/list', args.hostId ? { hostId: args.hostId } : {}); }
    },
    {
      name: 'fs_download',
      title: '下载文件',
      description: '下载远程文件，返回 base64；小文件会附带 resource blob 内容块。',
      inputSchema: objectSchema({
        name: prop('string', '文件名 / 路径'),
        hostId: prop('string', '主机 id')
      }, ['name']),
      annotations: Object.assign({ title: '下载文件' }, READ_ONLY),
      run: function (args, api) {
        var p = { name: args.name };
        if (args.hostId) p.hostId = args.hostId;
        return api.call('/api/fs/download', p);
      }
    },
    {
      name: 'fs_upload',
      title: '上传文件',
      description: '上传 base64 内容到远程主机。大文件注意客户端超时与 32MB 请求体上限。',
      inputSchema: objectSchema({
        name: prop('string', '目标文件名'),
        rel: prop('string', '相对路径（默认同 name）'),
        dataBase64: prop('string', 'base64 编码的文件内容'),
        hostId: prop('string', '主机 id')
      }, ['name', 'dataBase64']),
      annotations: Object.assign({ title: '上传文件' }, WRITE),
      run: async function (args, api) {
        await api.guard({ tool: 'fs_upload', title: '上传文件', summary: args.name + ' (' + String(args.dataBase64 || '').length + ' b64 chars)' });
        return api.call('/api/fs/upload', args);
      }
    },
    {
      name: 'fs_delete',
      title: '删除文件',
      description: '删除远程主机上的文件。',
      inputSchema: objectSchema({
        name: prop('string', '文件名 / 路径'),
        hostId: prop('string', '主机 id')
      }, ['name']),
      annotations: Object.assign({ title: '删除文件' }, WRITE),
      run: async function (args, api) {
        await api.guard({ tool: 'fs_delete', title: '删除文件', summary: args.name });
        return api.call('/api/fs/delete', args);
      }
    },
    {
      name: 'ai_context',
      title: '读取 AI 上下文',
      description: '读取终端最近输出、最后一条命令、cwd、退出码。',
      inputSchema: objectSchema({
        termId: prop('string', '终端 id'),
        lines: prop('integer', '读取行数', { default: 50, minimum: 1, maximum: 5000 })
      }, []),
      annotations: Object.assign({ title: '读取 AI 上下文' }, READ_ONLY),
      run: function (args, api) {
        var p = {};
        if (args.termId) p.termId = args.termId;
        if (args.lines) p.lines = args.lines;
        return api.call('/api/ai/context', p);
      }
    },
    {
      name: 'security_check',
      title: '命令安全检查',
      description: '检查命令的风险等级（safe / warn / danger）与原因，不执行命令。',
      inputSchema: objectSchema({
        command: prop('string', '要检查的命令')
      }, ['command']),
      annotations: Object.assign({ title: '命令安全检查' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/security/check', { command: args.command }); }
    },
    {
      name: 'service_info',
      title: '服务信息',
      description: '返回 Agent 版本、域名、能力、主机与路由列表。',
      inputSchema: objectSchema({}, []),
      annotations: Object.assign({ title: '服务信息' }, READ_ONLY),
      run: function (args, api) { return api.call('/api/info', {}); }
    }
  ];

  var TOOL_MAP = {};
  TOOLS.forEach(function (tool) { TOOL_MAP[tool.name] = tool; });

  function publicTool(tool) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations
    };
  }

  function publicTools() {
    return TOOLS.map(publicTool);
  }

  // ============================================================
  // 资源与提示
  // ============================================================
  var RESOURCES = [
    {
      uri: 'pty://hosts',
      name: '主机列表',
      description: '所有 PTY 主机及连接状态',
      mimeType: 'application/json'
    },
    {
      uri: 'pty://terminals',
      name: '终端列表',
      description: '所有主机的终端列表',
      mimeType: 'application/json'
    },
    {
      uri: 'pty://files',
      name: '文件下载',
      description: '用 pty://files?name=<path>&hostId=<id> 读取文件内容',
      mimeType: 'application/octet-stream'
    }
  ];

  var RESOURCE_TEMPLATES = [
    {
      uriTemplate: 'pty://hosts/{hostId}',
      name: '主机状态',
      description: '单个主机状态',
      mimeType: 'application/json'
    },
    {
      uriTemplate: 'pty://terminals/{hostId}',
      name: '主机终端',
      description: '某台主机的终端列表',
      mimeType: 'application/json'
    },
    {
      uriTemplate: 'pty://terminals/{hostId}/{termId}/buffer',
      name: '终端输出',
      description: '终端最近 200 行输出',
      mimeType: 'text/plain'
    }
  ];

  var PROMPTS = [
    {
      name: 'diagnose_terminal',
      title: '诊断终端',
      description: '让模型读取终端上下文并给出诊断建议',
      arguments: [
        { name: 'termId', description: '终端 id（可省略）', required: false },
        { name: 'lines', description: '读取行数', required: false }
      ]
    },
    {
      name: 'run_and_explain',
      title: '执行并解释',
      description: '先安全检查，再执行命令并解释输出',
      arguments: [
        { name: 'command', description: '要执行的命令', required: true }
      ]
    }
  ];

  function promptResult(name, args) {
    args = args || {};
    if (name === 'diagnose_terminal') {
      var text = '请先调用 ai_context 读取终端上下文' +
        (args.termId ? '（termId=' + args.termId + '）' : '') +
        (args.lines ? '，读取 ' + args.lines + ' 行' : '') +
        '，然后分析最近的输出、最后一条命令和 cwd，给出下一步建议。不要执行危险命令。';
      return {
        description: '终端诊断提示',
        messages: [{ role: 'user', content: { type: 'text', text: text } }]
      };
    }
    if (name === 'run_and_explain') {
      var command = String(args.command || '');
      if (!command) throw toolError('command is required');
      return {
        description: '执行并解释提示',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: '请先用 security_check 检查命令风险，再用 exec 执行：\n```\n' + command + '\n```\n执行后解释 stdout/stderr 和退出码。'
          }
        }]
      };
    }
    throw toolError('Unknown prompt: ' + name);
  }

  // ============================================================
  // SSE / 工具结果
  // ============================================================
  function sseFrame(message) {
    return 'event: message\ndata: ' + JSON.stringify(message) + '\n\n';
  }

  function setSseHeaders(res) {
    res.set('content-type', 'text/event-stream; charset=utf-8');
    res.set('cache-control', 'no-cache');
    res.set('x-accel-buffering', 'no');
  }

  function setCors(res) {
    res.set('access-control-allow-origin', '*');
    res.set('access-control-allow-methods', '*, GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.set('access-control-allow-headers',
      '*, Authorization, Content-Type, Accept, X-Requested-With, X-Request-ID, X-Filename, X-Rel-Path, ' +
      'MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID');
    res.set('access-control-expose-headers', '*');
    res.set('access-control-max-age', '86400');
  }

  function toToolResult(tool, out) {
    var status = (out && out.status) || 200;
    var payload = out && out.body;
    var failed = status >= 400 || (payload && payload.success === false);
    var text;

    if (tool.name === 'pty_read' && payload && typeof payload.text === 'string') {
      text = payload.text;
    } else if (failed && payload && payload.error) {
      text = String(payload.error);
      if (payload.reason) text += '：' + payload.reason;
      if (payload.hint) text += '\n' + payload.hint;
    } else if (tool.name === 'exec' && payload) {
      text = String(payload.stdout || '');
      if (payload.stderr) text += (text ? '\n\n[stderr]\n' : '[stderr]\n') + payload.stderr;
      if (!text) text = '(no output, exitCode=' + payload.exitCode + ')';
    } else if (tool.name === 'fs_download' && payload) {
      text = 'downloaded ' + payload.name + ' (' + payload.size + ' bytes)';
    } else if (typeof payload === 'string') {
      text = payload;
    } else {
      text = safeStringify(payload);
    }

    var result = {
      content: [{ type: 'text', text: truncate(text) }],
      isError: failed
    };

    if (payload && typeof payload === 'object' && !ArrayBuffer.isView(payload)) {
      result.structuredContent = payload;
    }

    if (tool.name === 'fs_download' && payload && payload.dataBase64 &&
        payload.dataBase64.length <= MAX_RESOURCE_BLOB) {
      result.content.push({
        type: 'resource',
        resource: {
          uri: 'pty://files?name=' + encodeURIComponent(String(payload.name || 'download.bin')),
          name: String(payload.name || 'download.bin'),
          mimeType: 'application/octet-stream',
          blob: payload.dataBase64
        }
      });
    }

    return result;
  }

  // ============================================================
  // createServer
  // ============================================================
  function createServer(options) {
    options = options || {};

    var call = typeof options.call === 'function' ? options.call : function () {
      return Promise.reject(new Error('mcp: call() not configured'));
    };
    var getConfig = typeof options.getConfig === 'function' ? options.getConfig : function () { return {}; };
    var getService = typeof options.getService === 'function' ? options.getService : function () { return {}; };
    var log = typeof options.log === 'function' ? options.log : function () { };
    var confirm = typeof options.confirm === 'function' ? options.confirm : defaultConfirm;

    var state = {
      requests: 0,
      errors: 0,
      denied: 0,
      toolCalls: 0,
      active: 0,
      startedAt: now(),
      toolCounts: {},
      recent: []
    };
    var buckets = [];

    function cfg() { return getConfig() || {}; }
    function enabled() { return cfg().mcpEnabled !== false; }

    function disabledTools() {
      var list = Array.isArray(cfg().mcpDisabledTools) ? cfg().mcpDisabledTools.slice() : [];
      if (cfg().mcpReadOnly === true) {
        READ_ONLY_TOOL_NAMES.forEach(function (name) {
          if (list.indexOf(name) === -1) list.push(name);
        });
      }
      return list;
    }

    function serverMeta() {
      var meta = {};
      meta[META + 'serverInfo'] = { name: SERVER_NAME, version: VERSION };
      return meta;
    }

    function logEvent(event) {
      var entry = Object.assign({ time: new Date().toISOString() }, event || {});
      state.recent.push(entry);
      if (state.recent.length > 50) state.recent.shift();
      try { log(entry); } catch (e) { /* ignore */ }
    }

    function previewArgs(args) {
      var out = {};
      if (!args || typeof args !== 'object') return out;
      Object.keys(args).slice(0, 12).forEach(function (key) {
        var value = args[key];
        if (key === 'dataBase64') out[key] = '[base64 ' + String(value || '').length + ' chars]';
        else if (typeof value === 'string' && value.length > 160) out[key] = value.slice(0, 160) + '…';
        else out[key] = value;
      });
      return out;
    }

    function rateOk() {
      var limit = Number(cfg().mcpRateLimitPerMin || 240);
      if (!(limit > 0)) return true;
      var t = now();
      while (buckets.length && t - buckets[0] > 60000) buckets.shift();
      if (buckets.length >= limit) return false;
      buckets.push(t);
      return true;
    }

    function authorized(req) {
      var token = String(cfg().mcpToken || '');
      if (!token) return true;
      var header = String(req.get('authorization') || '');
      var match = /^Bearer\s+(.+)$/i.exec(header);
      return !!match && safeEqual(match[1].trim(), token);
    }

    function guard(info) {
      if (cfg().mcpRequireApproval !== true) return Promise.resolve(true);
      return Promise.resolve(confirm(info)).then(function (ok) {
        if (!ok) {
          state.denied += 1;
          throw toolError('用户拒绝了该操作');
        }
        return true;
      });
    }

    function parseBody(req) {
      var body = req.body;
      var raw = req.rawBody;
      if (body === undefined || body === null) {
        if (!raw || !raw.length) return { error: { code: -32700, message: 'Parse error: empty body' } };
        try { body = JSON.parse(decodeBytes(raw)); }
        catch (e) { return { error: { code: -32700, message: 'Parse error: invalid JSON' } }; }
      }
      if (typeof body === 'string') {
        var text = body.trim();
        if (!text) return { error: { code: -32700, message: 'Parse error: empty body' } };
        try { body = JSON.parse(text); }
        catch (e) { return { error: { code: -32700, message: 'Parse error: invalid JSON' } }; }
      }
      if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) {
        try { body = JSON.parse(decodeBytes(body)); }
        catch (e) { return { error: { code: -32700, message: 'Parse error: invalid JSON' } }; }
      }
      return { value: body };
    }

    function validateRequest(message) {
      if (Array.isArray(message)) {
        return { code: -32600, message: 'Batch requests are not supported' };
      }
      if (!isObject(message)) {
        return { code: -32600, message: 'Invalid Request: body must be a JSON object' };
      }
      if (message.jsonrpc !== '2.0') {
        return { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' };
      }
      if (typeof message.method !== 'string' || !message.method) {
        return { code: -32600, message: 'Invalid Request: method is required' };
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        var type = typeof message.id;
        if (type !== 'string' && type !== 'number' && message.id !== null) {
          return { code: -32600, message: 'Invalid Request: id must be string, number or null' };
        }
      }
      return null;
    }

    function detectEra(req, message) {
      var headerVersion = String(req.get('mcp-protocol-version') || '').trim();
      var params = message.params || {};
      var meta = isObject(params._meta) ? params._meta : {};
      var metaVersion = meta[META + 'protocolVersion'];
      var version = String(metaVersion || headerVersion || '');

      if (!version) {
        return { modern: false, version: null };
      }

      if (version !== MODERN &&
          PROTOCOL_VERSIONS.indexOf(version) === -1) {
        return {
          httpStatus: 400,
          error: {
            code: -32022,
            message: 'Unsupported protocol version: ' + version,
            data: { supportedVersions: PROTOCOL_VERSIONS }
          }
        };
      }

      if (version === MODERN) {
        if (!headerVersion) {
          return { httpStatus: 400, error: { code: -32020, message: 'MCP-Protocol-Version header is required' } };
        }
        if (!metaVersion) {
          return { httpStatus: 400, error: { code: -32602, message: 'params._meta["io.modelcontextprotocol/protocolVersion"] is required' } };
        }
        if (headerVersion !== String(metaVersion)) {
          return {
            httpStatus: 400,
            error: { code: -32020, message: 'Header mismatch: MCP-Protocol-Version="' + headerVersion + '" but _meta version="' + metaVersion + '"' }
          };
        }
        if (!isObject(meta[META + 'clientCapabilities']) && cfg().mcpRequireClientCapabilities === true) {
          return {
            httpStatus: 400,
            error: { code: -32021, message: 'params._meta["io.modelcontextprotocol/clientCapabilities"] is required' }
          };
        }
        if (cfg().mcpStrictHeaders !== false) {
          var methodHeader = decodeHeaderValue(req.get('mcp-method') || '');
          if (!methodHeader) {
            return { httpStatus: 400, error: { code: -32020, message: 'Mcp-Method header is required' } };
          }
          if (methodHeader !== message.method) {
            return {
              httpStatus: 400,
              error: { code: -32020, message: 'Header mismatch: Mcp-Method="' + methodHeader + '" but body method="' + message.method + '"' }
            };
          }
          if (message.method === 'tools/call' || message.method === 'resources/read' || message.method === 'prompts/get') {
            var nameHeader = decodeHeaderValue(req.get('mcp-name') || '');
            var bodyName = String((message.params && (message.params.name || message.params.uri)) || '');
            if (!nameHeader) {
              return { httpStatus: 400, error: { code: -32020, message: 'Mcp-Name header is required for ' + message.method } };
            }
            if (nameHeader !== bodyName) {
              return {
                httpStatus: 400,
                error: { code: -32020, message: 'Header mismatch: Mcp-Name="' + nameHeader + '" but body value="' + bodyName + '"' }
              };
            }
          }
        }
        return { modern: true, version: MODERN };
      }

      return { modern: false, version: version };
    }

    function initializeResult(params) {
      params = params || {};
      var requested = String(params.protocolVersion || '');
      var version = LEGACY_VERSIONS.indexOf(requested) !== -1 ? requested : LEGACY_VERSIONS[0];
      return {
        protocolVersion: version,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false }
        },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: INSTRUCTIONS
      };
    }

    function discoverResult() {
      return {
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false }
        },
        instructions: INSTRUCTIONS,
        ttlMs: 3600000,
        cacheScope: 'public'
      };
    }

    function toolsList(era) {
      var disabled = disabledTools();
      var result = {
        tools: TOOLS.filter(function (tool) {
          return disabled.indexOf(tool.name) === -1;
        }).map(publicTool)
      };
      if (era.modern) {
        result.ttlMs = 60000;
        result.cacheScope = 'private';
      }
      return result;
    }

    function resourcesList(era) {
      var result = { resources: RESOURCES };
      if (era.modern) {
        result.ttlMs = 60000;
        result.cacheScope = 'private';
      }
      return result;
    }

    function resourceTemplatesList(era) {
      var result = { resourceTemplates: RESOURCE_TEMPLATES };
      if (era.modern) {
        result.ttlMs = 60000;
        result.cacheScope = 'private';
      }
      return result;
    }

    function promptsList(era) {
      var result = { prompts: PROMPTS };
      if (era.modern) {
        result.ttlMs = 60000;
        result.cacheScope = 'private';
      }
      return result;
    }

    function resourceContent(uri, mimeType, text) {
      return { contents: [{ uri: uri, mimeType: mimeType, text: text }] };
    }

    async function readResource(params) {
      var uri = String((params && params.uri) || '');
      if (!uri) throw toolError('uri is required');

      var parsed;
      try { parsed = new URL(uri); }
      catch (e) { throw toolError('Invalid uri: ' + uri); }
      if (parsed.protocol !== 'pty:') throw toolError('Unsupported uri scheme: ' + parsed.protocol);

      var host = parsed.hostname;
      var path = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');

      if (host === 'hosts') {
        if (!path) {
          var hosts = await call('/api/hosts/list', {});
          return resourceContent(uri, 'application/json', safeStringify(hosts.body));
        }
        var status = await call('/api/hosts/status', { hostId: path });
        return resourceContent(uri, 'application/json', safeStringify(status.body));
      }

      if (host === 'terminals') {
        var parts = path ? path.split('/').filter(Boolean) : [];
        if (!parts.length) {
          var all = await call('/api/pty/list', {});
          return resourceContent(uri, 'application/json', safeStringify(all.body));
        }
        if (parts.length === 1) {
          var list = await call('/api/pty/list', { hostId: parts[0] });
          return resourceContent(uri, 'application/json', safeStringify(list.body));
        }
        if (parts.length === 3 && parts[2] === 'buffer') {
          var read = await call('/api/pty/read', { hostId: parts[0], termId: parts[1], lines: 200 });
          return resourceContent(uri, 'text/plain', String((read.body && read.body.text) || ''));
        }
        throw toolError('Unsupported terminals uri: ' + uri);
      }

      if (host === 'files') {
        var name = parsed.searchParams.get('name');
        if (!name) throw toolError('files uri requires ?name=');
        var p = { name: name };
        var hid = parsed.searchParams.get('hostId');
        if (hid) p.hostId = hid;
        var file = await call('/api/fs/download', p);
        var body = file.body || {};
        if (body.dataBase64) {
          return {
            contents: [{
              uri: uri,
              mimeType: 'application/octet-stream',
              blob: body.dataBase64
            }]
          };
        }
        return resourceContent(uri, 'application/octet-stream', safeStringify(body));
      }

      throw toolError('Unknown resource host: ' + host);
    }

    async function callTool(params, era) {
      var name = String((params && params.name) || '');
      if (!name) return { error: { code: -32602, message: 'params.name is required' } };
      var tool = TOOL_MAP[name];
      if (!tool) return { error: { code: -32602, message: 'Unknown tool: ' + name } };
      if (disabledTools().indexOf(name) !== -1) {
        return { result: toolErrText('工具已被禁用：' + name + '（可在 Agent 面板启用）') };
      }

      var args = params.arguments;
      if (args === undefined || args === null) args = {};
      if (!isObject(args)) return { error: { code: -32602, message: 'params.arguments must be an object' } };

      var maxConcurrent = Number(cfg().mcpMaxConcurrent || 4);
      if (state.active >= maxConcurrent) {
        return { result: toolErrText('服务器繁忙：并发上限 ' + maxConcurrent + '，请稍后重试') };
      }

      state.active += 1;
      state.toolCalls += 1;
      state.toolCounts[name] = (state.toolCounts[name] || 0) + 1;
      var started = now();

      try {
        var out = await tool.run(args, api);
        var result = toToolResult(tool, out);
        logEvent({
          method: 'tools/call',
          tool: name,
          args: previewArgs(args),
          status: (out && out.status) || 200,
          isError: result.isError === true,
          ms: now() - started
        });
        return { result: result };
      } catch (error) {
        if (error && error.toolError) {
          logEvent({
            method: 'tools/call',
            tool: name,
            args: previewArgs(args),
            status: 0,
            isError: true,
            reason: error.message,
            ms: now() - started
          });
          return { result: toolErrText(error.message) };
        }
        state.errors += 1;
        logEvent({
          method: 'tools/call',
          tool: name,
          args: previewArgs(args),
          status: 0,
          isError: true,
          reason: (error && error.message) || String(error),
          ms: now() - started
        });
        return {
          error: {
            code: -32603,
            message: 'Tool execution failed: ' + ((error && error.message) || String(error))
          }
        };
      } finally {
        state.active -= 1;
      }
    }

    function methodNotFound(era, method) {
      if (era.modern) {
        return { httpStatus: 404, error: { code: -32601, message: 'Method not found: ' + method } };
      }
      return { error: { code: -32601, message: 'Method not found: ' + method } };
    }

    async function dispatch(message, era) {
      var method = message.method;
      var params = isObject(message.params) ? message.params : {};

      switch (method) {
        case 'initialize':
          if (era.modern) return methodNotFound(era, method);
          return { result: initializeResult(params) };

        case 'notifications/initialized':
          return { result: {} };

        case 'ping':
          if (era.modern) return methodNotFound(era, method);
          return { result: {} };

        case 'server/discover':
          if (!era.modern) return methodNotFound(era, method);
          return { result: discoverResult() };

        case 'tools/list':
          return { result: toolsList(era) };

        case 'tools/call':
          return callTool(params, era);

        case 'resources/list':
          return { result: resourcesList(era) };

        case 'resources/templates/list':
          return { result: resourceTemplatesList(era) };

        case 'resources/read':
          return { result: await readResource(params) };

        case 'prompts/list':
          return { result: promptsList(era) };

        case 'prompts/get':
          return { result: promptResult(String(params.name || ''), params.arguments || {}) };

        case 'logging/setLevel':
          if (era.modern) return methodNotFound(era, method);
          return { result: {} };

        case 'subscriptions/listen':
          return {
            httpStatus: 404,
            error: {
              code: -32601,
              message: 'subscriptions/listen requires SSE (Accept: text/event-stream)'
            }
          };

        default:
          return methodNotFound(era, method);
      }
    }

    function decorateResult(result, era) {
      if (!era.modern) return result;
      if (!isObject(result)) return result;
      if (!result.resultType) result.resultType = 'complete';
      if (!isObject(result._meta)) result._meta = serverMeta();
      else if (!result._meta[META + 'serverInfo']) result._meta[META + 'serverInfo'] = serverMeta()[META + 'serverInfo'];
      return result;
    }

    function sendJson(res, status, payload) {
      if (res && res.isSse === true) {
        // 中继已写好 text/event-stream 头：只写事件体，再结束流。
        res.write(JSON.stringify(payload));
        res.end();
        return res;
      }
      return res.status(status).json(payload);
    }

    function sendError(res, status, id, error) {
      return sendJson(res, status || 200, {
        jsonrpc: '2.0',
        id: id === undefined ? null : id,
        error: error
      });
    }

    function wantsSse(req) {
      if (req && req.isSSE === true) return true;
      var accept = String(req.get('accept') || '');
      if (!/text\/event-stream/i.test(accept)) return false;
      // 同时接受 JSON 时优先 JSON（兼容更多客户端）；只接受 SSE 时才走 SSE。
      return !/application\/json/i.test(accept);
    }

    function handleSubscriptionsListen(req, res) {
      var subscriptionId = 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      logEvent({ method: 'subscriptions/listen', subscriptionId: subscriptionId });

      res.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { subscriptionId: subscriptionId }
      }));

      // 保持 SSE 流打开，直到客户端断开（中继会回 sse_close）。
      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          try { res.off('close', finish); } catch (error) { /* ignore */ }
          resolve();
        }
        try { res.on('close', finish); } catch (error) { finish(); }
      });
    }

    function handlePost(req, res) {
      setCors(res);
      if (!enabled()) {
        return sendJson(res, 404, { ok: false, error: 'mcp_disabled', hint: '在 Agent 面板启用 MCP' });
      }
      if (!authorized(req)) {
        res.set('www-authenticate', 'Bearer realm="pty2-mcp"');
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (!rateOk()) {
        return sendError(res, 429, null, { code: -32603, message: 'Rate limit exceeded' });
      }

      state.requests += 1;

      var contentType = String(req.get('content-type') || '');
      if (contentType && !/application\/json/i.test(contentType)) {
        return sendError(res, 415, null, { code: -32600, message: 'Content-Type must be application/json' });
      }

      var parsed = parseBody(req);
      if (parsed.error) {
        state.errors += 1;
        return sendError(res, 400, null, parsed.error);
      }

      var message = parsed.value;
      var invalid = validateRequest(message);
      if (invalid) {
        state.errors += 1;
        return sendError(res, 400, isObject(message) ? message.id : null, invalid);
      }

      var hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      var id = hasId ? message.id : null;

      var era = detectEra(req, message);
      if (era.error) {
        state.errors += 1;
        return sendError(res, era.httpStatus || 400, id, era.error);
      }

      if (!hasId) {
        // 通知：接受即 202，无 body。
        res.status(202).end();
        return;
      }

      if (message.method === 'subscriptions/listen') {
        if (req.isSSE === true) {
          return handleSubscriptionsListen(req, res);
        }
        return sendError(res, 404, id, {
          code: -32601,
          message: 'subscriptions/listen requires an SSE response (Accept: text/event-stream)'
        });
      }

      return Promise.resolve()
        .then(function () { return dispatch(message, era); })
        .then(function (out) {
          if (out && out.error) {
            state.errors += 1;
            return sendError(res, out.httpStatus || 200, id, out.error);
          }

          var result = decorateResult(out.result, era);

          if (req.isSSE === true) {
            // 真流式：中继用旧 SSE 旁路把请求送进来，这里逐条写 sse_data。
            var streamFrames = [];
            var streamToken = message.params && message.params._meta && message.params._meta.progressToken;
            if (streamToken !== undefined && streamToken !== null) {
              streamFrames.push({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: streamToken, progress: 1, total: 1 }
              });
            }
            streamFrames.push({ jsonrpc: '2.0', id: id, result: result });
            streamFrames.forEach(function (frame) { res.write(JSON.stringify(frame)); });
            res.end();
            return;
          }

          if (wantsSse(req)) {
            var frames = [];
            var progressToken = message.params && message.params._meta && message.params._meta.progressToken;
            if (progressToken !== undefined && progressToken !== null) {
              frames.push({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: progressToken, progress: 1, total: 1 }
              });
            }
            frames.push({ jsonrpc: '2.0', id: id, result: result });
            setSseHeaders(res);
            var body = frames.map(sseFrame).join('');
            return res.status(200).send(body);
          }

          return sendJson(res, 200, { jsonrpc: '2.0', id: id, result: result });
        })
        .catch(function (error) {
          state.errors += 1;
          logEvent({ method: message.method, status: 0, reason: (error && error.message) || String(error) });
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id: id,
            error: { code: -32603, message: 'Internal error: ' + ((error && error.message) || String(error)) }
          });
        });
    }

    function handleGet(req, res) {
      setCors(res);
      if (!enabled()) {
        return sendJson(res, 404, { ok: false, error: 'mcp_disabled' });
      }
      if (!authorized(req)) {
        res.set('www-authenticate', 'Bearer realm="pty2-mcp"');
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      // GET 也支持直接调用：
      //   /mcp?method=tools/list
      //   /mcp?message=<urlencoded JSON-RPC>
      //   /mcp?method=tools/call&params=<urlencoded JSON>&id=1
      var query = req.query || {};
      var message = null;
      try {
        if (query.message) {
          message = JSON.parse(String(query.message));
        } else if (query.method) {
          var params = {};
          if (query.params) params = JSON.parse(String(query.params));
          message = {
            jsonrpc: '2.0',
            id: query.id !== undefined ? query.id : 1,
            method: String(query.method),
            params: params
          };
        }
      } catch (error) {
        return sendError(res, 400, null, { code: -32700, message: 'Parse error in GET query' });
      }

      if (message) {
        // 让 GET 也能走与现代 POST 相同的头部校验（用 query 模拟头部）
        if (query.protocolVersion && req.headers) {
          req.headers['mcp-protocol-version'] = String(query.protocolVersion);
        }
        if (query.method && req.headers) {
          req.headers['mcp-method'] = String(query.method);
        }
        if (paramsName(message) && req.headers) {
          req.headers['mcp-name'] = paramsName(message);
        }
        req.body = message;
        return handlePost(req, res);
      }

      var payload = info();
      if (req.isSSE === true) {
        return sendJson(res, 200, payload);
      }
      if (wantsSse(req)) {
        setSseHeaders(res);
        return res.status(200).send(sseFrame(payload));
      }
      return sendJson(res, 200, payload);
    }

    function handleDelete(req, res) {
      setCors(res);
      res.set('allow', 'GET, POST');
      return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        allow: 'GET, POST',
        hint: '本服务无协议级会话，不需要 DELETE'
      });
    }

    function info() {
      var svc = getService() || {};
      var base = svc.apiBase || '';
      var disabled = disabledTools();
      var enabledTools = TOOLS.filter(function (tool) {
        return disabled.indexOf(tool.name) === -1;
      });
      return {
        name: SERVER_NAME + ' MCP',
        version: VERSION,
        enabled: enabled(),
        readOnly: cfg().mcpReadOnly === true,
        endpoint: base ? base + '/mcp' : '/mcp',
        description: 'PTY Agent MCP endpoint (Streamable HTTP)',
        protocolVersions: PROTOCOL_VERSIONS,
        transport: {
          type: 'streamable-http',
          methods: ['POST', 'GET', 'DELETE'],
          responseModes: ['application/json', 'text/event-stream'],
          sse: 'streaming',
          note: 'SSE 走中继的旧 SSE 旁路（sdk capabilities.stream=false）：sse_data 逐条推送；subscriptions/listen 会保持连接。'
        },
        capabilities: {
          tools: { count: enabledTools.length, listChanged: false },
          resources: { count: RESOURCES.length, subscribe: false, listChanged: false },
          prompts: { count: PROMPTS.length, listChanged: false }
        },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: INSTRUCTIONS,
        tools: enabledTools.map(publicTool),
        resources: RESOURCES,
        resourceTemplates: RESOURCE_TEMPLATES,
        prompts: PROMPTS
      };
    }

    function stats() {
      return {
        enabled: enabled(),
        requests: state.requests,
        errors: state.errors,
        denied: state.denied,
        toolCalls: state.toolCalls,
        active: state.active,
        tools: TOOLS.length - disabledTools().length,
        resources: RESOURCES.length,
        prompts: PROMPTS.length,
        uptimeMs: now() - state.startedAt,
        toolCounts: Object.assign({}, state.toolCounts),
        recent: state.recent.slice(-10)
      };
    }

    var api = {
      call: call,
      config: cfg,
      guard: guard,
      confirm: confirm,
      denied: function () { state.denied += 1; }
    };

    return {
      handlePost: handlePost,
      handleGet: handleGet,
      handleDelete: handleDelete,
      info: info,
      stats: stats,
      tools: publicTools,
      version: VERSION,
      protocolVersions: PROTOCOL_VERSIONS.slice()
    };
  }

  // ============================================================
  // 默认确认框（浏览器）
  // ============================================================
  function defaultConfirm(info) {
    if (typeof document === 'undefined') return Promise.resolve(false);
    info = info || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;';

      var card = document.createElement('div');
      card.style.cssText = 'background:#2c3e50;color:#eee;border-radius:8px;padding:18px;max-width:600px;width:100%;font-family:Arial,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);';

      var title = document.createElement('div');
      title.textContent = 'MCP 请求确认';
      title.style.cssText = 'font-weight:bold;font-size:16px;margin-bottom:10px;';

      var desc = document.createElement('div');
      desc.textContent = (info.title || info.tool || '操作') + (info.risk ? '（' + info.risk + '）' : '');
      desc.style.cssText = 'color:#f1c40f;margin-bottom:8px;';

      var reason = document.createElement('div');
      reason.textContent = info.reason || '';
      reason.style.cssText = 'color:#bdc3c7;font-size:12px;margin-bottom:8px;';

      var pre = document.createElement('pre');
      pre.textContent = info.summary || info.command || '';
      pre.style.cssText = 'background:#1e1e1e;padding:10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;font-size:12px;margin:0;';

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;margin-top:14px;';

      var allow = document.createElement('button');
      allow.textContent = '允许一次';
      allow.style.cssText = 'flex:1;padding:10px;background:#27ae60;color:#fff;border:0;border-radius:4px;font-weight:bold;cursor:pointer;';

      var deny = document.createElement('button');
      deny.textContent = '拒绝';
      deny.style.cssText = 'flex:1;padding:10px;background:#c0392b;color:#fff;border:0;border-radius:4px;font-weight:bold;cursor:pointer;';

      row.appendChild(allow);
      row.appendChild(deny);
      card.appendChild(title);
      card.appendChild(desc);
      if (info.reason) card.appendChild(reason);
      card.appendChild(pre);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      var timer = setTimeout(function () { done(false); }, Number(info.timeoutMs) || 60000);

      function done(value) {
        clearTimeout(timer);
        try { overlay.remove(); } catch (e) { /* ignore */ }
        resolve(value);
      }

      allow.onclick = function () { done(true); };
      deny.onclick = function () { done(false); };
    });
  }

  return {
    version: VERSION,
    PROTOCOL_VERSIONS: PROTOCOL_VERSIONS,
    LEGACY_VERSIONS: LEGACY_VERSIONS,
    TOOLS: TOOLS,
    createServer: createServer,
    // 供 openai-compat.js 复用同一个页面确认框
    confirm: defaultConfirm
  };
});
