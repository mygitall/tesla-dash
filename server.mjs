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
import { gzipSync } from 'node:zlib';
import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { createRecorder } from './recorder.mjs';
import { createNotifier } from './notifier.mjs';

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

// 压缩缓存：key = 文件路径，value = { mtime, gz, etag }
const GZ_CACHE = new Map();
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.map']);

async function serveStatic(req, res, relPath) {
  const safe = relPath.replace(/\.\./g, '').replace(/^\/+/, '');
  const file = join(ROOT, 'public', safe || 'index.html');
  try {
    const st = statSync(file);
    const ext = extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // 静态资源缓存策略：vendor 永久缓存，应用文件每次协商（304 极快）
    const cacheControl = /^vendor\//.test(safe)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

    // 客户端已有最新版本 → 304，只回几十字节
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      return res.end();
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const head = {
      'Content-Type': type,
      'Cache-Control': cacheControl,
      ETag: etag,
      Vary: 'Accept-Encoding',
    };

    if (acceptsGzip && COMPRESSIBLE.has(ext)) {
      let hit = GZ_CACHE.get(file);
      if (!hit || hit.mtime !== st.mtimeMs) {
        const raw = await readFile(file);
        hit = { mtime: st.mtimeMs, gz: gzipSync(raw, { level: 6 }) };
        GZ_CACHE.set(file, hit);
      }
      res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': hit.gz.length });
      return res.end(hit.gz);
    }

    const buf = await readFile(file);
    res.writeHead(200, { ...head, 'Content-Length': buf.length });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const req = res.req;
  const acceptsGzip = req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  // 超过 1KB 才压：小响应压缩反而更慢（series 这类大响应收益明显）
  if (acceptsGzip && body.length > 1024) {
    const gz = gzipSync(body, { level: 5 });
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

/* -------------------------------- 路由 -------------------------------- */
/* --------------------------- 数据存储 + 采集器 --------------------------- */
const store = openDb(DATA_DIR);

// 采集器通过依赖注入拿 API 函数，避免和 server.mjs 循环引用
/* ---------------------- 运行时设置（可在线修改） ---------------------- */
// 电池容量与电价（用于估算剩余电量、今日花费）
const BATTERY_KWH = Number(process.env.BATTERY_KWH || 75);
const ELECTRICITY_PRICE = Number(process.env.ELECTRICITY_PRICE || 1.6);

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  autoLock: false,
  autoLockDelaySec: 60,
  // 官方 App 显示的历史累计（导入前的手工基线）
  chargeBaseline: { sessions: 0, kwh: 0, durationMin: 0, assumedKw: 60, updatedAt: null },
};

function readSettings() {
  try {
    const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...j };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  // 夹紧取值范围，避免误配置
  next.autoLock = !!next.autoLock;
  const d = Number(next.autoLockDelaySec);
  next.autoLockDelaySec = Number.isFinite(d) ? Math.min(600, Math.max(30, Math.round(d))) : 60;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

let SETTINGS = readSettings();

/* ------------------ 自动锁：下发指令（复用唤醒 + 签名流程） ------------------ */
async function sendAutoLock() {
  if (MODE === 'demo') return { ok: false, message: 'demo 模式不支持' };
  if (!ALLOW_COMMANDS) return { ok: false, message: '未开启控制功能（ALLOW_COMMANDS!=1）' };

  const list = await teslaGet('/api/1/vehicles');
  const v = (list.response || [])[0];
  if (!v) return { ok: false, message: '账号下没有车辆' };

  // 必须在线的车才能收指令；休眠就先唤醒
  let st = v.state;
  if (st !== 'online') {
    try { await teslaPost(`/api/1/vehicles/${encodeURIComponent(v.id)}/wake_up`); } catch {}
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const l2 = await teslaGet('/api/1/vehicles');
        const v2 = (l2.response || []).find((x) => String(x.id) === String(v.id));
        if (v2 && v2.state === 'online') { st = 'online'; break; }
      } catch {}
    }
    if (st !== 'online') return { ok: false, message: '车唤醒超时' };
  }

  const token = await getAccessToken();
  writeFileSync(CMD_TOKEN_FILE, token, { mode: 0o600 });

  const r = await runProcess(TESLA_CONTROL, [
    '-key-file', KEY_FILE,
    '-vin', v.vin,
    '-token-file', CMD_TOKEN_FILE,
    '-command-timeout', '30s',
    '-connect-timeout', '40s',
    'lock',
  ], 70000);

  const ok = r.code === 0;
  const detail = (r.stderr || r.stdout || '').trim();
  return { ok, message: ok ? null : (detail || '指令失败'), detail };
}

const recorder = createRecorder({
  db: store,
  autoLock: {
    enabled: () => SETTINGS.autoLock,
    delaySec: () => SETTINGS.autoLockDelaySec,
    fire: sendAutoLock,
  },
  api: {
    listVehicles: () => (MODE === 'demo' ? Promise.resolve(demoVehicles) : teslaGet('/api/1/vehicles')),
    fetchVehicleData: (id) => (MODE === 'demo' ? Promise.resolve(demoData()) : fetchVehicleData(id)),
  },
  intervalSec: Math.max(15, Number(process.env.POLL_INTERVAL_SEC) || 60),
  // 0 或未设置 = 永久保留（不自动清理历史采样）
  // 事件推送（BARK_URL 存在时启用）
  onData: (await (async () => {
    const barkUrl = process.env.BARK_URL;
    if (!barkUrl) return null;
    const notifier = createNotifier({
      push: async (title, body) => {
        const url = `${barkUrl.replace(/\/$/, '')}/${encodeURIComponent('Tesla·' + title)}/${encodeURIComponent(body)}?group=tesla&level=active`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`Bark HTTP ${r.status}`);
      },
      batteryKwh: BATTERY_KWH,
      lowBatteryPct: Number(process.env.LOW_BATTERY_PCT) || 20,
      unlockedMinutes: Number(process.env.UNLOCKED_MINUTES) || 10,
      stateFile: join(DATA_DIR, '.events-state.json'),
      log: (m) => console.log(m),
    });
    return (d) => notifier.handle(d, Math.floor(Date.now() / 1000));
  })()),

  retentionDays: Math.max(0, Number(process.env.RETENTION_DAYS) ?? 0),
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

// 免密访问密钥：/k/<key> 可换取登录会话，用于「不输密码也能进」
const ACCESS_KEY_FILE = join(DATA_DIR, '.access-key');
const ACCESS_KEY = (() => {
  try {
    const k = readFileSync(ACCESS_KEY_FILE, 'utf8').trim();
    if (k.length >= 24) return k;
  } catch {}
  const k = randomBytes(24).toString('hex');
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ACCESS_KEY_FILE, k, { mode: 0o600 });
  } catch {}
  return k;
})();

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

