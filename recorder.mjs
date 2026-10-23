/**
 * 采集器：定时轮询车辆状态 → 落库 → 切分行程 / 充电会话
 *
 * 设计要点：
 * - 车休眠时**不唤醒**（唤醒很耗电，且 Tesla 会限流），只读 /vehicles 的 state 判断
 * - 行程结束判定：连续 5 分钟没动，或车进入休眠
 * - 充电结束判定：连续 5 分钟不在充电
 * - 采样间隔默认 60 秒，可用 POLL_INTERVAL_SEC 调整
 */

const TRIP_END_GAP_SEC = 300;    // 停车 5 分钟算行程结束
const CHARGE_END_GAP_SEC = 300;  // 停止充电 5 分钟算本次充电结束
const STALE_SEC = 7200;          // 超过 2 小时没更新的开放段，强制收尾

export function createRecorder({ db, api, intervalSec = 60, retentionDays = 90, log = console.log }) {
  const state = {
    running: false,
    intervalSec,
    lastPollAt: null,
    lastSampleTs: null,
    lastError: null,
    lastVehicleState: null,
    polls: 0,
    samples: 0,
    sleeps: 0,
    errors: 0,
    trip: null,      // { start_ts, start_odo, start_battery, start_lat, start_lon, lastMoveTs, maxSpeed, speedSum, movingSamples, end_odo, end_battery, end_lat, end_lon }
    charging: null,  // { start_ts, start_battery, start_energy, start_range, lastChargingTs, peakPower, chargeLimit, samples }
  };

  let timer = null;
  let prunedAt = 0;

  const isMoving = (d) => {
    const sp = d.speed ?? 0;
    const sh = d.shift_state;
    return sp > 0 || sh === 'D' || sh === 'R';
  };

  function closeTrip(ts) {
    const t = state.trip;
    if (!t) return;
    const durationSec = Math.max(1, (ts - t.start_ts));
    const avgMph = t.movingSamples > 0 ? t.speedSum / t.movingSamples : null;
    db.insertTrip({
      start_ts: t.start_ts,
      end_ts: ts,
      start_odo: t.start_odo,
      end_odo: t.end_odo,
      distance_mi: t.start_odo != null && t.end_odo != null ? Math.max(0, t.end_odo - t.start_odo) : null,
      start_battery: t.start_battery,
      end_battery: t.end_battery,
      start_lat: t.start_lat,
      start_lon: t.start_lon,
      end_lat: t.end_lat,
      end_lon: t.end_lon,
      max_speed: t.maxSpeed,
      avg_speed: avgMph,
      samples: t.samples,
    });
    const distMi = (t.start_odo != null && t.end_odo != null) ? (t.end_odo - t.start_odo) : 0;
    log(`[行程] 结束 · ${(distMi * 1.609344).toFixed(1)} km · ${Math.round(durationSec / 60)} 分钟 · 电量 ${t.start_battery}%→${t.end_battery}%`);
    state.trip = null;
  }

  function closeCharging(ts) {
    const c = state.charging;
    if (!c) return;
    const added = (c.end_energy != null && c.start_energy != null)
      ? Math.max(0, c.end_energy - c.start_energy)
      : null;
    db.insertCharging({
      start_ts: c.start_ts,
      end_ts: ts,
      start_battery: c.start_battery,
      end_battery: c.end_battery,
      start_energy: c.start_energy,
      end_energy: c.end_energy,
      energy_added: added,
      peak_power: c.peakPower,
      charge_limit: c.chargeLimit,
      start_range_mi: c.start_range,
      end_range_mi: c.end_range,
      lat: c.lat,
      lon: c.lon,
      samples: c.samples,
    });
    log(`[充电] 结束 · +${(added ?? 0).toFixed(2)} kWh · 峰值 ${c.peakPower ?? 0} kW · 电量 ${c.start_battery}%→${c.end_battery}%`);
    state.charging = null;
  }

  function handleSample(d) {
    const ts = d._ts ?? Math.floor(Date.now() / 1000);
    const cs = d.charge_state || {};
    const ds = d.drive_state || {};
    const hs = d.climate_state || {};
    const vs = d.vehicle_state || {};
    const moving = isMoving(ds);
    // 电量统一用「可用电量」，与特斯拉 App / 车机口径一致
    const batt = cs.usable_battery_level ?? cs.battery_level;

    // ---------- 落库 ----------
    db.insertSample({
      ts,
      state: d.state,
      speed: ds.speed,
      power: ds.power,
      shift_state: ds.shift_state,
      moving: moving ? 1 : 0,
      lat: ds.latitude,
      lon: ds.longitude,
      heading: ds.heading,
      battery: cs.battery_level,
      usable_battery: cs.usable_battery_level,
      range_mi: cs.battery_range,
      ideal_range_mi: cs.ideal_battery_range,
      est_range_mi: cs.est_battery_range,
      charging_state: cs.charging_state,
      charger_power: cs.charger_power,
      charger_voltage: cs.charger_voltage,
      charger_current: cs.charger_actual_current,
      energy_added: cs.charge_energy_added,
      charge_limit: cs.charge_limit_soc,
      time_to_full: cs.time_to_full_charge,
      inside_temp: hs.inside_temp,
      outside_temp: hs.outside_temp,
      climate_on: hs.is_climate_on == null ? null : (hs.is_climate_on ? 1 : 0),
      odometer: vs.odometer,
      locked: vs.locked == null ? null : (vs.locked ? 1 : 0),
      sentry: vs.sentry_mode == null ? null : (vs.sentry_mode ? 1 : 0),
      tpms_fl: vs.tpms_pressure_fl,
      tpms_fr: vs.tpms_pressure_fr,
      tpms_rl: vs.tpms_pressure_rl,
      tpms_rr: vs.tpms_pressure_rr,
      car_version: vs.car_version,
    });
    state.samples++;
    state.lastSampleTs = ts;

    // ---------- 行程切分 ----------
    if (moving) {
      if (!state.trip) {
        state.trip = {
          start_ts: ts,
          start_odo: vs.odometer,
          start_battery: batt,
          start_lat: ds.latitude,
          start_lon: ds.longitude,
          lastMoveTs: ts,
          maxSpeed: ds.speed ?? 0,
          speedSum: 0,
          movingSamples: 0,
          samples: 0,
          end_odo: vs.odometer,
          end_battery: batt,
          end_lat: ds.latitude,
          end_lon: ds.longitude,
        };
        log('[行程] 开始');
      }
      const t = state.trip;
      t.lastMoveTs = ts;
      t.samples++;
      t.movingSamples++;
      t.speedSum += ds.speed ?? 0;
      t.maxSpeed = Math.max(t.maxSpeed, ds.speed ?? 0);
      t.end_odo = vs.odometer ?? t.end_odo;
      t.end_battery = batt ?? t.end_battery;
      t.end_lat = ds.latitude ?? t.end_lat;
      t.end_lon = ds.longitude ?? t.end_lon;
    } else if (state.trip && ts - state.trip.lastMoveTs >= TRIP_END_GAP_SEC) {
      closeTrip(state.trip.lastMoveTs);
    }

    // ---------- 充电切分 ----------
    const charging = cs.charging_state === 'Charging';
    if (charging) {
      if (!state.charging) {
        state.charging = {
          start_ts: ts,
          start_battery: batt,
          start_energy: cs.charge_energy_added ?? 0,
          start_range: cs.battery_range,
          lastChargingTs: ts,
          peakPower: cs.charger_power ?? 0,
          chargeLimit: cs.charge_limit_soc,
          samples: 0,
          lat: ds.latitude,
          lon: ds.longitude,
          end_battery: batt,
          end_energy: cs.charge_energy_added ?? 0,
          end_range: cs.battery_range,
        };
        log('[充电] 开始');
      }
      const c = state.charging;
      c.lastChargingTs = ts;
      c.samples++;
      c.peakPower = Math.max(c.peakPower ?? 0, cs.charger_power ?? 0);
      c.end_battery = batt ?? c.end_battery;
      c.end_energy = cs.charge_energy_added ?? c.end_energy;
      c.end_range = cs.battery_range ?? c.end_range;
      if (cs.charge_limit_soc != null) c.chargeLimit = cs.charge_limit_soc;
    } else if (state.charging && ts - state.charging.lastChargingTs >= CHARGE_END_GAP_SEC) {
      closeCharging(state.charging.lastChargingTs);
    }
  }

  /** 车进入休眠/离线：行程立即收尾；充电留给后续样本判定 */
  function onSleep(nowTs) {
    state.sleeps++;
    if (state.trip) closeTrip(state.trip.lastMoveTs);
    if (state.charging && nowTs - state.charging.lastChargingTs >= STALE_SEC) {
      closeCharging(state.charging.lastChargingTs);
    }
  }

  async function tick() {
    const nowTs = Math.floor(Date.now() / 1000);
    state.polls++;
    state.lastPollAt = nowTs;
    try {
      const list = await api.listVehicles();
      const v = (list.response || [])[0];
      if (!v) {
        state.lastVehicleState = 'no-vehicle';
        return;
      }
      state.lastVehicleState = v.state;
      if (v.state !== 'online') {
        onSleep(nowTs);
        return; // 休眠时不唤醒，省电也避免被限流
      }
      const data = await api.fetchVehicleData(v.id);
      const resp = data.response;
      if (!resp) throw new Error('返回里没有 response');
      resp.state = v.state;
      resp._ts = nowTs;
      handleSample(resp);
      state.lastError = null;

      // 每天清理一次过期采样
      if (nowTs - prunedAt > 86400) {
        const cutoff = nowTs - retentionDays * 86400;
        const n = db.prune(cutoff);
        if (n) log(`[清理] 删除 ${n} 条超过 ${retentionDays} 天的采样`);
        prunedAt = nowTs;
      }
    } catch (e) {
      state.errors++;
      state.lastError = e?.message || String(e);
      // 408 = 车休眠/离线，属正常情况，不刷屏
      if (!/408|offline|asleep|unavailable/i.test(state.lastError)) {
        log(`[错误] ${state.lastError}`);
      }
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    log(`[采集] 启动 · 间隔 ${intervalSec}s · 保留 ${retentionDays} 天`);
    tick();
    timer = setInterval(tick, intervalSec * 1000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    state.running = false;
    if (timer) clearInterval(timer);
    timer = null;
    log('[采集] 已停止');
  }

  function status() {
    return {
      running: state.running,
      intervalSec: state.intervalSec,
      lastPollAt: state.lastPollAt,
      lastSampleTs: state.lastSampleTs,
      lastError: state.lastError,
      vehicleState: state.lastVehicleState,
      polls: state.polls,
      samples: state.samples,
      sleeps: state.sleeps,
      errors: state.errors,
      tripOpen: !!state.trip,
      chargingOpen: !!state.charging,
    };
  }

  return { start, stop, status, tick };
}
