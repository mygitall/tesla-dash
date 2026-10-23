/* Tesla Dash — 前端逻辑 */

const POLL_MS = 30_000;
const MI_TO_KM = 1.609344;

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'demo',
  vehicles: [],
  currentId: null,
  timer: null,
  history: [],            // 会话内电量采样，用来画迷你趋势
  units: localStorage.getItem('td.units') || 'km',
  tab: 'live',            // live | history
  chartHours: 24,
  hasVehicle: false,
  hist: { stats: null, trips: [], charging: [], series: null },
};

let tempInited = false;

/* ------------------------------ 工具函数 ------------------------------ */
const show = (el, on = true) => { el.hidden = !on; };

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Tesla API 一律返回英里 / 华氏度，这里换算成公制
const dist = (mi, digits = 0) =>
  mi == null ? '—'
    : state.units === 'km'
      ? `${fmtNum(mi * MI_TO_KM, digits)} km`
      : `${fmtNum(mi, digits)} mi`;

const temp = (c) =>
  c == null ? '—'
    : Number(c).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' °C';

const yesNo = (v, yes = '是', no = '否') => (v === true ? yes : v === false ? no : '—');

function cls(el, kind) {
  el.classList.remove('ok', 'warn', 'bad', 'off');
  if (kind) el.classList.add(kind);
}

function setText(id, value, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  cls(el, kind);
}

