# Tesla Dash — 生产环境部署记录

> 部署日期：2026-10-23
> 状态：✅ 运行中

---

## 访问地址

| 地址 | 用途 |
|---|---|
| **https://www.zhangweiwei.cc** | 主地址（推荐） |
| https://dash.zhangweiwei.cc | 备用，同一套服务 |

密码：见服务器 `/opt/tesla-dash/.env` 的 `APP_PASSWORD`

---

## 服务器

| 项 | 值 |
|---|---|
| 提供商 | Vultr |
| IP | `167.179.86.244` |
| 机房 | 东京 (Tokyo, JP) |
| 配置 | 1 vCPU / 1 GB RAM / 23 GB SSD |
| 系统 | Ubuntu 24.04.5 LTS (x86_64) |
| 成本 | ~$6/月（按小时计费） |
| 登录 | `ssh root@167.179.86.244`（SSH 密钥，已配置） |

---

## 架构

```
浏览器 / PWA
    │ HTTPS (443)
    ▼
Caddy  ─── 自动 Let's Encrypt 证书，反代到本地
    │ http://127.0.0.1:8787
    ▼
Docker 容器 tesla-dash  (node:24-alpine)
    │
    ├── server.mjs      HTTP 服务 / OAuth / 特斯拉代理 / 指令下发
    ├── recorder.mjs    60 秒轮询，落库
    └── data/tesla.db   SQLite（samples / trips / charging）
```

| 组件 | 说明 |
|---|---|
| Caddy | 2.6.2，systemd 管理，证书自动续期 |
| 容器名 | `tesla-dash` |
| 端口绑定 | `127.0.0.1:8787`（只监听本地，外部必须走 Caddy） |
| 资源占用 | 约 23 MB 内存，CPU 0% |

---

## 目录结构（服务器）

```
/opt/tesla-dash/
├── .env                配置（APP_PASSWORD / 特斯拉凭证）
├── .env.raw.bak.*      转义前的原始 .env 备份
├── data/
│   ├── tesla.db        SQLite 数据库
│   ├── .tokens.json    特斯拉 OAuth token
│   └── session.secret  登录会话密钥
├── keys/private-key.pem 虚拟密钥私钥（600 权限）
└── docker-compose.yml
```

---

## 常用命令

```bash
ssh root@167.179.86.244
cd /opt/tesla-dash

docker compose ps              # 状态
docker compose logs -f         # 实时日志
docker compose logs --tail=50  # 最近 50 行
docker compose restart         # 重启应用
docker compose down            # 停止
docker compose up -d           # 启动

systemctl status caddy         # 证书/反代状态
systemctl reload caddy         # 改完 Caddyfile 后重载
```

---

## 备份

| 项 | 说明 |
|---|---|
| 脚本 | `/usr/local/bin/tesla-backup.sh` |
| 计划 | 每天 03:00（`/etc/cron.d/tesla-backup`） |
| 位置 | `/root/backups/tesla-data-YYYYMMDD-HHMM.tar.gz` |
| 保留 | 最近 7 份 |
| 内容 | 整个 `data/` 目录（数据库 + token） |

**手动备份：**
```bash
/usr/local/bin/tesla-backup.sh
```

**恢复：**
```bash
cd /opt/tesla-dash
docker compose stop
tar xzf /root/backups/tesla-data-XXXXXXXX-XXXX.tar.gz
docker compose start
```

---

## 安全加固

### SSH 仅允许密钥登录

