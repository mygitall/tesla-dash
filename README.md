# ⚡ Tesla Dash

一个最小可跑通的特斯拉车辆看板。零依赖，只用 Node 内置模块。

**两种模式：**

| 模式 | 说明 | 需要什么 |
|---|---|---|
| `demo` | 假数据，打开即用 | 什么都不需要 |
| `fleet` | 真实特斯拉 Fleet API | 开发者账号 + 车辆授权 + CN 区伙伴注册 |

> ✅ **已实测跑通**（上海 Model Y，CN 区）。真实数据、GPS 实时、token 自动刷新全部正常。
> 完整踩坑记录见 [SETUP-CN.md](SETUP-CN.md)。

---

## 快速开始（30 秒）

```bash
cd tesla-dash
node server.mjs
```

打开 <http://localhost:8787>

默认就是 `demo` 模式，会显示一台模拟的 Model 3，数据每 30 秒轻微漂移。

> 需要 Node ≥ 18（推荐 20+）。本机是 v24，直接用。

---

## 接真实车辆

### 第 1 步：注册开发者应用

1. 打开 <https://developer.tesla.com>，用**车主本人的特斯拉账号**登录
2. 创建应用，拿到 `Client ID` 和 `Client Secret`
3. 在应用的 **Allowed Redirect URIs** 里填你的回调地址
   - 特斯拉要求 **HTTPS**
   - 本地开发用隧道把 8787 暴露出去：

```bash
# 方式 A：cloudflared（免费，不用注册）
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
# 会输出类似 https://xxx-yyy-zzz.trycloudflare.com

# 方式 B：ngrok（要注册）
ngrok http 8787
```

4. 把隧道地址填进 `.env`：

```bash
TESLA_REDIRECT_URI=https://xxx-yyy-zzz.trycloudflare.com/auth/callback
```

> ⚠️ 隧道地址每次重启都会变。变了就要回到开发者后台同步改，否则 OAuth 会报 `redirect_uri mismatch`。

### 第 2 步：配置 `.env`

```bash
cp .env.example .env
```

```ini
MODE=fleet
TESLA_CLIENT_ID=你的client_id
TESLA_CLIENT_SECRET=你的client_secret
TESLA_REDIRECT_URI=https://你的隧道域名/auth/callback
TESLA_REGION=cn        # na | eu | cn
```

### 第 3 步：启动并授权

```bash
node server.mjs
```

打开 <http://localhost:8787> → 点「用特斯拉账号登录」→ 授权 → 自动跳回并显示数据。

Token 会存到 `.tokens.json`（权限 0600，已 gitignore），过期前自动用 `refresh_token` 续期。

---

## 只在本地验证数据（跳过 OAuth）

隧道配起来嫌麻烦的话，最快的路子是直接贴一个现成的 `access_token`：

```ini
MODE=fleet
TESLA_REGION=cn
TESLA_ACCESS_TOKEN=eyJhbGciOi...
```

`node server.mjs` 启动即可，不走登录流程。缺点是 token 几小时后过期，不能长期用，**只适合验证「数据到底能不能拿到」**。

---

## 目录结构

```
tesla-dash/
├── server.mjs          # 零依赖 HTTP 服务 + Tesla API 代理 + OAuth
├── public/
│   ├── index.html      # 页面结构
│   ├── style.css       # 样式（深色仪表盘）
│   └── app.js          # 前端逻辑：轮询、渲染、趋势图
├── .env.example
├── .gitignore
└── preview.png         # 截图
```

前端不直接调特斯拉（会撞 CORS，而且不能暴露 secret），**所有请求都过 `server.mjs` 代理**。

