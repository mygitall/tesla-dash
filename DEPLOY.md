# 部署：用 Tailscale 在手机上安全访问

> 目标：在外面用手机看车，**但不把服务暴露到公网**。
> 成果：`https://你的机器名.你的tailnet.ts.net` —— 真 HTTPS，只有你自己的设备能打开。

---

## 为什么选 Tailscale

| | 公网 VPS | **Tailscale** |
|---|---|---|
| 谁能访问 | 全互联网（靠密码挡）| **只有你的设备** |
| 要不要域名 | 要 | 不要 |
| 要不要备案 | 国内机房要 | **不要** |
| 花钱 | ¥30-80/月 | **免费** |
| 证书 | 自己搞 | 自动 |
| 被扫端口 | 会 | **扫不到** |

Tailscale 是一个基于 WireGuard 的虚拟局域网。你的 Mac 和手机装上并登录同一个账号后，它们就像插在同一台路由器上。

---

## 第 1 步：装 Tailscale

**Mac：**
```bash
brew install --cask tailscale
```
或从 App Store 搜「Tailscale」。

**手机：** App Store / 应用商店搜「Tailscale」。

两边都登录**同一个账号**（Google / Microsoft / Apple 都行，免费）。

---

## 第 2 步：打开 HTTPS 功能

Tailscale 免费版默认不开 HTTPS 证书，要手动开一次。

1. 打开 <https://login.tailscale.com/admin/dns>
2. 找到 **HTTPS Certificates** → 点 **Enable**
3. 确认 **MagicDNS** 也是开启状态

---

## 第 3 步：让服务能被 Tailscale 代理

现在服务默认只听 `127.0.0.1:8787`（`HOST` 环境变量控制），这正是我们要的——只有本机能连，Tailscale 会在前面做代理。

确认服务在跑：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
node server.mjs
```

---

## 第 4 步：一条命令开 HTTPS

```bash
tailscale serve --bg 8787
```

会输出类似：

```
https://你的机器名.你的tailnet.ts.net/ proxies to http://127.0.0.1:8787
```

**这个地址就是你的访问入口**，手机在 Tailscale 开着的情况下直接打开即可。

> 查看当前配置：`tailscale serve status`
> 关闭：`tailscale serve --https=443 off`

---

## 第 5 步（可选）：加一层密码

Tailscale 已经做了网络层鉴权，密码是**第二道锁**。如果你担心设备丢失或账号共享，就加上：

编辑 `.env`：

```ini
APP_PASSWORD=你想设的密码
```

重启服务。之后任何设备访问都会先看到登录页。

> 密码不设就完全跳过登录页，直接进看板。

---

## 第 6 步（可选）：手机上想重新授权特斯拉时

目前 token 存在 Mac 上，**手机只是看数据，不需要重新登录特斯拉**。

只有当你需要**重新授权**（比如换了密钥、撤销了权限）时，才需要在特斯拉后台加一条回调地址：

```
https://你的机器名.你的tailnet.ts.net/auth/callback
```

加到「允许的重定向 URI」，然后改 `.env`：

```ini
TESLA_REDIRECT_URI=https://你的机器名.你的tailnet.ts.net/auth/callback
```

> 注意：这一步**不是必须的**，日常看数据用不到。

---

## 常见问题

**手机打不开 `xxx.ts.net`**
- 手机上的 Tailscale 是否连上（App 里显示 Connected）
- `tailscale serve status` 是否还显示代理规则
- Mac 有没有睡眠（合盖会断，插电设置里可关休眠）

**提示证书不安全**
- 回第 2 步确认 HTTPS Certificates 已启用
- 首次签发要等 1-2 分钟

**Mac 重启后服务没起来**
用 `launchd` 或 `pm2` 让它开机自启：

```bash
# 用 pm2（推荐）
npm i -g pm2
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
pm2 start server.mjs --name tesla-dash
pm2 save
pm2 startup    # 按提示执行它给的那条命令
```

---

# 备选：公有云 VPS 部署

如果以后想长期挂着、或者给别人看，用 VPS。**必须是 Docker 部署**，因为要持久化 `data/`。

## 一台香港/海外 VPS（不用备案）

```bash
# 1. 装 Docker
curl -fsSL https://get.docker.com | sh

# 2. 传代码
scp -r tesla-dash user@your-vps:~/tesla-dash

# 3. 写 .env
cd ~/tesla-dash
cat > .env <<'EOF'
MODE=fleet
TESLA_REGION=cn
TESLA_CLIENT_ID=...
TESLA_CLIENT_SECRET=...
TESLA_REDIRECT_URI=https://你的域名/auth/callback
APP_PASSWORD=一定要设一个强密码
EOF