配置文件：`/etc/ssh/sshd_config.d/00-hardening.conf`

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 20
```

> `00-` 前缀是必须的：sshd 先匹配先生效，`50-cloud-init.conf` 里有 `PasswordAuthentication yes`，
> 只有排在它前面才能覆盖。

**验证：**
```bash
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@167.179.86.244
# 应返回 Permission denied (publickey)
```

**如果密钥丢失**：用 Vultr 控制台的 Web Console 登录（不走 SSH），
或挂载救援 ISO 修改 `/etc/ssh/sshd_config.d/00-hardening.conf`。

### 防火墙

`ufw`：只开 22 / 80 / 443。

---

## 健康检查 + 自愈

| 项 | 说明 |
|---|---|
| 脚本 | `/usr/local/bin/tesla-health.sh` |
| 计划 | 每 5 分钟（`/etc/cron.d/tesla-health`） |
| 日志 | `/var/log/tesla-health.log`（超过 1MB 自动截断） |
| 检测方式 | `curl --resolve` 打本机 Caddy，检查 `/login` 是否 200 |

**自愈逻辑：**

| 检测结果 | 动作 |
|---|---|
| HTTP 200 | 静默退出，不写日志 |
| 容器 exited / unhealthy | `docker compose up -d --force-recreate` |
| HTTP 500/502/503 | `docker compose restart` |
| 其他（证书/反代问题） | `systemctl restart caddy` |
| 修复后仍失败 | 容器 + Caddy 全量重启 |

**实测：**停掉容器后 21 秒内自动恢复，日志完整记录。

```bash
# 手动触发一次
/usr/local/bin/tesla-health.sh

# 看日志
tail -20 /var/log/tesla-health.log
```

---

## 离车自动上锁

**默认关闭**，在网页「快捷操作」卡片下方手动开启。

### 触发条件（全部满足）

```
is_user_present == false   ← 驾驶员离座
locked          == false   ← 当前未锁
shift_state     == 'P'     ← 驻车（或为空且静止）
speed           == 0       ← 静止
df/pf/dr/pr/ft/rt == 0     ← 六门全关
```

任一条件不满足，或状态未知（字段缺失），**一律不动手**。

### 执行时序

```
T+0  采集器发现条件满足 → 武装，日志「[自动锁] 条件满足（离车未锁），60 秒后执行」
T+60 下一轮轮询仍是同一状态 → 下发 tesla-control lock
T+61 日志「[自动锁] 下发 lock → ✓ 成功」
```

采集间隔 60 秒 + 延迟 60 秒，**最慢约 2 分钟**锁车。这是有意的缓冲，
避免人刚下车拿个东西就被锁。

### 安全设计

| 机制 | 说明 |
|---|---|
| 默认关闭 | 必须手动开启，避免误锁 |
| 状态未知不动手 | `is_user_present` 缺失时不触发 |
| 车门未关不锁 | 六门任一开启即放弃 |
| 手动操作抑制 5 分钟 | 你在网页点了解锁/锁车，5 分钟内不自动锁 |
| 180 秒防抖 | 同一时段不会重复下发 |
| 事件记录 | 最近 10 条存在内存，网页可见 |

### 已知局限

**`is_user_present` 只感知驾驶座。** 你下了车但后排有小孩/宠物时，仍会锁车。
特斯拉车机自带的「离车自动上锁」逻辑相同，但它响应是秒级、你能立刻反应；
云端版延迟约 2 分钟。**车上有小孩/宠物时请手动关闭此功能。**

### 配置项

`data/settings.json`：

```json
{ "autoLock": true, "autoLockDelaySec": 60 }
```

或通过 API 修改：

```bash
curl -X POST https://www.zhangweiwei.cc/api/settings \
  -H 'Content-Type: application/json' \
  -b cookie.txt \
  -d '{"autoLock": true, "autoLockDelaySec": 60}'
```

延迟范围被夹紧在 30~600 秒。

### 排查

```bash
# 看自动锁是否触发
docker compose logs --since 30m | grep 自动锁

# 看当前状态
curl -b cookie.txt https://www.zhangweiwei.cc/api/recorder | jq .autoLock
```

---

## 特斯拉配置

| 项 | 值 |
|---|---|
| 区域 | 中国 (cn) |
| API | `https://fleet-api.prd.cn.vn.cloud.tesla.cn` |
| Client ID | `e4bbe918-f5dd-4199-b07a-e99fd8f661e7` |
| 伙伴账号 ID | `8e011601-c0f2-472b-b569-b86ec9aad10c` |
| **登记域名** | `www.zhangweiwei.cc`（2026-10-23 从 netlify 迁移过来） |
| 公钥 | 托管在 `https://www.zhangweiwei.cc/.well-known/appspecific/com.tesla.3p.public-key.pem` |
| 虚拟密钥 | 已配对（`tesla-control ping` 通） |

