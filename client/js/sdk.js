/**
 * DTNS Agent SDK · sdk.js (generated)
 *
 * Self-contained proxy SDK: embeds the DTNS binary codec and exposes an
 * Express-style app for binding HTTP APIs through the dtns.http-proxy tunnel.
 *
 * Regenerate from assets/dtns-protocol.js + assets/sdk-app.js with build-sdk.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DTNSAgent = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==================== embedded DTNS protocol codec ====================
  var Protocol = (function () {
'use strict';

  var MAGIC = [0x44, 0x54, 0x4e, 0x53]; // "DTNS"
  var VERSION = 1;
  var VERSION_2 = 2;

  var TYPE = {
    REGISTER_TUNNEL: 0x0001,
    UNREGISTER_TUNNEL: 0x0002,
    HEARTBEAT: 0x0003,
    HTTP_RESPONSE: 0x0004,
    TUNNEL_LIST: 0x0005,
    COMMAND_RESPONSE: 0x0006,
    STATS: 0x0007,
    SSE_DATA: 0x0008,
    SSE_END: 0x0009,
    SSE_ERROR: 0x000a,
    SSE_CLOSE: 0x000b,
    WEBSOCKET_UPGRADED: 0x000c,
    WEBSOCKET_DATA: 0x000d,
    WEBSOCKET_END: 0x000e,
    WEBSOCKET_ERROR: 0x000f,
    WEBSOCKET_CLOSE: 0x0010,
    SSE_CONNECTIONS: 0x0011,
    ERROR: 0x0012,
    STREAM_OPEN: 0x0020,
    STREAM_CHUNK: 0x0021,
    STREAM_END: 0x0022,
    STREAM_ACK: 0x0023,
    STREAM_CANCEL: 0x0024,
    CAPABILITIES: 0x0025,
    WELCOME: 0x0101,
    REGISTERED: 0x0102,
    UNREGISTERED: 0x0103,
    HEARTBEAT_ACK: 0x0104,
    HTTP_REQUEST: 0x0105,
    TUNNEL_STATUS: 0x0106,
    COMMAND: 0x0107,
    WEBSOCKET_DATA_FROM_SERVER: 0x0108,
    WEBSOCKET_CLOSE_FROM_SERVER: 0x0109,
    SSE_DATA_FROM_SERVER: 0x010a,
    SSE_END_FROM_SERVER: 0x010b,
    SSE_ERROR_FROM_SERVER: 0x010c,
    SSE_CLOSE_FROM_SERVER: 0x010d
  };

  var TYPE_NAME = {};
  Object.keys(TYPE).forEach(function (name) {
    TYPE_NAME[TYPE[name]] = name.toLowerCase();
  });

  var FLAGS = {
    HAS_BODY: 0x0001,
    HAS_HEADERS: 0x0002,
    IS_SSE: 0x0004,
    IS_WEBSOCKET: 0x0008,
    GZIPPED: 0x0010,
    IS_BINARY: 0x0020
  };

  var encoder = new TextEncoder();
  var decoder = new TextDecoder('utf-8');

  function utf8(text) {
    return encoder.encode(text == null ? '' : String(text));
  }

  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return utf8(input);
  }

  function concat(parts) {
    var length = 0;
    var i;
    for (i = 0; i < parts.length; i++) length += parts[i].length;
    var output = new Uint8Array(length);
    var offset = 0;
    for (i = 0; i < parts.length; i++) {
      output.set(parts[i], offset);
      offset += parts[i].length;
    }
    return output;
  }

  function u8(value) {
    return new Uint8Array([value & 0xff]);
  }

  function u16(value) {
    var bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff);
    return bytes;
  }

  function u32(value) {
    var bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0);
    return bytes;
  }

  function encodeString(value) {
    var bytes = utf8(value);
    return concat([u16(bytes.length), bytes]);
  }

  function encodeBuffer(value) {
    var bytes = toBytes(value);
    return concat([u32(bytes.length), bytes]);
  }

  function encodeHeaders(headers, multiValue) {
    headers = headers || {};
    var keys = Object.keys(headers).filter(function (key) {
      return headers[key] !== undefined && headers[key] !== null;
    });

    var parts = [u16(keys.length)];
    keys.forEach(function (key) {
      var value = headers[key];
      var text = Array.isArray(value)
        ? value.map(String).join(multiValue ? '\n' : ',')
        : String(value);
      parts.push(encodeString(key));
      parts.push(encodeString(text));
    });
    return concat(parts);
  }

  function Reader(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  Reader.prototype.u8 = function () {
    var value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  };

  Reader.prototype.u16 = function () {
    var value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  };

  Reader.prototype.u32 = function () {
    var value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  };

  Reader.prototype.str = function () {
    var length = this.u16();
    var value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  };

  Reader.prototype.buf = function () {
    var length = this.u32();
    var value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  };

  Reader.prototype.headers = function () {
    var count = this.u16();
    var output = {};
    for (var i = 0; i < count; i++) {
      var key = this.str();
      var value = this.str();
      output[key] = value.indexOf('\n') >= 0 ? value.split('\n') : value;
    }
    return output;
  };

  Reader.prototype.remaining = function () {
    return this.bytes.length - this.offset;
  };

  function encodeFrame(typeName, payload, version, flags) {
    var typeCode = TYPE[String(typeName).toUpperCase()];
    if (typeCode === undefined) throw new Error('Unknown DTNS frame type: ' + typeName);

    var header = new Uint8Array(13);
    header.set(MAGIC, 0);
    header[4] = version === VERSION_2 ? VERSION_2 : VERSION;
    var view = new DataView(header.buffer);
    view.setUint16(5, typeCode);
    view.setUint16(7, flags || 0);
    view.setUint32(9, payload.length);
    return concat([header, payload]);
  }

  function decodeFrame(input) {
    var bytes = toBytes(input);
    if (bytes.length < 13) throw new Error('DTNS frame too short: ' + bytes.length);

    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new Error('Invalid DTNS magic');
    }

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var version = bytes[4];
    var typeCode = view.getUint16(5);
    var flags = view.getUint16(7);
    var length = view.getUint32(9);

    if (bytes.length < 13 + length) {
      throw new Error('DTNS frame truncated: need ' + (13 + length) + ', got ' + bytes.length);
    }

    return {
      version: version,
      typeCode: typeCode,
      type: TYPE_NAME[typeCode] || 'unknown_0x' + typeCode.toString(16),
      flags: flags,
      payload: bytes.slice(13, 13 + length),
      byteLength: bytes.length
    };
  }

  // ==================== client -> server ====================

  function encodeRegisterTunnel(fields) {
    var tunnel = fields.tunnel || fields;
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(tunnel.id || ''),
      encodeString(tunnel.domain || ''),
      u8((tunnel.localPort || 80) & 0xff),
      encodeString(tunnel.localHost || '127.0.0.1'),
      encodeString(tunnel.protocol || 'http'),
      encodeString(tunnel.description || '')
    ]);
    return encodeFrame('register_tunnel', payload, VERSION, 0);
  }

  function encodeUnregisterTunnel(fields) {
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(fields.domain || '')
    ]);
    return encodeFrame('unregister_tunnel', payload, VERSION, 0);
  }

  function encodeCapabilities(fields) {
    var flags = 0;
    if (fields.stream) flags |= 0x01;
    if (fields.multiValueHeaders) flags |= 0x02;
    var payload = concat([encodeString(fields.clientId || ''), u8(flags)]);
    return encodeFrame('capabilities', payload, VERSION, 0);
  }

  function encodeHeartbeat(fields) {
    var stats = fields.stats || {};
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(fields.timestamp || new Date().toISOString()),
      u32(stats.tunnelCount || 0),
      u32(stats.registeredCount || 0),
      u32(stats.sseConnections || 0),
      u32(stats.totalRequests || 0),
      u32(stats.totalErrors || 0)
    ]);
    return encodeFrame('heartbeat', payload, VERSION, 0);
  }

  function encodeHttpResponse(fields, version) {
    var v = version >= VERSION_2 ? VERSION_2 : VERSION;
    var status = Number(fields.status);
    if (!(status >= 100 && status <= 599)) status = 200;

    var body = toBytes(fields.body);
    var headers = fields.headers || {};
    var payloadFlags = 0;
    if (fields.isSSE) payloadFlags |= 0x01;
    if (fields.isWebSocket) payloadFlags |= 0x02;
    if (fields.error) payloadFlags |= 0x04;

    var payload = concat([
      encodeString(fields.requestId || ''),
      encodeString(fields.domain || ''),
      v >= VERSION_2 ? u16(status) : u8(status),
      encodeHeaders(headers, true),
      encodeBuffer(body),
      u8(payloadFlags),
      encodeString(fields.sseRequestId || ''),
      encodeString(fields.wsRequestId || ''),
      encodeString(fields.error || '')
    ]);

    var frameFlags = 0;
    if (body.length) frameFlags |= FLAGS.HAS_BODY;
    if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
    if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
    if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

    return encodeFrame('http_response', payload, v, frameFlags);
  }

  function encodeWebSocketData(fields) {
    var data = toBytes(fields.data);
    var payload = concat([
      encodeString(fields.wsRequestId || ''),
      encodeBuffer(data),
      encodeString(fields.timestamp || new Date().toISOString())
    ]);
    var flags = fields.binary ? FLAGS.IS_BINARY : 0;
    return encodeFrame('websocket_data', payload, VERSION, flags);
  }

  function encodeWebSocketClose(fields) {
    var code = fields.code === undefined ? 1000 : Number(fields.code);
    if (!isFinite(code)) code = 1000;
    var payload = concat([
      encodeString(fields.wsRequestId || ''),
      u8(code & 0xff),
      encodeString(fields.reason || ''),
      encodeString(fields.timestamp || new Date().toISOString())
    ]);
    return encodeFrame('websocket_close', payload, VERSION, 0);
  }

  // ==================== SSE (client -> server) ====================
  // 旧 SSE 旁路：sseRequestId 由中继在 handleSSERequest() 中生成，
  // 客户端通过 sse_data / sse_end 帧把事件推回浏览器。

  function encodeSSEData(fields) {
    var data = typeof fields.data === 'string'
      ? utf8(fields.data)
      : utf8(JSON.stringify(fields.data === undefined ? '' : fields.data));
    var payload = concat([
      encodeString(fields.sseRequestId || ''),
      encodeBuffer(data),
      encodeString(fields.event || ''),
      encodeString(fields.id || ''),
      u8(fields.retry || 0),
      encodeString(fields.timestamp || new Date().toISOString())
    ]);
    return encodeFrame('sse_data', payload, VERSION, 0);
  }

  function encodeSSEEnd(fields) {
    // 服务端没有 sse_end 专用解码器，走通用 JSON（u32 长度 + JSON）。
    return encodeFrame('sse_end', encodeGeneric({
      type: 'sse_end',
      sseRequestId: fields.sseRequestId || '',
      timestamp: fields.timestamp || new Date().toISOString()
    }), VERSION, 0);
  }

  function encodeSSEError(fields) {
    return encodeFrame('sse_error', encodeGeneric({
      type: 'sse_error',
      sseRequestId: fields.sseRequestId || '',
      error: fields.error || '',
      timestamp: fields.timestamp || new Date().toISOString()
    }), VERSION, 0);
  }

  function encodeGeneric(fields) {
    var bytes = utf8(JSON.stringify(fields));
    return concat([u32(bytes.length), bytes]);
  }

  // ==================== server -> client ====================

  function decodeWelcome(payload) {
    var reader = new Reader(payload);
    var clientId = reader.str();
    var timestamp = reader.str();
    var message = reader.str();
    var protocolVersion = reader.remaining() > 0 ? reader.u8() : VERSION;
    return {
      type: 'welcome',
      clientId: clientId,
      timestamp: timestamp,
      message: message,
      protocolVersion: protocolVersion
    };
  }

  function decodeRegistered(payload) {
    var reader = new Reader(payload);
    var domain = reader.str();
    var success = reader.u8() === 1;
    var error = reader.str();
    var message = reader.str();
    return {
      type: 'registered',
      domain: domain,
      success: success,
      error: error || null,
      message: message
    };
  }

  function decodeHttpRequest(payload) {
    var reader = new Reader(payload);
    var requestId = reader.str();
    var domain = reader.str();
    var method = reader.str();
    var url = reader.str();
    var headers = reader.headers();
    var body = reader.buf();
    var remoteAddress = reader.str();
    var timestamp = reader.str();
    var flags = reader.u8();
    var sseRequestId = reader.str();
    var wsRequestId = reader.str();

    return {
      type: 'http_request',
      requestId: requestId,
      domain: domain,
      method: method,
      url: url,
      headers: headers,
      body: body,
      remoteAddress: remoteAddress,
      timestamp: timestamp,
      isSSE: !!(flags & 0x01),
      isWebSocket: !!(flags & 0x02),
      sseRequestId: sseRequestId || null,
      wsRequestId: wsRequestId || null
    };
  }

  function decodeWebSocketData(payload, flags) {
    var reader = new Reader(payload);
    var wsRequestId = reader.str();
    var data = reader.buf();
    var timestamp = reader.str();
    return {
      type: 'websocket_data',
      wsRequestId: wsRequestId,
      data: data,
      isBinary: !!(flags & FLAGS.IS_BINARY),
      timestamp: timestamp
    };
  }

  function decodeWebSocketClose(payload) {
    var reader = new Reader(payload);
    var wsRequestId = reader.str();
    var code = reader.u8();
    var reason = reader.str();
    var timestamp = reader.str();
    return {
      type: 'websocket_close',
      wsRequestId: wsRequestId,
      code: code,
      reason: reason,
      timestamp: timestamp
    };
  }

  function decodeMessage(frame) {
    switch (frame.type) {
      case 'welcome':
        return decodeWelcome(frame.payload);
      case 'registered':
        return decodeRegistered(frame.payload);
      case 'http_request':
        return decodeHttpRequest(frame.payload);
      case 'heartbeat_ack':
        return { type: 'heartbeat_ack' };
      case 'websocket_data':
      case 'websocket_data_from_server':
        return decodeWebSocketData(frame.payload, frame.flags);
      case 'websocket_close':
      case 'websocket_close_from_server':
        return decodeWebSocketClose(frame.payload);
      case 'sse_close':
      case 'sse_close_from_server':
        // 服务端对 sse_close 走通用 JSON（u32 长度 + JSON）
        try {
          var view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          var jsonLen = view.getUint32(0);
          return JSON.parse(decoder.decode(frame.payload.slice(4, 4 + jsonLen)));
        } catch (error) {
          return { type: 'sse_close', payload: frame.payload };
        }
      default:
        return { type: frame.type, payload: frame.payload };
    }
  }

  return {
    MAGIC: MAGIC,
    VERSION: VERSION,
    VERSION_2: VERSION_2,
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    FLAGS: FLAGS,
    utf8: utf8,
    toBytes: toBytes,
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    decodeMessage: decodeMessage,
    encodeRegisterTunnel: encodeRegisterTunnel,
    encodeUnregisterTunnel: encodeUnregisterTunnel,
    encodeCapabilities: encodeCapabilities,
    encodeHeartbeat: encodeHeartbeat,
    encodeHttpResponse: encodeHttpResponse,
    encodeWebSocketData: encodeWebSocketData,
    encodeWebSocketClose: encodeWebSocketClose,
    encodeSSEData: encodeSSEData,
    encodeSSEEnd: encodeSSEEnd,
    encodeSSEError: encodeSSEError,
    decodeWebSocketData: decodeWebSocketData,
    decodeWebSocketClose: decodeWebSocketClose,
    decodeWelcome: decodeWelcome,
    decodeRegistered: decodeRegistered,
    decodeHttpRequest: decodeHttpRequest
  };
  })();

  // ==================== Express-style proxy app ====================
/* sdk-app.js — DTNS Agent proxy app (built into sdk.js with the DTNS codec) */

