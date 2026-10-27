// src/tunnel/dtns-protocol.js
//
// DTNS 二进制隧道协议（http-proxy 2.0 / sdk.js 兼容）的编解码层。
//
// 参考实现：E:\dtns.dsh-http\src\dtns-protocol.js（与本文件 wire 兼容），
// 以及服务端 E:\dtns.http-proxy\server\protocol.js。
//
// 帧格式（13 字节头 + payload）：
//   [0..3]  MAGIC "DTNS"
//   [4]     version (1 | 2)
//   [5..6]  typeCode (UInt16 BE)
//   [7..8]  flags (UInt16 BE)
//   [9..12] payload length (UInt32 BE)
//
// 本模块只实现 pty 反向代理需要的最小集合：
//   - 上行：register_tunnel / capabilities / heartbeat / http_response /
//           websocket_data / websocket_close
//   - 下行：welcome / registered / heartbeat_ack / http_request /
//           websocket_data / websocket_close
//
// 说明：不实现 STREAM_* 流式通道（客户端能力声明 stream=false），
//       HTTP 往返走 HTTP_REQUEST / HTTP_RESPONSE，WebSocket 走 101 + WS 帧。
'use strict';

const MAGIC = Buffer.from('DTNS', 'ascii');
const VERSION = 1;
const VERSION_2 = 2;

const TYPE = {
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
  SSE_CLOSE_FROM_SERVER: 0x010d,
};

const TYPE_NAME = {};
for (const name of Object.keys(TYPE)) TYPE_NAME[TYPE[name]] = name.toLowerCase();

const FLAGS = {
  HAS_BODY: 0x0001,
  HAS_HEADERS: 0x0002,
  IS_SSE: 0x0004,
  IS_WEBSOCKET: 0x0008,
  GZIPPED: 0x0010,
  IS_BINARY: 0x0020,
};

const EMPTY = Buffer.alloc(0);

// ==================== 基础工具 ====================

function toBuffer(input) {
  if (input == null) return EMPTY;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(String(input), 'utf8');
}

function encodeString(value) {
  const bytes = Buffer.from(value == null ? '' : String(value), 'utf8');
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([head, bytes]);
}

function encodeBuffer(value) {
  const bytes = toBuffer(value);
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([head, bytes]);
}