# 4. 起
docker compose up -d

# 5. 看日志
docker compose logs -f
```

## 配 HTTPS（Caddy，自动证书）

```bash
apt install caddy
cat > /etc/caddy/Caddyfile <<'EOF'
你的域名 {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy
```

再把 `https://你的域名` 加进特斯拉后台的「允许的源」，并在 Tesla 重新走一次伙伴注册（公钥域名不变的话这步不用做）。

## ⚠️ 云上部署必须注意

| 项 | 说明 |
|---|---|
| **必须设 `APP_PASSWORD`** | 公网 IP 会被扫 |
| `data/` 必须挂卷 | 否则重建容器丢 token，要重新授权特斯拉 |
| `.env` 不要提交 git | 已 gitignore |
| 建议加 fail2ban | 防暴力破解登录 |

---

# 数据持久化说明

现在所有需要持久化的东西都在 `data/` 一个目录里：

```
data/
├── tesla.db            # 采样 / 行程 / 充电记录
├── tesla.db-wal        # SQLite 预写日志
├── .tokens.json        # 特斯拉 token（自动刷新）
└── session.secret      # 登录会话签名密钥
```

**备份只需要拷 `data/` 目录。**

```bash
# 备份
tar czf tesla-dash-backup-$(date +%F).tar.gz data/

# 恢复
tar xzf tesla-dash-backup-*.tar.gz
```

---

# 安全清单

上线前逐条确认：

- [ ] `data/` 不在 git 里（`.gitignore` 已包含）
- [ ] `.env` 权限 `chmod 600`
- [ ] 公网部署时 `APP_PASSWORD` 已设置
- [ ] 服务只监听 `127.0.0.1`（由反代/Tailscale 进入）
- [ ] 特斯拉 Client Secret 没有硬编码进代码
- [ ] `keys/private-key.pem` 没有外泄（目前只读模式用不到它）

---

# 临时外网访问（Pinggy，应急用）

**适用场景：** 就想现在从外面打开看一眼，不想装 Tailscale、不想买服务器。

**代价：** 60 分钟过期、URL 每次重启都变、浏览器首次访问多一个提示页。

## 前提：必须设密码

```ini
# .env
APP_PASSWORD=强密码
```

没密码的公网地址等于把车的实时位置公开。

## 为什么不用 cloudflared

Cloudflare Tunnel 走 7844 端口（QUIC/TCP）。如果本机开着 Clash 之类的代理（fake-IP 模式），
`*.argotunnel.com` 会被解析到 `198.18.x.x` 假 IP，隧道连不上。

## 用 Pinggy（走 SSH 443，能穿代理）

```bash
ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -R0:localhost:8787 a.pinggy.io
```

输出里的地址就能用：

```
https://xxxx-xx-xxx-xxx-xxx.run.pinggy-free.link
```

**注意：**
- 免费版 **60 分钟**过期
- 浏览器首次访问会看到 Pinggy 的 "Caution" 提示页，点 **Enter site** 即可，之后不再出现
- curl / API 不受那个提示页影响
- 进程一停 URL 就失效

## 想更稳的临时方案

**临时关掉代理**（Clash/TUN 全部退出），然后：

```bash
cloudflared tunnel --url http://localhost:8787
```

Cloudflare 快速隧道**没有提示页**，也不限时（进程在就一直通），代价是域名也是随机的。

## 安全提醒

公网地址一旦建立，全世界都能访问到**登录页**（但进不去看板）。已经加的保护：

- 密码登录（`APP_PASSWORD`）
- 登录失败限流：同一 IP 5 分钟内最多 5 次，超了 429
- `/.well-known/` 公钥**故意公开**，特斯拉要抓
- 会话 cookie：`HttpOnly` + `SameSite=Lax`，30 天有效

用完了记得 `Ctrl+C` 停掉隧道。

---

# ⚠️ 危险组合：无密码 + 公网隧道

| 场景 | 安全性 |
|---|---|
| `APP_PASSWORD` 为空 + 只听 `127.0.0.1` | ✅ 安全（本机专用）|
| `APP_PASSWORD` 为空 + Tailscale | ✅ 基本安全（只有你的设备能连）|
| **`APP_PASSWORD` 为空 + 公网隧道（Pinggy/ngrok/cloudflared）** | ❌ **任何人拿到链接就能看你车的实时 GPS** |

第三种组合下，`/api/vehicles` 和 `/api/vehicle/:id` 无需登录即可返回：
车型、VIN、实时经纬度、电量、是否锁车、胎压……

**如果你要在公网暴露，必须二选一：**
- 设 `APP_PASSWORD`
- 或者关掉隧道，只在 Tailscale / 本机访问