### 已知问题：回调地址加不上

特斯拉开发者后台「允许的重定向 URI」输入
`https://www.zhangweiwei.cc/auth/callback` 报 **「URL / URI 格式无效」**，
即使伙伴域名已更新、公钥可正常抓取。

**影响：无。** 只有 refresh token 过期（约 3 个月）需要重新授权时才用到。

---

## Token 生命周期

| token | 寿命 | 续期方式 |
|---|---|---|
| `access_token` | 8 小时 | 应用自动刷新 |
| `refresh_token` | 文档写 90 天 | **每次刷新换新的（滑动续期）** |

**只要服务持续运行，refresh_token 会不断滚动，理论上永不需重新授权。**

`server.mjs` 每次刷新都会把新的 `refresh_token` 写回 `data/.tokens.json`：

```js
saveTokens({
  access_token: j.access_token,
  refresh_token: j.refresh_token || tokens.refresh_token,  // 特斯拉的是一次性的
  expires_at: Date.now() + (j.expires_in || 3600) * 1000,
});
```

### 会导致真的过期的情况

| 场景 | 后果 |
|---|---|
| 服务停机超过 90 天 | 必须重新授权 |
| 修改特斯拉账号密码 | 立刻失效 |
| 在特斯拉后台撤销应用授权 | 立刻失效 |
| 两个实例同时用一个 token | 互相踢下线（已规避） |

### 到期征兆

- 日志出现 `login_required`
- 看板数据停止更新
- 健康检查日志出现 `⚠️ token 已 N 小时未刷新`

### 监控

健康检查脚本会检查 `data/.tokens.json` 的修改时间，
超过 **30 小时**未更新就记日志告警（正常每 8 小时刷新一次）。

---

## 重新授权流程（token 过期时）

> 到期时日志出现 `login_required`，看板数据停止更新。

### 方案 A：SSH 隧道（推荐，换电脑也能用）⭐

**不需要 Node、不需要项目文件、不需要密钥、不挑操作系统。**
只要那台电脑能 `ssh` 就行（Windows 自带 OpenSSH 也可以）。

原理：

```
浏览器 → http://localhost:8787（本机）
      → SSH 隧道
      → VPS 上的应用 /auth/callback
      → 用 code 换 token，直接写进云端 data/.tokens.json
```

#### 步骤

```bash
# ① 服务器切到本地回调模式
ssh root@167.179.86.244 '/opt/tesla-dash/scripts/renew-mode.sh on'

# ② 建立隧道（这个窗口保持开着，不要关）
ssh -N -L 8787:127.0.0.1:8787 root@167.179.86.244

# ③ 浏览器打开（新开一个终端）
open http://localhost:8787/auth/login
#    - 如提示输密码，输入 APP_PASSWORD
#    - 会跳到特斯拉登录页，登录并同意

# ④ 看到「授权成功」即完成，token 已在云端

# ⑤ 切回公网回调模式
ssh root@167.179.86.244 '/opt/tesla-dash/scripts/renew-mode.sh off'
```

#### 为什么第 ② 步能行

`/auth/callback` 是**公开路由**（已改），浏览器带着 `?code=...` 打到
`localhost:8787` 时，请求经隧道转发到 VPS 上的应用，应用立刻用 code 换 token。
**不要求先登录**，避免 code 被登录页吞掉。

> `/auth/login` 仍然要求登录 —— 这是有意的：防止别人用自己的特斯拉账号
> 走一遍授权，把 token 写进你的实例。

#### 常见问题

| 现象 | 原因 |
|---|---|
| 隧道窗口报 `Address already in use` | 本机 8787 被占用，加 `-L 8788:127.0.0.1:8787` 然后访问 8788（但 redirect_uri 写的是 8787，会失败）→ 先关掉占用进程 |
| 回调页显示「缺少 code」 | 直接访问了 /auth/callback，正常，要在 /auth/login 走完整流程 |
| 回调页显示 Tesla 报错 | 看错误文案，多半是 scope 或 client 配置 |