function ago(ts) {
  if (!ts) return '—';
  const secs = Math.max(0, Date.now() / 1000 - ts);
  if (secs < 60) return `${Math.round(secs)} 秒前`;
  if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)} 小时前`;
  return `${Math.round(secs / 86400)} 天前`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.code = data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------ 错误 / 门 ------------------------------ */
function showError(title, message, detail) {
  show($('errorBox'), true);
  $('errorTitle').textContent = title;
  $('errorMsg').textContent = message || '';
  if (detail) {
    show($('errorDetail'), true);
    $('errorDetail').textContent = detail;
  } else {
    show($('errorDetail'), false);
  }
}
const clearError = () => show($('errorBox'), false);

function showGate(on) {
  show($('gate'), on);
  if (on) {
    show($('dash'), false);
    show($('viewHistory'), false);
    show($('tabs'), false);
  }
}

/** 根据当前 tab 显示/隐藏两个视图 */
function applyTab() {
  const live = state.tab === 'live';
  show($('dash'), live && state.hasVehicle);
  show($('viewHistory'), !live && state.hasVehicle);
  show($('tabs'), state.hasVehicle);
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('is-active', b.dataset.tab === state.tab);
  }
}

function setBadge(text, kind) {
  const b = $('modeBadge');
  b.textContent = text;
  b.className = 'badge ' + kind;
}

/* ------------------------------ 渲染 ------------------------------ */
function renderVehicle(v) {
  const vs = v.vehicle_state || {};
  const cs = v.charge_state || {};
  const hs = v.climate_state || {};
  const ds = v.drive_state || {};
  const cfg = v.vehicle_config || {};

  // 头部
  $('carName').textContent = v.display_name || vs.vehicle_name || '未命名车辆';
  $('carSub').textContent = v.vin ? `VIN ${v.vin}` : '';

  const st = (v.state || 'unknown').toLowerCase();
  const pill = $('carState');
  pill.textContent = st;
  pill.className = 'pill ' + (st === 'online' ? 'pill-online' : 'pill-asleep');

  // 电量环：用「可用电量」，与特斯拉 App / 车机显示口径一致
  // （battery_level 含约 1% 的电池保护缓冲，会比 App 高 1%）
  const nominalPct = cs.battery_level;
  const pct = cs.usable_battery_level ?? nominalPct ?? 0;
  const ring = $('batteryRing');
  ring.style.setProperty('--pct', pct);
  const color = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--amber)' : 'var(--red)';
  ring.style.setProperty('--ring-color', color);
  $('batteryPct').textContent = pct;
  const nomEl = $('batteryNominal');
  if (nomEl) nomEl.textContent = nominalPct != null && nominalPct !== pct ? `标称 ${nominalPct}%` : '';

  // 顶部统计
  $('range').textContent = dist(cs.battery_range ?? cs.ideal_battery_range);

  const chargingMap = {
    Charging: ['充电中', 'ok'],
    Complete: ['已充满', 'ok'],
    Stopped: ['已停止', 'warn'],
    Disconnected: ['未连接', 'off'],
    NoPower: ['无电源', 'bad'],
    Starting: ['启动中', 'warn'],
  };
  const [cLabel, cKind] = chargingMap[cs.charging_state] || [cs.charging_state || '—', null];
  setText('chargeState', cLabel, cKind);

  $('odometer').textContent = dist(vs.odometer, 0);
  $('insideTemp').textContent = temp(hs.inside_temp);

  // ---- 充电卡片 ----
  setText('c_state', cLabel, cKind);
  setText(
    'c_power',
    cs.charger_power ? `${fmtNum(cs.charger_power, 1)} kW` : '0 kW',
    cs.charger_power > 0 ? 'ok' : 'off'
  );
  // 车没在充电时 API 仍会返回 charger_voltage=2 这种垃圾值，只在有功率时才显示
  setText(
    'c_vi',
    cs.charger_power > 0 && cs.charger_voltage
      ? `${fmtNum(cs.charger_voltage, 0)} V / ${fmtNum(cs.charger_actual_current, 0)} A`
      : '—'
  );
  setText('c_limit', cs.charge_limit_soc != null ? `${cs.charge_limit_soc} %` : '—');
  setText('c_added', cs.charge_energy_added ? `${fmtNum(cs.charge_energy_added, 2)} kWh` : '—');
  setText(
    'c_eta',
    cs.time_to_full_charge ? `${fmtNum(cs.time_to_full_charge, 1)} 小时` : '—'
  );
  setText('c_port', yesNo(cs.charge_port_door_open, '已打开', '关闭') + (cs.charge_port_latch ? ` / ${cs.charge_port_latch}` : ''));
  setText(
    'c_fast',
    cs.fast_charger_present ? `是${cs.fast_charger_type ? ` (${cs.fast_charger_type})` : ''}` : '否',
    cs.fast_charger_present ? 'ok' : 'off'
  );

  // ---- 空调卡片 ----
  setText('h_on', yesNo(hs.is_climate_on, '开启', '关闭'), hs.is_climate_on ? 'ok' : 'off');
  setText(
    'h_set',
    hs.driver_temp_setting != null
      ? `${temp(hs.driver_temp_setting)}${hs.passenger_temp_setting != null && hs.passenger_temp_setting !== hs.driver_temp_setting ? ` / 副驾 ${temp(hs.passenger_temp_setting)}` : ''}`
      : '—'
  );
  setText('h_temps', `${temp(hs.inside_temp)} / ${temp(hs.outside_temp)}`);
  setText('h_fan', hs.fan_status != null ? String(hs.fan_status) : '—');
  setText(
    'h_seat',
    `${fmtNum(hs.seat_heater_left ?? 0)} / ${fmtNum(hs.seat_heater_right ?? 0)}`
  );
  setText('h_wheel', yesNo(hs.steering_wheel_heater, '开', '关'), hs.steering_wheel_heater ? 'ok' : 'off');
  setText(
    'h_defrost',
    `${yesNo(hs.is_front_defroster_on, '前 开', '前 关')} / ${yesNo(hs.is_rear_defroster_on, '后 开', '后 关')}`
  );
  setText('h_pre', yesNo(hs.is_preconditioning, '是', '否'));

  // ---- 车辆状态卡片 ----
  setText('v_locked', yesNo(vs.locked, '已锁', '未锁'), vs.locked ? 'ok' : 'bad');
  // Tesla 字段：df 前左 / pf 前右 / dr 后左 / pr 后右；ft 前备箱 / rt 后备箱
  const door = (x) => (x === 0 ? '关' : x === 1 ? '开' : '—');
  // 紧凑成「前 关关 · 后 关关」，避免中文长标签把数值挤到下一行
  setText('v_doors', `前 ${door(vs.df)}${door(vs.pf)} · 后 ${door(vs.dr)}${door(vs.pr)}`);
  setText('v_trunks', `${door(vs.ft)} / ${door(vs.rt)}`);
  setText('v_sentry', yesNo(vs.sentry_mode, '开', '关'), vs.sentry_mode ? 'warn' : 'off');
  setText('v_valet', yesNo(vs.valet_mode, '开', '关'));
  setText('v_remote', yesNo(vs.remote_start, '开', '关'));
  setText('v_fw', vs.car_version || '—');
  const CAR_NAMES = { model3: 'Model 3', modely: 'Model Y', models: 'Model S', modelx: 'Model X', cybertruck: 'Cybertruck' };
  const cfgBits = [
    CAR_NAMES[cfg.car_type] || cfg.car_type,
    cfg.exterior_color,
    cfg.has_air_suspension ? '空气悬挂' : null,
  ].filter(Boolean).join(' · ');
  setText('v_config', cfgBits || '—');

  // 胎压（bar）
  const tp = (v) => (v == null ? '—' : Number(v).toFixed(2));
  setText('v_tpms', `${tp(vs.tpms_pressure_fl)}/${tp(vs.tpms_pressure_fr)} / ${tp(vs.tpms_pressure_rl)}/${tp(vs.tpms_pressure_rr)}`);

  // ---- 位置卡片 ----
  const lat = ds.latitude;
  const lon = ds.longitude;
  if (lat != null && lon != null) {
    $('l_coord').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    // 国内车机上报的 native_* 是 GCJ-02（火星坐标），高德能用；
    // latitude/longitude 是 WGS-84，给 OpenStreetMap 用。混用会偏移几百米。
    const isGcj = ds.native_type === 'gcj' && ds.native_latitude != null;
    if (isGcj) {
      const glat = ds.native_latitude, glon = ds.native_longitude;
      $('mapLink').href = `https://uri.amap.com/marker?position=${glon},${glat}&name=${encodeURIComponent('车辆位置')}&src=mysite&coordinate=gaode&callnative=0`;
      $('mapLink').textContent = '在高德地图中打开 →';
    } else {
      $('mapLink').href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
      $('mapLink').textContent = '在地图中打开 →';
    }
    show($('mapLink'), true);
  } else {
    $('l_coord').textContent = '车机未上报';
    show($('mapLink'), false);
  }
  $('l_heading').textContent = ds.heading != null ? `${ds.heading}°` : '—';

  const gpsTs = ds.gps_as_of;
  $('l_gps').textContent = gpsTs
    ? new Date(gpsTs * 1000).toLocaleString('zh-CN', { hour12: false })
    : '—';

  const ageSecs = gpsTs ? Date.now() / 1000 - gpsTs : null;
  if (ageSecs == null) {
    setText('l_age', '—');
  } else if (ageSecs < 120) {
    setText('l_age', `实时 · ${ago(gpsTs)}`, 'ok');
  } else if (ageSecs < 1800) {
    setText('l_age', `较旧 · ${ago(gpsTs)}`, 'warn');
  } else {
    setText('l_age', `陈旧 · ${ago(gpsTs)}`, 'bad');
  }

  // ---- 充电：电流 & 限值范围 ----
  setText(
    'c_amps',
    cs.charge_current_request_max != null
      ? `${cs.charge_amps ?? cs.charge_current_request ?? '—'} / ${cs.charge_current_request_max} A`
      : '—'
  );
  setText(
    'c_limit_range',
    cs.charge_limit_soc_min != null
      ? `${cs.charge_limit_soc_min}–${cs.charge_limit_soc_max}%（标准 ${cs.charge_limit_soc_std}%）`
      : '—'
  );

  // ---- 空调：座椅通风 / 座舱保护 / 保持模式 / 电池加热 ----
  if (cfg.has_seat_cooling || hs.seat_fan_front_left != null) {
    setText('h_fan_seat', `${fmtNum(hs.seat_fan_front_left ?? 0)} / ${fmtNum(hs.seat_fan_front_right ?? 0)}`);
  } else {
    setText('h_fan_seat', '不支持', 'off');
  }
  setText(
    'h_cop',
    hs.cabin_overheat_protection
      ? `${hs.cabin_overheat_protection}${hs.cabin_overheat_protection_actively_cooling ? '（正在降温）' : ''}`
      : '—',
    hs.cabin_overheat_protection_actively_cooling ? 'ok' : null
  );
  setText('h_keeper', hs.climate_keeper_mode && hs.climate_keeper_mode !== 'off' ? hs.climate_keeper_mode : '关');
  setText('h_batt_heat', yesNo(hs.battery_heater, '加热中', '否'), hs.battery_heater ? 'warn' : 'off');

  // 控制面板：首次用车辆当前设定温度初始化
  if (!tempInited && hs.driver_temp_setting != null) {
    ctrl.temp = Number(hs.driver_temp_setting);
    tempInited = true;
    if (typeof renderTemp === 'function') renderTemp();
  }

  // ---- 车辆状态：车窗 / 档位 / 胎压推荐 / 驾驶辅助 ----
  const win = (x) => (x == null ? '—' : x === 0 ? '关' : '开');
  setText(
    'v_windows',
    `${win(vs.fd_window)}${win(vs.fp_window)} · ${win(vs.rd_window)}${win(vs.rp_window)}`
  );
  const SHIFT = { P: 'P 驻车', R: 'R 倒车', N: 'N 空挡', D: 'D 前进' };
  setText('v_shift', ds.shift_state ? (SHIFT[ds.shift_state] || ds.shift_state) : '—');
  setText(
    'v_tpms_rec',
    vs.tpms_rcp_front_value != null
      ? `${vs.tpms_rcp_front_value} / ${vs.tpms_rcp_rear_value} bar`
      : '—'
  );
  setText('v_ap', cfg.driver_assist || '—');

  // ---- 影音与记录 ----
  const mi = vs.media_info || {};
  setText('m_title', mi.now_playing_title || '—', mi.now_playing_title ? null : 'off');
  setText('m_artist', mi.now_playing_artist || '—');
  setText('m_source', mi.now_playing_source || '—');
  setText(
    'm_status',
    mi.media_playback_status === 'Playing' ? '播放中'
      : mi.media_playback_status === 'Paused' ? '已暂停'
      : (mi.media_playback_status || '—'),
    mi.media_playback_status === 'Playing' ? 'ok' : 'off'
  );
  setText('m_volume', mi.audio_volume != null ? Number(mi.audio_volume).toFixed(1) : '—');
  setText(
    'm_dashcam',
    vs.dashcam_state || '—',
    vs.dashcam_state === 'Recording' ? 'ok' : null
  );
  setText('m_dashcam_save', yesNo(vs.dashcam_clip_save_available, '可保存', '不可'));

  // ---- 系统与预约 ----
  const su = vs.software_update || {};
  setText(
    's_ota',
    su.status || '无待更新',
    su.status && su.status !== 'available' ? 'warn' : 'off'
  );
  setText('s_ota_ver', su.version ? String(su.version).trim() : '—');
  setText(
    's_ota_prog',
    (su.download_perc != null || su.install_perc != null)
      ? `${su.download_perc ?? 0}% / ${su.install_perc ?? 0}%`
      : '—'
  );
  const slm = vs.speed_limit_mode || {};
  setText(
    's_speed_limit',
    slm.active ? `启用中 · 限 ${Math.round((slm.current_limit_mph ?? 0) * MI_TO_KM)} km/h` : '未启用',
    slm.active ? 'warn' : 'off'
  );
  setText(
    's_sched_charge',
    cs.scheduled_charging_mode && cs.scheduled_charging_mode !== 'Off'
      ? `${cs.scheduled_charging_mode}${cs.scheduled_charging_start_time ? ' · ' + new Date(cs.scheduled_charging_start_time * 1000).toLocaleString('zh-CN', { hour12: false }) : ''}`
      : '关'
  );
  setText('s_sched_pre', cs.preconditioning_times || '—');
  setText('s_service', vs.service_mode_plus ? '增强' : vs.service_mode ? '开启' : '关', vs.service_mode ? 'bad' : 'off');

  // ---- 趋势图 ----
  pushHistory(pct);
  drawSpark();

  // 页脚
  $('lastUpdated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

/* ------------------------------ 趋势图 ------------------------------ */
function pushHistory(pct) {
  const last = state.history[state.history.length - 1];
  // 同一秒内重复渲染就去重
  if (last && Math.abs(last.t - Date.now()) < 400) {
    last.v = pct;
    return;
  }
  state.history.push({ t: Date.now(), v: pct });
  if (state.history.length > 200) state.history.shift();
}

function drawSpark() {
  const h = state.history;
  const line = $('sparkLine');
  const area = $('sparkArea');
  if (h.length < 2) {
    line.setAttribute('d', '');
    area.setAttribute('d', '');
    $('sparkRange').textContent = '采集中…';
    return;
  }
  const W = 300, H = 60, PAD = 4;
  const vals = h.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;

  const x = (i) => (i / (h.length - 1)) * W;
  // 所有采样都相同时画在垂直居中，否则会贴着底边像一条 bug
  const y = (v) => (span === 0 ? H / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2));

  const pts = h.map((p, i) => `${x(i).toFixed(2)},${y(p.v).toFixed(2)}`);
  line.setAttribute('d', 'M' + pts.join(' L'));
  area.setAttribute('d', span === 0 ? '' : `M0,${H} L` + pts.join(' L') + ` L${W},${H} Z`);

  $('sparkRange').textContent =
    span === 0 ? `${min}% 持平 · ${h.length} 个采样` : `${min}% → ${max}% · ${h.length} 个采样`;
}

