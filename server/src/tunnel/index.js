// src/tunnel/index.js
//
// 隧道能力装配层：读取 setting.tunnel，解析稳定的 serverId，
// 生成动态域名 api.pty2.<serverId>.html.dtns.top 并启动隧道客户端。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TunnelClient } = require('./tunnel-client');

const DEFAULT_SERVER_URL = 'wss://res2.dtns.top/tunnel';
const DEFAULT_DOMAIN_PREFIX = 'api.pty2';
const DEFAULT_DOMAIN_SUFFIX = '.html.dtns.top';
const DEFAULT_DESCRIPTION = 'ibbot-pty-server (HTTP + WebSocket)';

// serverId 持久化文件：不写进 setting JSON，避免每次启动都改配置。
const SERVER_ID_FILE = path.join(__dirname, '..', '..', 'setting', 'server-id');

const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function readPersistedServerId() {
  try {
    const value = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    return value || '';
  } catch (error) {
    return '';
  }
}

function persistServerId(serverId, logger) {
  try {
    fs.mkdirSync(path.dirname(SERVER_ID_FILE), { recursive: true });
    fs.writeFileSync(SERVER_ID_FILE, serverId + '\n', 'utf8');
  } catch (error) {
    logger.warn(
      `[tunnel] 无法保存 serverId 到 ${SERVER_ID_FILE}: ${error.message} ` +
      '（下次启动会生成新的域名）',
    );
  }
}

function normalizeServerId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (!SERVER_ID_RE.test(value)) {
    throw new Error(
      `invalid serverId "${raw}" (只允许字母、数字和短横线，且以字母/数字开头)`,
    );
  }
  return value;
}

/**
 * 解析稳定的 serverId：
 *   环境变量 PTY_SERVER_ID > setting.tunnel.serverId / setting.serverId
 *   > setting/server-id 持久化文件 > 自动生成并落盘。
 */
function resolveServerId(tunnelCfg, setting, logger) {
  const fromEnv = normalizeServerId(process.env.PTY_SERVER_ID);
  if (fromEnv) return { serverId: fromEnv, source: 'env' };

  const fromSetting = normalizeServerId(
    (tunnelCfg && tunnelCfg.serverId) || (setting && setting.serverId),
  );
  if (fromSetting) return { serverId: fromSetting, source: 'setting' };

  const persisted = normalizeServerId(readPersistedServerId());
  if (persisted) return { serverId: persisted, source: 'file' };

  const generated = 'pty-' + crypto.randomBytes(10).toString('hex');
  persistServerId(generated, logger);
  return { serverId: generated, source: 'generated' };
}

function buildDomain(tunnelCfg, serverId) {
  const explicit = String((tunnelCfg && tunnelCfg.domain) || '').trim().toLowerCase();
  if (explicit) return explicit;

  const prefix = String(tunnelCfg.domainPrefix || DEFAULT_DOMAIN_PREFIX)
    .trim().replace(/\.+$/, '').toLowerCase();
  const suffix = String(tunnelCfg.domainSuffix || DEFAULT_DOMAIN_SUFFIX)
    .trim().toLowerCase();
  const normalizedSuffix = suffix.startsWith('.') ? suffix : '.' + suffix;
  return `${prefix}.${serverId}${normalizedSuffix}`;
}

/**
 * 创建并启动隧道客户端。
 * @returns {TunnelClient|null}
 */
function startTunnel({ setting, port, logger }) {
  const log = logger || console;
  const cfg = (setting && setting.tunnel) || {};
  const enabled = envFlag(process.env.PTY_TUNNEL_ENABLED, cfg.enabled !== false);

  if (!enabled) {
    log.log('[tunnel] disabled (setting.tunnel.enabled = false)');
    return null;
  }

  let serverId;
  let serverIdSource;
  try {
    const resolved = resolveServerId(cfg, setting, log);
    serverId = resolved.serverId;
    serverIdSource = resolved.source;
  } catch (error) {
    log.error('[tunnel] serverId 解析失败，隧道未启动:', error.message);
    return null;
  }

  const serverUrl = String(process.env.PTY_TUNNEL_URL || cfg.serverUrl || DEFAULT_SERVER_URL).trim();
  const domain = String(process.env.PTY_TUNNEL_DOMAIN || buildDomain(cfg, serverId)).trim();

  if (!DOMAIN_RE.test(domain)) {
    log.error(`[tunnel] 域名非法，隧道未启动: ${domain}`);
    return null;
  }

  const localHost = cfg.localHost || '127.0.0.1';
  const localPort = Number(cfg.localPort) || Number(port) || 10310;

  const client = new TunnelClient({
    serverUrl,
    clientId: serverId,
    domain,
    tunnelId: cfg.tunnelId || 'ibbot-pty-server',
    description: cfg.description || DEFAULT_DESCRIPTION,
    localHost,
    localPort,
    reconnect: cfg.reconnect !== false,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
    wsConnectTimeoutMs: cfg.wsConnectTimeoutMs,
    logger: log,
  });

  client.on('registered', ({ domain: registered }) => {
    log.log(`[tunnel] public HTTP : http://${registered}`);
    log.log(`[tunnel] public WS   : ws://${registered}`);
  });
  client.on('register_failed', ({ error }) => {
    log.error(`[tunnel] 域名注册失败: ${error}`);
  });
  client.on('reconnecting', ({ attempt, delay }) => {
    if (process.env.PTY_TUNNEL_VERBOSE === '1') {
      log.log(`[tunnel] reconnecting in ${delay}ms (attempt ${attempt})`);
    }
  });
  client.on('error', (error) => {
    if (process.env.PTY_TUNNEL_VERBOSE === '1') {
      log.warn('[tunnel] error:', error && error.message);
    }
  });

  log.log(`[tunnel] serverId: ${serverId} (${serverIdSource})`);
  log.log(`[tunnel] domain  : ${domain}`);
  log.log(`[tunnel] local   : http://${localHost}:${localPort}`);
  log.log(`[tunnel] tunnel  : ${serverUrl}`);

  client.start();
  return client;
}

module.exports = {
  startTunnel,
  resolveServerId,
  buildDomain,
  SERVER_ID_FILE,
  DEFAULT_SERVER_URL,
  DEFAULT_DOMAIN_PREFIX,
  DEFAULT_DOMAIN_SUFFIX,
};
