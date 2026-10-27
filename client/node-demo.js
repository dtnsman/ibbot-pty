// node-demo.js
const { PtyClient } = require('ibbot-pty-sdk');

(async () => {
  const client = new PtyClient({
    url: 'ws://127.0.0.1:8080',
    secretKey: process.env.PTY_PWD || null
  });

  client.on('exit', ({ termId, code }) => console.log('[exit]', termId, code));
  client.on('error', e => console.error('[error]', e));

  await client.connect();

  const { backends, default: def } = await client.listBackends();
  console.log('backends:', backends, 'default:', def);

  const { shells } = await client.listShells();
  console.log('shells:', shells);

  const term = await client.createTerminal({
    cols: 120, rows: 30,
    backend: 'ssh',
    remoteShell: 'bash'
  });

  term.onData(d => process.stdout.write(d));
  term.onExit(() => { client.disconnect(); process.exit(0); });

  process.stdin.setRawMode && process.stdin.setRawMode(true);
  process.stdin.on('data', d => term.write(d.toString()));

  term.write('uname -a && whoami\n');

  // 优雅退出
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });
})();