/* ------------------------------ 数据加载 ------------------------------ */
async function loadStatus() {
  const s = await api('/api/status');
  state.mode = s.mode;

  if (s.mode === 'demo') {
    setBadge('DEMO · 假数据', 'badge-demo');
    $('tokenInfo').hidden = true;
    // tokenInfo 紧跟它的那个 "·" 分隔点也一起去掉
    const dot = $('tokenInfo').previousElementSibling;
    if (dot && dot.classList.contains('dot')) dot.remove();
    return s;
  }

  setBadge(s.region.toUpperCase() + ' · Fleet API', 'badge-live');
  $('tokenInfo').textContent = s.hasToken ? `token 来源: ${s.tokenSource}` : '未授权';
  return s;
}

async function loadVehicles() {
  const data = await api('/api/vehicles');
  const list = data.response || [];
  state.vehicles = list;

  const sel = $('vehicleSelect');
  sel.innerHTML = '';
  for (const v of list) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.display_name || '未命名'}${v.state ? ` (${v.state})` : ''}`;
    sel.appendChild(opt);
  }
  if (list.length > 1) {
    show(sel, true);
  } else {
    show(sel, false);
  }

  if (!list.length) {
    throw Object.assign(new Error('账号下没有车辆'), { code: 'NO_VEHICLE' });
  }

  state.currentId = state.currentId || list[0].id;
  sel.value = state.currentId;
  return state.currentId;
}

async function loadVehicle() {
  if (!state.currentId) return;
  const data = await api(`/api/vehicle/${encodeURIComponent(state.currentId)}`);
  const v = data.response;
  if (!v) throw new Error('返回数据里没有 response 字段');

  clearError();
  showGate(false);
  state.hasVehicle = true;
  applyTab();

  if (data._demo) {
    // demo 模式下每次刷新微调车辆名，提醒这是假数据
    setBadge('DEMO · 假数据', 'badge-demo');
  }

  renderVehicle(v);

  // 车在睡觉时给个提示
  const st = (v.state || '').toLowerCase();
  if (st === 'asleep' || st === 'offline') {
    showError(
      '车辆处于休眠状态',
      '车机没上报数据，下面显示的是最后一次缓存值。点击「刷新」会自动尝试唤醒（很耗电，别频繁点）。'
    );
  }
}

/* ------------------------------ 轮询控制 ------------------------------ */
function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
function startPolling() {
  stopPolling();
  if (!$('autoRefresh').checked) return;
  state.timer = setInterval(() => {
    refresh(true).catch(() => {});
  }, POLL_MS);
}

async function refresh(silent = false) {
  const btn = $('refreshBtn');
  if (!silent) btn.disabled = true;
  try {
    await loadVehicles();
    // 车辆列表拿到了就算「有车」，即使接下来 vehicle_data 因为休眠失败，
    // 历史标签页也必须能打开（数据在本地库里，不依赖车在线）
    state.hasVehicle = true;
    showGate(false);
    applyTab();

    // 车不在线就别白调 vehicle_data（必然 408），改成提示 + 显示唤醒按钮
    const v0 = state.vehicles[0];
    const asleep = v0 && v0.state !== 'online';
    show($('wakeBtn'), !!asleep);
    if (asleep) {
      setBadge(v0.state === 'asleep' ? '休眠中' : '离线', 'badge-muted');
      showError(
        '车辆处于休眠',
        `车机当前状态：${v0.state}。需要实时数据请点右上角「唤醒车辆」（会耗一点电，别频繁点）。`
      );
      return;
    }
    await loadVehicle();
    if (state.mode !== 'demo') setBadge('LIVE · Fleet API', 'badge-live');
  } catch (e) {
    if (e.code === 'NO_TOKEN') {
      showGate(true);
      setBadge('未授权', 'badge-muted');
    } else if (e.code === 'NO_VEHICLE') {
      showError('没有可用车辆', '账号下没有关联车辆，或车辆未完成授权配对。');
    } else {
      setBadge('错误', 'badge-err');
      showError('刷新失败', e.message);
    }
  } finally {
    if (!silent) btn.disabled = false;
    $('lastUpdated').textContent =
      state.mode === 'demo'
        ? `假数据 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        : $('lastUpdated').textContent;
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
$('refreshBtn').addEventListener('click', () => refresh());