---

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/status` | 当前模式、区域、是否已授权 |
| GET | `/api/vehicles` | 车辆列表 |
| GET | `/api/vehicle/:id` | 单车完整数据 |
| POST | `/api/wake/:id` | 唤醒车辆 |
| GET | `/auth/login` | 跳转特斯拉 OAuth |
| GET | `/auth/callback` | 授权回调，换 token |
| GET | `/auth/logout` | 清除本地 token |

---

## 会遇到的问题

**`401 NO_TOKEN`**
还没授权。点登录，或按上面「只在本地验证数据」塞一个 token。

**`redirect_uri mismatch`**
`.env` 里的 `TESLA_REDIRECT_URI` 和开发者后台登记的不一致（隧道重启后地址变了）。

**`Tesla API 403: vehicle not authorized` / 车辆列表为空**
应用建好了但**车辆还没授权给这个应用**。需要在车辆上完成一次配对（特斯拉 App 或车机里操作），或先走「只在本地验证数据」确认 token 有效。

**车辆一直 `asleep`，数据是旧的**
车机休眠了。点「刷新」会尝试唤醒，但**频繁唤醒很耗电，特斯拉也会限流**。别写个 5 秒轮询。

**数据看起来"不动"**
正常。`speed`、`shift_state` 只有行驶时才非空；GPS 的 `gps_as_of` 常常是几十分钟前。看页面右下「数据新鲜度」判断。

---

## 数据边界

这个看板能拿到的是**当前状态快照**，不是行车历史：

- ✅ 电量、续航、充电功率/电压/电流、空调、门锁、里程、固件、GPS 坐标
- ❌ 历史轨迹、分次行程、行车记录仪视频、电池单体数据、Autopilot 接管记录

要攒轨迹得**自己高频轮询并落库**（且要处理休眠跳过、GPS 时间戳校验）。要 CAN 级数据得走 OBD 采集。详见对话里的分析。

---

## 下一步可以加

- [ ] 定时轮询 + SQLite 落库，切分行程
- [ ] 历史轨迹地图（Leaflet）
- [ ] 充电会话统计
- [ ] 指令面板（需要 signed command / 车辆配对公钥）
- [ ] 打包成 PWA，手机加主屏

---

# 📊 数据采集与历史记录（v2）

默认开启：服务启动后自动每 60 秒轮询一次车辆状态，落库到 SQLite，并自动切分**行程**和**充电会话**。

零依赖实现：用 Node 内置的 `node:sqlite`（Node ≥ 22）。

## 界面

顶部有两个 Tab：

- **实时** —— 当前状态（电量、位置、空调、胎压…）
- **历史** —— 汇总卡 + 电量曲线 + 行程表 + 充电表

右上角有采集状态徽章：`采集中 · 12s前` / `车休眠 · 暂停采集` / `采集异常`。

## 采集策略（重要）

| 车状态 | 行为 |
|---|---|
| `online` | 拉 `vehicle_data`，落库，切分行程/充电 |
| `asleep` / `offline` | **只读 `/vehicles` 的 state，不唤醒车**，跳过 |

**为什么不自动唤醒？** 唤醒很耗电，而且特斯拉会对高频请求限流甚至封 token。
代价是：车休眠期间的行程/充电记录会缺失——这是所有第三方工具的通病。

## 切分规则

| 类型 | 开始条件 | 结束条件 |
|---|---|---|
| **行程** | `speed > 0` 或档位在 `D`/`R` | 连续 **5 分钟**没动，或车进入休眠 |
| **充电** | `charging_state === 'Charging'` | 连续 **5 分钟**不在充电 |

行程里程用 `odometer` 差值，充电电量用 `charge_energy_added` 差值（所以从充电中途开始记录时只会算到观察到的部分）。

## 数据库

`data/tesla.db`，三张表：

```sql
samples    -- 每 60 秒一条原始快照（默认保留 90 天）
trips      -- 行程（永久）
charging   -- 充电会话（永久）
```

直接查：

```bash
sqlite3 data/tesla.db "SELECT datetime(start_ts,'unixepoch','localtime'),
  round(distance_mi*1.609344,1)||' km', start_battery||'%→'||end_battery||'%'
  FROM trips ORDER BY start_ts DESC LIMIT 10;"
