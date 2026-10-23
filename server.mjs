#!/usr/bin/env node
/**
 * Tesla Dash — 最小可跑通版本
 * 零依赖：只用 Node 内置模块（Node >= 18，建议 20+）
 *
 * 两种模式：
 *   MODE=demo   —— 假数据，不需要任何特斯拉账号，打开就能看
 *   MODE=fleet  —— 真实 Fleet API，走 OAuth 或粘贴 access_token
 *
 * 启动：node server.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { createRecorder } from './recorder.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/* ------------------------------ .env 加载 ------------------------------ */
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(join(ROOT, '.env'));

/* ------------------------------- 配置 ------------------------------- */
const MODE = (process.env.MODE || 'demo').toLowerCase();
const PORT = Number(process.env.PORT || 8787);
const CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.TESLA_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const REGION = (process.env.TESLA_REGION || 'na').toLowerCase();
const STATIC_TOKEN = process.env.TESLA_ACCESS_TOKEN || '';

// ⚠️ 中国区是独立的一套 auth 域名（auth.tesla.cn），不能复用国际版
const AUTH_BASES = {
  na: 'https://auth.tesla.com/oauth2/v3/authorize',
  eu: 'https://auth.tesla.com/oauth2/v3/authorize',
  cn: 'https://auth.tesla.cn/oauth2/v3/authorize',
};
const TOKEN_BASES = {
  na: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
  eu: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
  cn: 'https://auth.tesla.cn/oauth2/v3/token',
};
const API_BASES = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
};
const AUTH_BASE = AUTH_BASES[REGION] || AUTH_BASES.na;
const TOKEN_BASE = TOKEN_BASES[REGION] || TOKEN_BASES.na;
const API_BASE = API_BASES[REGION] || API_BASES.na;
// 只读看板只需要前四个；vehicle_cmds 等要虚拟密钥配对，先不加，避免授权页弹用不到的权限
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds';

/* ----------------------------- 数据目录 ----------------------------- */
// 统一放在 DATA_DIR：容器/云服务器上挂一个卷就够，重建不丢
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

/* ----------------------------- Token 存储 ----------------------------- */
const TOKEN_FILE = join(DATA_DIR, '.tokens.json');
const LEGACY_TOKEN_FILE = join(ROOT, '.tokens.json');
// 从旧位置迁移一次（老版本把 token 放在项目根目录）
try {
  if (!existsSync(TOKEN_FILE) && existsSync(LEGACY_TOKEN_FILE)) {
    mkdirSync(DATA_DIR, { recursive: true });
    copyFileSync(LEGACY_TOKEN_FILE, TOKEN_FILE);
    chmodSync(TOKEN_FILE, 0o600);
    console.log('[迁移] 已把 .tokens.json 移到 data/ 目录');
  }
} catch {}
let tokens = null;
if (existsSync(TOKEN_FILE)) {
  try {
    tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    tokens = null;
  }
}
if (STATIC_TOKEN && !tokens) {
  tokens = { access_token: STATIC_TOKEN, refresh_token: null, expires_at: null, source: 'env' };
}
// 云端部署：没有 token 文件时，用环境变量里的 refresh_token 自举
if (!tokens && process.env.TESLA_REFRESH_TOKEN) {
  tokens = {
    access_token: null,
    refresh_token: process.env.TESLA_REFRESH_TOKEN,
    expires_at: 0,
    source: 'env-refresh',
  };
  console.log('[token] 已从 TESLA_REFRESH_TOKEN 环境变量初始化（首次请求时刷新）');
}

function saveTokens(t) {
  tokens = t;
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[warn] 无法写入 .tokens.json:', e.message);
  }
}

async function getAccessToken() {
  if (!tokens?.access_token && !tokens?.refresh_token) throw new Error('NO_TOKEN');
  // env 里的静态 token 不做刷新
  if (!tokens.refresh_token) return tokens.access_token;
  // 还有效就不刷
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }

  // 官方文档里刷新只需要 grant_type / client_id / refresh_token，不含 secret。
  // 但不同区域/时期有可能要求 secret，所以先按文档来，失败了再带 secret 重试一次。
  const buildBody = (withSecret) => {
    const b = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });
    if (withSecret && CLIENT_SECRET) b.set('client_secret', CLIENT_SECRET);
    return b;
  };

  const postToken = (body) =>
    fetch(TOKEN_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

  let res = await postToken(buildBody(false));
  let j = await res.json().catch(() => ({}));
  if ((!res.ok || !j.access_token) && CLIENT_SECRET) {
    res = await postToken(buildBody(true));
    j = await res.json().catch(() => ({}));
  }
  if (!res.ok || !j.access_token) {
    throw new Error(`刷新 token 失败 (${res.status}): ${j.error_description || j.error || '未知错误'}`);
  }
  // 注意：特斯拉的 refresh_token 是一次性的，每次刷新都会换新的，必须存下来
  saveTokens({
    access_token: j.access_token,
    refresh_token: j.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    source: 'refresh',
  });
  return tokens.access_token;
}

