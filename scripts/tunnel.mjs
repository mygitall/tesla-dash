/**
 * Pinggy 隧道守护（Node 实现）
 * launchd 在 ~/Documents 下执行 bash 会被 macOS TCC 拦截，但 node 有权限。
 * 用法: node scripts/tunnel.mjs [port]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PORT = process.argv[2] || '8787';
const URL_FILE = '/tmp/tesla-tunnel-url.txt';
const RE = /https:\/\/[A-Za-z0-9._-]+\.(?:pinggy-free\.link|pinggy\.net)/;

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function connect() {
  console.log(`[连接] ${ts()} 建立隧道 → localhost:${PORT}`);
  const p = spawn('ssh', [
    '-p', '443',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-R0:localhost:' + PORT,
    'a.pinggy.io',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    for (;;) {
      const m = RE.exec(buf);
      if (!m) break;
      const url = m[0];
      console.log(`[地址] ${url}`);
      try { writeFileSync(URL_FILE, url); } catch {}
      buf = buf.slice(m.index + url.length);
    }
    if (buf.length > 8192) buf = buf.slice(-2048);
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);

  p.on('close', (code) => {
    console.log(`[重连] ${ts()} 隧道断开 (code=${code})，3 秒后重连`);
    setTimeout(connect, 3000);
  });
  p.on('error', (e) => {
    console.log(`[错误] ${ts()} ${e.message}，10 秒后重连`);
    setTimeout(connect, 10000);
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
connect();