```

## 新增接口

| 路径 | 说明 |
|---|---|
| `GET /api/recorder` | 采集器状态（运行、轮询数、最后采样、最后错误） |
| `GET /api/stats` | 汇总：累计里程、今日里程、累计充入、采样数 |
| `GET /api/trips?limit=50&offset=0` | 行程列表 |
| `GET /api/charging?limit=50&offset=0` | 充电列表 |
| `GET /api/series?hours=24` | 电量曲线（自动抽稀到 ≤400 点） |

## 配置

```ini
POLL_INTERVAL_SEC=60   # 轮询间隔，别低于 30
RETENTION_DAYS=90      # 采样保留天数
DATA_DIR=./data        # 数据库目录
```

## 已知局限

- **只能从启动那一刻开始记录**，之前的无法补录（Fleet API 不提供历史）
- 车休眠期间的数据缺失
- 行程按"停车 5 分钟"切分，中途长时间等红灯（>5 分钟）会被切成两段，可在 `recorder.mjs` 里调 `TRIP_END_GAP_SEC`

---

# 🗺️ 行程详情与完整字段（v3）

## 1. 补全的字段

实时页从 4 张卡扩展到 **6 张卡**，新增约 30 个字段：

| 卡片 | 新增内容 |
|---|---|
| 🔌 充电 | 充电电流（请求/上限）、充电限值范围（最小/标准/最大）|
| ❄️ 空调 | 座椅通风档位、座舱过热保护、空调保持模式、电池加热 |
| 🚗 车辆状态 | **四车窗状态**、档位、胎压推荐值、驾驶辅助硬件（TeslaAP4）|
| 🎵 影音与记录 | 正在播放（曲名/艺人/来源/状态/音量）、行车记录仪状态、可保存片段 |
| ⚙️ 系统与预约 | OTA 状态与进度、限速模式、预约充电、预热计划、服务模式 |

## 2. 行程 / 充电详情

**点历史页的任意一行**即可打开详情弹窗：

**行程详情**
- 统计卡：开始时间、时长、里程、耗电%、均速、最高速、估算能耗、百公里电耗、估算依据
- **地图轨迹**：Leaflet + OpenStreetMap，绿线画轨迹，蓝点起点、红点终点
- **车速曲线**：按当前 km/mi 单位换算后绘制

**充电详情**
- 统计卡：时长、充入 kWh、峰值功率、平均功率、电量变化、充电限值
- **充电功率曲线**：功率随 SOC 变化，能看出是慢充还是超充

## 3. 依赖

Leaflet **1.9.4 已本地化**到 `public/vendor/leaflet/`，不依赖 CDN。

地图瓦片用 OpenStreetMap，需要联网；坐标存的是 WGS-84（`drive_state.latitude`），与 OSM 一致，不会偏移。

> 想换高德/天地图瓦片：它们的坐标系是 GCJ-02，需要先把坐标转换，并改 `public/app.js` 里的 `TILE_URL`。README 不展开，需要时再说。

## 4. 新增接口

| 路径 | 说明 |
|---|---|
| `GET /api/trips/:id` | 行程详情 + 轨迹点（前后各放宽 2 分钟）|
| `GET /api/charging/:id` | 充电详情 + 功率曲线 |

## 5. 已知取舍

- **能耗是估算**：用「电量差 × 电池容量」算的，容量按 75 kWh 硬编码（`public/app.js` 里 `capGuess`）。不同车型要改这个值。
- **轨迹精度受采样间隔限制**：60 秒一个点，开快车时两点间可能是几百米直线。想更细就调小 `POLL_INTERVAL_SEC`（代价是更容易被限流）。
- **地图瓦片需联网**，且 OSM 在国内加载偏慢。

---

# 🌐 远程访问（Tailscale）

服务默认**只监听 `127.0.0.1`**，局域网和公网都访问不到。要用手机看，走 Tailscale：

```bash
brew install --cask tailscale     # Mac
# 手机装 Tailscale App，登同一账号
# 然后在 Tailscale 后台开启 HTTPS Certificates + MagicDNS