$('autoRefresh').addEventListener('change', () => {
  startPolling();
  localStorage.setItem('td.auto', $('autoRefresh').checked ? '1' : '0');
});

$('vehicleSelect').addEventListener('change', (e) => {
  state.currentId = e.target.value;
  loadVehicle().catch((err) => showError('切换车辆失败', err.message));
});

// 单位切换
const unitsBtn = document.createElement('button');
unitsBtn.className = 'btn';
unitsBtn.id = 'unitsBtn';
unitsBtn.title = '切换 km / mi';
function syncUnitsBtn() {
  unitsBtn.textContent = state.units === 'km' ? 'km' : 'mi';
}
unitsBtn.addEventListener('click', () => {
  state.units = state.units === 'km' ? 'mi' : 'km';
  localStorage.setItem('td.units', state.units);
  syncUnitsBtn();
  if (state.vehicles.length) refresh(true).catch(() => {});
});
syncUnitsBtn();
$('refreshBtn').parentElement.insertBefore(unitsBtn, $('refreshBtn'));

/* ------------------------------ 启动 ------------------------------ */
(async function init() {
  if (localStorage.getItem('td.auto') === '0') $('autoRefresh').checked = false;

  try {
    const s = await loadStatus();

    if (s.mode === 'fleet' && !s.hasToken) {
      showGate(true);
      if (s.canOAuth) {
        $('loginLink').href = '/auth/login';
        $('loginLink').textContent = '用特斯拉账号登录 →';
        show($('loginLink'), true);
        $('gateHint').textContent = `OAuth 回调地址：${s.redirectUri}`;
        show($('pasteTokenBtn'), true);
        $('pasteTokenBtn').addEventListener('click', () => {
          show($('pasteBox'), true);
        });
      } else {
        // 还没填 client_id / client_secret —— 登录按钮点了也是 400，直接引导去注册
        $('loginLink').textContent = '去 developer.tesla.com 建应用 →';
        $('loginLink').href = 'https://developer.tesla.com';
        $('loginLink').target = '_blank';
        $('loginLink').rel = 'noopener';
        show($('loginLink'), true);
        show($('pasteTokenBtn'), false);
        $('gateHint').innerHTML =
          '还差 <code>TESLA_CLIENT_ID</code> 和 <code>TESLA_CLIENT_SECRET</code>。<br>' +
          '建好应用后填进 <code>.env</code>，重启服务即可。' +
          `<br><br>回调地址请填：<code>${s.redirectUri}</code>`;
      }
      setBadge('未授权', 'badge-muted');
      return;
    }

    await refresh();
    startPolling();
  } catch (e) {
    setBadge('错误', 'badge-err');
    showError('启动失败', e.message);
  }
})();

