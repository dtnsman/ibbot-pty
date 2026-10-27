const localShells = require('../localShells');

function buildSpawn(setting, opts = {}) {
  const localCfg = setting.local || {};
  if (!localCfg.enabled) throw new Error('local backend is not enabled');

  let shellDef;
  if (opts.shellId) {
    shellDef = localShells.get(setting, opts.shellId);
    if (!shellDef) throw new Error(`shell not available: ${opts.shellId}`);
  } else {
    shellDef = localShells.getDefault(setting);
    if (!shellDef) throw new Error('no shell available on this system');
  }

  // 客户端 args 只允许追加，并做长度/数量限制
  const extraArgs = Array.isArray(opts.args) ? opts.args : [];
  const sanitizedExtra = extraArgs
    .filter(a => typeof a === 'string' && a.length > 0 && a.length <= 256)
    .slice(0, 8);

  return {
    bin: shellDef.path,
    args: shellDef.args.concat(sanitizedExtra),
    shellId: shellDef.id,
    cwd: opts.cwd || localCfg.defaultCwd ||
      process.env.HOME || process.env.USERPROFILE || process.cwd()
  };
}

function listShells(setting) {
  return localShells.listAvailable(setting);
}

module.exports = { buildSpawn, listShells };