/**
 * 数据层：SQLite（Node 内置 node:sqlite，零依赖）
 *
 * 存储单位约定：原始值照存特斯拉 API 的单位（英里 / 华氏摄氏已成 + 英里），
 * 换算交给前端，避免入库时丢精度。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 原始采样
CREATE TABLE IF NOT EXISTS samples (
  ts              INTEGER PRIMARY KEY,   -- unix 秒
  state           TEXT,
  speed           INTEGER,
  power           INTEGER,
  shift_state     TEXT,
  moving          INTEGER,
  lat             REAL,
  lon             REAL,
  heading         INTEGER,
  battery         INTEGER,
  usable_battery  INTEGER,
  range_mi        REAL,
  ideal_range_mi  REAL,
  est_range_mi    REAL,
  charging_state  TEXT,
  charger_power   REAL,
  charger_voltage REAL,
  charger_current REAL,
  energy_added    REAL,
  charge_limit    INTEGER,
  time_to_full    REAL,
  inside_temp     REAL,
  outside_temp    REAL,
  climate_on      INTEGER,
  odometer        REAL,
  locked          INTEGER,
  sentry          INTEGER,
  tpms_fl         REAL,
  tpms_fr         REAL,
  tpms_rl         REAL,
  tpms_rr         REAL,
  car_version     TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

-- 行程（一次连续驾驶）
CREATE TABLE IF NOT EXISTS trips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  start_odo     REAL,
  end_odo       REAL,
  distance_mi   REAL,
  start_battery INTEGER,
  end_battery   INTEGER,
  start_lat     REAL,
  start_lon     REAL,
  end_lat       REAL,
  end_lon       REAL,
  max_speed     INTEGER,
  avg_speed     REAL,
  samples       INTEGER,
  UNIQUE(start_ts)
);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_ts DESC);

-- 一次充电
CREATE TABLE IF NOT EXISTS charging (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER NOT NULL,
  start_battery  INTEGER,
  end_battery    INTEGER,
  start_energy   REAL,
  end_energy     REAL,
  energy_added   REAL,
  peak_power     REAL,
  charge_limit   INTEGER,
  start_range_mi REAL,
  end_range_mi   REAL,
  lat            REAL,
  lon            REAL,
  samples        INTEGER,
  UNIQUE(start_ts)
);
CREATE INDEX IF NOT EXISTS idx_charging_start ON charging(start_ts DESC);
`;

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tesla.db');
  const db = new DatabaseSync(file);
  // 兼容旧库：补上后加的列
  db.exec(SCHEMA);

  // 兼容旧库：补上后加的列
  try { db.exec('ALTER TABLE samples ADD COLUMN charge_rate REAL'); } catch {}
  // 车给的「本地坐标系」坐标（中国为 GCJ-02），用于地图精确显示
  try { db.exec('ALTER TABLE samples ADD COLUMN native_lat REAL'); } catch {}
  try { db.exec('ALTER TABLE samples ADD COLUMN native_lon REAL'); } catch {}

  const stmts = {
    insertSample: db.prepare(`
      INSERT OR REPLACE INTO samples (
        ts,state,speed,power,shift_state,moving,lat,lon,heading,
        battery,usable_battery,range_mi,ideal_range_mi,est_range_mi,
        charging_state,charger_power,charger_voltage,charger_current,charge_rate,
        energy_added,charge_limit,time_to_full,
        inside_temp,outside_temp,climate_on,
        odometer,locked,sentry,tpms_fl,tpms_fr,tpms_rl,tpms_rr,car_version,
        native_lat,native_lon
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,
        ?,?,?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,?,?,?,?,?,?,?,?
      )`),
    insertTrip: db.prepare(`
      INSERT OR IGNORE INTO trips (
        start_ts,end_ts,start_odo,end_odo,distance_mi,
        start_battery,end_battery,start_lat,start_lon,end_lat,end_lon,
        max_speed,avg_speed,samples
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    insertCharging: db.prepare(`
      INSERT OR IGNORE INTO charging (
        start_ts,end_ts,start_battery,end_battery,
        start_energy,end_energy,energy_added,peak_power,charge_limit,
        start_range_mi,end_range_mi,lat,lon,samples
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    listTrips: db.prepare(`SELECT * FROM trips ORDER BY start_ts DESC LIMIT ? OFFSET ?`),
    listCharging: db.prepare(`SELECT * FROM charging ORDER BY start_ts DESC LIMIT ? OFFSET ?`),
    // 用可用电量画曲线，和特斯拉 App 口径一致
    batterySeries: db.prepare(`
      SELECT ts, COALESCE(usable_battery, battery) AS battery, range_mi, charging_state
      FROM samples WHERE ts >= ? ORDER BY ts ASC`),
    lastSample: db.prepare(`SELECT ts, battery, odometer FROM samples ORDER BY ts DESC LIMIT 1`),
    counts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM samples)  AS samples,
        (SELECT COUNT(*) FROM trips)    AS trips,
        (SELECT COUNT(*) FROM charging) AS charging`),
    totals: db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(distance_mi),0) FROM trips)          AS distance_mi,
        (SELECT COALESCE(SUM(energy_added),0) FROM charging)      AS energy_kwh,
        (SELECT COALESCE(MAX(end_ts),0) FROM trips)               AS last_trip,
        (SELECT COALESCE(MAX(end_ts),0) FROM charging)            AS last_charge`),
    last24: db.prepare(`
      SELECT
        COALESCE(SUM(distance_mi),0) AS distance_mi,
        COUNT(*) AS trips
      FROM trips WHERE start_ts >= ?`),
    prune: db.prepare(`DELETE FROM samples WHERE ts < ?`),
    getTrip: db.prepare(`SELECT * FROM trips WHERE id = ?`),
    getCharging: db.prepare(`SELECT * FROM charging WHERE id = ?`),
    // 行程轨迹：只要移动中的点，按时间排序
    trackBetween: db.prepare(`
      SELECT ts, lat, lon, speed, power, battery, odometer,
             native_lat, native_lon
      FROM samples
      WHERE ts BETWEEN ? AND ? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY ts ASC`),
    // 充电曲线
    chargeCurve: db.prepare(`
      SELECT ts, charger_power, battery, range_mi, energy_added, inside_temp, outside_temp
      FROM samples
      WHERE ts BETWEEN ? AND ?
      ORDER BY ts ASC`),
  };

  return {
    file,
    raw: db,

    insertSample(s) {
      stmts.insertSample.run(
        s.ts, s.state ?? null, s.speed ?? null, s.power ?? null, s.shift_state ?? null, s.moving ?? null,
        s.lat ?? null, s.lon ?? null, s.heading ?? null,
        s.battery ?? null, s.usable_battery ?? null, s.range_mi ?? null, s.ideal_range_mi ?? null, s.est_range_mi ?? null,
        s.charging_state ?? null, s.charger_power ?? null, s.charger_voltage ?? null, s.charger_current ?? null, s.charge_rate ?? null,
        s.energy_added ?? null, s.charge_limit ?? null, s.time_to_full ?? null,
        s.inside_temp ?? null, s.outside_temp ?? null, s.climate_on ?? null,
        s.odometer ?? null, s.locked ?? null, s.sentry ?? null,
        s.tpms_fl ?? null, s.tpms_fr ?? null, s.tpms_rl ?? null, s.tpms_rr ?? null,
        s.car_version ?? null,
        s.native_lat ?? null, s.native_lon ?? null
      );
    },

    insertTrip(t) {
      return stmts.insertTrip.run(
        t.start_ts, t.end_ts, t.start_odo ?? null, t.end_odo ?? null, t.distance_mi ?? null,
        t.start_battery ?? null, t.end_battery ?? null,
        t.start_lat ?? null, t.start_lon ?? null, t.end_lat ?? null, t.end_lon ?? null,
        t.max_speed ?? null, t.avg_speed ?? null, t.samples ?? null
      );
    },

    insertCharging(c) {
      return stmts.insertCharging.run(
        c.start_ts, c.end_ts, c.start_battery ?? null, c.end_battery ?? null,
        c.start_energy ?? null, c.end_energy ?? null, c.energy_added ?? null,
        c.peak_power ?? null, c.charge_limit ?? null,
        c.start_range_mi ?? null, c.end_range_mi ?? null,
        c.lat ?? null, c.lon ?? null, c.samples ?? null
      );
    },

    /** 最近一条采样（车辆休眠时用于兜底展示） */
    latestSample() {
      return db.prepare('SELECT * FROM samples ORDER BY ts DESC LIMIT 1').get() || null;
    },

    /**
     * 从 samples 推导充电会话
     * 采样稀疏时（例如部署前/重启期间），用「电量百分比差 × 电池容量」补算电量
     */
    chargingSessionsFromSamples(packKwh = 75) {
      let rows;
      try {
        rows = db.prepare(`
          SELECT ts, charging_state, charger_power, energy_added, battery
          FROM samples
          WHERE charging_state IN ('Charging','Starting','Complete')
            AND battery IS NOT NULL
          ORDER BY ts
        `).all();
      } catch { return []; }

      const GAP = 900;             // 15 分钟无充电样本视为新会话
      const out = [];
      let cur = null;
      for (const r of rows) {
        if (!cur || r.ts - cur.end > GAP) {
          if (cur) out.push(cur);
          cur = {
            start: r.ts, end: r.ts,
            e0: r.energy_added ?? 0, e1: r.energy_added ?? 0,
            peak: r.charger_power ?? 0,
            b0: r.battery, b1: r.battery,
            n: 1,
          };
        } else {
          cur.end = r.ts;
          cur.e1 = Math.max(cur.e1, r.energy_added ?? 0);
          cur.peak = Math.max(cur.peak, r.charger_power ?? 0);
          cur.b1 = r.battery;
          cur.n += 1;
        }
      }
      if (cur) out.push(cur);

      // 采样稀疏时：充电可能延续到后面的样本（例如重启期间没采到）
      // 若下一个样本电量更高且间隔 < 6 小时、中间没有充电样本，则合并进来
      for (const s of out) {
        try {
          const nx = db.prepare(
            'SELECT ts, battery FROM samples WHERE ts > ? AND battery IS NOT NULL ORDER BY ts LIMIT 1'
          ).get(s.end);
          if (nx && nx.battery > s.b1 && nx.ts - s.end < 6 * 3600 && nx.ts - s.end > 300) {
            s.b1 = nx.battery;
            s.end = nx.ts;
            s.truncated = true;
          }
        } catch {}
      }

      return out.map((s) => {
        const sampleKwh = Math.max(0, s.e1 - s.e0);
        const pctGain = Math.max(0, (s.b1 ?? 0) - (s.b0 ?? 0));
        const kwhFromBattery = (pctGain / 100) * packKwh;
        // 两者取大：采样不足时电池差更接近真实
        const energyKwh = Math.max(sampleKwh, kwhFromBattery);
        const estimated = kwhFromBattery > sampleKwh + 0.3;   // 电池差明显更大 → 采样不足

        // 时长：采样太少时按峰值功率估算
        let durationMin = Math.round((s.end - s.start) / 60);
        let durationEstimated = false;
        if (estimated && s.n < 8) {
          const kw = s.peak > 1 ? s.peak : 7;
          durationMin = Math.max(durationMin, Math.round((energyKwh / kw) * 60));
          durationEstimated = true;
        }

        return {
          startTs: s.start,
          endTs: s.end,
          energyKwh: Math.round(energyKwh * 100) / 100,
          peakPower: Math.round((s.peak || 0) * 10) / 10,
          startBattery: s.b0,
          endBattery: s.b1,
          durationMin,
          samples: s.n,
          estimated,
          durationEstimated,
          truncated: !!s.truncated,
        };
      });
    },

    /** 一次性校正：用里程表差值重算历史行程距离（新的计算口径） */
    recomputeTripDistances() {
      const changed = [];
      try {
        const rows = db.prepare('SELECT id, start_ts, end_ts, distance_mi FROM trips').all();
        const upd = db.prepare('UPDATE trips SET distance_mi = ? WHERE id = ?');
        for (const t of rows) {
          const r = db.prepare(`
            SELECT MIN(odometer) AS lo, MAX(odometer) AS hi
            FROM samples WHERE ts BETWEEN ? AND ? AND odometer IS NOT NULL
          `).get(t.start_ts, t.end_ts);
          if (!r || r.lo == null || r.hi == null) continue;
          const delta = Math.max(0, r.hi - r.lo);
          const old = t.distance_mi ?? 0;
          if (delta > old + 0.05) {
            upd.run(delta, t.id);
            changed.push({ id: t.id, from: old, to: delta });
          }
        }
      } catch (e) {}
      return changed;
    },

    /** 某时间段内里程表最小/最大值（英里），用于精确算行程距离 */
    rawOdoRange(startTs, endTs) {
      try {
        return db.prepare(`
          SELECT MIN(odometer) AS lo, MAX(odometer) AS hi
          FROM samples WHERE ts BETWEEN ? AND ? AND odometer IS NOT NULL
        `).get(startTs, endTs) || null;
      } catch { return null; }
    },

    /** 某个时间窗内续航的最大增量（英里），用于算「上次增加多少 km」 */
    rangeDeltaBetween(startTs, endTs) {
      try {
        const r = db.prepare(`
          SELECT MIN(range_mi) AS lo, MAX(range_mi) AS hi
          FROM samples
          WHERE ts BETWEEN ? AND ? AND range_mi IS NOT NULL AND range_mi > 0
        `).get(startTs, endTs);
        if (r && r.lo != null && r.hi != null && r.hi > r.lo) return r.hi - r.lo;
        return null;
      } catch { return null; }
    },

    /** 某段时间内的充电曲线点（功率 vs 电量） */
    chargeCurveBetween(startTs, endTs) {
      try {
        return db.prepare(`
          SELECT ts, battery, charger_power, charger_voltage, charger_current, charging_state
          FROM samples
          WHERE ts BETWEEN ? AND ?
            AND charger_power IS NOT NULL
          ORDER BY ts
        `).all(startTs, endTs).map((r) => ({
          ts: r.ts,
          battery: r.battery,
          power: r.charger_power,
          voltage: r.charger_voltage,
          current: r.charger_current,
          state: r.charging_state,
        }));
      } catch { return []; }
    },

    /** 全部行程的累计值（不受列表条数限制） */
    tripsTotals() {
      try {
        const r = db.prepare(`
          SELECT COUNT(*) AS n,
                 COALESCE(SUM(distance_mi), 0) AS mi,
                 COALESCE(SUM(end_ts - start_ts), 0) AS sec,
                 MIN(start_ts) AS firstTs,
                 MAX(end_ts) AS lastTs
          FROM trips
        `).get();
        return {
          count: r.n || 0,
          distanceMi: r.mi || 0,
          durationSec: r.sec || 0,
          firstTs: r.firstTs || null,
          lastTs: r.lastTs || null,
        };
      } catch { return { count: 0, distanceMi: 0, durationSec: 0, firstTs: null, lastTs: null }; }
    },

    /** 今日统计：trips 表 + samples 里程差 双重兜底 */
    todayStats(sinceTs) {
      const t = db.prepare(`
        SELECT COUNT(*) AS trips,
               COALESCE(SUM(distance_mi), 0) AS distance_mi,
               COALESCE(SUM(end_ts - start_ts), 0) AS duration_sec
        FROM trips WHERE start_ts >= ?
      `).get(sinceTs) || {};

      // 采样兜底：odometer 是英里，用最大-最小得到当天里程
      let s = {};
      try {
        s = db.prepare(`
          SELECT MIN(odometer) AS a, MAX(odometer) AS b,
                 MIN(battery) AS bmin, MAX(battery) AS bmax
          FROM samples WHERE ts >= ? AND odometer IS NOT NULL
        `).get(sinceTs) || {};
      } catch {}

      const odoMi = (s.a != null && s.b != null) ? Math.max(0, s.b - s.a) : 0;

      // 行驶时长：按相邻样本的时间差累加（适配 20 秒/60 秒不同采样间隔）
      let sampleSec = 0;
      try {
        const r = db.prepare(`
          SELECT COALESCE(SUM(gap), 0) AS sec FROM (
            SELECT MIN(ts - prev, 180) AS gap
            FROM (SELECT ts, moving, LAG(ts) OVER (ORDER BY ts) AS prev
                  FROM samples WHERE ts >= ?) 
            WHERE moving = 1 AND prev IS NOT NULL
          )
        `).get(sinceTs) || {};
        sampleSec = Math.round(r.sec || 0);
      } catch {
        // 兜底：老式估算（至少有用）
        try {
          const r2 = db.prepare(`SELECT SUM(CASE WHEN moving=1 THEN 1 ELSE 0 END) AS mov FROM samples WHERE ts >= ?`).get(sinceTs);
          sampleSec = (r2.mov || 0) * 60;
        } catch {}
      }

      return {
        trips: t.trips || 0,
        distanceMi: Math.max(t.distance_mi || 0, odoMi),
        durationSec: Math.max(t.duration_sec || 0, sampleSec),
        batteryMin: s.bmin ?? null,
        batteryMax: s.bmax ?? null,
      };
    },

    listTrips(limit = 50, offset = 0) {
      return stmts.listTrips.all(limit, offset);
    },
    listCharging(limit = 50, offset = 0) {
      return stmts.listCharging.all(limit, offset);
    },
    batterySeries(sinceTs) {
      return stmts.batterySeries.all(sinceTs);
    },
    lastSample() {
      return stmts.lastSample.get() || null;
    },
    stats() {
      const c = stmts.counts.get();
      const t = stmts.totals.get();
      const d = stmts.last24.get(Math.floor(Date.now() / 1000) - 86400);
      return { ...c, ...t, today_distance_mi: d.distance_mi, today_trips: d.trips };
    },
    getTrip(id) {
      return stmts.getTrip.get(id) || null;
    },
    getCharging(id) {
      return stmts.getCharging.get(id) || null;
    },
    trackBetween(from, to) {
      return stmts.trackBetween.all(from, to);
    },
    chargeCurve(from, to) {
      return stmts.chargeCurve.all(from, to);
    },
    prune(olderThanTs) {
      return stmts.prune.run(olderThanTs).changes;
    },
    close() {
      db.close();
    },
  };
}
