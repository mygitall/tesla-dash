# 换 VPS / 数据恢复手册

> 目标：任何一台新服务器上，30 分钟内把整套服务恢复起来。

---

## 一、备份里有什么

七牛云 `tesla-backup/daily/` 下每天一个加密包（AES-256）：

```
app/
  data/tesla.db          全部采样、行程、充电记录
  data/.tokens.json      特斯拉 OAuth 令牌（恢复后无需重新授权）
  data/settings.json     自动锁、充电基线
  data/.access-key       免密登录密钥
  data/session.secret    会话签名密钥
  data/phone-pub.pem     手机钥匙公钥
  .env                   特斯拉 client_id/secret、APP_PASSWORD
  docker-compose.yml     容器编排
system/
  etc/caddy/Caddyfile    反向代理 + 自动 HTTPS
  etc/cron.d/tesla-*     定时任务（备份、健康检查）
  etc/logrotate.d/       日志轮转
  etc/tesla-backup.env   七牛 AK/SK（加密存放在备份里）
  usr/local/bin/tesla-*  备份/恢复脚本
```

**保留 30 天，每天 03:10 自动上传，每周日自动校验可恢复。**

---

## 二、恢复数据（同机）

### 场景 A：数据被误删 / 损坏，服务器还在

```bash
# 1) 看云端有哪些备份
tesla-backup-qiniu.sh list

# 2) 恢复最新一份到临时目录
tesla-backup-qiniu.sh restore

# 3) 先停服务，再覆盖数据
cd /opt/tesla-dash
docker compose down
cp -a /tmp/tesla-restore/app/data/. ./data/
docker compose up -d

# 4) 验证
curl -s localhost:8787/api/status | head -5
```

> 只恢复数据库：`cp /tmp/tesla-restore/app/data/tesla.db ./data/`

### 场景 B：恢复指定某天的备份

```bash
tesla-backup-qiniu.sh list
tesla-backup-qiniu.sh restore daily/tesla-2026-10-24-09-45-12.tar.gz.enc
```

---

## 三、换 VPS（完整迁移）

### 前提：域名不变

只要继续用 `www.zhangweiwei.cc`：

- ✅ 特斯拉 partner 域名注册**不用重做**
- ✅ OAuth 回调地址**不用改**
- ✅ 令牌在 `data/.tokens.json` 里，恢复后**直接可用**
- ✅ Caddy 会自动为新 IP 重新签发证书

### 步骤

#### 1. 新机器装基础环境（Ubuntu 24.04）

```bash
apt update && apt install -y curl git ufw unzip nodejs
# Docker
curl -fsSL https://get.docker.com | sh
# Caddy
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
# 防火墙
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

#### 2. 拿到七牛凭据

**这一步是唯一的"鸡生蛋"问题** —— 下载备份需要 AK/SK，而 AK/SK 又存在备份里。

所以：**把 `/etc/tesla-backup.env` 的内容单独存一份到你的密码管理器**，或留在旧机器上 scp 过来。

```bash
# 旧机器上
cat /etc/tesla-backup.env
```

#### 3. 新机器恢复

```bash
# 写入凭据
cat > /etc/tesla-backup.env <<'EOF'
QINIU_AK=...
QINIU_SK=...
QINIU_BUCKET=tesla-backup
QINIU_DOMAIN=tnen2tn8t.hd-bkt.clouddn.com
QINIU_SCHEME=http
BACKUP_PASS=<备份密码见本地凭证>
BACKUP_KEEP_DAYS=30
APP_DIR=/opt/tesla-dash
EOF
chmod 600 /etc/tesla-backup.env

# 装恢复脚本
curl -o /usr/local/bin/tesla-qiniu-backup.mjs <从旧机器拷或从备份里取>
chmod +x /usr/local/bin/tesla-qiniu-backup.mjs

# 恢复
mkdir -p /opt/tesla-dash
/usr/local/bin/tesla-qiniu-backup.mjs restore      # 需要环境变量，见下
```

> 更省事的办法：先在旧机器 `scp /usr/local/bin/tesla-*` 和新 `.env` 过来，
> 再在新机器跑 `tesla-backup-qiniu.sh restore`。

#### 4. 还原文件

```bash
cp -a /tmp/tesla-restore/app/. /opt/tesla-dash/
cp -a /tmp/tesla-restore/system/. /
systemctl reload caddy
```

#### 5. 改 DNS

```
域名控制台 → zhangweiwei.cc → DNS
  www   A   → 新 IP
  dash  A   → 新 IP
  @     A   → 新 IP（可选）
```

**生效后 Caddy 会自动申请新证书**（1~3 分钟）。

#### 6. 验证清单

```bash
# 容器
docker compose ps                          # 应为 healthy
# 接口
curl -s https://www.zhangweiwei.cc/api/status | head -3
# 证书
curl -sI https://www.zhangweiwei.cc | grep -i strict-transport
# 数据行数
docker compose exec tesla-dash node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/app/data/tesla.db");
console.log(db.prepare("SELECT COUNT(*) n FROM samples").get());
'
# 定时任务
cat /etc/cron.d/tesla-*
```

---

## 四、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| App 打不开数据 | 容器挂了 | `docker compose up -d` |
| 502 | Caddy 或容器异常 | `systemctl status caddy` / `docker compose logs` |
| 特斯拉指令全部失败 | token 失效 | 见 DEPLOYED.md「重新授权」 |
| 数据全空 | 数据库被删 | 用本手册第二节恢复 |
| 证书过期 | Caddy 挂了 | `systemctl restart caddy` |
| 备份上传失败 | 七牛欠费/密钥失效 | `tail /var/log/tesla-qiniu-backup.log` |

---

## 五、手动操作速查

```bash
# 立即备份一次
tesla-backup-qiniu.sh backup

# 看云端备份
tesla-backup-qiniu.sh list

# 校验最新备份能恢复
tesla-backup-qiniu.sh verify

# 本地备份（保留 7 份，在 /root/backups）
/usr/local/bin/tesla-backup.sh

# 健康检查
/usr/local/bin/tesla-health.sh
```
