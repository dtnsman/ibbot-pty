const fs = require('fs');
const os = require('os');

function resolveSshBin() {
  if (os.platform() === 'win32') {
    const candidates = [
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      'C:\\Program Files\\OpenSSH\\ssh.exe',
      'C:\\Program Files (x86)\\OpenSSH\\ssh.exe'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'ssh';
}

function buildSshCommand(sshCfg, opts = {}) {
  if (!sshCfg) throw new Error('ssh config is missing');
  if (!sshCfg.enabled) throw new Error('ssh backend is not enabled');

  const args = [];

  // 端口
  if (sshCfg.port && sshCfg.port !== 22) {
    args.push('-p', String(sshCfg.port));
  }

  // 强制分配 TTY
  args.push('-tt');

  // 主机密钥校验
  if (sshCfg.strictHostKeyChecking === false) {
    args.push('-o', 'StrictHostKeyChecking=no');
    if (os.platform() === 'win32') {
      args.push('-o', 'UserKnownHostsFile=NUL');
    } else {
      args.push('-o', 'UserKnownHostsFile=/dev/null');
    }
  } else if (sshCfg.knownHostsPath) {
    args.push('-o', `UserKnownHostsFile=${sshCfg.knownHostsPath}`);
  }

  // keepalive
  args.push('-o', 'ServerAliveInterval=30');
  args.push('-o', 'ServerAliveCountMax=3');

  // 认证
  const auth = sshCfg.auth || {};
  let useSshpass = false;
  let password = null;

  if (auth.type === 'key') {
    if (!auth.privateKeyPath || !fs.existsSync(auth.privateKeyPath)) {
      throw new Error(`private key not found: ${auth.privateKeyPath}`);
    }
    args.push('-i', auth.privateKeyPath);
    args.push('-o', 'IdentitiesOnly=yes');
    args.push('-o', 'BatchMode=yes');
  } else if (auth.type === 'password') {
    if (!auth.password) throw new Error('ssh.auth.password is empty');
    useSshpass = true;
    password = auth.password;
    args.push('-o', 'PubkeyAuthentication=no');
    args.push('-o', 'PreferredAuthentications=password');
  } else {
    throw new Error('unsupported ssh.auth.type: ' + auth.type);
  }

  if (!sshCfg.user || !sshCfg.host) {
    throw new Error('ssh.user / ssh.host are required');
  }
  args.push(`${sshCfg.user}@${sshCfg.host}`);

  if (opts.remoteShell) {
    if (!/^[a-zA-Z0-9_\-]+$/.test(opts.remoteShell)) {
      throw new Error('invalid remoteShell');
    }
    args.push(opts.remoteShell);
  }

  return { useSshpass, password, args };
}

function buildSpawn(setting, opts = {}) {
  const sshCfg = setting && setting.ssh;
  if (!sshCfg || !sshCfg.enabled) {
    throw new Error('ssh backend is not enabled');
  }
  const built = buildSshCommand(sshCfg, opts);
  if (built.useSshpass) {
    return {
      bin: 'sshpass',
      args: ['-p', built.password, 'ssh'].concat(built.args)
    };
  }
  return { bin: resolveSshBin(), args: built.args };   // ← 改这里
}

function listShells(setting) {
  const sshCfg = (setting && setting.ssh) || {};
  const allowed = sshCfg.allowedShells || ['bash', 'zsh', 'fish', 'sh'];
  return allowed.map(id => ({ id, label: id, backend: 'ssh' }));
}

module.exports = { buildSpawn, listShells };