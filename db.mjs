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
  db.exec(SCHEMA);

  const stmts = {
    insertSample: db.prepare(`
      INSERT OR REPLACE INTO samples (
        ts,state,speed,power,shift_state,moving,lat,lon,heading,
        battery,usable_battery,range_mi,ideal_range_mi,est_range_mi,
        charging_state,charger_power,charger_voltage,charger_current,
        energy_added,charge_limit,time_to_full,
        inside_temp,outside_temp,climate_on,
        odometer,locked,sentry,tpms_fl,tpms_fr,tpms_rl,tpms_rr,car_version
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,?,?,?,?,?,?
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
      SELECT ts, lat, lon, speed, power, battery, odometer
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
        s.charging_state ?? null, s.charger_power ?? null, s.charger_voltage ?? null, s.charger_current ?? null,
        s.energy_added ?? null, s.charge_limit ?? null, s.time_to_full ?? null,
        s.inside_temp ?? null, s.outside_temp ?? null, s.climate_on ?? null,
        s.odometer ?? null, s.locked ?? null, s.sentry ?? null,
        s.tpms_fl ?? null, s.tpms_fr ?? null, s.tpms_rl ?? null, s.tpms_rr ?? null,
        s.car_version ?? null
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