/* ======================= 历史视图 ======================= */

const pad2 = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDur(sec) {
  if (sec == null || sec < 0) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

const kmOrMi = (mi, digits = 1) =>
  mi == null ? '—'
    : state.units === 'km'
      ? `${(mi * MI_TO_KM).toFixed(digits)} km`
      : `${mi.toFixed(digits)} mi`;

const mphOrKph = (mph) =>
  mph == null ? '—'
    : state.units === 'km'
      ? `${Math.round(mph * MI_TO_KM)} km/h`
      : `${Math.round(mph)} mph`;

/* ---------- 汇总卡 ---------- */
function renderStats(s) {
  const box = $('histStats');
  if (!s) { box.innerHTML = ''; return; }
  const cards = [
    { k: '累计里程', v: kmOrMi(s.distance_mi, 0), sub: `${s.trips} 次行程` },
    { k: '今日里程', v: kmOrMi(s.today_distance_mi, 0), sub: `${s.today_trips} 次行程` },
    { k: '累计充入', v: `${(s.energy_kwh || 0).toFixed(1)}<small>kWh</small>`, sub: `${s.charging} 次充电` },
    { k: '采样点', v: `${s.samples}`, sub: `行程 ${s.trips} · 充电 ${s.charging}` },
  ];
  box.innerHTML = cards
    .map((c) => `<div class="stat-card"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="sub">${c.sub}</div></div>`)
    .join('');
}

/* ---------- 电量曲线 ---------- */
function renderChart(series, hours) {
  const svg = $('batChart');
  const empty = $('chartEmpty');
  const pts = (series && series.items) || [];

  if (pts.length < 2) {
    svg.innerHTML = '';
    show(empty, true);
    return;
  }
  show(empty, false);

  const W = 800, H = 200, PL = 34, PR = 10, PT = 12, PB = 22;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);

  const bats = pts.map((p) => p.battery).filter((v) => v != null);
  let lo = Math.min(...bats), hi = Math.max(...bats);
  if (hi - lo < 5) { const c = (hi + lo) / 2; lo = c - 3; hi = c + 3; }
  lo = Math.max(0, Math.floor(lo - 2));
  hi = Math.min(100, Math.ceil(hi + 2));

  const x = (ts) => PL + ((ts - t0) / span) * (W - PL - PR);
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.battery).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${H - PB} L${x(t0).toFixed(1)},${H - PB} Z`;

  // 网格 + 刻度
  const gridLines = [];
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const yy = y(v);
    gridLines.push(
      `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" stroke="#222831" stroke-width="1"/>` +
      `<text x="${PL - 7}" y="${(yy + 3.5).toFixed(1)}" fill="#5d646f" font-size="10" text-anchor="end">${Math.round(v)}%</text>`
    );
  }

  const fmtAxis = (ts) => {
    const d = new Date(ts * 1000);
    return hours <= 24
      ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };

  svg.innerHTML = `
    <defs>
      <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3ddc84" stop-opacity=".30"/>
        <stop offset="100%" stop-color="#3ddc84" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines.join('')}
    <path d="${area}" fill="url(#bg1)"/>
    <path d="${line}" fill="none" stroke="#3ddc84" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(t1).toFixed(1)}" cy="${y(pts[pts.length - 1].battery).toFixed(1)}" r="3.5" fill="#3ddc84"/>
    <text x="${PL}" y="${H - 5}" fill="#5d646f" font-size="10">${fmtAxis(t0)}</text>
    <text x="${W - PR}" y="${H - 5}" fill="#5d646f" font-size="10" text-anchor="end">${fmtAxis(t1)}</text>
  `;
}