---

### 方案 B：公网回调（如果哪天能加上）

特斯拉后台若能加上 `https://www.zhangweiwei.cc/auth/callback`，
之后直接访问 `https://www.zhangweiwei.cc/auth/login` 走网页授权，不用碰服务器。

---

### 方案 C：本地跑完整应用（有项目文件时）

适用于手里有项目目录和 Node 的情况：

```bash
# ① 停云端，避免抢 token
ssh root@167.179.86.244 'cd /opt/tesla-dash && docker compose stop'

# ② 本地起服务
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
TESLA_REDIRECT_URI=http://localhost:8787/auth/callback node server.mjs

# ③ 浏览器授权
open http://localhost:8787/auth/login

# ④ token 写到本地 data/.tokens.json，传上去
scp data/.tokens.json root@167.179.86.244:/opt/tesla-dash/data/
ssh root@167.179.86.244 'cd /opt/tesla-dash && docker compose up -d'
```

---

### `renew-mode.sh` 说明

服务器上：`/opt/tesla-dash/scripts/renew-mode.sh`

| 参数 | 作用 |
|---|---|
| `on` | 回调地址切成 `http://localhost:8787/auth/callback` |
| `off` | 回调地址切回 `https://www.zhangweiwei.cc/auth/callback` |
| `status` | 查看当前值 |

每次切换会自动备份 `.env`，并重建容器使配置生效。

---

## 故障排查

| 现象 | 检查 |
|---|---|
| 502 Bad Gateway | `docker compose ps` 看容器是否在跑 |
| 证书报错 | `systemctl status caddy`；`journalctl -u caddy -n 50` |
| 数据不更新 | `curl` 看采集器是否 `running`；车可能休眠 |
| 指令失败 | 看日志是否 `your public key has not been paired` |
| 域名解析不了 | `dig +tcp www.zhangweiwei.cc A @111.13.13.35` |

### 健康检查

```bash
curl -o /dev/null -w "%{http_code}\n" https://www.zhangweiwei.cc/login   # 期望 200
curl -o /dev/null -w "%{http_code}\n" https://www.zhangweiwei.cc/api/status  # 期望 401
```

---

## ⚠️ 重要约束

### 不要同时运行本地和云端

两边共用一个 `refresh_token`，同时刷新会互相踢下线。

Mac 上的 launchd 服务已禁用（plist 改名为 `.plist.disabled`）。
如需恢复本地运行：

```bash
cd ~/Library/LaunchAgents
mv com.tesladash.server.plist.disabled com.tesladash.server.plist
launchctl enable gui/$(id -u)/com.tesladash.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tesladash.server.plist
# 同时必须停掉云端：
ssh root@167.179.86.244 'cd /opt/tesla-dash && docker compose stop'
```

### 不要删除 Netlify 站点

`dapper-platypus-2424c9.netlify.app`（site id `88379abe-c15b-40bc-aa6f-ce3802d7662d`）
是旧的伙伴域名，虽然已迁移，但保留无害。

### .env 里的 `$` 已被转义

`TESLA_CLIENT_SECRET` 中的 `$` 写成了 `$$`，因为 docker-compose 会对 env_file 做变量替换。
直接改 `.env` 时**注意保持转义**，原始值在 `.env.raw.bak.*`。

---

## 部署时踩过的坑

| # | 问题 | 原因 | 解决 |
|---|---|---|---|
| 1 | SSH 连不上 | Shadowrocket 劫持 TCP，握手是伪造的 | 退出代理 / 全局直连 |
| 2 | 镜像构建失败 | `make-bundle.sh` 漏打包 `docker-entrypoint.sh` | 补进清单 |
| 3 | Client Secret 只剩 12 字符 | compose 把 `$` 当变量替换 | `.env` 里 `$` → `$$` |
| 4 | 域名全球 SERVFAIL | NS 指向西部数码但解析区已被删 | 腾讯云改 NS 到 DNSPod |
| 5 | 特斯拉报「域无效」 | 该域名没有托管公钥 | 公钥托管好后重新做伙伴注册 |
