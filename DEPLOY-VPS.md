# P0 部署清单：香港 VPS 从零到跑起来

> 目标：把现在这套东西搬到云上，你用手机/电脑从任何地方访问。
> 预计耗时：**40~60 分钟**（含域名解析等待）。
> 前置：你已有一个能登录的特斯拉开发者账号（已完成伙伴注册）。

---

## 0. 先明确三件事（避免走弯路）

| 问题 | 答案 |
|---|---|
| **要重新做伙伴注册吗？** | ❌ **不用**。公钥还在 Netlify，伙伴注册绑的是那个域名，跟应用部署在哪无关 |
| **要重新授权特斯拉吗？** | ❌ **不用**。把本地 `data/` 一起传上去，token 直接沿用 |
| **新域名要加进「允许的源」吗？** | ⚠️ **先别加**。之前你加 `sseeee.com` 报「域无效」，而**只加「允许的重定向 URI」就够用**（详见第 8 步） |

---

## 1. 买机器

### 规格

| 项 | 建议 |
|---|---|
| 内存 | **2 GB 起**（Docker + Node + Postgres 够用） |
| CPU | 2 核 |
| 硬盘 | 40 GB SSD |
| 系统 | **Ubuntu 24.04 LTS**（或 22.04） |
| 地区 | **香港 / 新加坡**（免备案，国内访问也还行） |

### 推荐厂商

| 厂商 | 套餐 | 价格 |
|---|---|---|
| 阿里云轻量应用服务器（香港） | 2C2G 40G | ~¥60/月 |
| 腾讯云轻量（香港） | 2C4G | ~¥70/月 |
| Vultr（东京/新加坡） | 2C2G | ~$12/月 |
| 搬瓦工 | 2C2G | ~$15/月 |

> **别买国内节点**——需要 ICP 备案，没备案 80/443 会被封。

### 系统镜像
选 **Ubuntu 24.04 LTS**，不要选带面板的（宝塔等），纯净系统最省事。

---

## 2. 首次登录 + 安全加固

拿到 IP 和 root 密码后：

```bash
ssh root@你的服务器IP
```

### 2.1 更新系统

```bash
apt update && apt upgrade -y
apt install -y curl wget git ufw unzip
```

### 2.2 建普通用户（别一直用 root）

```bash
adduser --disabled-password --gecos "" tesla
usermod -aG sudo tesla
```

### 2.3 配 SSH 密钥登录

**在你本地 Mac 上**（新开一个终端）：

```bash
# 如果已有密钥就跳过
[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519 -C "tesla-dash" -f ~/.ssh/id_ed25519 -N ""

# 把公钥传上去
ssh-copy-id -i ~/.ssh/id_ed25519.pub tesla@你的服务器IP
```

测试密码无关登录：

```bash
ssh -i ~/.ssh/id_ed25519 tesla@你的服务器IP
```

能免密进去后，**回到 root 会话**：

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

> ⚠️ **做完这步先别断开**，另开一个窗口确认 `ssh tesla@IP` 还能进，再关旧会话。

### 2.4 防火墙

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

**注意：8787 端口不要开**。应用只监听 `127.0.0.1`，由 Caddy 反代。

---

## 3. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker tesla
```

退出重登，让用户组生效：

```bash
exit
ssh tesla@你的服务器IP
docker version
```

装 compose 插件：

```bash
sudo apt install -y docker-compose-plugin
docker compose version
```

### 3.1 换 Docker 镜像源（国内加速）

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com"
  ]
}
EOF
sudo systemctl restart docker
```

---

## 4. 本地准备 + 上传

### 4.1 交叉编译 `tesla-control`（关键！）

你 Mac 上那个是 `Mach-O arm64`，Linux 跑不了。

**在本地 Mac 上**：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
./scripts/build-linux.sh amd64
```

看到这个就对了：

```
bin/tesla-control-linux-amd64: ELF 64-bit LSB executable, x86-64, statically linked
```

> 如果 VPS 是 ARM（少见），用 `./scripts/build-linux.sh arm64`，并改 Dockerfile 里的文件名。

### 4.2 打包

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash

tar czf /tmp/tesla-dash.tgz \
  --exclude='node_modules' \
  --exclude='*.png' \
  --exclude='*.zip' \
  --exclude='netlify-drop' \
  --exclude='netlify-rewrite' \
  --exclude='bin/tesla-control' \
  --exclude='.git' \
  server.mjs db.mjs recorder.mjs \
  public bin keys data scripts \
  Dockerfile docker-compose.yml .dockerignore .env

ls -lh /tmp/tesla-dash.tgz
```

> **`data/` 里带着** token 和数据库 → 上去不用重新授权特斯拉。

### 4.3 上传

```bash
scp /tmp/tesla-dash.tgz tesla@你的服务器IP:/tmp/
```

### 4.4 在服务器上解包