function createSDK(Protocol) {
  'use strict';

  var VERSION = '2.1.0';
  var DEFAULT_WS_URL = 'wss://res2.dtns.top/tunnel';
  var DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

  class SDKError extends Error {
    constructor(message, options) {
      super(message || 'DTNS Agent SDK error');
      this.name = 'DTNSAgentError';
      options = options || {};
      this.code = options.code || 'SDK_ERROR';
      this.status = options.status || 0;
      if (options.cause) this.cause = options.cause;
    }
  }

  class Emitter {
    constructor() { this._events = {}; }
    on(name, fn) {
      if (typeof fn === 'function') (this._events[name] = this._events[name] || []).push(fn);
      return this;
    }
    off(name, fn) {
      var list = this._events[name];
      if (!list) return this;
      if (!fn) { delete this._events[name]; return this; }
      this._events[name] = list.filter(function (item) { return item !== fn; });
      return this;
    }
    emit(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var list = (this._events[name] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i].apply(null, args); } catch (error) { /* listener errors must not break the tunnel */ }
      }
      return this;
    }
  }

  function now() { return Date.now(); }

  function randomHex(bytes) {
    var data = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(data);
    else for (var i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(data, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function utf8(value) { return new TextEncoder().encode(String(value == null ? '' : value)); }

  function textOf(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes || new Uint8Array(0)); }
    catch (error) { return ''; }
  }

  function normalizePath(path) {
    var value = String(path || '/');
    if (value.charAt(0) !== '/') value = '/' + value;
    if (value.length > 1) value = value.replace(/\/+$/, '');
    return value || '/';
  }

  function parseQuery(search) {
    var out = {};
    var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    params.forEach(function (value, key) {
      if (out[key] === undefined) out[key] = value;
      else if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    });
    return out;
  }

  function lowerHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      out[String(key).toLowerCase()] = headers[key];
    });
    return out;
  }

  function headerValue(headers, name) {
    var value = headers[String(name).toLowerCase()];
    return Array.isArray(value) ? value.join(', ') : value;
  }

  function compilePath(path) {
    var normalized = normalizePath(path);
    if (normalized === '/') return [];
    return normalized.slice(1).split('/').map(function (segment) {
      if (segment === '*') return { wildcard: true };
      if (segment.charAt(0) === ':') return { param: segment.slice(1) };
      return { literal: segment };
    });
  }

  function matchPath(segments, path) {
    var parts = path === '/' ? [] : path.slice(1).split('/');
    var params = {};
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.wildcard) {
        params['*'] = parts.slice(i).join('/');
        return params;
      }
      if (i >= parts.length) return null;
      if (segment.param) {
        try { params[segment.param] = decodeURIComponent(parts[i]); }
        catch (error) { params[segment.param] = parts[i]; }
      } else if (segment.literal !== parts[i]) {
        return null;
      }
    }
    return parts.length === segments.length ? params : null;
  }

  function matchesPrefix(path, prefix) {
    if (!prefix || prefix === '/') return true;
    return path === prefix || path.indexOf(prefix + '/') === 0;
  }

  function isValidStatus(code) { return code >= 100 && code <= 599; }

  function isPromise(value) {
    return !!value && typeof value.then === 'function';
  }

  class Request {
    constructor(message) {
      this.method = String(message.method || 'GET').toUpperCase();
      this.url = message.url || '/';
      this.originalUrl = this.url;
      var parsed = new URL(this.url, 'http://sdk.local');
      this.path = normalizePath(parsed.pathname);
      this.query = parseQuery(parsed.search);
      this.headers = lowerHeaders(message.headers || {});
      this.rawBody = message.body || new Uint8Array(0);
      this.body = undefined;
      this.params = {};
      this.domain = message.domain || '';
      this.requestId = message.requestId || '';
      this.remoteAddress = message.remoteAddress || '';
      this.isSSE = !!message.isSSE;
      this.sseRequestId = message.sseRequestId || null;
      this.locals = {};
      this.message = message;
    }
    get(name) { return headerValue(this.headers, name); }
    header(name) { return this.get(name); }
  }

  class Response {
    constructor(app, request, message, onFinish) {
      this.app = app;
      this.req = request;
      this.message = message;
      this.statusCode = 200;
      this.headers = {};
      this.locals = {};
      this.finished = false;
      this.headersSent = false;
      this.onFinish = onFinish || null;
    }

    status(code) { this.statusCode = Number(code) || 200; return this; }

    set(name, value) {
      if (!this.finished) this.headers[String(name).toLowerCase()] = String(value);
      return this;
    }

    header(name, value) { return this.set(name, value); }
    setHeader(name, value) { return this.set(name, value); }
    get(name) { return this.headers[String(name).toLowerCase()]; }

    type(value) {
      var type = String(value || '');
      if (type === 'json') type = 'application/json; charset=utf-8';
      else if (type === 'text' || type === 'txt') type = 'text/plain; charset=utf-8';
      else if (type === 'html') type = 'text/html; charset=utf-8';
      else if (type.indexOf('/') === -1) type = 'application/' + type;
      return this.set('content-type', type);
    }

    json(value) {
      if (!this.get('content-type')) this.set('content-type', 'application/json; charset=utf-8');
      return this.end(JSON.stringify(value === undefined ? null : value));
    }

    send(value) {
      if (value === undefined || value === null) return this.end('');
      if (value instanceof Uint8Array) {
        if (!this.get('content-type')) this.set('content-type', 'application/octet-stream');
        return this.end(value);
      }
      if (typeof value === 'object') return this.json(value);
      if (typeof value === 'string') {
        if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
        return this.end(value);
      }
      return this.end(String(value));
    }

    text(value) {
      if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
      return this.end(String(value == null ? '' : value));
    }

    redirect(url, status) {
      this.status(status || 302);
      this.set('location', String(url));
      return this.end('');
    }

    sendStatus(code) {
      this.status(code);
      return this.end('');
    }

    acceptWebSocket(headers) {
      if (this.finished) return this;
      this.finished = true;
      this.headersSent = true;
      var merged = {};
      var self = this;
      Object.keys(this.headers).forEach(function (key) { merged[key] = self.headers[key]; });
      Object.keys(headers || {}).forEach(function (key) { merged[key] = headers[key]; });
      this.app._acceptWebSocket(this.message, merged);
      if (this.onFinish) this.onFinish(101);
      return this;
    }

    end(body) {
      if (this.finished) return this;
      var status = isValidStatus(this.statusCode) ? this.statusCode : 200;
      var bytes;
      if (body instanceof Uint8Array) bytes = body;
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
      else if (body === undefined || body === null) bytes = new Uint8Array(0);
      else if (typeof body === 'string') bytes = utf8(body);
      else bytes = utf8(String(body));

      if (this.req.method === 'HEAD') bytes = new Uint8Array(0);

      var headers = {};
      Object.keys(this.headers).forEach(function (key) {
        if (this.headers[key] !== undefined && this.headers[key] !== null) {
          headers[key] = String(this.headers[key]);
        }
      }, this);

      if (status === 204 || status === 304) {
        delete headers['content-type'];
        delete headers['content-length'];
      } else {
        if (headers['content-type'] === undefined && bytes.length) {
          headers['content-type'] = 'application/octet-stream';
        }
        if (headers['content-length'] === undefined) {
          headers['content-length'] = String(bytes.length);
        }
      }

      this.finished = true;
      this.headersSent = true;
      this.app._sendResponse(this.message, status, headers, bytes);
      if (this.onFinish) this.onFinish(status);
      return this;
    }
  }

  // SSE response for the legacy relay bypass (Capabilities stream=false):
  //   browser -> relay: GET/POST with Accept: text/event-stream
  //   relay  -> sdk  : http_request { isSSE: true, sseRequestId }
  //   sdk    -> relay: sse_data / sse_end frames
  // 中继已经写好了 200 + text/event-stream 头，所以这里只负责写事件体。
  class SseResponse extends Emitter {
    constructor(app, request, message, onFinish) {
      super();
      this.app = app;
      this.req = request;
      this.message = message;
      this.statusCode = 200;
      this.headers = {};
      this.locals = {};
      this.finished = false;
      this.headersSent = false;
      this.isSse = true;
      this.sseRequestId = message.sseRequestId || null;
      this.onFinish = onFinish || null;
      this._closed = false;
    }

    status(code) { this.statusCode = Number(code) || 200; return this; }

    set(name, value) {
      if (!this.finished) this.headers[String(name).toLowerCase()] = String(value);
      return this;
    }

    header(name, value) { return this.set(name, value); }
    setHeader(name, value) { return this.set(name, value); }
    get(name) { return this.headers[String(name).toLowerCase()]; }

    type(value) {
      var type = String(value || '');
      if (type === 'json') type = 'application/json; charset=utf-8';
      else if (type === 'text' || type === 'txt') type = 'text/plain; charset=utf-8';
      else if (type === 'html') type = 'text/html; charset=utf-8';
      else if (type.indexOf('/') === -1) type = 'application/' + type;
      return this.set('content-type', type);
    }

    writeHead(status, headers) {
      this.statusCode = Number(status) || this.statusCode;
      var self = this;
      Object.keys(headers || {}).forEach(function (key) {
        self.headers[String(key).toLowerCase()] = String(headers[key]);
      });
      this.headersSent = true;
      return this;
    }

    flushHeaders() {
      this.headersSent = true;
      return this;
    }

    write(chunk, encoding, callback) {
      if (this.finished || this._closed) return false;
      var text;
      if (typeof chunk === 'string') text = chunk;
      else if (chunk instanceof Uint8Array) text = textOf(chunk);
      else if (chunk instanceof ArrayBuffer) text = textOf(new Uint8Array(chunk));
      else text = String(chunk == null ? '' : chunk);

      var sent = this.app._sendSseData(this.sseRequestId, text, 'message');
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return sent;
    }

    json(value) {
      return this.end(JSON.stringify(value === undefined ? null : value));
    }

    send(value) {
      if (value === undefined || value === null) return this.end('');
      if (value instanceof Uint8Array) return this.end(value);
      if (typeof value === 'object') return this.json(value);
      return this.end(String(value));
    }

    text(value) {
      return this.end(String(value == null ? '' : value));
    }

    end(chunk, encoding, callback) {
      if (this.finished) return this;
      if (chunk !== undefined && chunk !== null && chunk !== '') this.write(chunk);
      this.finished = true;
      this.headersSent = true;
      this.app._sendSseEnd(this.sseRequestId);
      try { this.app.sseStreams.delete(this.sseRequestId); } catch (error) { /* ignore */ }
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      if (this.onFinish) this.onFinish(this.statusCode);
      this.emit('finish');
      return this;
    }

    _onClientClose() {
      if (this._closed) return;
      this._closed = true;
      this.finished = true;
      try { this.app.sseStreams.delete(this.sseRequestId); } catch (error) { /* ignore */ }
      this.emit('close');
    }
  }


  class WsConnection extends Emitter {
    constructor(app, message, req, protocol) {
      super();
      this.app = app;
      this.message = message;
      this.req = req;
      this.wsRequestId = message.wsRequestId;
      this.readyState = 1;
      this.open = true;
      this.remoteAddress = req.remoteAddress || '';
      this.path = req.path;
      this.protocol = protocol || '';
      this.url = 'ws://' + (req.domain || '') + req.url;
      this.bytesSent = 0;
      this.bytesReceived = 0;
      this._closed = false;
    }

    send(data, options) {
      if (this._closed || this.readyState !== 1) return false;

      var binary;
      var bytes;
      if (typeof data === 'string') {
        bytes = utf8(data);
        binary = false;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
        binary = true;
      } else if (data instanceof Uint8Array) {
        bytes = data;
        binary = true;
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        binary = true;
      } else if (data === undefined || data === null) {
        bytes = new Uint8Array(0);
        binary = false;
      } else {
        bytes = utf8(String(data));
        binary = false;
      }

      if (typeof options === 'boolean') binary = options;
      else if (options && typeof options.binary === 'boolean') binary = options.binary;

      var sent = this.app._send(Protocol.encodeWebSocketData({
        wsRequestId: this.wsRequestId,
        data: bytes,
        binary: binary,
        timestamp: new Date().toISOString()
      }));
      if (sent) this.bytesSent += bytes.length;
      return sent;
    }

    sendText(text) { return this.send(text); }
    sendBinary(data) { return this.send(data, true); }

    close(code, reason) {
      if (this._closed) return;
      this.readyState = 2;
      var closeCode = code === undefined ? 1000 : Number(code);
      if (!isFinite(closeCode)) closeCode = 1000;
      this._finish(closeCode, reason || '', true);
    }

    terminate() {
      this.close(1000, 'terminated');
    }

    _handleMessage(message) {
      if (this._closed) return;
      var data = message.data || new Uint8Array(0);
      this.bytesReceived += data.length;
      var isBinary = !!message.isBinary;
      this.emit('message', isBinary ? data : textOf(data), isBinary);
    }

    _onServerClose(message) {
      var code = Number(message.code);
      if (!code || code < 1000) code = 1000;
      this._finish(code, message.reason || '', false);
    }

    _onServerEnd() {
      this._finish(1000, 'ended', false);
    }

    _onServerError(message) {
      this.emit('error', new SDKError(
        (message && message.error) || 'websocket error',
        { code: 'WS_PEER_ERROR' }
      ));
      this._finish(1011, (message && message.error) || 'websocket error', false);
    }

    _finish(code, reason, sendClose) {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 3;
      this.open = false;

      var closeCode = code === undefined ? 1000 : Number(code);
      if (!isFinite(closeCode)) closeCode = 1000;

      if (sendClose) {
        // The tunnel protocol carries close codes in one byte. Normal close
        // (1000) is sent as 0 so the server maps it back to 1000 cleanly.
        var protocolCode = closeCode === 1000 ? 0 : (closeCode & 0xff);
        this.app._send(Protocol.encodeWebSocketClose({
          wsRequestId: this.wsRequestId,
          code: protocolCode,
          reason: reason || '',
          timestamp: new Date().toISOString()
        }));
      }

      this.app.wsConnections.delete(this.wsRequestId);
      this.emit('close', closeCode, reason || '');
    }

    _fail(error) {
      this.emit('error', error);
      this.close(1011, (error && error.message) || 'websocket handler error');
    }
  }

  WsConnection.OPEN = 1;
  WsConnection.CLOSING = 2;
  WsConnection.CLOSED = 3;

  class AgentApp extends Emitter {
    constructor(options) {
      super();
      options = options || {};
      var domain = String(options.domain || '').trim().toLowerCase();
      if (!domain || !DOMAIN_RE.test(domain)) {
        throw new SDKError('options.domain is required, e.g. agent-xxxx.html.dtns.top', { code: 'INVALID_DOMAIN' });
      }
      this.domain = domain;
      this.apiBase = 'http://' + domain;
      this.wsUrl = options.wsUrl || DEFAULT_WS_URL;
      this.clientId = options.clientId || ('sdk-' + randomHex(6));
      this.token = options.token ? String(options.token).trim() : '';
      this.WebSocket = options.WebSocket || null;
      this.description = options.description || 'sdk.js app';
      this.localPort = options.localPort || 80;
      this.maxBodySize = options.maxBodySize || 1024 * 1024;
      this.heartbeatInterval = options.heartbeatInterval || 25000;
      this.reconnect = options.reconnect !== false;
      this.exposeErrors = !!options.exposeErrors;

      this.routes = [];
      this.middlewares = [];
      this.wsRoutes = [];
      this.wsConnections = new Map();
      this.sseStreams = new Map();
      this.socket = null;
      this.ready = null;
      this.connected = false;
      this.registered = false;
      this.closed = false;
      this.listening = false;
      this.serverVersion = 2;
      this.requests = 0;
      this.errors = 0;
      this.reconnects = 0;
      this.startedAt = 0;
      this.heartbeatTimer = null;
      this.reconnectTimer = null;
      this._resolveReady = null;
      this._rejectReady = null;
    }

    // ==================== routing ====================

    _route(method, path, handler) {
      if (typeof handler !== 'function') {
        throw new SDKError(method + ' ' + path + ' handler must be a function', { code: 'INVALID_HANDLER' });
      }
      var normalized = normalizePath(path);
      this.routes.push({
        method: method,
        path: normalized,
        matcher: compilePath(normalized),
        handler: handler
      });
      return this;
    }

    get(path, handler) { return this._route('GET', path, handler); }
    post(path, handler) { return this._route('POST', path, handler); }
    put(path, handler) { return this._route('PUT', path, handler); }
    patch(path, handler) { return this._route('PATCH', path, handler); }
    delete(path, handler) { return this._route('DELETE', path, handler); }
    head(path, handler) { return this._route('HEAD', path, handler); }
    options(path, handler) { return this._route('OPTIONS', path, handler); }
    all(path, handler) { return this._route('ALL', path, handler); }

    ws(path, handler) {
      if (typeof handler !== 'function') {
        throw new SDKError('ws ' + path + ' handler must be a function', { code: 'INVALID_HANDLER' });
      }
      var normalized = normalizePath(path);
      this.wsRoutes.push({
        path: normalized,
        matcher: compilePath(normalized),
        handler: handler
      });
      return this;
    }

    use(pathOrFn, fn) {
      var prefix = '';
      var handler = pathOrFn;
      if (typeof pathOrFn === 'string') {
        prefix = normalizePath(pathOrFn);
        handler = fn;
      }
      if (typeof handler !== 'function') {
        throw new SDKError('middleware must be a function', { code: 'INVALID_MIDDLEWARE' });
      }
      this.middlewares.push({ path: prefix, fn: handler });
      return this;
    }

    listRoutes() {
      var httpRoutes = this.routes.map(function (route) {
        return { method: route.method, path: route.path };
      });
      var wsRoutes = this.wsRoutes.map(function (route) {
        return { method: 'WS', path: route.path };
      });
      return httpRoutes.concat(wsRoutes);
    }

    // ==================== lifecycle ====================

    listen() {
      if (this.ready) return this.ready;
      if (this.closed) {
        return Promise.reject(new SDKError('app is closed', { code: 'APP_CLOSED' }));
      }
      var self = this;
      this.startedAt = now();
      this.ready = new Promise(function (resolve, reject) {
        self._resolveReady = resolve;
        self._rejectReady = reject;
      });
      this._connect();
      return this.ready;
    }

    close() {
      this.closed = true;
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'app closed');
      this._closeAllSse();
      this._stopHeartbeat();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this._rejectReady && !this.listening) {
        try { this._rejectReady(new SDKError('app closed before listening', { code: 'APP_CLOSED' })); } catch (e) { /* ignore */ }
      }
      var ws = this.socket;
      this.socket = null;
      if (ws) {
        try { ws.close(1000, 'sdk app closed'); } catch (error) { /* ignore */ }
      }
      this.emit('close', this.status());
    }

    status() {
      return {
        connected: this.connected,
        registered: this.registered,
        domain: this.domain,
        apiBase: this.apiBase,
        clientId: this.clientId,
        auth: this.token ? 'bearer' : 'url',
        requests: this.requests,
        errors: this.errors,
        reconnects: this.reconnects,
        startedAt: this.startedAt,
        uptimeMs: this.startedAt ? now() - this.startedAt : 0,
        routes: this.routes.length,
        wsRoutes: this.wsRoutes.length,
        websockets: this.wsConnections.size,
        sseStreams: this.sseStreams.size,
        middlewares: this.middlewares.length
      };
    }

    // ==================== tunnel ====================

    _connect() {
      if (this.closed) return;
      var WS = this.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      if (!WS) {
        this._failInitial(new SDKError(
          'WebSocket is not available; pass options.WebSocket (e.g. require("ws"))',
          { code: 'NO_WEBSOCKET' }
        ));
        return;
      }

      var self = this;
      var url = this.wsUrl + (this.wsUrl.indexOf('?') === -1 ? '?' : '&') +
        'clientId=' + encodeURIComponent(this.clientId);
      var ws;
      try { ws = new WS(url); }
      catch (error) {
        this._failInitial(new SDKError('WebSocket constructor failed: ' + error.message, {
          code: 'WS_INIT_FAILED', cause: error
        }));
        return;
      }

      this.socket = ws;
      try { ws.binaryType = 'arraybuffer'; } catch (error) { /* ignore */ }

      ws.onopen = function () {
        if (self.socket !== ws) return;
        self.connected = true;
        self.emit('open', self.status());
        self._sendCapabilities();
        self._sendRegister();
        self._startHeartbeat();
      };

      ws.onmessage = function (event) {
        if (self.socket !== ws) return;
        self._onMessage(event && event.data !== undefined ? event.data : event);
      };

      ws.onerror = function () {
        if (self.socket !== ws) return;
        self.emit('error', new SDKError('WebSocket error', { code: 'WS_ERROR' }));
      };

      ws.onclose = function (event) {
        if (self.socket !== ws) return;
        self.socket = null;
        self._onClose(event || {});
      };
    }

    _onMessage(data) {
      var frame;
      try {
        frame = Protocol.decodeFrame(data);
      } catch (error) {
        this.emit('error', new SDKError('Frame decode failed: ' + error.message, { code: 'FRAME_DECODE_ERROR', cause: error }));
        return;
      }

      var message = Protocol.decodeMessage(frame);
      if (message.type === 'welcome') {
        this.serverVersion = message.protocolVersion || 1;
        return;
      }
      if (message.type === 'registered') {
        this._onRegistered(message);
        return;
      }
      if (message.type === 'http_request') {
        this._handleRequest(message);
        return;
      }
      if (message.type === 'websocket_data' || message.type === 'websocket_data_from_server') {
        var dataConnection = this.wsConnections.get(message.wsRequestId);
        if (dataConnection) dataConnection._handleMessage(message);
        return;
      }
      if (message.type === 'websocket_close' || message.type === 'websocket_close_from_server') {
        var closeConnection = this.wsConnections.get(message.wsRequestId);
        if (closeConnection) closeConnection._onServerClose(message);
        return;
      }
      if (message.type === 'sse_close') {
        var sseResponse = this.sseStreams.get(message.sseRequestId);
        if (sseResponse) {
          this.sseStreams.delete(message.sseRequestId);
          sseResponse._onClientClose();
        }
        return;
      }
      if (message.type === 'heartbeat_ack') return;
    }

    _onRegistered(message) {
      if (message.success) {
        this.registered = true;
        this.reconnects = 0;
        var first = !this.listening;
        this.listening = true;
        if (first && this._resolveReady) {
          try { this._resolveReady(this); } catch (error) { /* ignore */ }
        }
        this.emit(first ? 'listening' : 'reconnected', this.status());
        return;
      }

      var error = new SDKError(message.error || 'tunnel registration failed', {
        code: 'REGISTER_FAILED'
      });
      if (!this.listening) {
        this._failInitial(error);
        return;
      }
      this.registered = false;
      this.emit('error', error);
      this._scheduleReconnect();
    }

    _onClose(event) {
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'tunnel disconnected');
      this._closeAllSse();
      this._stopHeartbeat();
      if (this.closed) return;
      this.emit('disconnected', { code: event.code || 0, reason: event.reason || '' });
      if (this.reconnect) this._scheduleReconnect();
      else this.emit('close', this.status());
    }

    _scheduleReconnect() {
      if (this.closed || !this.reconnect || this.reconnectTimer) return;
      var self = this;
      this.reconnects += 1;
      var delay = Math.min(1500 * Math.pow(1.7, this.reconnects - 1), 20000);
      this.emit('reconnecting', { attempt: this.reconnects, delay: delay });
      this.reconnectTimer = setTimeout(function () {
        self.reconnectTimer = null;
        self._connect();
      }, delay);
    }

    _failInitial(error) {
      this.closed = true;
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'tunnel failed');
      this._closeAllSse();
      this._stopHeartbeat();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this._rejectReady) {
        try { this._rejectReady(error); } catch (e) { /* ignore */ }
      }
      var ws = this.socket;
      this.socket = null;
      if (ws) {
        try { ws.close(4000, 'sdk registration failed'); } catch (e) { /* ignore */ }
      }
      this.emit('error', error);
    }

    _send(frame) {
      if (!this.socket || this.socket.readyState !== 1) return false;
      try { this.socket.send(frame); return true; }
      catch (error) {
        this.emit('error', new SDKError('WebSocket send failed: ' + error.message, { code: 'WS_SEND_FAILED', cause: error }));
        return false;
      }
    }

    _sendCapabilities() {
      this._send(Protocol.encodeCapabilities({
        clientId: this.clientId,
        stream: false,
        multiValueHeaders: true
      }));
    }

    _sendRegister() {
      this._send(Protocol.encodeRegisterTunnel({
        clientId: this.clientId,
        tunnel: {
          id: 'sdk-app',
          domain: this.domain,
          localPort: this.localPort,
          localHost: '127.0.0.1',
          protocol: 'http',
          description: this.description
        }
      }));
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      var self = this;
      this._sendHeartbeat();
      this.heartbeatTimer = setInterval(function () { self._sendHeartbeat(); }, this.heartbeatInterval);
    }

    _stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }

    _sendHeartbeat() {
      if (!this.socket || this.socket.readyState !== 1) return;
      this._send(Protocol.encodeHeartbeat({
        clientId: this.clientId,
        timestamp: new Date().toISOString(),
        stats: {
          tunnelCount: 1,
          registeredCount: this.registered ? 1 : 0,
          sseConnections: 0,
          totalRequests: this.requests,
          totalErrors: this.errors
        }
      }));
    }

    // ==================== request handling ====================

    _handleRequest(message) {
      var self = this;
      var started = now();
      this.requests += 1;
      var req = new Request(message);
      var res = message.isSSE
        ? new SseResponse(this, req, message, function (status) {
          self._after(req, status, started);
        })
        : new Response(this, req, message, function (status) {
          self._after(req, status, started);
        });

      if (message.isWebSocket) {
        this._handleWebSocket(message, req, res);
        return;
      }

      if (message.isSSE) {
        if (!message.sseRequestId) {
          res.status(500).json({ ok: false, error: 'missing_sse_request_id' });
          return;
        }
        this.sseStreams.set(message.sseRequestId, res);
      }

      if (req.method === 'OPTIONS') {
        var optionsMatch = this._match('OPTIONS', req.path);
        if (!optionsMatch.route) {
          res.status(204).end();
          return;
        }
        req.params = optionsMatch.params;
        var optionsStack = [];
        this.middlewares.forEach(function (middleware) {
          if (matchesPrefix(req.path, middleware.path)) {
            optionsStack.push({ fn: middleware.fn, isRoute: false });
          }
        });
        optionsStack.push({ fn: optionsMatch.route.handler, isRoute: true });
        this._runStack(optionsStack, req, res);
        return;
      }

      if (this.token && !this._checkAuth(req)) {
        res.set('www-authenticate', 'Bearer realm="dtns-agent"');
        res.status(401).json({
          ok: false,
          error: 'unauthorized',
          hint: 'Send Authorization: Bearer <token>.'
        });
        return;
      }

      try {
        this._parseBody(req);
      } catch (error) {
        res.status(error.status || 400).json({
          ok: false,
          error: error.code || 'invalid_body'
        });
        return;
      }

      var found = this._match(req.method, req.path);
      if (!found.route) {
        if (found.allowed.length) {
          var allow = this._allowHeader(found.allowed);
          res.set('allow', allow);
          res.status(405).json({
            ok: false,
            error: 'method_not_allowed',
            allow: allow
          });
        } else {
          res.status(404).json({
            ok: false,
            error: 'not_found',
            method: req.method,
            path: req.path
          });
        }
        return;
      }

      req.params = found.params;
      var stack = [];
      this.middlewares.forEach(function (middleware) {
        if (matchesPrefix(req.path, middleware.path)) {
          stack.push({ fn: middleware.fn, isRoute: false });
        }
      });
      stack.push({ fn: found.route.handler, isRoute: true });
      this._runStack(stack, req, res);
    }

    _handleWebSocket(message, req, res) {
      if (!message.wsRequestId) {
        res.status(400).json({ ok: false, error: 'missing_ws_request_id' });
        return;
      }
      if (this.token && !this._checkAuth(req)) {
        res.set('www-authenticate', 'Bearer realm="dtns-agent"');
        res.status(401).json({
          ok: false,
          error: 'unauthorized',
          hint: 'Send Authorization: Bearer <token>, or use ?token= for browser WebSocket.'
        });
        return;
      }
      if (req.method !== 'GET') {
        res.set('allow', 'GET');
        res.status(405).json({ ok: false, error: 'method_not_allowed', allow: 'GET' });
        return;
      }

      var found = this._matchWs(req.path);
      if (!found) {
        res.status(404).json({
          ok: false,
          error: 'websocket_route_not_found',
          path: req.path
        });
        return;
      }

      req.params = found.params;
      var offered = String(req.get('sec-websocket-protocol') || '')
        .split(',').map(function (value) { return value.trim(); }).filter(Boolean);
      var protocol = offered[0] || '';
      var headers = protocol ? { 'sec-websocket-protocol': protocol } : {};

      res.acceptWebSocket(headers);
      var connection = new WsConnection(this, message, req, protocol);
      this.wsConnections.set(message.wsRequestId, connection);
      this.emit('websocket', {
        path: req.path,
        wsRequestId: message.wsRequestId,
        remoteAddress: req.remoteAddress,
        protocol: protocol
      });

      try {
        var result = found.route.handler(connection, req);
        if (isPromise(result)) {
          result.catch(function (error) { connection._fail(error); });
        }
      } catch (error) {
        connection._fail(error);
      }
    }

    _matchWs(path) {
      for (var i = 0; i < this.wsRoutes.length; i++) {
        var route = this.wsRoutes[i];
        var params = matchPath(route.matcher, path);
        if (params) return { route: route, params: params };
      }
      return null;
    }

    _acceptWebSocket(message, headers) {
      return this._sendResponse(message, 101, headers || {}, new Uint8Array(0));
    }

    _closeAllWs(code, reason) {
      var self = this;
      this.wsConnections.forEach(function (connection) {
        connection._finish(code || 1000, reason || '', false);
      });
      this.wsConnections.clear();
    }

    _closeAllSse() {
      var self = this;
      this.sseStreams.forEach(function (response) {
        try { response._onClientClose(); } catch (error) { /* ignore */ }
      });
      this.sseStreams.clear();
    }

    _parseBody(req) {
      var bytes = req.rawBody || new Uint8Array(0);
      if (bytes.length > this.maxBodySize) {
        var tooLarge = new SDKError('payload too large', { code: 'payload_too_large', status: 413 });
        throw tooLarge;
      }
      if (!bytes.length) {
        req.body = undefined;
        return;
      }
      var type = String(req.get('content-type') || '');
      if (/application\/json/i.test(type)) {
        try { req.body = JSON.parse(textOf(bytes)); }
        catch (error) {
          throw new SDKError('invalid JSON body', { code: 'invalid_json', status: 400 });
        }
      } else if (/application\/x-www-form-urlencoded/i.test(type)) {
        req.body = parseQuery('?' + textOf(bytes));
      } else if (/^text\//i.test(type)) {
        req.body = textOf(bytes);
      } else {
        req.body = bytes;
      }
    }

    _checkAuth(req) {
      var authorization = String(req.get('authorization') || '');
      var match = /^Bearer\s+(.+)$/i.exec(authorization);
      if (match && match[1].trim() === this.token) return true;
      if (req.query && req.query.token === this.token) return true;
      return false;
    }

    _match(method, path) {
      var allowed = [];
      for (var i = 0; i < this.routes.length; i++) {
        var route = this.routes[i];
        var params = matchPath(route.matcher, path);
        if (!params) continue;
        var methodOk = route.method === 'ALL' || route.method === method ||
          (method === 'HEAD' && route.method === 'GET');
        if (methodOk) return { route: route, params: params };
        if (route.method !== 'ALL' && allowed.indexOf(route.method) === -1) {
          allowed.push(route.method);
        }
      }
      return { route: null, params: null, allowed: allowed };
    }

    _allowHeader(allowed) {
      var methods = allowed.slice();
      if (methods.indexOf('GET') !== -1 && methods.indexOf('HEAD') === -1) methods.push('HEAD');
      if (methods.indexOf('OPTIONS') === -1) methods.push('OPTIONS');
      return methods.join(', ');
    }

    _runStack(stack, req, res) {
      var self = this;
      var completed = false;

      function finish() { completed = true; }

      function fail(error) {
        if (res.finished) { finish(); return; }
        var status = error && isValidStatus(error.status) ? error.status : 500;
        var code = error && error.code ? String(error.code) : (status === 500 ? 'internal_error' : 'error');
        var body = { ok: false, error: code };
        if (error && error.message && (self.exposeErrors || status !== 500)) {
          body.message = String(error.message);
        }
        res.status(status).json(body);
        finish();
        self.emit('error', error instanceof Error ? error : new SDKError(String(error), {
          code: code, status: status
        }));
      }

      function run(index) {
        if (completed || res.finished) { finish(); return; }
        if (index >= stack.length) {
          if (!res.finished) res.status(204).end();
          finish();
          return;
        }

        var entry = stack[index];
        var called = false;

        function next(error) {
          if (called) return;
          called = true;
          if (res.finished) { finish(); return; }
          if (error) { fail(error); return; }
          run(index + 1);
        }

        try {
          var returned = entry.fn(req, res, next);
          if (isPromise(returned)) {
            returned.then(function (value) {
              if (res.finished) { finish(); return; }
              if (!called) {
                if (entry.isRoute && value !== undefined) {
                  sendAuto(res, value);
                  finish();
                } else {
                  next();
                }
              }
            }, function (error) {
              if (!called) {
                called = true;
                fail(error);
              }
            });
          } else if (!called) {
            if (res.finished) { finish(); return; }
            if (entry.isRoute && returned !== undefined) {
              sendAuto(res, returned);
              finish();
            } else {
              next();
            }
          }
        } catch (error) {
          if (!called) {
            called = true;
            fail(error);
          }
        }
      }

      function sendAuto(response, value) {
        if (response.finished) return;
        if (value === undefined) { response.status(204).end(); return; }
        if (value === null) { response.json(null); return; }
        if (typeof value === 'string') { response.text(value); return; }
        if (value instanceof Uint8Array) { response.send(value); return; }
        response.json(value);
      }

      run(0);
    }

    _sendSseData(sseRequestId, data, event) {
      if (!sseRequestId) return false;
      if (!this.socket || this.socket.readyState !== 1) {
        this.emit('error', new SDKError('WebSocket is not open', { code: 'WS_NOT_OPEN' }));
        return false;
      }
      var frame = Protocol.encodeSSEData({
        sseRequestId: sseRequestId,
        data: data === undefined || data === null ? '' : data,
        event: event || '',
        timestamp: new Date().toISOString()
      });
      return this._send(frame);
    }

    _sendSseEnd(sseRequestId) {
      if (!sseRequestId) return false;
      if (!this.socket || this.socket.readyState !== 1) return false;
      var frame = Protocol.encodeSSEEnd({
        sseRequestId: sseRequestId,
        timestamp: new Date().toISOString()
      });
      return this._send(frame);
    }

    _sendResponse(message, status, headers, body) {
      if (!this.socket || this.socket.readyState !== 1) {
        this.emit('error', new SDKError('WebSocket is not open', { code: 'WS_NOT_OPEN' }));
        return false;
      }
      if (!isValidStatus(status)) status = 200;

      var clean = {};
      Object.keys(headers || {}).forEach(function (key) {
        if (headers[key] !== undefined && headers[key] !== null) {
          clean[String(key).toLowerCase()] = String(headers[key]);
        }
      });

      var frame = Protocol.encodeHttpResponse({
        requestId: message.requestId,
        domain: message.domain,
        status: status,
        headers: clean,
        body: body || new Uint8Array(0),
        isSSE: false,
        sseRequestId: message.sseRequestId || null,
        isWebSocket: !!message.isWebSocket,
        wsRequestId: message.wsRequestId || null,
        error: null
      }, this.serverVersion);

      if (!this._send(frame)) return false;
      return true;
    }

    _after(req, status, started) {
      if (status >= 500) this.errors += 1;
      this.emit('request', {
        method: req.method,
        path: req.path,
        status: status,
        ms: Math.round(now() - started),
        requestId: req.requestId
      });
    }
  }

  var DTNSAgent = {
    version: VERSION,
    app: function (options) { return new AgentApp(options); },
    createApp: function (options) { return new AgentApp(options); },
    App: AgentApp,
    Error: SDKError
  };

  DTNSAgent.DTNSAgent = DTNSAgent;
  return DTNSAgent;
}


  return createSDK(Protocol);
});