function encodeHeaders(headers, multiValue) {
  headers = headers || {};
  const keys = Object.keys(headers).filter(
    (key) => headers[key] !== undefined && headers[key] !== null,
  );
  const parts = [];
  const count = Buffer.allocUnsafe(2);
  count.writeUInt16BE(keys.length, 0);
  parts.push(count);
  for (const key of keys) {
    const value = headers[key];
    const text = Array.isArray(value)
      ? value.map(String).join(multiValue ? '\n' : ',')
      : String(value);
    parts.push(encodeString(key), encodeString(text));
  }
  return Buffer.concat(parts);
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  _need(length) {
    if (this.offset + length > this.bytes.length) {
      throw new Error(
        `DTNS payload truncated: need ${length} at ${this.offset}, ` +
        `have ${this.bytes.length - this.offset}`,
      );
    }
  }

  u8() {
    this._need(1);
    const value = this.bytes.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16() {
    this._need(2);
    const value = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    this._need(4);
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  str() {
    const length = this.u16();
    this._need(length);
    const value = this.bytes.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  buf() {
    const length = this.u32();
    this._need(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  headers() {
    const count = this.u16();
    const out = {};
    for (let i = 0; i < count; i += 1) {
      const key = this.str();
      const value = this.str();
      out[key] = value.indexOf('\n') >= 0 ? value.split('\n') : value;
    }
    return out;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }
}

// ==================== 帧 ====================

function encodeFrame(typeName, payload, version, flags) {
  const typeCode = TYPE[String(typeName).toUpperCase()];
  if (typeCode === undefined) throw new Error('Unknown DTNS frame type: ' + typeName);

  const body = toBuffer(payload);
  const header = Buffer.allocUnsafe(13);
  MAGIC.copy(header, 0);
  header[4] = version === VERSION_2 ? VERSION_2 : VERSION;
  header.writeUInt16BE(typeCode, 5);
  header.writeUInt16BE(flags || 0, 7);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body]);
}

function decodeFrame(input) {
  const bytes = toBuffer(input);
  if (bytes.length < 13) throw new Error('DTNS frame too short: ' + bytes.length);
  if (!bytes.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid DTNS magic');

  const version = bytes[4];
  const typeCode = bytes.readUInt16BE(5);
  const flags = bytes.readUInt16BE(7);
  const length = bytes.readUInt32BE(9);
  if (bytes.length < 13 + length) {
    throw new Error(
      `DTNS frame truncated: need ${13 + length}, got ${bytes.length}`,
    );
  }

  return {
    version,
    typeCode,
    type: TYPE_NAME[typeCode] || 'unknown_0x' + typeCode.toString(16),
    flags,
    payload: bytes.subarray(13, 13 + length),
  };
}

// ==================== 客户端 -> 服务端 ====================

function encodeRegisterTunnel(fields) {
  const tunnel = fields.tunnel || fields;
  const payload = Buffer.concat([
    encodeString(fields.clientId || ''),
    encodeString(tunnel.id || ''),
    encodeString(tunnel.domain || ''),
    Buffer.from([(Number(tunnel.localPort) || 80) & 0xff]),
    encodeString(tunnel.localHost || '127.0.0.1'),
    encodeString(tunnel.protocol || 'http'),
    encodeString(tunnel.description || ''),
  ]);
  return encodeFrame('register_tunnel', payload, VERSION, 0);
}

function encodeUnregisterTunnel(fields) {
  const payload = Buffer.concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.domain || ''),
  ]);
  return encodeFrame('unregister_tunnel', payload, VERSION, 0);
}

function encodeCapabilities(fields) {
  let flags = 0;
  if (fields.stream) flags |= 0x01;
  if (fields.multiValueHeaders) flags |= 0x02;
  const payload = Buffer.concat([encodeString(fields.clientId || ''), Buffer.from([flags])]);
  return encodeFrame('capabilities', payload, VERSION, 0);
}

function encodeHeartbeat(fields) {
  const stats = fields.stats || {};
  const statsBuf = Buffer.allocUnsafe(20);
  statsBuf.writeUInt32BE(stats.tunnelCount || 0, 0);
  statsBuf.writeUInt32BE(stats.registeredCount || 0, 4);
  statsBuf.writeUInt32BE(stats.sseConnections || 0, 8);
  statsBuf.writeUInt32BE(stats.totalRequests || 0, 12);
  statsBuf.writeUInt32BE(stats.totalErrors || 0, 16);

  const payload = Buffer.concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    statsBuf,
  ]);
  return encodeFrame('heartbeat', payload, VERSION, 0);
}

function encodeHttpResponse(fields, version) {
  const v = version >= VERSION_2 ? VERSION_2 : VERSION;
  let status = Number(fields.status);
  if (!(status >= 100 && status <= 599)) status = 200;

  const body = toBuffer(fields.body);
  const headers = fields.headers || {};

  let payloadFlags = 0;
  if (fields.isSSE) payloadFlags |= 0x01;
  if (fields.isWebSocket) payloadFlags |= 0x02;
  if (fields.error) payloadFlags |= 0x04;

  const payload = Buffer.concat([
    encodeString(fields.requestId || ''),
    encodeString(fields.domain || ''),
    v >= VERSION_2
      ? (() => { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(status, 0); return b; })()
      : Buffer.from([status & 0xff]),
    encodeHeaders(headers, true),
    encodeBuffer(body),
    Buffer.from([payloadFlags]),
    encodeString(fields.sseRequestId || ''),
    encodeString(fields.wsRequestId || ''),
    encodeString(fields.error || ''),
  ]);

  let frameFlags = 0;
  if (body.length) frameFlags |= FLAGS.HAS_BODY;
  if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
  if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
  if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

  return encodeFrame('http_response', payload, v, frameFlags);
}

