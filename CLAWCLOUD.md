# ClawCloud Run 部署（免费、不用信用卡）

> 目标：`https://xxx.clawcloudrun.com` 在线，$0。
> 前提：GitHub 账号满 180 天（你已满足）。

---

## 已为你改造好的东西

云端和本地运行方式不同，代码已经适配：

| 改动 | 说明 |
|---|---|
| **私钥从环境变量注入** | `TESLA_KEY_B64` → 启动时还原成文件，**不进镜像、不进 Git** |
| **token 从环境变量自举** | `TESLA_REFRESH_TOKEN` → 首次请求自动刷新，**不用上传 data/** |
| **按架构自动选二进制** | 启动时 `uname -m` 判断，x86/ARM 都能跑 |
| **镜像不含任何密钥** | `.dockerignore` 排除了 `keys/`、`data/`、`.env` |
| **Git 仓库已就绪** | 已 `git init` + 首次提交，`.gitignore` 排除了密钥 |

---

## 第 1 步：推到 GitHub（私有仓库）

先在 <https://github.com/new> 建一个仓库：

| 项 | 值 |
|---|---|
| Repository name | `tesla-dash` |
| 可见性 | **Private**（私有） |
| 初始化选项 | 全部**不勾**（不要 README/gitignore/license） |

然后在你 Mac 上：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash

git remote add origin https://github.com/你的用户名/tesla-dash.git
git branch -M main
git push -u origin main
```

> 如果提示要 token：GitHub → Settings → Developer settings → Personal access tokens → 生成一个带 `repo` 权限的 token，密码位置填它。

推送完成后去 GitHub 页面确认：

- ✅ 有 `Dockerfile`、`server.mjs`、`public/`
- ❌ **没有** `.env`、`keys/`、`data/`

**如果看到任何密钥文件，立刻删仓库重来。**

---

## 第 2 步：注册 ClawCloud Run

1. 打开 <https://run.claw.cloud>
2. 点 **Sign in with GitHub**（用你的 GitHub 授权，满足 180 天条件）
3. 进入控制台后，先看右上角/账单页确认**免费额度是否到账**（正常是每月 $5）

> ⚠️ 如果注册过程要求绑卡，**先停下告诉我** —— 那就不是"不用信用卡"的方案了。

---

## 第 3 步：生成环境变量

在你 Mac 上：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
./scripts/export-secrets.sh
```

会输出一大段：

```
MODE=fleet
TESLA_REGION=cn
TESLA_CLIENT_ID=e4bbe918-...
TESLA_CLIENT_SECRET=...
TESLA_REFRESH_TOKEN=...
APP_PASSWORD=...
ALLOW_COMMANDS=1
HOST=0.0.0.0
PORT=8787
DATA_DIR=/app/data
POLL_INTERVAL_SEC=60
RETENTION_DAYS=90
TESLA_KEY_B64=LS0tLS1CRUdJTiBFQyBQ...
```

**先复制到记事本备用**（第 5 步要用，别截图外发）。

---

## 第 4 步：创建应用

ClawCloud 控制台 → **Create App**（或 "Deploy App"）

### 4.1 基本信息

| 项 | 值 |
|---|---|
| App Name | `tesla-dash` |
| Region | **Singapore / Japan**（离中国近） |
| Deploy Method | **GitHub Repository** |

授权 GitHub 后，选择 `你的用户名/tesla-dash`，分支 `main`。

### 4.2 构建配置

| 项 | 值 |
|---|---|
| Build Method | **Dockerfile** |
| Dockerfile Path | `Dockerfile`（默认） |
| 构建上下文 | `/`（默认） |

### 4.3 网络 / 端口

| 项 | 值 |
|---|---|
| Container Port | **8787** |
| Protocol | HTTP |
| Public Access | ✅ 开启 |

平台会自动分配一个 `https://xxx.clawcloudrun.com` 域名。

### 4.4 存储卷（**关键，不配就丢数据**）

| 项 | 值 |
|---|---|
| Mount Path | **`/app/data`** |
| Size | 1 GB（够我们用好几年） |

> 这个卷存 SQLite 数据库、刷新后的 token。**不挂的话每次重启数据清零。**

### 4.5 环境变量

把第 3 步复制的内容**逐条**填进去（或用平台的「批量导入」粘贴）。

**最少必须有的 6 条：**

```
TESLA_CLIENT_ID
TESLA_CLIENT_SECRET
TESLA_REFRESH_TOKEN
TESLA_KEY_B64
APP_PASSWORD
ALLOW_COMMANDS=1
```

其余（`MODE`、`TESLA_REGION`、`HOST`、`PORT`、`DATA_DIR`、`POLL_INTERVAL_SEC`、`RETENTION_DAYS`）一起填上更稳。

---

## 第 5 步：部署 + 验收

点 **Deploy**，等构建完成（2~5 分钟）。

看构建日志，成功的话最后会打印：

```
[init] 私钥已从 TESLA_KEY_B64 写入
[init] 签名工具: tesla-control-linux-amd64
⚡ Tesla Dash
  模式     : fleet  (Fleet API)
  区域     : cn  →  https://fleet-api.prd.cn.vn.cloud.tesla.cn
  OAuth    : 已配置
  Token    : 已有 (env-refresh)
  访问控制 : 需要密码登录
  远程控制 : 已开启
```

验收（把 `xxx` 换成你的实际域名）：

```bash
# ① 公钥可访问（必须 200）
curl -s -o /dev/null -w "%{http_code}\n" https://xxx.clawcloudrun.com/.well-known/appspecific/com.tesla.3p.public-key.pem

# ② 未登录 API 被拒（必须 401）
curl -s -o /dev/null -w "%{http_code}\n" https://xxx.clawcloudrun.com/api/status

# ③ 登录页（必须 200）
curl -s -o /dev/null -w "%{http_code}\n" https://xxx.clawcloudrun.com/login
```

浏览器打开 → 输密码 → 应该能看到车的数据。

---

## 第 6 步：⭐ 停掉本地服务（很重要）

**两个实例抢同一个 refresh_token 会互相踢下线**（特斯拉刷新时旧的会失效）。

云上跑通后，在你 Mac 上：

```bash
launchctl bootout gui/$(id -u)/com.tesladash.server
launchctl bootout gui/$(id -u)/com.tesladash.tunnel
launchctl bootout gui/$(id -u)/com.tesladash.caffeinate
```

本地代码留着当开发环境，但**别再同时运行**。

如果哪天要切回本地，反过来操作：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tesladash.server.plist
```

---

## 第 7 步：（可选）让云端也能重新授权特斯拉

现在云端用的是你本地的 refresh_token 自举，**不需要重新授权**。

但 refresh_token 大约 **3 个月**过期。到期后需要重新走一次 OAuth，那时要把云端域名加进特斯拉后台：

1. 打开 <https://developer.tesla.cn/dashboard> → 你的应用
2. 「**允许的重定向 URI**」新增：

```
https://xxx.clawcloudrun.com/auth/callback
```

3. 保存，等 3~10 分钟

> ⚠️ 「允许的源 URL」**不要动**（之前 `sseeee.com` 报「域无效」就是那个字段）。

---

## 排错

| 现象 | 原因 | 解决 |
|---|---|---|
| 构建失败 | Dockerfile 路径不对 | 确认 Dockerfile 在仓库根目录 |
| 容器启动即退出 | 环境变量缺失 | 看日志找 `NO_TOKEN` / `NO_KEYS` |
| 502 | 端口不对 | Container Port 必须是 **8787** |
| 数据每次重启清零 | 没挂卷 | 加 `/app/data` 挂载 |
| `Token: 空` | 没设 `TESLA_REFRESH_TOKEN` | 检查环境变量 |
| 控制报 `TOKEN 失败` | refresh_token 过期 | 重新授权后重新导出 |
| 访问很慢 | 区域选远了 | 换 Singapore |

---

## 用完额度会怎样

ClawCloud 每月 $5 额度，我们这套大约消耗：

| 资源 | 占用 |
|---|---|
| 内存 | ~60 MB |
| CPU | 几乎为 0（每 60 秒一次请求） |
| 出网 | 很小（地图瓦片是浏览器直连 OSM） |

**属于最低档配置就能跑的量级**，$5 一个月绰绰有余。

额度用完的话：容器会暂停，充值或等下月。数据在持久卷里不会丢。

---

## 如果 ClawCloud 走不通

告诉我卡在哪一步，备选顺序：

1. **Zeabur**（也支持支付宝、有免费层）
2. **Cloudflare Workers 只读版**（永久免费，但**没有空调控制**）
3. **回到本地 Mac + Tailscale**（5 分钟，控制全保留）
