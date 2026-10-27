const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 本机 shell 注册表。只列常见 shell，未安装的自动跳过。
 */
const REGISTRY = [
  { id: 'bash', label: 'Bash', platforms: ['linux', 'darwin'],
    candidates: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
    args: ['-l'] },
  { id: 'zsh', label: 'Zsh', platforms: ['linux', 'darwin'],
    candidates: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'],
    args: ['-l'] },
  { id: 'fish', label: 'Fish', platforms: ['linux', 'darwin'],
    candidates: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'],
    args: ['-l'] },
  { id: 'sh', label: 'POSIX sh', platforms: ['linux', 'darwin'],
    candidates: ['/bin/sh', '/usr/bin/sh'],
    args: [] },
  { id: 'powershell', label: 'Windows PowerShell', platforms: ['win32'],
    candidates: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    args: ['-NoLogo'] },
  { id: 'pwsh', label: 'PowerShell Core', platforms: ['win32', 'linux', 'darwin'],
    candidates: [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '/usr/bin/pwsh', '/usr/local/bin/pwsh',
      '/opt/microsoft/powershell/7/pwsh'
    ],
    args: ['-NoLogo'] },
  { id: 'cmd', label: 'Command Prompt', platforms: ['win32'],
    candidates: ['C:\\Windows\\System32\\cmd.exe'],
    args: [] }
];

function _exists(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; }
  catch { try { return fs.existsSync(p); } catch { return false; } }
}

function _findRealPath(candidates) {
  for (const c of candidates) if (_exists(c)) return c;
  // which / where 兜底
  for (const c of candidates) {
    const base = path.basename(c);
    try {
      const cmd = os.platform() === 'win32' ? `where ${base}` : `which ${base}`;
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\r?\n/)[0];
      if (out && _exists(out)) return out;
    } catch {}
  }
  return null;
}

function listAvailable(setting) {
  const platform = os.platform();
  const localCfg = (setting && setting.local) || {};
  const allowed = localCfg.allowedShells || ['bash', 'zsh', 'fish', 'sh'];

  const result = [];
  for (const entry of REGISTRY) {
    if (!entry.platforms.includes(platform)) continue;
    if (!allowed.includes(entry.id)) continue;
    const realPath = _findRealPath(entry.candidates);
    if (!realPath) continue;
    result.push({
      id: entry.id,
      label: entry.label,
      path: realPath,
      args: entry.args.slice(),
      backend: 'local'
    });
  }
  return result;
}

function get(setting, shellId) {
  return listAvailable(setting).find(s => s.id === shellId) || null;
}

function getDefault(setting) {
  const available = listAvailable(setting);
  return available[0] || null;
}

module.exports = { listAvailable, get, getDefault, REGISTRY };