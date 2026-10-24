#!/usr/bin/env node
/**
 * Tesla Dash 服务监控
 * 用法: tesla-watch.mjs [run|test|status]
 *   run   - 执行检查，异常时推送告警（cron 每 5 分钟调用）
 *   test  - 推送一条测试告警，验证渠道配置
 *   status- 打印当前所有检查项
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASE = process.env.WATCH_BASE || 'http://127.0.0.1:8787';
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const STATE_FILE = '/var/lib/tesla-watch-state.json';
const BACKUP_DIR = '/root/backups';
const COOLDOWN_SEC = Number(process.env.WATCH_COOLDOWN || 3600);

// ── 告警渠道 ──
const ALERT_TYPE = (process.env.ALERT_TYPE || '').toLowerCase();   // bark | dingtalk | wecom | telegram | json
const ALERT_URL = process.env.ALERT_URL || '';

async function push(title, body, level = 'error') {
  if (!ALERT_TYPE || !ALERT_URL) {
    console.log(`[告警未配置] ${title} :: ${body}`);
    return false;
  }
  try {
    if (ALERT_TYPE === 'bark') {
      // ALERT_URL 形如 https://api.day.app/你的KEY
      const url = `${ALERT_URL.replace(/\/$/, '')}/${encodeURIComponent('Tesla·' + title)}/${encodeURIComponent(body)}?level=${level === 'error' ? 'timeSensitive' : 'active'}&group=tesla`;
      const r = await fetch(url, { method: 'GET' });
      return r.ok;
    }
    if (ALERT_TYPE === 'dingtalk' || ALERT_TYPE === 'wecom') {
      const r = await fetch(ALERT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: `【Tesla】${title}\n${body}` } }),
      });
      return r.ok;
    }
    if (ALERT_TYPE === 'telegram') {
      const r = await fetch(`${ALERT_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `【Tesla】${title}\n${body}` }),
      });
      return r.ok;
    }
    // 通用 JSON webhook
    const r = await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level, service: 'tesla-dash', ts: Math.floor(Date.now() / 1000) }),
    });
    return r.ok;
  } catch (e) {
    console.error('推送失败:', e.message);
    return false;
  }
}

// ── 检查函数 ──
async function httpOk() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    return { ok: r.ok, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e.name === 'TimeoutError' ? '超时 4s' : e.message };
  }
}

let _cookie = null;

/** 用 /k/<key> 免密登录换取会话 cookie */
async function getCookie() {
  if (_cookie) return _cookie;
  let key = ACCESS_KEY;
  if (!key) {
    try { key = readFileSync('/opt/tesla-dash/data/.access-key', 'utf8').trim(); } catch {}
  }
  if (!key) return null;
  try {
    const r = await fetch(`${BASE}/k/${key}`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    for (const c of raw) {
      const m = /dash_sess=([^;]+)/.exec(c || '');
      if (m) { _cookie = m[1]; return _cookie; }
    }
  } catch {}
  return null;
}

async function apiStatus() {
  try {
    const cookie = await getCookie();
    if (!cookie) return { ok: false, detail: '无法登录（密钥读取失败）', data: null };
    const r = await fetch(`${BASE}/api/status`, {
      headers: { Cookie: `dash_sess=${cookie}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}`, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, detail: e.message, data: null };
  }
}

function backupAge() {
  try {
    if (!existsSync(BACKUP_DIR)) return { ok: false, detail: '无备份目录' };
    const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.tar.gz'));
    if (!files.length) return { ok: false, detail: '无备份文件' };
    const newest = Math.max(...files.map((f) => statSync(`${BACKUP_DIR}/${f}`).mtimeMs));
    const hours = (Date.now() - newest) / 3600000;
    return { ok: hours < 30, detail: `最后备份 ${hours.toFixed(1)} 小时前` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function diskUsage() {
  try {
    const r = spawnSync('df', ['-P', '/'], { encoding: 'utf8' });
    const line = (r.stdout || '').split('\n')[1] || '';
    const m = line.match(/(\d+)%/);
    const pct = m ? Number(m[1]) : 0;
    return { ok: pct < 85, detail: `磁盘占用 ${pct}%` };
  } catch (e) {
    return { ok: true, detail: '无法检测' };
  }
}

function containerState() {
  try {
    const r = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', 'tesla-dash'], { encoding: 'utf8' });
    const [st, health] = (r.stdout || '').trim().split('|');
    const ok = st === 'running' && (health === 'healthy' || health === 'none');
    return { ok, detail: `容器 ${st || '未找到'} / ${health || '-'}` };
  } catch (e) {
    return { ok: true, detail: '未安装 docker 客户端（跳过）' };
  }
}

// ── 主流程 ──
async function collect() {
  const out = {};
  out.http = await httpOk();
  const st = await apiStatus();
  out.api = { ok: st.ok, detail: st.ok ? 'API 正常' : st.detail };

  const d = st.data || {};
  const now = Math.floor(Date.now() / 1000);

  // 令牌
  if (st.ok) {
    const hasToken = !!d.hasToken;
    const ageH = d.tokenRefreshTs ? (now - d.tokenRefreshTs) / 3600 : null;
    out.token = {
      ok: hasToken && (ageH === null || ageH < 30),
      detail: !hasToken ? '没有令牌（需重新授权）' : (ageH === null ? '令牌正常（时间未知）' : `令牌 ${ageH.toFixed(1)} 小时前刷新`),
    };
  } else {
    out.token = { ok: false, detail: '无法获取状态' };
  }

  // 采集器心跳（自适应轮询下采样稀疏，看 tick 时间更准）
  if (st.ok) {
    const tick = d.recorderTickTs;
    const tickMin = tick ? (now - tick) / 60 : null;
    const sampleMin = d.lastSampleTs ? (now - d.lastSampleTs) / 60 : null;
    out.sampler = {
      ok: tickMin !== null && tickMin < 10,
      detail: tickMin === null
        ? (sampleMin === null ? '没有心跳记录' : `最后采样 ${sampleMin.toFixed(0)} 分钟前`)
        : `采集器 ${tickMin.toFixed(0)} 分钟前心跳` + (sampleMin !== null ? `，最近采样 ${sampleMin.toFixed(0)} 分钟前` : ''),
    };
  } else {
    out.sampler = { ok: false, detail: '无法获取状态' };
  }

  out.backup = backupAge();
  out.disk = diskUsage();
  out.container = containerState();
  return out;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

const LABELS = {
  http: '服务可访问性',
  api: '接口响应',
  token: '特斯拉令牌',
  sampler: '数据采集器',
  backup: '备份新鲜度',
  disk: '磁盘空间',
  container: '容器状态',
};

async function run() {
  const res = await collect();
  const prev = loadState();
  const now = Math.floor(Date.now() / 1000);
  let alerted = 0;

  for (const [k, v] of Object.entries(res)) {
    const key = `state_${k}`;
    const lastFailAt = prev[`fail_${k}`] || 0;

    if (!v.ok) {
      const cooling = now - lastFailAt < COOLDOWN_SEC;
      if (!cooling) {
        const ok = await push(`⚠️ ${LABELS[k] || k}`, v.detail, 'error');
        if (ok) { prev[`fail_${k}`] = now; alerted++; }
      }
      prev[key] = 'fail';
    } else {
      // 恢复通知
      if (prev[key] === 'fail') {
        const ok = await push(`✅ 已恢复：${LABELS[k] || k}`, v.detail, 'active');
        if (ok) alerted++;
        delete prev[`fail_${k}`];
      }
      prev[key] = 'ok';
    }
  }

  saveState(prev);

  // 可选：外部心跳（检测整机死亡）
  if (process.env.HC_PING_URL) {
    try {
      await fetch(process.env.HC_PING_URL, { signal: AbortSignal.timeout(8000) });
    } catch {}
  }

  const bad = Object.entries(res).filter(([, v]) => !v.ok);
  const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${stamp}] 检查完成：${bad.length ? bad.map(([k]) => k).join(',') + ' 异常' : '全部正常'}${alerted ? `，已推送 ${alerted} 条` : ''}`);
  bad.forEach(([k, v]) => console.log(`   ✗ ${LABELS[k] || k}: ${v.detail}`));
}

async function showStatus() {
  const res = await collect();
  console.log('检查项状态：');
  for (const [k, v] of Object.entries(res)) {
    console.log(`  ${v.ok ? '✓' : '✗'} ${(LABELS[k] || k).padEnd(10)} ${v.detail}`);
  }
}

const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'run') await run();
  else if (cmd === 'status') await showStatus();
  else if (cmd === 'test') {
    const ok = await push('🧪 测试告警', '这条消息说明你的告警渠道配置成功。', 'active');
    console.log(ok ? '✓ 已推送，请查看手机' : '✗ 推送失败，检查 ALERT_TYPE / ALERT_URL');
  } else console.log('用法: run | status | test');
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