/* ---------- 行程表 ---------- */
function renderTrips(items) {
  const box = $('tripList');
  if (!items || !items.length) {
    box.innerHTML = `<p class="empty-row">还没有行程记录<br><span class="muted tiny">开车跑一趟，停车 5 分钟后就会自动生成</span></p>`;
    return;
  }
  const rows = items.map((t) => {
    const dur = t.end_ts - t.start_ts;
    const db = t.start_battery != null && t.end_battery != null ? t.start_battery - t.end_battery : null;
    return `<tr data-trip-id="${t.id}">
      <td>${fmtTime(t.start_ts)}</td>
      <td class="num">${kmOrMi(t.distance_mi)}</td>
      <td class="num">${fmtDur(dur)}</td>
      <td class="num">${db != null ? `−${db}%` : '—'}</td>
      <td class="num">${mphOrKph(t.max_speed)}</td>
      <td class="dim">${t.start_battery ?? '—'}→${t.end_battery ?? '—'}%</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="dt"><thead><tr>
    <th>开始</th><th class="num">里程</th><th class="num">时长</th>
    <th class="num">耗电</th><th class="num">最高速</th><th>电量</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- 充电表 ---------- */
function renderCharging(items) {
  const box = $('chargeList');
  if (!items || !items.length) {
    box.innerHTML = `<p class="empty-row">还没有充电记录<br><span class="muted tiny">插枪充一次电，结束后会自动生成</span></p>`;
    return;
  }
  const rows = items.map((c) => {
    const dur = c.end_ts - c.start_ts;
    const db = c.start_battery != null && c.end_battery != null ? c.end_battery - c.start_battery : null;
    return `<tr data-charge-id="${c.id}">
      <td>${fmtTime(c.start_ts)}</td>
      <td class="num">${c.energy_added != null ? c.energy_added.toFixed(2) : '—'}</td>
      <td class="num">${c.peak_power != null ? c.peak_power.toFixed(1) : '—'}</td>
      <td class="num">${fmtDur(dur)}</td>
      <td class="num">${db != null ? `+${db}%` : '—'}</td>
      <td class="dim">${c.charge_limit ?? '—'}%</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="dt"><thead><tr>
    <th>开始</th><th class="num">充入 kWh</th><th class="num">峰值 kW</th>
    <th class="num">时长</th><th class="num">电量</th><th>限值</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- 数据加载 ---------- */
async function loadHistory(silent = false) {
  try {
    const [stats, series, trips, charging] = await Promise.all([
      api('/api/stats'),
      api(`/api/series?hours=${state.chartHours}`),
      api('/api/trips?limit=50'),
      api('/api/charging?limit=50'),
    ]);
    state.hist = { stats, series, trips: trips.items || [], charging: charging.items || [] };
    renderStats(stats);
    renderChart(series, state.chartHours);
    renderTrips(state.hist.trips);
    renderCharging(state.hist.charging);
  } catch (e) {
    if (!silent) showError('历史数据加载失败', e.message);
  }
}

/* ---------- 采集器状态徽章 ---------- */
async function refreshRecBadge() {
  try {
    const r = await api('/api/recorder');
    const b = $('recBadge');
    if (!r.running) {
      b.textContent = '采集未运行';
      b.className = 'rec-badge';
      return;
    }
    if (r.lastError) {
      b.textContent = '采集异常';
      b.className = 'rec-badge is-err';
      b.title = r.lastError;
      return;
    }
    if (r.vehicleState && r.vehicleState !== 'online') {
      b.textContent = `车${r.vehicleState === 'asleep' ? '休眠' : '离线'} · 暂停采集`;
      b.className = 'rec-badge is-sleep';
      return;
    }
    const age = r.lastSampleTs ? Math.round(Date.now() / 1000 - r.lastSampleTs) : null;
    b.textContent = age != null ? `采集中 · ${age < 90 ? age + 's' : Math.round(age / 60) + 'm'}前` : '采集中';
    b.className = 'rec-badge is-on';
  } catch {
    /* 忽略 */
  }
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    applyTab();
    if (state.tab === 'history') loadHistory();
  });
});

document.querySelectorAll('[data-hours]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-hours]').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.chartHours = Number(btn.dataset.hours);
    loadHistory(true);
  });
});

setInterval(refreshRecBadge, 15000);
refreshRecBadge();

// 单位切换后刷新历史视图
unitsBtn.addEventListener('click', () => {
  if (state.tab === 'history') setTimeout(() => loadHistory(true), 50);
});

/* ======================= 详情弹窗（行程 / 充电） ======================= */

// 地图瓦片：默认 OpenStreetMap（WGS-84 坐标，与 drive_state.latitude 一致）
// 想换高德瓦片的话，需要把坐标转成 GCJ-02，见 README
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
let modalMap = null;
let modalMapReady = false;

function showModal(title) {
  $('modalTitle').textContent = title;
  show($('modal'), true);
}
function closeModal() {
  show($('modal'), false);
}

/* ---------- 通用折线图（弹窗里用） ---------- */
function drawSeriesChart(svg, pts, opts) {
  const { xKey, yKey, unit = '', color = '#5b9cf6', minOverride, maxOverride } = opts;
  const valid = pts.filter((p) => p[xKey] != null && p[yKey] != null);
  if (valid.length < 2) {
    svg.innerHTML = '';
    return false;
  }
  const W = 800, H = 180, PL = 44, PR = 12, PT = 12, PB = 24;
  const xs = valid.map((p) => p[xKey]);
  const ys = valid.map((p) => p[yKey]);
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const span = Math.max(1, t1 - t0);

  let lo = minOverride != null ? minOverride : Math.min(...ys);
  let hi = maxOverride != null ? maxOverride : Math.max(...ys);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  // 明确给了下限（速度/功率 ≥ 0）就不要因留白出现负数刻度
  if (minOverride != null && lo < minOverride) lo = minOverride;
  if (maxOverride != null && hi > maxOverride) hi = maxOverride;

  const x = (v) => PL + ((v - t0) / span) * (W - PL - PR);
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

  const line = valid.map((p, i) => `${i ? 'L' : 'M'}${x(p[xKey]).toFixed(1)},${y(p[yKey]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${H - PB} L${x(t0).toFixed(1)},${H - PB} Z`;

  const grid = [];
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const yy = y(v);
    grid.push(
      `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" stroke="#222831"/>` +
      `<text x="${PL - 7}" y="${(yy + 3.5).toFixed(1)}" fill="#5d646f" font-size="10" text-anchor="end">${Math.round(v)}</text>`
    );
  }
  const fa = (ts) => {
    const d = new Date(ts * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  svg.innerHTML = `
    <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid.join('')}
    <path d="${area}" fill="url(#mg)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${PL}" y="${H - 6}" fill="#5d646f" font-size="10">${fa(t0)}</text>
    <text x="${W - PR}" y="${H - 6}" fill="#5d646f" font-size="10" text-anchor="end">${fa(t1)}</text>
    <text x="${W - PR}" y="${PT + 12}" fill="#5d646f" font-size="10" text-anchor="end">${unit}</text>
  `;
  return true;
}

/* ---------- 轨迹地图 ---------- */
function renderTrackMap(track) {
  const pts = track.filter((p) => p.lat != null && p.lon != null);
  if (pts.length < 2) {
    show($('modalMapWrap'), false);
    return;
  }
  show($('modalMapWrap'), true);

  if (!modalMapReady) {
    modalMap = L.map('modalMap', { scrollWheelZoom: true, zoomControl: true });
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(modalMap);
    modalMapReady = true;
  }

  // 清掉上一次的线/点
  modalMap.eachLayer((l) => {
    if (l instanceof L.Polyline || l instanceof L.CircleMarker || l instanceof L.Marker) {
      modalMap.removeLayer(l);
    }
  });

  const latlngs = pts.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: '#3ddc84', weight: 4, opacity: 0.92, lineCap: 'round' }).addTo(modalMap);

  const dot = (ll, color, label) =>
    L.circleMarker(ll, {
      radius: 7, color: '#0b0d10', weight: 2, fillColor: color, fillOpacity: 1,
    }).addTo(modalMap).bindTooltip(label, { direction: 'top', offset: [0, -8] });

  dot(latlngs[0], '#5b9cf6', '起点');
  dot(latlngs[latlngs.length - 1], '#f24e4e', '终点');

  modalMap.fitBounds(latlngs, { padding: [26, 26] });
  setTimeout(() => modalMap.invalidateSize(), 60);
}