/** 上次充电增加里程：电池差 × 满电续航（采样太稀时比 range 差更准），带 10 分钟缓存 */
let _addedKmCache = { ts: 0, val: null };
function lastChargeAddedKm(rangeKmNow, batteryNow) {
  const now = Math.floor(Date.now() / 1000);
  if (now - _addedKmCache.ts < 600) return _addedKmCache.val;
  let val = null;
  try {
    const list = store.chargingSessionsFromSamples(BATTERY_KWH);
    const last = list[list.length - 1];
    if (last && last.startBattery != null && last.endBattery != null
        && last.endBattery > last.startBattery) {
      // 满电续航：用当前 range/battery 推算，异常时回退 430km
      let fullKm = 430;
      if (rangeKmNow && batteryNow && batteryNow > 8) {
        const guess = rangeKmNow / (batteryNow / 100);
        if (guess > 300 && guess < 700) fullKm = guess;
      }
      const pct = (last.endBattery - last.startBattery) / 100;
      val = Math.round(pct * fullKm);
    }
    // 兜底：电池数据缺失时才用续航差
    if (val == null && last) {
      const dmi = store.rangeDeltaBetween(last.startTs - 300, last.endTs + 300);
      if (dmi != null && dmi > 0 && dmi < 300) val = Math.round(dmi * MI_TO_KM);
    }
  } catch {}
  _addedKmCache = { ts: now, val };
  return val;
}

