/**
 * 特斯拉数据备份 → 七牛云（原生 API）
 *
 * 用法:
 *   backup                 打包 + 加密 + 上传 + 清理旧备份
 *   list                   列出云端备份
 *   download <key> [out]   下载指定备份
 *   restore [key] [dir]    恢复（默认最新 + /tmp/tesla-restore）
 *   verify                 下载最新备份并校验可解密
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { createHmac, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { join, dirname } from 'node:path';

const AK = process.env.QINIU_AK;
const SK = process.env.QINIU_SK;
const BUCKET = process.env.QINIU_BUCKET || 'tesla-backup';
const PASS = process.env.BACKUP_PASS;
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);
const APP_DIR = process.env.APP_DIR || '/opt/tesla-dash';
const PREFIX = 'daily/';

/** 除 APP_DIR 外还需要备份的系统文件（换 VPS 时靠它们重建） */
const SYSTEM_FILES = [
  '/etc/caddy/Caddyfile',
  '/etc/cron.d/tesla-backup',
  '/etc/cron.d/tesla-health',
  '/etc/cron.d/tesla-qiniu',
  '/etc/logrotate.d/tesla-backup',
  '/etc/tesla-backup.env',
  '/usr/local/bin/tesla-backup.sh',
  '/usr/local/bin/tesla-health.sh',
  '/usr/local/bin/tesla-backup-qiniu.sh',
  '/usr/local/bin/tesla-qiniu-backup.mjs',
  '/usr/local/bin/tesla-install.sh',
  '/etc/cron.d/tesla-watch',
  '/etc/logrotate.d/tesla-watch',
  '/etc/logrotate.d/tesla-health',
  '/etc/tesla-alert.env',
  '/usr/local/bin/tesla-watch.mjs',
  '/usr/local/bin/tesla-watch.sh',
  '/usr/local/bin/tesla-alert-setup.sh',
];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const hmacSha1 = (data) => createHmac('sha1', SK).update(data).digest();