/* ---------------------------- Tesla 请求 ---------------------------- */
async function teslaGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'tesla-dash/0.1' },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      body?.error_description || body?.error?.message || body?.error || body?.message || text.slice(0, 200);
    const err = new Error(`Tesla API ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function teslaPost(path) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'tesla-dash/0.1',
    },
    body: '{}',
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Tesla API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const VEHICLE_ENDPOINTS =
  'charge_state;climate_state;drive_state;vehicle_state;vehicle_config;gui_settings;location_data';

async function fetchVehicleData(id) {
  try {
    return await teslaGet(`/api/1/vehicles/${encodeURIComponent(id)}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_ENDPOINTS)}`);
  } catch (e) {
    // 部分端点组合不支持时退化为全量拉取
    if (e.status === 400 || e.status === 404) {
      return teslaGet(`/api/1/vehicles/${encodeURIComponent(id)}/vehicle_data`);
    }
    throw e;
  }
}

/* ------------------------------ 演示数据 ------------------------------ */
function demoData() {
  const t = Date.now() / 1000;
  // 用正弦波让数字轻微漂移，看起来像实时
  const drift = Math.sin(t / 60);
  const battery = Math.min(95, Math.max(38, 78 + drift * 2));
  const range = battery * 3.1;

  return {
    _demo: true,
    response: {
      id: 4242424242424242,
      vin: '5YJ3E1EA7KF000000',
      display_name: '小白',
      state: 'online',
      in_service: false,
      vehicle_state: {
        api_version: 4,
        car_version: '2025.38.7',
        odometer: 23417.836,
        locked: true,
        df: 0,
        dr: 0,
        ft: 0,
        pf: 0,
        pr: 0,
        rt: 0,
        remote_start: false,
        valet_mode: false,
        sentry_mode: false,
        center_display_state: 0,
        sun_roof_state: 'unknown',
        vehicle_name: '小白',
        tpms_soft_warning_fl: false,
        tpms_soft_warning_fr: false,
        tpms_soft_warning_rl: false,
        tpms_soft_warning_rr: false,
      },
      charge_state: {
        battery_level: Math.round(battery),
        usable_battery_level: Math.round(battery),
        battery_range: +range.toFixed(2),
        ideal_battery_range: +(range * 1.03).toFixed(2),
        est_battery_range: +(range * 0.96).toFixed(2),
        charging_state: 'Disconnected',
        charge_limit_soc: 80,
        charge_limit_soc_std: 90,
        charge_limit_soc_max: 100,
        charger_power: 0,
        charger_voltage: 0,
        charger_actual_current: 0,
        charger_phases: null,
        charge_energy_added: 0,
        time_to_full_charge: 0,
        charge_port_door_open: false,
        charge_port_latch: 'Engaged',
        fast_charger_present: false,
        fast_charger_type: '<invalid>',
        fast_charger_brand: '<invalid>',
        charge_rate: 0,
        charge_current_request: 16,
        charge_current_request_max: 32,
        scheduled_charging_pending: false,
        trip_charging: null,
        not_enough_power_to_heat: null,
        managed_charging_active: false,
        timestamp: Math.round(t * 1000),
      },
      climate_state: {
        inside_temp: +(22.5 + drift * 0.6).toFixed(1),
        outside_temp: 18.0,
        driver_temp_setting: 22.0,
        passenger_temp_setting: 22.0,
        is_climate_on: false,
        is_preconditioning: false,
        is_auto_conditioning_on: null,
        fan_status: 0,
        seat_heater_left: 0,
        seat_heater_right: 0,
        seat_heater_rear_left: 0,
        seat_heater_rear_right: 0,
        seat_heater_rear_center: 0,
        side_mirror_heaters: false,
        wiper_blade_heater: false,
        steering_wheel_heater: false,
        battery_heater: false,
        is_front_defroster_on: false,
        is_rear_defroster_on: false,
        min_avail_temp: 15,
        max_avail_temp: 28,
        timestamp: Math.round(t * 1000),
      },
      drive_state: {
        shift_state: null,
        speed: null,
        power: 0,
        latitude: 31.2304,
        longitude: 121.4737,
        heading: 275,
        gps_as_of: Math.round(t) - 47,
        native_location_supported: 1,
        native_latitude: 31.2304,
        native_longitude: 121.4737,
        native_type: 'wgs',
        timestamp: Math.round(t * 1000),
      },
      vehicle_config: {
        car_type: 'model3',
        car_special_type: 'base',
        exterior_color: 'PearlWhite',
        has_ludicrous_mode: false,
        motorized_charge_port: true,
        right_hand_drive: false,
        eu_vehicle: false,
        plg: false,
        roof_color: 'None',
        perf_config: 'P74',
        rear_seat_heaters: 0,
        rear_seat_type: null,
        seat_type: null,
        spoiler_type: 'None',
        sun_roof_installed: null,
        third_row_seats: 'None',
        trim_badging: '74d',
        charge_port_type: 'CCS',
        timestamp: Math.round(t * 1000),
      },
    },
  };
}

const demoVehicles = {
  response: [
    {
      id: 4242424242424242,
      vehicle_id: 1234567890,
      vin: '5YJ3E1EA7KF000000',
      display_name: '小白',
      state: 'online',
      option_codes: 'AD15,AF02,APF0,APH2,AU00,BCMB,BTX4,MDL3,PMNG,TM00',
      in_service: false,
      calendar_enabled: true,
      api_version: 4,
    },
  ],
  count: 1,
};

/* ------------------------------- 静态资源 ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res, relPath) {
  const safe = relPath.replace(/\.\./g, '').replace(/^\/+/, '');
  const file = join(ROOT, 'public', safe || 'index.html');
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* -------------------------------- 路由 -------------------------------- */
/* --------------------------- 数据存储 + 采集器 --------------------------- */
const store = openDb(DATA_DIR);

// 采集器通过依赖注入拿 API 函数，避免和 server.mjs 循环引用
const recorder = createRecorder({
  db: store,
  api: {
    listVehicles: () => (MODE === 'demo' ? Promise.resolve(demoVehicles) : teslaGet('/api/1/vehicles')),
    fetchVehicleData: (id) => (MODE === 'demo' ? Promise.resolve(demoData()) : fetchVehicleData(id)),
  },
  intervalSec: Math.max(15, Number(process.env.POLL_INTERVAL_SEC) || 60),
  retentionDays: Math.max(1, Number(process.env.RETENTION_DAYS) || 90),
  log: (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
});


/* ------------------------------ 访问控制 ------------------------------
 * APP_PASSWORD 为空  → 不启用登录（本地用，或已由 Tailscale 等网络层保护）
 * APP_PASSWORD 非空  → 所有页面和 API 都要先登录
 * 例外：/.well-known/... （Tesla 必须能公网抓到公钥）
 * -------------------------------------------------------------------- */
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE_NAME = 'dash_sess';
const SESSION_SECRET_FILE = join(DATA_DIR, 'session.secret');

let sessionSecret = '';
try { sessionSecret = readFileSync(SESSION_SECRET_FILE, 'utf8').trim(); } catch {}
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex');
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
  } catch {}
}
// cookie 值绑定当前密码：改密码后旧 cookie 自动失效
const SESSION_VALUE = createHmac('sha256', sessionSecret).update('pw:' + APP_PASSWORD).digest('hex').slice(0, 40);

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const got = parseCookies(req)[COOKIE_NAME] || '';
  const a = Buffer.from(got);
  const b = Buffer.from(SESSION_VALUE);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 登录失败限流：同一 IP 5 分钟内最多 5 次失败
const LOGIN_FAILS = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

function clientIp(req) {
  // 走反代时优先用 X-Forwarded-For 的第一段
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const rec = LOGIN_FAILS.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  const recent = rec.filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length) LOGIN_FAILS.set(ip, recent); else LOGIN_FAILS.delete(ip);
  return recent.length >= LOGIN_MAX_FAILS ? Math.ceil((LOGIN_WINDOW_MS - (now - recent[0])) / 1000) : 0;
}

function recordLoginFail(ip) {
  const now = Date.now();
  const rec = (LOGIN_FAILS.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  rec.push(now);
  LOGIN_FAILS.set(ip, rec);
}

function loginPage(error = '') {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Tesla Dash</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e9ecf1;
       font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",system-ui,sans-serif;
       background-image:radial-gradient(800px 400px at 50% -10%,rgba(61,220,132,.08),transparent 60%)}
  form{width:min(340px,88vw);background:#14171c;border:1px solid #262b33;border-radius:16px;padding:30px 26px}
  .bolt{font-size:22px;filter:drop-shadow(0 0 8px rgba(61,220,132,.5))}
  h1{font-size:15px;font-weight:600;letter-spacing:.14em;color:#8b929d;margin:10px 0 22px}
  h1 b{color:#e9ecf1}
  input{width:100%;padding:11px 13px;background:#0e1116;border:1px solid #262b33;border-radius:9px;
        color:#e9ecf1;font-size:14px;font-family:inherit;outline:none}
  input:focus{border-color:#2a9d5f}
  button{width:100%;margin-top:14px;padding:11px;background:#3ddc84;color:#07140c;border:none;
         border-radius:9px;font-size:14px;font-weight:650;font-family:inherit;cursor:pointer}
  button:hover{background:#4ee896}
  .err{color:#f24e4e;font-size:12.5px;margin-top:10px;min-height:16px}
</style>
<form method="POST" action="/login">
  <div class="bolt">⚡</div>
  <h1>TESLA <b>DASH</b></h1>
  <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="current-password">
  <button type="submit">进入</button>
  <div class="err">${error}</div>
</form>`;
}


