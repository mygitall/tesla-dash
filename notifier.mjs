/**
 * 车辆事件推送
 * 在每次成功拉取 vehicle_data 后评估规则，命中就推送（带去重）
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function createNotifier({
  push,
  batteryKwh = 75,
  lowBatteryPct = 20,
  unlockedMinutes = 10,
  stateFile,
  log = console.log,
}) {
  let st = load();

  function load() {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return { charging: null, lowBattery: false, unlockedSince: null, unlockedAlerted: false };
    }
  }
  function save() {
    try { writeFileSync(stateFile, JSON.stringify(st)); } catch {}
  }

  async function send(title, body) {
    try {
      await push(title, body);
      log(`[事件] ${title} — ${body}`);
    } catch (e) {
      log(`[事件] 推送失败: ${e.message}`);
    }
  }

  function handle(d, nowTs) {
    const cs = d?.charge_state || {};
    const ds = d?.drive_state || {};
    const vs = d?.vehicle_state || {};

    const charging = cs.charging_state || null;
    const battery = typeof cs.battery_level === 'number' ? cs.battery_level : null;
    const isCharging = charging === 'Charging' || charging === 'Starting';

    /* ── 1) 开始充电 ── */
    if (isCharging && st.charging && !['Charging', 'Starting'].includes(st.charging)) {
      const pct = battery != null ? `当前 ${battery}%` : '';
      send('🔌 开始充电', `${pct}${cs.charge_limit_soc ? `，上限 ${cs.charge_limit_soc}%` : ''}`.trim());
    }

    /* ── 2) 充电完成 ── */
    if (!isCharging && st.charging && ['Charging', 'Starting'].includes(st.charging)) {
      const added = cs.charge_energy_added ?? 0;
      if (added >= 1) {
        const mins = cs.charge_minutes_to_full ?? null;
        send(
          '✅ 充电完成',
          `本次充入 ${added.toFixed(1)} 度，当前电量 ${battery ?? '?'}%` +
            (mins != null && mins > 0 ? `，距满电约 ${mins} 分钟` : '')
        );
      }
    }

    /* ── 3) 电量过低 ── */
    if (battery != null) {
      if (battery <= lowBatteryPct && !isCharging && !st.lowBattery) {
        const range = cs.battery_range ?? cs.est_battery_range ?? null;
        const km = range != null ? `（约 ${Math.round(range * 1.609)} km）` : '';
        send('🪫 电量偏低', `当前 ${battery}%${km}，记得及时充电`);
        st.lowBattery = true;
      } else if (battery > lowBatteryPct + 5) {
        st.lowBattery = false;   // 充上来后复位
      }
    }

    /* ── 4) 未锁车超时 ── */
    const locked = vs.locked;
    const speed = ds.speed ?? 0;
    const parked = !speed && (ds.shift_state === 'P' || ds.shift_state == null);
    if (locked === false && parked) {
      if (st.unlockedSince == null) st.unlockedSince = nowTs;
      const mins = (nowTs - st.unlockedSince) / 60;
      if (mins >= unlockedMinutes && !st.unlockedAlerted) {
        send('🔓 车辆未上锁', `已解锁 ${Math.round(mins)} 分钟，需要我帮你锁上吗？`);
        st.unlockedAlerted = true;
      }
    } else {
      st.unlockedSince = null;
      st.unlockedAlerted = false;
    }

    st.charging = charging;
    save();
  }

  return { handle, state: () => st };
}
