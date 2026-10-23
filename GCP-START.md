# GCP 免费机器部署 —— 手把手

> 目标：`https://dash.你的域名.com` 永久在线，$0/月。
> 你需要准备：Google 账号、一张能验证的银行卡（**不会扣费**）、一个域名。

---

## 第 1 步：开通 GCP（约 5 分钟）

1. 打开 <https://console.cloud.google.com>
2. 用 Google 账号登录，同意条款
3. 填**国家/地区**（选中国或其他都行）→ 填**信用卡**（验证用，$1 预授权会退还）
4. 可能会给 $300 试用金，**不用管它**，我们要的是「永久免费层」

> 卡验证失败常见原因：卡不支持境外支付。招商/中信/建行的 Visa/Mastercard 一般可以。

---

## 第 2 步：创建 VM（关键，每项都要对）

进入 <https://console.cloud.google.com/compute/instances> → **创建实例**

| 配置项 | 必须选这个 | 为什么 |
|---|---|---|
| **名称** | `tesla-dash` | 随意 |
| **区域** | **us-central1（爱荷华）** | 只有 us-west1 / us-central1 / us-east1 免费 |
| **可用区** | 任意（如 us-central1-a） | — |
| **机器类型** | 系列选 **E2** → 类型 **e2-micro** | 免费层唯一机型 |
| **启动磁盘 → 更改** | 操作系统 **Ubuntu**，版本 **Ubuntu 24.04 LTS**<br>磁盘类型 **标准永久性磁盘**<br>大小 **30 GB** | ⚠️ 磁盘类型默认可能是「均衡」，**必须改成标准**，否则会产生小额费用 |
| **防火墙** | ✅ 允许 HTTP 流量　✅ 允许 HTTPS 流量 | 不勾就没有 80/443 规则 |

### ⚠️ 外部 IP：建议改成静态

默认是**临时 IP**，机器重启后会变，DNS 就断了。

在「网络接口」里点开 → 外部 IP 选 **创建静态 IP 地址** → 名称随意 → 保留。

> 已绑在运行中 VM 上的静态 IP 不额外收费。

---

## 第 3 步：确认 VPC 防火墙（最容易漏）

GCP 有**两层**防火墙，实例内 `ufw` 只管一层。

进入 <https://console.cloud.google.com/networking/firewalls>

确认存在这两条规则：

| 名称 | 目标 | 来源 | 协议端口 |
|---|---|---|---|
| `default-allow-http` | 应用于所有实例 | 0.0.0.0/0 | tcp:80 |
| `default-allow-https` | 应用于所有实例 | 0.0.0.0/0 | tcp:443 |

**如果不存在**，点「创建防火墙规则」补上。

> 还要确认 VM 的「网络标记」里有 `http-server` 和 `https-server`。创建时勾了那两个框通常会自动加上。

---

## 第 4 步：配 DNS

在域名控制台（西部数码 / Namecheap）加一条 A 记录：

| 类型 | 主机记录 | 值 |
|---|---|---|
| A | `dash` | 第 2 步拿到的**静态 IP** |

验证（在你 Mac 上）：

```bash
dig +short dash.你的域名.com
```

**必须输出那个 IP 才能继续**，否则 Caddy 申请证书会失败并触发限流。

---

## 第 5 步：登录服务器

在 <https://console.cloud.google.com/compute/instances> 点 VM 那一行的 **SSH** 按钮，浏览器里直接开终端。

或者用本地终端（推荐，方便传文件）：

```bash
gcloud compute ssh tesla-dash --zone=us-central1-a
```

---

## 第 6 步：上传部署包

**在你 Mac 上**（新开一个终端）：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
./scripts/make-bundle.sh

gcloud compute scp dist/tesla-dash-deploy.tar.gz tesla-dash:/tmp/ --zone=us-central1-a
```

> 没有 `gcloud` 命令的话，用控制台 SSH 里的「上传文件」按钮也行。

---

## 第 7 步：一条命令部署

**在服务器上**：

```bash
sudo mkdir -p /opt/tesla-dash
sudo tar xzf /tmp/tesla-dash-deploy.tar.gz -C /opt/tesla-dash
sudo /opt/tesla-dash/scripts/cloud-bootstrap.sh dash.你的域名.com '你的强密码'
```

脚本会跑 8 个阶段（含自动加 2GB swap，因为 e2-micro 只有 1GB 内存）：

```
0/8   环境检测（x86 → 用 amd64 二进制）
0.5/8 内存检查 → 自动创建 2GB swap
1/8   装基础软件
2/8   装 Docker + compose
3/8   部署文件 + 权限收紧
4/8   生成 .env
5/8   防火墙（ufw + GCP 提示）
6/8   启动容器 + 健康检查
7/8   配 Caddy + 自动 HTTPS
8/8   打印验收信息
```

---

## 第 8 步：特斯拉后台加回调（必须做）

打开 <https://developer.tesla.cn/dashboard> → 你的应用 → **「允许的重定向 URI」** 新增：

```
https://dash.你的域名.com/auth/callback
```

保存，等 **3~10 分钟**生效。

> ⚠️ **「允许的源 URL」不用动**（之前加 `sseeee.com` 报「域无效」就是这个字段，别碰）。

---

## 第 9 步：验收

| 检查 | 命令 | 期望 |
|---|---|---|
| 本地健康 | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/.well-known/appspecific/com.tesla.3p.public-key.pem` | `200` |
| 公网未登录 | `curl -s -o /dev/null -w "%{http_code}" https://dash.你的域名.com/api/status` | `401` |
| 登录页 | `curl -s -o /dev/null -w "%{http_code}" https://dash.你的域名.com/login` | `200` |
| 证书 | `curl -sI https://dash.你的域名.com \| head -1` | `HTTP/2 200` |

然后浏览器打开 `https://dash.你的域名.com`：

1. 输密码登录
2. 能看到车的数据
3. 点「开启」空调 → 车会真的启动

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `docker compose build` 卡住 | 镜像拉取慢 | 脚本已配 daocloud 加速，重跑即可 |
| 证书申请失败 | DNS 没生效 | `dig` 确认后再 `sudo systemctl reload caddy` |
| 502 Bad Gateway | 容器没起 | `cd /opt/tesla-dash && docker compose logs` |
| 打不开 80/443 | VPC 防火墙缺失 | 回第 3 步 |
| 构建时 OOM | 内存不足 | 脚本会自动加 swap；确认 `free -m` 看到 Swap |
| 登录后提示缺权限 | token 缺 vehicle_cmds | 本地 `/auth/login` 重新授权后重新上传 `data/` |
| 指令报未配对 | 虚拟密钥没配 | 你已经配过了，`data/` 传上去就带着 |

---

## 日常运维

```bash
cd /opt/tesla-dash

docker compose logs -f          # 看日志
docker compose logs -f | grep 指令
docker compose restart          # 重启
docker compose down             # 停止

# 备份（建议加 crontab）
tar czf ~/backup-$(date +%F).tar.gz data/
```

---

## 费用提醒

- e2-micro + 30GB 标准盘 + 北美 1GB 出网 = **免费层覆盖**
- **外部 IPv4 可能单独计费**（Google 2023 年起对外部 IP 收费）
- 上线 24 小时后，去 <https://console.cloud.google.com/billing> 看一眼实际费用
- 如果出现几美元，告诉我，我帮你换成 Cloudflare Tunnel 方案（去掉公网 IP 依赖）

**无论超没超，都建议设个预算提醒**：Billing → 预算和提醒 → 设 $1 上限。