/* ---------- 行程详情 ---------- */
async function openTripDetail(id) {
  showModal('行程详情');
  $('modalStats').innerHTML = '<p class="muted small">加载中…</p>';
  show($('modalMapWrap'), false);
  show($('modalChartWrap'), false);
  show($('modalEmpty'), false);

  try {
    const { trip: t, track } = await api(`/api/trips/${id}`);
    const dur = t.end_ts - t.start_ts;
    const db = t.start_battery != null && t.end_battery != null ? t.start_battery - t.end_battery : null;
    // 能耗估算：电量差 × 可用容量。Model Y 按 75 kWh 粗估
    const capGuess = 75;
    const kwh = db != null ? (db / 100) * capGuess : null;
    const per100 = kwh != null && t.distance_mi ? (kwh / (t.distance_mi * MI_TO_KM)) * 100 : null;

    const stats = [
      ['开始', fmtTime(t.start_ts)],
      ['时长', fmtDur(dur)],
      ['里程', kmOrMi(t.distance_mi)],
      ['耗电', db != null ? `−${db}%` : '—'],
      ['均速', mphOrKph(t.avg_speed)],
      ['最高速', mphOrKph(t.max_speed)],
      ['估算能耗', kwh != null ? `${kwh.toFixed(1)} kWh` : '—'],
      ['百公里', per100 != null ? `${per100.toFixed(1)} kWh` : '—'],
      ['估算依据', `按 ${capGuess} kWh 电池`],
    ];
    $('modalStats').innerHTML = stats
      .map(([k, v]) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');

    if (!track || track.length < 2) {
      show($('modalEmpty'), true);
      show($('modalMapWrap'), false);
      show($('modalChartWrap'), false);
      return;
    }

    renderTrackMap(track);

    show($('modalChartWrap'), true);
    // 库里 speed 存的是 mph（特斯拉 API 原生单位），显示前换算，避免「标 km/h 画 mph」
    const km = state.units === 'km';
    const speedPts = track.map((p) => ({
      ts: p.ts,
      v: p.speed == null ? null : (km ? p.speed * MI_TO_KM : p.speed),
    }));
    $('modalChartTitle').textContent = '车速曲线';
    $('modalChartHint').textContent = `${track.length} 个采样点`;
    drawSeriesChart($('modalChart'), speedPts, {
      xKey: 'ts', yKey: 'v', unit: km ? 'km/h' : 'mph', color: '#5b9cf6', minOverride: 0,
    });
  } catch (e) {
    $('modalStats').innerHTML = `<p class="muted small">加载失败：${e.message}</p>`;
  }
}

/* ---------- 充电详情 ---------- */
async function openChargingDetail(id) {
  showModal('充电详情');
  $('modalStats').innerHTML = '<p class="muted small">加载中…</p>';
  show($('modalMapWrap'), false);
  show($('modalChartWrap'), false);
  show($('modalEmpty'), false);

  try {
    const { session: c, curve } = await api(`/api/charging/${id}`);
    const dur = c.end_ts - c.start_ts;
    const db = c.start_battery != null && c.end_battery != null ? c.end_battery - c.start_battery : null;
    const stats = [
      ['开始', fmtTime(c.start_ts)],
      ['时长', fmtDur(dur)],
      ['充入', c.energy_added != null ? `${c.energy_added.toFixed(2)} kWh` : '—'],
      ['峰值功率', c.peak_power != null ? `${c.peak_power.toFixed(1)} kW` : '—'],
      ['电量', db != null ? `+${db}%` : '—'],
      ['充电限值', c.charge_limit != null ? `${c.charge_limit}%` : '—'],
      ['平均功率', c.energy_added != null && dur > 0 ? `${(c.energy_added / (dur / 3600)).toFixed(1)} kW` : '—'],
    ];
    $('modalStats').innerHTML = stats
      .map(([k, v]) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');

    if (!curve || curve.length < 2) {
      show($('modalEmpty'), true);
      return;
    }
    show($('modalChartWrap'), true);
    $('modalChartTitle').textContent = '充电功率曲线';
    $('modalChartHint').textContent = `${curve.length} 个采样点`;
    drawSeriesChart($('modalChart'), curve, {
      xKey: 'ts', yKey: 'charger_power', unit: 'kW', color: '#3ddc84', minOverride: 0,
    });
  } catch (e) {
    $('modalStats').innerHTML = `<p class="muted small">加载失败：${e.message}</p>`;
  }
}

/* ---------- 事件绑定 ---------- */
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// 事件委托：点行程/充电行打开详情
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-trip-id]');
  if (tr) return openTripDetail(Number(tr.dataset.tripId));
  const cr = e.target.closest('tr[data-charge-id]');
  if (cr) return openChargingDetail(Number(cr.dataset.chargeId));
});