tailscale serve --bg 8787
# → https://你的机器名.你的tailnet.ts.net
```

**不暴露公网、不用域名、不用备案、免费、自动 HTTPS。**

完整步骤（含备选的 VPS + Docker 方案）见 👉 [DEPLOY.md](DEPLOY.md)

## 访问控制

| 环境变量 | 作用 |
|---|---|
| `HOST` | 监听地址，默认 `127.0.0.1`。Docker 里设 `0.0.0.0` |
| `APP_PASSWORD` | 留空 = 不登录；设置后所有页面和 API 都要密码 |

`/.well-known/appspecific/com.tesla.3p.public-key.pem` **始终公开**——特斯拉要能抓到它，否则伙伴注册会失效。

## 数据持久化

所有需要保留的东西都在 `data/` 一个目录：

```
data/
├── tesla.db          # 采样/行程/充电
├── .tokens.json      # 特斯拉 token
└── session.secret     # 登录会话密钥
```

备份就是 `tar czf backup.tar.gz data/`。

---

# 🎛️ 远程控制（空调 / 温度 / 座椅加热）

## 已实现

| 功能 | 指令 | 参数 |
|---|---|---|
| 空调开 / 关 | `climate-on` / `climate-off` | — |
| 设定温度 | `climate-set-temp` | 15~28 °C，0.5 步进 |
| 座椅加热（左/右） | `seat-heater` | off / low / medium / high |
| 方向盘加热 | `steering-wheel-heater` | on / off |

界面上是「🎛️ 远程控制」卡片，温度滑杆会**自动读取车辆当前设定值**作为初始值。

## 前提条件

| 条件 | 状态 |
|---|---|
| `ALLOW_COMMANDS=1` | ✅ 已配 |
| `APP_PASSWORD` 非空 | ✅ **强制要求**，否则接口一律 403 |
| `bin/tesla-control` | ✅ 已编译（官方签名工具，v0.4.1） |
| `keys/private-key.pem` | ✅ 已生成（SEC1 EC P-256） |
| **车辆已配对虚拟密钥** | ❗ **需要你做一次** |

## ⚠️ 配对只能走蓝牙

`add-key-request` 这个指令特斯拉限制为 **BLE（蓝牙）通道**，网络发不出去。
所以配对时有两条路：

### 方案 A：手机 + Tesla App（推荐）

在**车旁边**，用手机（装了 Tesla App）打开：

```
https://tesla.com/_ak/dapper-platypus-2424c9.netlify.app
```

App 会提示"添加虚拟钥匙"，然后**在中控屏上刷钥匙卡确认**。

> 域名里的 public key 我们已托管在 Netlify，Tesla App 能正常抓取。

### 方案 B：把电脑拿到车里

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
./scripts/pair-key.sh
```

脚本会：取 token → 取 VIN → 通过蓝牙发配对请求。
执行后**中控屏会弹出提示，刷钥匙卡确认**。

> 参数可改：`./scripts/pair-key.sh <VIN> owner nfc_card`
> 角色：`owner` / `driver` / `fm` / `vehicle_monitor` / `charging_manager`
> 形态：`cloud_key` / `nfc_card` / `ios_device` / `android_device`

## 配对完成后

回页面点「开启」，应该就能远程开空调了。

验证指令是否成功：

```bash
# 看服务日志里的 [指令] 行
tail -f /tmp/tesla-dash.log | grep 指令
```

## 技术实现

后端 `POST /api/cmd/:action`：

1. 校验 `ALLOW_COMMANDS` + `APP_PASSWORD`
2. 解析车辆 VIN
3. 车不在线就先 `wake_up` 并等最多 30 秒
4. 把 access_token 写进临时文件（`data/.cmd-token`，600）
5. 调 `tesla-control -key-file ... -vin ... -token-file ... <cmd>`
6. 返回 stdout / stderr

**signing 由官方 `tesla-control` 完成**（ECDSA P-256 + 车辆会话），我们只负责编排。

## 安全须知

| 风险 | 说明 |
|---|---|
| **控制接口 = 能开你车门** | 所以强制要求 `APP_PASSWORD` |
| 公网无密码时 | 控制接口返回 403 `NEED_PASSWORD`，不会执行 |
| `bin/tesla-control` 体积 | 18MB，是 Go 静态二进制 |
| 私钥 | `keys/private-key.pem`，600，已 gitignore |

**绝不要把 `keys/private-key.pem` 或 `.env` 提交到 git / 发给别人。**