```bash
ssh tesla@你的服务器IP

sudo mkdir -p /opt/tesla-dash
sudo chown tesla:tesla /opt/tesla-dash

cd /opt/tesla-dash
tar xzf /tmp/tesla-dash.tgz

# 权限收紧
chmod 600 .env
chmod 700 keys
chmod 600 keys/private-key.pem
chmod +x bin/tesla-control-linux-amd64

ls -la
```

---

## 5. 配置 `.env`

```bash
cd /opt/tesla-dash
nano .env
```

**必须改这两处**：

```ini
MODE=fleet
TESLA_REGION=cn
TESLA_CLIENT_ID=<特斯拉CLIENT_ID>
TESLA_CLIENT_SECRET=你的密钥

# ↓ 改成你的域名（第 7 步配好域名再填也行，但必须和特斯拉后台一致）
TESLA_REDIRECT_URI=https://dash.你的域名.com/auth/callback

# ↓ 必须是强密码，公网必备
APP_PASSWORD=换一个强密码

HOST=127.0.0.1
PORT=8787
ALLOW_COMMANDS=1
POLL_INTERVAL_SEC=60
RETENTION_DAYS=90
```

`Ctrl+O` 保存，`Ctrl+X` 退出。

```bash
chmod 600 .env
```

---

## 6. 启动

```bash
cd /opt/tesla-dash
docker compose up -d --build
```

第一次构建约 1~3 分钟。看日志：

```bash
docker compose logs -f
```

应该看到：

```
  ⚡ Tesla Dash
  模式     : fleet  (Fleet API)
  区域     : cn  →  https://fleet-api.prd.cn.vn.cloud.tesla.cn
  OAuth    : 已配置
  Token    : 已有 (oauth)
  数据库   : /app/data/tesla.db
  访问控制 : 需要密码登录
  远程控制 : 已开启
```

本地验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/.well-known/appspecific/com.tesla.3p.public-key.pem
# 期望 200
```

---

## 7. 域名 + HTTPS（Caddy 自动证书）

### 7.1 加 DNS 记录

在你的域名控制台加一条 **A 记录**：

| 类型 | 主机记录 | 值 |
|---|---|---|
| A | `dash` | 你的服务器 IP |

等解析生效（1~10 分钟）：

```bash
dig +short dash.你的域名.com
# 应输出服务器 IP
```

> ⚠️ 解析没生效前**不要**启动 Caddy，否则证书申请会失败并触发限流。

### 7.2 装 Caddy

```bash
sudo apt install -y caddy
```

### 7.3 配置反代

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
dash.你的域名.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        -Server
    }
}
EOF

sudo systemctl reload caddy
sudo systemctl status caddy --no-pager | head -5
```

Caddy 会**自动申请 Let's Encrypt 证书**，约 10~30 秒。

验证：

```bash
curl -sI https://dash.你的域名.com | head -3
# 期望 HTTP/2 200 或 302
```

---

## 8. 特斯拉后台：只加「允许的重定向 URI」

打开：https://developer.tesla.cn/dashboard/app-details/<特斯拉CLIENT_ID>

**「允许的重定向 URI」** → 新增：

```
https://dash.你的域名.com/auth/callback
```

点更新。

### ⚠️ 关键提醒

| 字段 | 要不要加新域名 |
|---|---|
| **允许的重定向 URI** | ✅ **必须加** |
| **允许的源 URL** | ❌ **先别加** |

**为什么别加「允许的源」**：你之前加 `sseeee.com` 时被特斯拉判「域无效」，卡了很久。而**只读数据 + 指令功能都不依赖「允许的源」**——它主要用于 CORS 和伙伴注册域名匹配，而我们的伙伴注册域名是 Netlify，公钥也在 Netlify，完全不用动。

> 如果哪天你要用 Fleet Telemetry 或换公钥域名，才需要动「允许的源」。

### 8.1 改 `.env` 里的回调地址

如果第 5 步填的还是占位符：

```bash
cd /opt/tesla-dash
nano .env     # 改 TESLA_REDIRECT_URI
docker compose restart
```

---

## 9. 验证清单

逐条打勾：

```bash
# ① 本地健康
curl -s -o /dev/null -w "本地: %{http_code}\n" http://127.0.0.1:8787/.well-known/appspecific/com.tesla.3p.public-key.pem

# ② 公网可达 + 强制登录
curl -s -o /dev/null -w "公网首页: %{http_code} → %{redirect_url}\n" https://dash.你的域名.com/
# 期望 302 到 /login

curl -s -o /dev/null -w "公网API未登录: %{http_code}\n" https://dash.你的域名.com/api/status
# 期望 401

# ③ 公钥（特斯拉要抓的）必须公开
curl -s -o /dev/null -w "公钥: %{http_code}\n" https://dash.你的域名.com/.well-known/appspecific/com.tesla.3p.public-key.pem
# 期望 200

# ④ 证书
echo | openssl s_client -connect dash.你的域名.com:443 -servername dash.你的域名.com 2>/dev/null | openssl x509 -noout -dates
```

浏览器测试：