const CMD_SPECS = {
  'lock':                  () => ['lock'],
  'drive':                 () => ['drive'],   // 无钥匙启动：授权驾驶 2 分钟
  'unlock':                () => ['unlock'],
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

    /* ---------- 免密登录：/k/<key> 或 /?k=<key> ---------- */
    if (path === '/k' || path.startsWith('/k/') || (path === '/' && url.searchParams.get('k'))) {
      const given = path.startsWith('/k/')
        ? decodeURIComponent(path.slice(3))
        : (url.searchParams.get('k') || '');
      if (ACCESS_KEY && given && safeEqual(given, ACCESS_KEY)) {
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE_NAME}=${SESSION_VALUE}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`,
          Location: '/',
        });
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    /* ---------------------- 访问守卫 ---------------------- */
    // 公钥必须公开（Tesla 服务端要抓）；其余全部要登录
    // /auth/callback 必须公开：特斯拉回调时浏览器没有会话 cookie，
    // 若要求登录会把 code 丢在重定向里，导致续期失败
    // /health 供外部监控探测，不含任何敏感信息
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, ts: Math.floor(Date.now() / 1000) }));
    }

    const isPublic = path.startsWith('/.well-known/') || path === '/auth/callback';
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

    /* 行程列表（含单位换算，供 App 直接用） */
    if (path === '/api/trips') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const MI_TO_KM_ = 1.609344;
      const trips = store.listTrips(limit, offset).map((t) => ({
        id: t.id,
        startTs: t.start_ts,
        endTs: t.end_ts,
        distanceKm: Math.round((t.distance_mi || 0) * MI_TO_KM_ * 10) / 10,
        durationMin: Math.round((t.end_ts - t.start_ts) / 60),
        startBattery: t.start_battery,
        endBattery: t.end_battery,
        maxSpeedKmh: Math.round((t.max_speed || 0) * 1.609),
        avgSpeedKmh: Math.round((t.avg_speed || 0) * 1.609),
        startLat: t.start_lat, startLon: t.start_lon,
        endLat: t.end_lat, endLon: t.end_lon,
        samples: t.samples,
      }));
      // 累计值：数据库全量统计，不受分页影响
      const tt = store.tripsTotals();
      const totals = {
        count: tt.count,
        distanceKm: Math.round(tt.distanceMi * 1.609344 * 10) / 10,
        durationMin: Math.round(tt.durationSec / 60),
        firstTs: tt.firstTs,
        lastTs: tt.lastTs,
      };
      return json(res, 200, { trips, items: trips, totals, limit, offset });
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
      const raw = store.trackBetween(trip.start_ts - 120, trip.end_ts + 120);
      // 优先用车辆给的本地坐标（GCJ-02），没有则回退 WGS-84 并标记
      const track = raw.map((p) => {
        const hasNative = p.native_lat != null && p.native_lon != null;
        return {
          ts: p.ts,
          lat: hasNative ? p.native_lat : p.lat,
          lon: hasNative ? p.native_lon : p.lon,
          frame: hasNative ? 'gcj' : 'wgs',
          speed: p.speed,
          battery: p.battery,
        };
      });
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
        autoLock: SETTINGS.autoLock,
        autoLockDelaySec: SETTINGS.autoLockDelaySec,
        // 监控用：最近一条采样的时间戳 + 令牌刷新时间
        lastSampleTs: (() => { try { const r = store.latestSample(); return r?.ts ?? null; } catch { return null; } })(),
        recorderTickTs: recorder?.lastTickTs ?? null,
        tokenRefreshTs: tokens?.refreshed_at ? Math.floor(new Date(tokens.refreshed_at).getTime() / 1000) : null,
        uptimeSec: Math.floor(process.uptime()),
      });
    }

    /* ---------- App 专用：一次拿全的精简状态 ---------- */
    /* ---------- 充电曲线 ---------- */
    if (path === '/api/charge/curve') {
      let startTs = Number(url.searchParams.get('start'));
      let endTs = Number(url.searchParams.get('end'));

      // 不传时间就取最近一次充电
      if (!startTs || !endTs) {
        const list = store.chargingSessionsFromSamples(BATTERY_KWH);
        if (!list.length) return json(res, 200, { startTs: null, endTs: null, points: [] });
        const last = list[list.length - 1];
        startTs = last.startTs - 300;
        endTs = last.endTs + 300;
      }

      const raw = store.chargeCurveBetween(startTs, endTs);
      // 只保留真正在充电的样本（功率 > 0.5kW）
      const points = raw
        .filter((p) => (p.power ?? 0) > 0.5)
        .map((p) => ({
          ts: p.ts,
          battery: p.battery,
          power: Math.round((p.power ?? 0) * 10) / 10,
          voltage: p.voltage,
          current: p.current,
        }));
      const peak = points.reduce((m, p) => Math.max(m, p.power), 0);
      return json(res, 200, {
        startTs, endTs, points,
        peakPower: Math.round(peak * 10) / 10,
        count: points.length,
      });
    }

    /* ---------- 充电历史基线（手工导入官方 App 数字） ---------- */
    if (path === '/api/charge/baseline') {
      if (req.method === 'GET') {
        return json(res, 200, SETTINGS.chargeBaseline || { sessions: 0, kwh: 0, updatedAt: null });
      }
      if (req.method === 'POST') {
        const body = await readBody(req, 8 * 1024).catch(() => null);
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch {}
        const baseline = {
          sessions: Math.max(0, Number(payload.sessions) || 0),
          kwh: Math.max(0, Number(payload.kwh) || 0),
          durationMin: Math.max(0, Math.round(Number(payload.durationMin) || 0)),
          assumedKw: Math.max(1, Number(payload.assumedKw) || 60),
          updatedAt: new Date().toISOString(),
        };
        SETTINGS = writeSettings({ chargeBaseline: baseline });
        return json(res, 200, { ok: true, chargeBaseline: SETTINGS.chargeBaseline });
      }
    }    /* ---------- 充电统计：按年月筛选 ---------- */
    if (path === '/api/charge/months') {
      const sessions = store.chargingSessionsFromSamples(BATTERY_KWH);
      const map = new Map();
      for (const x of sessions) {
        const d = new Date((x.startTs + 8 * 3600) * 1000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const cur = map.get(key) || { key, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, count: 0, kwh: 0, minutes: 0, peak: 0 };
        cur.count += 1;
        cur.kwh += x.energyKwh;
        cur.minutes += x.durationMin;
        cur.peak = Math.max(cur.peak, x.peakPower);
        map.set(key, cur);
      }
      const months = [...map.values()]
        .map((m) => ({ ...m, kwh: Math.round(m.kwh * 10) / 10, peak: Math.round(m.peak * 10) / 10 }))
        .sort((a, b) => b.key.localeCompare(a.key));
      return json(res, 200, { months, totalSessions: sessions.length });
    }

    if (path === '/api/charge/summary') {
      const nowCN = new Date(Date.now() + 8 * 3600 * 1000);
      const year = Number(url.searchParams.get('year')) || nowCN.getUTCFullYear();
      const monthRaw = url.searchParams.get('month');
      const month = monthRaw && monthRaw !== 'all' ? Number(monthRaw) : null;
      const allTime = url.searchParams.get('range') === 'all';

      if (allTime) {
        const base = (SETTINGS.chargeBaseline || { sessions: 0, kwh: 0 });
        const sessions = store.chargingSessionsFromSamples(BATTERY_KWH).sort((a, b) => b.startTs - a.startTs);
        const sum = sessions.reduce((acc, x) => {
          acc.energyKwh += x.energyKwh;
          acc.minutes += x.durationMin;
          acc.peakPower = Math.max(acc.peakPower, x.peakPower);
          return acc;
        }, { energyKwh: 0, minutes: 0, peakPower: 0 });

        const totalSessions = sessions.length + (base.sessions || 0);
        const totalKwh = Math.round((sum.energyKwh + (base.kwh || 0)) * 10) / 10;

        // 时长：优先用基线里手工填的；没填就按「总电量 ÷ 假设功率」估算
        let baseMinutes = base.durationMin || 0;
        let minutesEstimated = false;
        let assumedKw = 0;
        if (!baseMinutes && (base.kwh || 0) > 0) {
          // 用用户指定的假设充电功率（默认 60kW 快充桩）
          assumedKw = Math.max(1, Number(base.assumedKw) || 60);
          baseMinutes = Math.round((base.kwh / assumedKw) * 60);
          minutesEstimated = true;
        }

        return json(res, 200, {
          year, month: null, allTime: true,
          baseline: {
            sessions: base.sessions || 0,
            kwh: base.kwh || 0,
            durationMin: base.durationMin || 0,
            assumedKw: base.assumedKw || 60,
            updatedAt: base.updatedAt || null,
          },
          totals: {
            count: totalSessions,
            energyKwh: totalKwh,
            minutes: sum.minutes + baseMinutes,
            minutesEstimated,
            assumedKw,
            peakPower: Math.round(sum.peakPower * 10) / 10,
            avgKwh: totalSessions ? Math.round((totalKwh / totalSessions) * 10) / 10 : 0,
          },
          sessions,
        });
      }

      // 东八区该月/该年的起止（转回 UTC 秒）
      const startUtc = Date.UTC(year, month ? month - 1 : 0, 1) - 8 * 3600 * 1000;
      const endUtc = month
        ? Date.UTC(year, month, 1) - 8 * 3600 * 1000
        : Date.UTC(year + 1, 0, 1) - 8 * 3600 * 1000;
      const fromTs = Math.floor(startUtc / 1000);
      const toTs = Math.floor(endUtc / 1000);

      const all = store.chargingSessionsFromSamples(BATTERY_KWH);
      const picked = all
        .filter((x) => x.startTs >= fromTs && x.startTs < toTs)
        .sort((a, b) => b.startTs - a.startTs);

      const totals = picked.reduce((acc, x) => {
        acc.count += 1;
        acc.energyKwh += x.energyKwh;
        acc.minutes += x.durationMin;
        acc.peakPower = Math.max(acc.peakPower, x.peakPower);
        acc.energyKwh = acc.energyKwh;
        return acc;
      }, { count: 0, energyKwh: 0, minutes: 0, peakPower: 0 });
      totals.energyKwh = Math.round(totals.energyKwh * 10) / 10;
      totals.peakPower = Math.round(totals.peakPower * 10) / 10;
      totals.avgKwh = totals.count ? Math.round((totals.energyKwh / totals.count) * 10) / 10 : 0;

      return json(res, 200, {
        year,
        month,
        range: { fromTs, toTs },
        totals,
        sessions: picked,
      });
    }

    if (path === '/api/app/summary') {
      const MI_TO_KM = 1.609344;
      const list = await teslaGet('/api/1/vehicles');
      const v = (list.response || [])[0];
      if (!v) return json(res, 404, { error: 'NO_VEHICLE', message: '账号下没有车辆' });

      const out = {
        id: v.id,
        name: v.display_name,
        vin: v.vin,
        state: v.state,
        commandsEnabled: ALLOW_COMMANDS && !!APP_PASSWORD,
        autoLock: SETTINGS.autoLock,
        autoLockDelaySec: SETTINGS.autoLockDelaySec,
        ts: Math.floor(Date.now() / 1000),
      };

      // 车在线才去取实时数据；休眠时不唤醒（省电）
      if (v.state === 'online') {
        try {
          const d = await teslaGet(`/api/1/vehicles/${encodeURIComponent(v.id)}/vehicle_data`);
          const r = d.response || {};
          const vs = r.vehicle_state || {};
          const ds = r.drive_state || {};
          const cs = r.charge_state || {};
          const cvs = r.climate_state || {};

          // 特斯拉不同车型/固件返回的字段不一样，按优先级兜底
          const kmCandidates = [
            cs.rated_battery_range_km,
            cs.battery_range_km,
            cs.est_battery_range_km,
            cs.rated_battery_range != null ? cs.rated_battery_range * MI_TO_KM : null,
            cs.battery_range != null ? cs.battery_range * MI_TO_KM : null,
            cs.est_battery_range != null ? cs.est_battery_range * MI_TO_KM : null,
            cs.ideal_battery_range != null ? cs.ideal_battery_range * MI_TO_KM : null,
          ];
          const ratedKm = kmCandidates.find((x) => x != null) ?? null;

          Object.assign(out, {
            battery: cs.usable_battery_level ?? cs.battery_level ?? null,
            batteryNominal: cs.battery_level ?? null,
            rangeKm: ratedKm != null ? Math.round(ratedKm) : null,
            charging: cs.charging_state || null,
            chargeLimit: cs.charge_limit_soc ?? null,
            locked: vs.locked ?? null,
            userPresent: vs.is_user_present ?? null,
            odometerKm: vs.odometer != null ? Math.round(vs.odometer * MI_TO_KM) : null,
            insideTemp: cvs.inside_temp ?? null,
            outsideTemp: cvs.outside_temp ?? null,
            climateOn: cvs.is_climate_on ?? null,
            setTemp: cvs.driver_temp_setting ?? null,
            lat: ds.latitude ?? null,
            lon: ds.longitude ?? null,
            speed: ds.speed ?? null,
            shift: ds.shift_state ?? null,

            // 上次充电增加的续航（特斯拉给英里，转 km）
            addedKm: (() => {
              const mi = cs.charge_miles_added_rated ?? cs.charge_miles_added_ideal ?? null;
              return mi != null && mi > 0 ? Math.round(mi * MI_TO_KM) : null;
            })(),

            // 充电细节（对应 UI 的充电卡片）
            chargerPower: cs.charger_power ?? null,
            chargerVoltage: cs.charger_voltage ?? null,
            chargerCurrent: cs.charger_actual_current ?? null,
            chargeRate: cs.charge_rate != null ? Math.round(cs.charge_rate * MI_TO_KM) : null,
            energyAddedKwh: cs.charge_energy_added ?? null,
            minutesToFull: cs.minutes_to_full_charge ?? null,
            chargePortOpen: cs.charge_port_door_open ?? null,
            fastCharger: cs.fast_charger_present ?? null,

            // 剩余电量（kWh）按电池容量估算，容量可用 BATTERY_KWH 覆盖
            batteryKwh: cs.battery_level != null
              ? Math.round(cs.battery_level / 100 * BATTERY_KWH * 10) / 10
              : null,
            batteryCapacityKwh: BATTERY_KWH,
          });
        } catch (e) {
          out.dataError = e?.message || String(e);
        }
      }
          // 车辆休眠/离线时，用最后一次采样兜底，保证界面不空
          if (out.battery == null) {
            try {
              const last = store.latestSample();
              if (last) {
                out.stale = true;
                out.lastSeenTs = last.ts;
                out.battery = last.battery ?? null;
                out.batteryNominal = last.usable_battery ?? last.battery ?? null;
                out.rangeKm = last.range_mi != null ? Math.round(last.range_mi * MI_TO_KM) : null;
                out.odometerKm = last.odometer != null ? Math.round(last.odometer * MI_TO_KM) : null;
                out.insideTemp = last.inside_temp ?? null;
                out.outsideTemp = last.outside_temp ?? null;
                out.locked = last.locked === 1 ? true : last.locked === 0 ? false : null;
                out.charging = last.charging_state ?? null;
                out.chargerPower = last.charger_power ?? null;
                out.chargerVoltage = last.charger_voltage ?? null;
                out.chargerCurrent = last.charger_current ?? null;
                out.chargeRate = last.charge_rate != null
                  ? Math.round(last.charge_rate * MI_TO_KM) : null;
                out.energyAddedKwh = last.energy_added ?? null;
                if (out.battery != null) {
                  out.batteryKwh = Math.round(out.battery / 100 * BATTERY_KWH * 10) / 10;
                }
              }
            } catch (e) {}
          }


        // 今日统计（按东八区当天 0 点）
        try {
          const now = new Date();
          const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
          const st = store.todayStats(Math.floor(localMidnight));
          const distKm = st.distanceMi * MI_TO_KM;
          // 今日耗电：里程估算 与 电池差推算 取较大者（避免偏低）
          let kwh = distKm * 0.15;
          if (st.batteryMax != null && st.batteryMin != null && st.batteryMax > st.batteryMin) {
            const byBattery = ((st.batteryMax - st.batteryMin) / 100) * BATTERY_KWH;
            kwh = Math.max(kwh, byBattery);
          }
          out.today = {
            distanceKm: Math.round(distKm * 10) / 10,
            driveMinutes: Math.round(st.durationSec / 60),
            energyKwh: Math.round(kwh * 10) / 10,
            cost: Math.round(kwh * ELECTRICITY_PRICE * 100) / 100,
            trips: st.trips,
          };
        } catch (e) {
          out.today = null;
        }

      // 兜底：API 没给 addedKm 时，用最近一次充电的续航差（带缓存，避免阻塞）
      if (out.addedKm == null) out.addedKm = lastChargeAddedKm(out.rangeKm, out.battery);

      return json(res, 200, out);
    }

    /* 运行时设置（离车自动锁等） */
    if (path === '/api/settings') {
      if (req.method === 'POST') {
        let body = {};
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch { body = {}; }
        const patch = {};
        if ('autoLock' in body) patch.autoLock = !!body.autoLock;
        if ('autoLockDelaySec' in body) patch.autoLockDelaySec = body.autoLockDelaySec;
        SETTINGS = writeSettings(patch);
        console.log(`[设置] 离车自动锁=${SETTINGS.autoLock ? '开' : '关'} 延迟=${SETTINGS.autoLockDelaySec}s`);
        return json(res, 200, SETTINGS);
      }
      return json(res, 200, SETTINGS);
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
      // 手动操作后 5 分钟内不自动锁，避免「远程解锁 → 又被自动锁回去」
      if (ok) {
        recorder.suppressAutoLock(300);
        // 有人操作 → 15 分钟内恢复高频采样（其余时间让车休眠省电）
        recorder.markActive?.(900);
      }
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
    if (path === '/' || path === '/index.html') return serveStatic(req, res, 'index.html');
    if (path.startsWith('/public/')) return serveStatic(req, res, path.slice('/public/'.length));
    if (path.startsWith('/vendor/')) return serveStatic(req, res, path);
    if (path === '/app.js' || path === '/style.css') return serveStatic(req, res, path);
    if (path === '/manifest.json') return serveStatic(req, res, path);
    if (path.startsWith('/icons/')) return serveStatic(req, res, path);

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
  console.log(`  免密 →  /k/${ACCESS_KEY}`);
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