function encodeWebSocketData(fields) {
  const data = toBuffer(fields.data);
  const payload = Buffer.concat([
    encodeString(fields.wsRequestId || ''),
    encodeBuffer(data),
    encodeString(fields.timestamp || new Date().toISOString()),
  ]);
  const flags = fields.binary ? FLAGS.IS_BINARY : 0;
  return encodeFrame('websocket_data', payload, VERSION, flags);
}

// 协议里 close code 只有 1 字节，1000 会溢出。
// 约定：0 表示 1000（与 sdk.js 一致），服务端收到 0 会还原成 1000。
function encodeWebSocketClose(fields) {
  let code = fields.code === undefined ? 1000 : Number(fields.code);
  if (!Number.isFinite(code) || code < 1000 || code > 4999) code = 1000;
  if (code === 1005 || code === 1006) code = 1000;
  const wireCode = code === 1000 ? 0 : (code & 0xff);

  const payload = Buffer.concat([
    encodeString(fields.wsRequestId || ''),
    Buffer.from([wireCode]),
    encodeString(fields.reason || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
  ]);
  return encodeFrame('websocket_close', payload, VERSION, 0);
}

// ==================== 服务端 -> 客户端 ====================

function decodeWelcome(payload) {
  const reader = new Reader(payload);
  const clientId = reader.str();
  const timestamp = reader.str();
  const message = reader.str();
  const protocolVersion = reader.remaining() > 0 ? reader.u8() : VERSION;
  return { type: 'welcome', clientId, timestamp, message, protocolVersion };
}

function decodeRegistered(payload) {
  const reader = new Reader(payload);
  const domain = reader.str();
  const success = reader.u8() === 1;
  const error = reader.str();
  const message = reader.str();
  return { type: 'registered', domain, success, error: error || null, message };
}

function decodeHttpRequest(payload) {
  const reader = new Reader(payload);
  const requestId = reader.str();
  const domain = reader.str();
  const method = reader.str();
  const url = reader.str();
  const headers = reader.headers();
  const body = reader.buf();
  const remoteAddress = reader.str();
  const timestamp = reader.str();
  const flags = reader.u8();
  const sseRequestId = reader.str();
  const wsRequestId = reader.str();

  return {
    type: 'http_request',
    requestId,
    domain,
    method,
    url,
    headers,
    body,
    remoteAddress,
    timestamp,
    isSSE: !!(flags & 0x01),
    isWebSocket: !!(flags & 0x02),
    sseRequestId: sseRequestId || null,
    wsRequestId: wsRequestId || null,
  };
}

function decodeWebSocketData(payload, flags) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const data = reader.buf();
  const timestamp = reader.str();
  return {
    type: 'websocket_data',
    wsRequestId,
    data,
    isBinary: !!(flags & FLAGS.IS_BINARY),
    timestamp,
  };
}

function decodeWebSocketClose(payload) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const code = reader.u8();
  const reason = reader.str();
  const timestamp = reader.str();
  return {
    type: 'websocket_close',
    wsRequestId,
    // 0 是 1000 的线上表示；1005/1006 不能出现在 close 帧里
    code: !code || code === 1005 || code === 1006 ? 1000 : code,
    reason,
    timestamp,
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
    default:
      return { type: frame.type, payload: frame.payload };
  }
}

module.exports = {
  MAGIC,
  VERSION,
  VERSION_2,
  TYPE,
  TYPE_NAME,
  FLAGS,
  EMPTY,
  toBuffer,
  encodeFrame,
  decodeFrame,
  decodeMessage,
  encodeRegisterTunnel,
  encodeUnregisterTunnel,
  encodeCapabilities,
  encodeHeartbeat,
  encodeHttpResponse,
  encodeWebSocketData,
  encodeWebSocketClose,
  decodeWelcome,
  decodeRegistered,
  decodeHttpRequest,
  decodeWebSocketData,
  decodeWebSocketClose,
};