function uploadToken(key) {
  const policy = { scope: `${BUCKET}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = b64url(JSON.stringify(policy));
  return `${AK}:${b64url(hmacSha1(encoded))}:${encoded}`;
}
function qboxAuth(pathWithQuery) {
  return `QBox ${AK}:${b64url(hmacSha1(`${pathWithQuery}\n`))}`;
}
function privateUrl(key, expires = 3600) {
  const domain = process.env.QINIU_DOMAIN;
  if (!domain) return null;
  const scheme = process.env.QINIU_SCHEME || 'http';
  const deadline = Math.floor(Date.now() / 1000) + expires;
  const full = `${scheme}://${domain}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const token = `${AK}:${b64url(hmacSha1(`${full}?e=${deadline}`))}`;
  return `${full}?e=${deadline}&token=${token}`;
}

function encrypt(plainBuf) {
  const salt = randomBytes(16), iv = randomBytes(16);
  const key = pbkdf2Sync(PASS, salt, 100000, 32, 'sha256');
  const c = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([Buffer.from('TESLABK1'), salt, iv, c.update(plainBuf), c.final()]);
}
function decrypt(buf) {
  if (buf.subarray(0, 8).toString() !== 'TESLABK1') throw new Error('不是本系统的备份文件');
  const salt = buf.subarray(8, 24), iv = buf.subarray(24, 40), data = buf.subarray(40);
  const key = pbkdf2Sync(PASS, salt, 100000, 32, 'sha256');
  const d = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

// ───────────── 备份 ─────────────
async function backup() {
  if (!PASS) throw new Error('缺少 BACKUP_PASS');
  const tmp = '/tmp/tesla-bk';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'app'), { recursive: true });
  mkdirSync(join(tmp, 'system'), { recursive: true });

  console.log('[1/5] 收集应用文件');
  for (const f of ['data', '.env', 'docker-compose.yml']) {
    const src = join(APP_DIR, f);
    if (!existsSync(src)) continue;
    cpSync(src, join(tmp, 'app', f), { recursive: true });
  }

  console.log('[2/5] 收集系统文件（换 VPS 用）');
  for (const f of SYSTEM_FILES) {
    if (!existsSync(f)) continue;
    const dst = join(tmp, 'system', f);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(f, dst);
  }

  const tarPath = join(tmp, 'backup.tar.gz');
  console.log('[3/5] 打包');
  const r = spawnSync('tar', ['czf', tarPath, '-C', tmp, 'app', 'system']);
  if (r.status !== 0) throw new Error('tar 失败: ' + r.stderr?.toString());
  const plain = readFileSync(tarPath);
  console.log('      ', (plain.length / 1024).toFixed(1), 'KB');

  console.log('[4/5] 加密 + 上传');
  const enc = encrypt(plain);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const key = `${PREFIX}tesla-${stamp}.tar.gz.enc`;

  const form = new FormData();
  form.append('token', uploadToken(key));
  form.append('key', key);
  form.append('file', new Blob([enc]), key);
  const res = await fetch('https://upload.qiniup.com/', { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  const ok = JSON.parse(text);
  if (!ok.key) throw new Error('上传返回异常: ' + text.slice(0, 200));
  console.log('      ✓', ok.key, (enc.length / 1024).toFixed(1), 'KB');
  // 记录成功时间，供监控判断备份是否新鲜
  try {
    const { mkdirSync: _mk, writeFileSync: _wf } = await import('node:fs');
    _mk('/var/lib', { recursive: true });
    _wf('/var/lib/tesla-last-backup', String(Date.now()));
  } catch {}

  console.log('[5/5] 清理', KEEP_DAYS, '天前的备份');
  const files = await list();
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  let removed = 0;
  for (const f of files) {
    if (new Date(f.putTime / 10000).getTime() < cutoff) { await remove(f.key); removed++; }
  }
  console.log('      清理', removed, '个，现有', files.length - removed, '个');
  rmSync(tmp, { recursive: true, force: true });
}

// ───────────── 列表 / 删除 / 下载 ─────────────
async function list() {
  const path = '/list';
  const query = `?bucket=${encodeURIComponent(BUCKET)}&prefix=${encodeURIComponent(PREFIX)}&limit=1000`;
  const res = await fetch(`https://rsf.qiniu.com${path}${query}`, {
    headers: { Authorization: qboxAuth(path + query) },
  });
  if (!res.ok) throw new Error(`列表失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.items || []).sort((a, b) => b.putTime - a.putTime);
}

async function remove(key) {
  const entry = Buffer.from(`${BUCKET}:${key}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const path = `/delete/${entry}`;
  const res = await fetch(`https://rs.qiniu.com${path}`, { method: 'POST', headers: { Authorization: qboxAuth(path) } });
  if (!res.ok && res.status !== 612) throw new Error(`删除失败 HTTP ${res.status}`);
}

async function fetchKey(key) {
  const url = privateUrl(key);
  if (!url) throw new Error('未配置 QINIU_DOMAIN');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ───────────── 恢复 ─────────────
async function restore(keyArg, dirArg) {
  const files = await list();
  if (!files.length) throw new Error('云端没有备份');
  const key = keyArg && keyArg !== 'latest' ? keyArg : files[0].key;
  const dir = dirArg || '/tmp/tesla-restore';

  console.log('[1/4] 下载', key);
  const enc = await fetchKey(key);
  console.log('      ', (enc.length / 1024).toFixed(1), 'KB');

  console.log('[2/4] 解密');
  const plain = decrypt(enc);

  console.log('[3/4] 解包 →', dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync('/tmp/restore.tar.gz', plain);
  const r = spawnSync('tar', ['xzf', '/tmp/restore.tar.gz', '-C', dir]);
  if (r.status !== 0) throw new Error('解包失败: ' + r.stderr?.toString());

  console.log('[4/4] 完成。内容：');
  for (const sub of ['app', 'system']) {
    const p = join(dir, sub);
    if (existsSync(p)) {
      const r2 = spawnSync('sh', ['-c', `find ${p} -type f | head -20`], { encoding: 'utf8' });
      r2.stdout.split('\n').filter(Boolean).forEach((l) => console.log('   ', l.replace(dir + '/', '')));
    }
  }
  console.log('\n下一步（手工确认后执行）：');
  console.log(`   cp -a ${dir}/app/. ${APP_DIR}/`);
  console.log(`   cp -a ${dir}/system/. /`);
  console.log('   cd ' + APP_DIR + ' && docker compose up -d');
}

async function verify() {
  const files = await list();
  if (!files.length) throw new Error('云端没有任何备份');
  const latest = files[0];
  console.log('最新备份:', latest.key, (latest.fsize / 1024).toFixed(1), 'KB');
  if (!process.env.QINIU_DOMAIN) {
    console.log('⚠️  未配置 QINIU_DOMAIN，跳过下载校验');
    if (latest.fsize < 500) throw new Error('备份文件过小');
    return;
  }
  const enc = await fetchKey(latest.key);
  const plain = decrypt(enc);
  writeFileSync('/tmp/verify.tar.gz', plain);
  const out = spawnSync('tar', ['tzf', '/tmp/verify.tar.gz'], { encoding: 'utf8' }).stdout || '';
  const lines = out.split('\n').filter(Boolean);
  console.log('✓ 解密+解包成功，共', lines.length, '项');
  lines.slice(0, 6).forEach((l) => console.log('   ', l));
  rmSync('/tmp/verify.tar.gz', { force: true });
}

const cmd = process.argv[2];
try {
  if (cmd === 'backup') await backup();
  else if (cmd === 'list') {
    const fs2 = await list();
    fs2.forEach((f) => console.log(f.key, (f.fsize / 1024).toFixed(1) + 'KB', new Date(f.putTime / 10000).toISOString()));
    if (!fs2.length) console.log('（空）');
  } else if (cmd === 'download') {
    const n = (await fetchKey(process.argv[3])).length;
    writeFileSync(process.argv[4] || '/tmp/bk.enc', await fetchKey(process.argv[3]));
    console.log('已下载', (n / 1024).toFixed(1), 'KB');
  } else if (cmd === 'restore') await restore(process.argv[3], process.argv[4]);
  else if (cmd === 'verify') await verify();
  else console.log('用法: backup | list | download <key> [out] | restore [key] [dir] | verify');
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}

