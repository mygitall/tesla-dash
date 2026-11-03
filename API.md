# Tesla Dash API

> 所有 `/api/*` 接口都需要登录态（Cookie `dash_sess`），除 `/health`、`/login`、`/.well-known/*` 外。
> 时间戳均为 **Unix 秒**；距离单位 **km**，使用里程表换算。

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` | 表单 `password=...`，成功返回 302 + Set-Cookie |
| GET | `/health` | 健康检查，返回 `{ok:true,ts}` |

## 车辆与概览

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/app/summary` | – | App 首页总数据：电量/续航/锁/空调/今日统计/电价 |
| GET | `/api/vehicles` | – | 账号下车辆列表 |
| GET | `/api/vehicle/:id` | – | 单车完整车况 |
| GET | `/api/recorder` | – | 采集器状态（含 openTrip / autoLock / fastMode）|

## 行程

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/trips` | `limit`(≤500,默认50) `offset` | 行程列表（新→旧）|

## 充电

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/charge/summary` | `year` `month` 或 `range=all` | 充电汇总 + 会话列表 |
| GET | `/api/charge/curve` | `start` `end`（可选）| 充电曲线采样点 |
| GET | `/api/charge/months` | – | 有充电记录的月份 |
| GET | `/api/charge/health` | – | 电池健康度（满电续航 / 出厂值）|
| POST | `/api/charge/baseline` | `sessions` `kwh` `durationMin` `assumedKw` | 导入官方历史基线 |

## 设置

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/settings` | – | 当前设置 |
| POST | `/api/settings` | `autoLock`(bool) `autoLockDelaySec`(30~600) `electricityPrice`(0.1~10) | 修改设置 |

## 控制（需要 ALLOW_COMMANDS=1 + 密码）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/cmd/:action` | 执行控制指令，action 见下表 |

常用 action：`lock` `unlock` `climate-on` `climate-off` `drive` `charge-port-open` `charge-port-close` `honk` `flash` `sentry-on` `sentry-off` `trunk-open` `frunk-open`

返回：`{ok, action, code, message, needPairing, stdout, stderr}`

## 采集与在场

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| POST | `/api/recorder/wake` | `sec`(60~3600,默认900) | 进入高频采集窗口 |
| POST | `/api/recorder/presence` | `sec`(60~1800,默认180) `present`(1/0) | 手机在场：抑制自动锁；`present=0` 立刻解除 |

## 记录

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/actions` | `limit`(≤200,默认50) `offset` | 操作历史（最近 1000 条）|

## 数据口径

- **今日里程**：里程表增量（含未记成行程的短途），`today.gapKm` 表示其中未被行程记录的里程
- **今日能耗**：按电池下降百分比累计 × 电池容量（`BATTERY_KWH`，默认 75）；无电池数据时退回里程 × 0.15 并标记 `energyEstimated`
- **花费**：能耗 × 电价（`settings.electricityPrice`，默认 1.6 元/度）
- **电池健康度**：最近 3 次充满电表显续航最大值 ÷ 出厂值（`nominalRangeKm` 默认 435）
- **今日边界**：Asia/Shanghai 00:00