/* ======================= 唤醒车辆 ======================= */
$('wakeBtn').addEventListener('click', async () => {
  const btn = $('wakeBtn');
  if (btn.disabled) return;
  const id = state.currentId || (state.vehicles[0] && state.vehicles[0].id);
  if (!id) return;

  btn.disabled = true;
  btn.textContent = '唤醒中…';
  clearError();

  try {
    await api(`/api/wake/${encodeURIComponent(id)}`, { method: 'POST' });
    // 最多等 60 秒看它能不能上线
    let online = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const d = await api('/api/vehicles');
        const v = (d.response || [])[0];
        if (v && v.state === 'online') { online = true; break; }
      } catch {}
    }
    if (online) {
      await refresh();
    } else {
      showError('唤醒超时', '车还没上线。地库信号差时可能要等一两分钟，稍后再点「刷新」。');
    }
  } catch (e) {
    showError('唤醒失败', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '唤醒车辆';
  }
});

/* ======================= 远程控制 ======================= */

const ctrl = {
  enabled: false,
  busy: false,
  temp: 22,
};

function ctrlStatus(text, kind) {
  const el = $('ctrlStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ctrl-status' + (kind ? ' ' + kind : '');
}

function setCtrlBusy(on, label) {
  ctrl.busy = on;
  const card = $('ctrlCard');
  if (!card) return;
  card.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  if (on) ctrlStatus(label || '发送中…', 'busy');
}

async function sendCommand(action, payload = {}) {
  if (ctrl.busy) return;
  const id = state.currentId || (state.vehicles[0] && state.vehicles[0].id);
  setCtrlBusy(true, `发送指令：${action}…`);
  try {
    const r = await api(`/api/cmd/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    });
    const detail = (r.stdout || '').split('\n').filter(Boolean).pop() || '';
    ctrlStatus(`✓ ${action} 成功${detail ? ' · ' + detail : ''}`, 'ok');
    // 指令成功后刷新一次状态
    setTimeout(() => refresh(true).catch(() => {}), 1200);
  } catch (e) {
    if (e.data && e.data.needPairing) {
      const el = $('ctrlStatus');
      if (el) {
        el.className = 'ctrl-status err';
        el.innerHTML = '';
        const p1 = document.createElement('span');
        p1.textContent = '⚠️ 车辆还没配对虚拟密钥。到车旁边用手机打开下面链接，按提示在中控屏刷钥匙卡：';
        const a = document.createElement('a');
        a.href = 'https://tesla.com/_ak/dapper-platypus-2424c9.netlify.app?vin=' + encodeURIComponent(state.vehicles[0]?.vin || '');
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '点此配对 →';
        a.style.cssText = 'display:inline-block;margin-top:6px;color:#5b9cf6;text-decoration:underline';
        el.appendChild(p1);
        el.appendChild(document.createElement('br'));
        el.appendChild(a);
      }
    } else if (/missing scopes|unauthorized/i.test(e.message || '')) {
      const el = $('ctrlStatus');
      if (el) {
        el.className = 'ctrl-status err';
        el.innerHTML = '';
        const p1 = document.createElement('span');
        p1.textContent = '⚠️ 当前登录缺少「车辆命令」权限，需要重新授权一次：';
        const a = document.createElement('a');
        a.href = '/auth/login';
        a.textContent = '点此重新授权 →';
        a.style.cssText = 'display:inline-block;margin-top:6px;color:#5b9cf6;text-decoration:underline';
        el.appendChild(p1);
        el.appendChild(document.createElement('br'));
        el.appendChild(a);
      }
    } else {
      ctrlStatus(`✗ 失败：${e.message}`, 'err');
    }
  } finally {
    setCtrlBusy(false);
  }
}

/* 温度步进 */
function renderTemp() {
  const el = $('tempValue');
  if (el) el.textContent = `${ctrl.temp.toFixed(1)} °C`;
}

$('tempUp')?.addEventListener('click', () => {
  ctrl.temp = Math.min(28, Math.round((ctrl.temp + 0.5) * 2) / 2);
  renderTemp();
});
$('tempDown')?.addEventListener('click', () => {
  ctrl.temp = Math.max(15, Math.round((ctrl.temp - 0.5) * 2) / 2);
  renderTemp();
});
$('tempApply')?.addEventListener('click', () => sendCommand('set-temp', { temp: ctrl.temp }));

/* 空调开/关 */
document.querySelectorAll('[data-act]').forEach((b) => {
  b.addEventListener('click', () => sendCommand(b.dataset.act));
});

/* 座椅加热 */
document.querySelectorAll('[data-seat]').forEach((row) => {
  const seat = row.dataset.seat;
  row.querySelectorAll('[data-level]').forEach((b) => {
    b.addEventListener('click', async () => {
      await sendCommand('seat-heater', { seat, level: b.dataset.level });
      row.querySelectorAll('[data-level]').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
    });
  });
});

/* 方向盘加热 */
document.querySelectorAll('[data-wheel-state]').forEach((b) => {
  b.addEventListener('click', async () => {
    await sendCommand('steering-wheel-heater', { state: b.dataset.wheelState });
    document.querySelectorAll('[data-wheel-state]').forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
  });
});

/* 根据 /api/status 决定是否显示控制卡 */
async function initControls() {
  try {
    const s = await api('/api/status');
    ctrl.enabled = !!s.commandsEnabled;
    show($('ctrlCard'), ctrl.enabled);
    if (!ctrl.enabled) {
      // 控制未开启时给出原因提示（只提示一次，不打扰）
      if (s.commandsReason === 'NEED_PASSWORD') {
        console.info('[控制] 未启用：需要先设置 APP_PASSWORD');
      } else if (s.commandsReason === 'ALLOW_COMMANDS_NOT_SET') {
        console.info('[控制] 未启用：需要在 .env 加 ALLOW_COMMANDS=1');
      }
      return;
    }
    renderTemp();
  } catch {}
}
initControls();