1. 打开 `https://dash.你的域名.com` → 看到登录页
2. 输 `APP_PASSWORD` → 进看板
3. 能看到车的数据 → ✅ 全链路通
4. 点「开启」空调 → 如果已配对，车会真的启动

---

## 10. 日常运维

### 看日志

```bash
cd /opt/tesla-dash
docker compose logs -f --tail=50
docker compose logs -f | grep 指令      # 只看控制指令
```

### 更新代码

本地改完 → 重新打包上传：

```bash
# 本地
tar czf /tmp/tesla-dash.tgz --exclude='node_modules' --exclude='*.png' --exclude='*.zip' \
  --exclude='netlify-drop' --exclude='netlify-rewrite' --exclude='bin/tesla-control' --exclude='.git' \
  server.mjs db.mjs recorder.mjs public bin keys data scripts Dockerfile docker-compose.yml .dockerignore .env
scp /tmp/tesla-dash.tgz tesla@IP:/tmp/

# 服务器
cd /opt/tesla-dash && tar xzf /tmp/tesla-dash.tgz && docker compose up -d --build
```

> 注意：只改前端（`public/`）不用重启容器，刷新浏览器即可（静态文件不缓存）。

### 备份数据（重要）

```bash
cd /opt/tesla-dash
tar czf ~/tesla-backup-$(date +%F).tar.gz data/

# 拉回本地
# （在本地 Mac 跑）
scp tesla@IP:~/tesla-backup-*.tar.gz ~/Desktop/
```

**建议加个定时备份**：

```bash
crontab -e
# 加一行：每天凌晨 3 点备份，保留 7 天
0 3 * * * cd /opt/tesla-dash && tar czf ~/tesla-backup-$(date +\%F).tar.gz data/ && find ~ -name 'tesla-backup-*.tar.gz' -mtime +7 -delete
```

### 重启 / 停止

```bash
cd /opt/tesla-dash
docker compose restart      # 重启
docker compose down         # 停止
docker compose up -d        # 启动
```

---

## 11. 排错

| 现象 | 原因 | 解决 |
|---|---|---|
| `docker compose build` 卡住 | Docker Hub 拉不动 | 配镜像加速（第 3.1 步），或重试 |
| 容器起来就退出 | `.env` 格式错 / 缺文件 | `docker compose logs` 看报错 |
| 502 Bad Gateway | 容器没跑起来 | `docker compose ps` + `logs` |
| Caddy 证书申请失败 | DNS 没生效 / 80 端口被封 | 先 `dig` 确认，再 `ufw status` |
| 登录后白屏 | 静态资源 404 | 确认 `public/` 传上去了 |
| 指令报 `missing scopes` | token 缺 `vehicle_cmds` | 本地重新授权后重新上传 `data/` |
| 指令报 `not been paired` | 虚拟密钥没配对 | 在车旁用 `scripts/pair-key.sh` 或手机 `_ak` 链接配对 |
| 车一直离线 | 车在休眠 | 页面点「唤醒车辆」 |
| 邮件/日志提示 token 失效 | refresh token 过期（3个月） | 重新走一次 OAuth |

### 进容器里看

```bash
docker compose exec tesla-dash sh
ls -la /app/data
cat /app/data/.tokens.json | head -c 100
```

---

## 12. 成本汇总

| 项 | 费用 |
|---|---|
| 香港 VPS 2C2G | ¥60-80/月 |
| 域名（已有 sseeee.com） | 0 |
| Let's Encrypt 证书 | 0 |
| Netlify 公钥托管 | 0 |
| **合计** | **约 ¥70/月** |

---

# 一条命令速查（熟练后）

```bash
# 本地
./scripts/build-linux.sh amd64 && \
tar czf /tmp/td.tgz --exclude='node_modules' --exclude='*.png' --exclude='*.zip' \
  --exclude='netlify-*' --exclude='bin/tesla-control' --exclude='.git' \
  server.mjs db.mjs recorder.mjs public bin keys data scripts Dockerfile docker-compose.yml .dockerignore .env && \
scp /tmp/td.tgz tesla@IP:/tmp/

# 服务器
ssh tesla@IP 'cd /opt/tesla-dash && tar xzf /tmp/td.tgz && docker compose up -d --build && docker compose logs --tail=20'
```

---

# 安全必查清单

部署完逐条确认：

- [ ] `APP_PASSWORD` 是强密码（≥16 位随机）
- [ ] `8787` 端口**没有**在 ufw 里放行
- [ ] `docker-compose.yml` 里端口是 `127.0.0.1:8787:8787`
- [ ] `.env` 权限 `600`
- [ ] `keys/private-key.pem` 权限 `600`，`keys/` 权限 `700`
- [ ] SSH 已禁用密码登录
- [ ] 容器日志有轮转（compose 里已配 `max-size: 10m`）
- [ ] 有定时备份
- [ ] **`keys/private-key.pem` 没有出现在任何公网路径上**

> 最后一条最重要：**私钥 = 能开你车门**。现在它只在服务器上，且只读挂载进容器。
