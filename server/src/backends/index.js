const sshBackend = require('./sshBackend');
const localBackend = require('./localBackend');

/**
 * 选择 backend：
 *  - 客户端传的 backend 优先（且必须 enabled）
 *  - 否则用 setting.backend
 */
function pickBackend(setting, requested) {
  const want = requested || setting.backend || 'ssh';
  if (want === 'ssh') {
    if (!setting.ssh || !setting.ssh.enabled) throw new Error('ssh backend is not enabled');
    return 'ssh';
  }
  if (want === 'local') {
    if (!setting.local || !setting.local.enabled) throw new Error('local backend is not enabled');
    return 'local';
  }
  throw new Error('unknown backend: ' + want);
}

function getBackend(name) {
  if (name === 'ssh') return sshBackend;
  if (name === 'local') return localBackend;
  throw new Error('unknown backend: ' + name);
}

/** 汇总当前所有可用 backend 的 shell 列表 */
function listAllShells(setting) {
  const out = [];
  if (setting.ssh && setting.ssh.enabled) out.push(...sshBackend.listShells(setting));
  if (setting.local && setting.local.enabled) out.push(...localBackend.listShells(setting));
  return out;
}

module.exports = { pickBackend, getBackend, listAllShells };