/* ------------------------------ 远程控制 ------------------------------
 * 依赖：bin/tesla-control（官方签名工具）+ keys/private-key.pem + 车辆已配对虚拟密钥
 * 安全：必须同时设 ALLOW_COMMANDS=1 和 APP_PASSWORD，否则一律拒绝
 * -------------------------------------------------------------------- */
const ALLOW_COMMANDS = process.env.ALLOW_COMMANDS === '1';
const TESLA_CONTROL = process.env.TESLA_CONTROL_PATH || join(ROOT, 'bin', 'tesla-control');
const KEY_FILE = process.env.TESLA_KEY_FILE || join(ROOT, 'keys', 'private-key.pem');
const CMD_TOKEN_FILE = join(DATA_DIR, '.cmd-token');

const CMD_SPECS = {
  'climate-on':            () => ['climate-on'],
  'climate-off':           () => ['climate-off'],
  'set-temp':              (b) => {
    const t = Number(b.temp);
    if (!Number.isFinite(t) || t < 15 || t > 28) throw new Error('温度必须在 15~28 之间');
    // tesla-control 用 Sscanf("%f%s") 解析，必须带单位，裸数字会报错
    return ['climate-set-temp', `${Math.round(t * 2) / 2}C`];
  },
  'seat-heater':           (b) => {
    const SEATS = new Set(['front-left','front-right','2nd-row-left','2nd-row-right','2nd-row-center','3rd-row-left','3rd-row-right']);
    const LEVELS = new Set(['off','low','medium','high']);
    if (!SEATS.has(b.seat)) throw new Error('座位参数不合法');
    if (!LEVELS.has(b.level)) throw new Error('档位必须是 off/low/medium/high');
    return ['seat-heater', b.seat, b.level];
  },
  'steering-wheel-heater': (b) => {
    if (b.state !== 'on' && b.state !== 'off') throw new Error('状态必须是 on 或 off');
    return ['steering-wheel-heater', b.state];
  },
};

function runProcess(file, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out.trim(), stderr: err.trim() }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); });
  });
}

function tokenScopes() {
  try {
    const part = tokens.access_token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const d = JSON.parse(json);
    return Array.isArray(d.scp) ? d.scp : [];
  } catch {
    return [];
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    /* ---------------------- 登录 / 登出 ---------------------- */
    if (path === '/login') {
      if (req.method === 'POST') {
        const ip = clientIp(req);
        const wait = loginBlocked(ip);
        if (wait > 0) {
          res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(wait) });
          return res.end(loginPage(`尝试过于频繁，请 ${Math.ceil(wait / 60)} 分钟后再试`));
        }
        const body = await readBody(req);
        const pw = new URLSearchParams(body).get('password') || '';
        if (safeEqual(pw, APP_PASSWORD)) {
          res.writeHead(302, {
            'Set-Cookie': `${COOKIE_NAME}=${SESSION_VALUE}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`,
            Location: '/',
          });
          return res.end();
        }
        recordLoginFail(ip);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage('密码错误'));
      }
      if (!APP_PASSWORD || isAuthed(req)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage());
    }

    if (path === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
        Location: '/login',
      });
      return res.end();
    }

    /* ---------------------- 访问守卫 ---------------------- */
    // 公钥必须公开（Tesla 服务端要抓）；其余全部要登录
    const isPublic = path.startsWith('/.well-known/');
    if (APP_PASSWORD && !isPublic && !isAuthed(req)) {
      if (path.startsWith('/api/')) {
        return json(res, 401, { error: 'UNAUTHORIZED', message: '需要登录' });
      }
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    /* 采集器状态 */
    if (path === '/api/recorder') {
      return json(res, 200, { ...recorder.status(), dbFile: store.file });
    }

    /* 汇总统计 */
    if (path === '/api/stats') {
      return json(res, 200, store.stats());
    }

    /* 行程列表 */
    if (path === '/api/trips') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return json(res, 200, { items: store.listTrips(limit, offset), limit, offset });
    }

    /* 充电列表 */
    if (path === '/api/charging') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return json(res, 200, { items: store.listCharging(limit, offset), limit, offset });
    }

    /* 行程详情（含轨迹点） */
    if (path.startsWith('/api/trips/')) {
      const id = Number(path.slice('/api/trips/'.length));
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: 'BAD_ID' });
      const trip = store.getTrip(id);
      if (!trip) return json(res, 404, { error: 'NOT_FOUND' });
      // 轨迹前后各放宽 2 分钟，避免起点/终点被采样间隙裁掉
      const track = store.trackBetween(trip.start_ts - 120, trip.end_ts + 120);
      return json(res, 200, { trip, track });
    }

    /* 充电详情（含充电曲线） */
    if (path.startsWith('/api/charging/')) {
      const id = Number(path.slice('/api/charging/'.length));
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: 'BAD_ID' });
      const session = store.getCharging(id);
      if (!session) return json(res, 404, { error: 'NOT_FOUND' });
      const curve = store.chargeCurve(session.start_ts - 120, session.end_ts + 120);
      return json(res, 200, { session, curve });
    }

    /* 电量曲线 */
    if (path === '/api/series') {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      const pts = store.batterySeries(since);
      // 采样太密时抽稀，最多返回 400 个点
      const step = Math.max(1, Math.ceil(pts.length / 400));
      const out = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
      return json(res, 200, { hours, total: pts.length, items: out });
    }

    /* 配置状态 */
    if (path === '/api/status') {
      return json(res, 200, {
        mode: MODE,
        region: REGION,
        apiBase: API_BASE,
        redirectUri: REDIRECT_URI,
        hasToken: !!tokens?.access_token,
        tokenSource: tokens?.source || null,
        canOAuth: !!(CLIENT_ID && CLIENT_SECRET),
        canPasteToken: !!CLIENT_ID,
        commandsEnabled: ALLOW_COMMANDS && !!APP_PASSWORD,
        commandsReason: !ALLOW_COMMANDS ? 'ALLOW_COMMANDS_NOT_SET' : (!APP_PASSWORD ? 'NEED_PASSWORD' : null),
        scopes: tokens?.access_token ? tokenScopes() : [],
        hasCmdScope: tokens?.access_token ? tokenScopes().includes('vehicle_cmds') : false,
      });
    }

    /* 车辆列表 */
    if (path === '/api/vehicles') {
      if (MODE === 'demo') return json(res, 200, demoVehicles);
      const data = await teslaGet('/api/1/vehicles');
      return json(res, 200, data);
    }

    /* 车辆详情 */
    if (path.startsWith('/api/vehicle/')) {
      const id = decodeURIComponent(path.slice('/api/vehicle/'.length));
      if (MODE === 'demo') return json(res, 200, demoData());
      const data = await fetchVehicleData(id);
      return json(res, 200, data);
    }

    /* 唤醒 */
    if (path.startsWith('/api/wake/') && req.method === 'POST') {
      const id = decodeURIComponent(path.slice('/api/wake/'.length));
      if (MODE === 'demo') return json(res, 200, { response: { result: true, state: 'online' }, _demo: true });
      const data = await teslaPost(`/api/1/vehicles/${encodeURIComponent(id)}/wake_up`);
      return json(res, 200, data);
    }

    /* 远程控制（空调 / 温度 / 座椅加热 / 方向盘加热） */
    if (path.startsWith('/api/cmd/') && req.method === 'POST') {
      const action = path.slice('/api/cmd/'.length);
      if (MODE === 'demo') return json(res, 400, { error: 'DEMO', message: 'demo 模式不支持控制' });
      if (!ALLOW_COMMANDS) {
        return json(res, 403, {
          error: 'CMDS_DISABLED',
          message: '服务器未开启控制功能（需要在 .env 加 ALLOW_COMMANDS=1）',
        });
      }
      if (!APP_PASSWORD) {
        return json(res, 403, {
          error: 'NEED_PASSWORD',
          message: '控制功能要求先设置 APP_PASSWORD。否则任何人拿到链接都能开关你的空调、解锁车门。',
        });
      }
      const spec = CMD_SPECS[action];
      if (!spec) return json(res, 404, { error: 'UNKNOWN_CMD', message: `未知指令：${action}` });

      let body = {};
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch { body = {}; }

      let args;
      try {
        args = spec(body);
      } catch (e) {
        return json(res, 400, { error: 'BAD_PARAM', message: e.message });
      }

      // 解析车辆
      const list = await teslaGet('/api/1/vehicles');
      const vehicles = list.response || [];
      const v = (body.id && vehicles.find((x) => String(x.id) === String(body.id))) || vehicles[0];
      if (!v) return json(res, 400, { error: 'NO_VEHICLE', message: '账号下没有车辆' });

      // 车在睡就先唤醒（指令必须车在线才能送达）
      let st = v.state;
      if (st !== 'online') {
        try {
          await teslaPost(`/api/1/vehicles/${encodeURIComponent(v.id)}/wake_up`);
        } catch {}
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const l2 = await teslaGet('/api/1/vehicles');
            const v2 = (l2.response || []).find((x) => String(x.id) === String(v.id));
            if (v2 && v2.state === 'online') { st = 'online'; break; }
          } catch {}
        }
        if (st !== 'online') {
          return json(res, 408, { error: 'VEHICLE_OFFLINE', message: '车唤醒超时，指令未发送' });
        }
      }

      // 写 token（tesla-control 读纯文本）
      try {
        const token = await getAccessToken();
        writeFileSync(CMD_TOKEN_FILE, token, { mode: 0o600 });
      } catch (e) {
        return json(res, 500, { error: 'TOKEN', message: `取 token 失败：${e.message}` });
      }

      const r = await runProcess(TESLA_CONTROL, [
        '-key-file', KEY_FILE,
        '-vin', v.vin,
        '-token-file', CMD_TOKEN_FILE,
        '-command-timeout', '30s',
        '-connect-timeout', '40s',
        ...args,
      ], 70000);

      const ok = r.code === 0;
      const detail = (r.stderr || r.stdout || '').trim();
      const needPairing = /not been paired|public key/i.test(detail);
      console.log(`[指令] ${action} ${args.join(' ')} → ${ok ? '✓ 成功' : '✗ 失败'}${detail ? ' · ' + detail.slice(0, 160) : ''}`);
      return json(res, ok ? 200 : 502, {
        ok,
        action,
        args,
        code: r.code,
        // 让前端能显示真实原因，而不是只看到 "HTTP 502"
        message: ok ? null : needPairing
          ? '车辆还没和本应用的公钥配对。请到车旁边完成一次配对（见 README「远程控制 → 配对」）。'
          : (detail || '指令执行失败'),
        needPairing,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }

    /* ---------- OAuth：登录 ---------- */
    if (path === '/auth/login') {
      if (MODE === 'demo') {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      if (!CLIENT_ID || !CLIENT_SECRET) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderMsg('缺少配置', '请先在 .env 里填 TESLA_CLIENT_ID 和 TESLA_CLIENT_SECRET。'));
      }
      const state = randomBytes(16).toString('hex');
      res.setHeader(
        'Set-Cookie',
        `oauth_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${REDIRECT_URI.startsWith('https') ? '; Secure' : ''}`
      );
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        state,
        prompt: 'login',
        audience: API_BASE,
        // scope 增加后必须显式要求补授，否则特斯拉会复用旧授权、不弹新权限
        prompt_missing_scopes: 'true',
        require_requested_scopes: 'true',
      });
      res.writeHead(302, { Location: `${AUTH_BASE}?${q}` });
      return res.end();
    }

    /* ---------- OAuth：回调 ---------- */
    if (path === '/auth/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderMsg('授权被拒绝', String(err)));
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderMsg('缺少 code', '回调里没有授权码。'));
      }

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        audience: API_BASE,
      });

      const tr = await fetch(TOKEN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          renderMsg('换取 token 失败', `HTTP ${tr.status}<br>${escapeHtml(tj.error_description || tj.error || JSON.stringify(tj))}`)
        );
      }
      saveTokens({
        access_token: tj.access_token,
        refresh_token: tj.refresh_token,
        expires_at: Date.now() + (tj.expires_in || 3600) * 1000,
        source: 'oauth',
      });
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    if (path === '/auth/logout') {
      tokens = null;
      try {
        writeFileSync(TOKEN_FILE, '{}', { mode: 0o600 });
      } catch {}
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    /* Tesla 伙伴注册要校验的公钥 —— 必须能被公网 HTTPS 访问到 */
    if (path === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
      try {
        const buf = await readFile(join(ROOT, 'keys', 'public-key.pem'));
        res.writeHead(200, {
          'Content-Type': 'application/x-pem-file',
          'Cache-Control': 'public, max-age=300',
        });
        return res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('public key not generated yet');
      }
    }

    /* 静态文件 */
    if (path === '/' || path === '/index.html') return serveStatic(res, 'index.html');
    if (path.startsWith('/public/')) return serveStatic(res, path.slice('/public/'.length));
    if (path.startsWith('/vendor/')) return serveStatic(res, path);
    if (path === '/app.js' || path === '/style.css') return serveStatic(res, path);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg === 'NO_TOKEN') {
      return json(res, 401, { error: 'NO_TOKEN', message: '还没有授权，请先登录或粘贴 access_token。' });
    }
    console.error('[error]', req.method, path, '→', msg);
    json(res, e.status || 500, { error: 'UPSTREAM', message: msg });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderMsg(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui;background:#0f1115;color:#e8eaed;padding:48px;line-height:1.6">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>
<p style="color:#9aa0a6">${bodyHtml}</p>
<p><a href="/" style="color:#5b9cf6">返回首页</a></p></body>`;
}

const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ⚡ Tesla Dash');
  console.log(`  模式     : ${MODE}${MODE === 'demo' ? '  (假数据，无需账号)' : '  (Fleet API)'}`);
  if (MODE === 'fleet') {
    console.log(`  区域     : ${REGION}  →  ${API_BASE}`);
    console.log(`  回调地址 : ${REDIRECT_URI}`);
    console.log(`  OAuth    : ${CLIENT_ID && CLIENT_SECRET ? '已配置' : '未配置（.env 里填 client_id / client_secret）'}`);
    console.log(`  Token    : ${tokens?.access_token ? `已有 (${tokens.source})` : '无'}`);
  }
  console.log(`  数据库   : ${store.file}`);
  console.log(`  访问控制 : ${APP_PASSWORD ? '需要密码登录' : '无密码（仅建议在本机或 Tailscale 内使用）'}`);
  console.log(`  远程控制 : ${!ALLOW_COMMANDS ? '关闭（ALLOW_COMMANDS 未设为 1）' : !APP_PASSWORD ? '⚠ 已开启但无密码，已强制拒绝' : '已开启'}`);
  console.log('');
  console.log(`  打开 →  http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1') console.log(`  监听 →  ${HOST}:${PORT}（对外可访问）`);
  console.log('');

  // 有 token 才开始采集，避免无意义报错；demo 模式不采集，免得往真实库里写假数据
  if (MODE === 'demo') {
    console.log('  (demo 模式不采集数据)');
    console.log('');
  } else if (tokens?.access_token) {
    recorder.start();
  } else {
    console.log('  (未授权，采集器未启动；登录后重启服务即可开始记录)');
    console.log('');
  }
});

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  收到信号，收尾中…');
    try { recorder.stop(); } catch {}
    try { store.close(); } catch {}
    process.exit(0);
  });
}
