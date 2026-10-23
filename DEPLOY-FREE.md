# 零成本部署：不买 VPS 的三种方案

> 结论先放前面：**免费 PaaS 基本全军覆没，真正能用的只剩两家云厂商的「永久免费层」**，
> 再加一个「用你自己电脑」的兜底方案。

---

## 0. 先说清楚：为什么免费的 PaaS 都不行

我们这套东西有三个硬要求，普通免费 PaaS 全部满足不了：

| 要求 | 为什么 |
|---|---|
| **常驻进程** | 采集器每 60 秒轮询特斯拉，不能休眠 |
| **持久文件系统** | SQLite 数据库 + token + 签名会话缓存 |
| **能执行二进制** | `tesla-control` 是我们自己编译的 Go 程序 |

对照结果：

| 平台 | 能否用 | 致命问题 |
|---|---|---|
| **Render** | ❌ | 免费 Web 服务 **15 分钟无访问就休眠**；免费层**没有持久磁盘** |
| **Fly.io** | ❌ | 2024 年已取消免费额度 |
| **Railway** | ❌ | 只剩 $5 试用金，用完就停 |
| **Koyeb / Zeabur** | ❌ | 免费层无持久卷，或已收紧 |
| **Vercel / Netlify / Cloudflare Workers** | ❌ | 无文件系统、无常驻进程，且**不能执行 `tesla-control`** |
| **Replit / Glitch** | ❌ | 会休眠、限时长 |

所以「免费 + 稳定」只剩两条路：**云厂商的永久免费层**，或者**用你自己的机器**。

---

# ⚡ 最快路径（已全部脚本化）

> 你只需要：**① 开通免费云机器 ② 配 DNS ③ 跑一条命令**。
> 其余（Docker、防火墙、容器、HTTPS 证书）全部自动完成。

## 第 1 步：开一台免费机器（只有你能做）

### 选项 A：Google Cloud（推荐——最稳，基本不会失败）

1. <https://console.cloud.google.com> → Compute Engine → **创建实例**
2. 配置：
   | 项 | 值 |
   |---|---|
   | 名称 | `tesla-dash` |
   | 区域 | **us-central1（爱荷华）** ← 必须这三个免费区之一 |
   | 机器类型 | **e2-micro** |
   | 启动磁盘 | **Ubuntu 24.04 LTS**，30 GB 标准永久性磁盘 |
   | 防火墙 | ✅ 允许 HTTP 流量　✅ 允许 HTTPS 流量 |
3. 创建后，在「VPC 网络 → 防火墙」确认有 `default-allow-http` 和 `default-allow-https`
4. 记下**外部 IP**

### 选项 B：Oracle Cloud（免费规格更大）

1. <https://www.oracle.com/cloud/free> 注册，**Home Region 选日本/新加坡**
2. 建实例：
   | 项 | 值 |
   |---|---|
   | 镜像 | Ubuntu 24.04 |
   | Shape | **VM.Standard.E2.1.Micro**（x86，1GB，最不容易被回收）<br>或 **VM.Standard.A1.Flex**（ARM，2核12GB，可能抢不到） |
3. **安全列表要开 22 / 80 / 443**（OCI 控制台 → VPC → Security Lists）
4. 记下**公网 IP**

> 抢不到 ARM 就用 E2.1.Micro。脚本会自动识别架构。

## 第 2 步：配 DNS

在域名控制台加一条 A 记录：

| 类型 | 主机 | 值 |
|---|---|---|
| A | `dash` | 你的服务器 IP |

验证：

```bash
dig +short dash.你的域名.com
```

**必须等到输出 IP 再往下走**，否则证书申请会失败。

## 第 3 步：打包并上传（在你的 Mac 上）

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash

# 生成部署包（约 18MB，含两个架构的二进制）
./scripts/make-bundle.sh

# 上传
scp dist/tesla-dash-deploy.tar.gz 用户名@服务器IP:/tmp/
```

## 第 4 步：登服务器，一条命令搞定

```bash
ssh 用户名@服务器IP

# 解包
sudo mkdir -p /opt/tesla-dash
sudo tar xzf /tmp/tesla-dash-deploy.tar.gz -C /opt/tesla-dash

# 一键初始化（换成你的域名和密码）
sudo /opt/tesla-dash/scripts/cloud-bootstrap.sh dash.你的域名.com '你的强密码'
```

脚本会自动完成：

```
0/8 环境检测（x86/ARM 自动选二进制）
1/8 装基础软件
2/8 装 Docker + compose
3/8 部署应用文件 + 权限收紧
4/8 生成 .env（回调地址、密码、HOST、ALLOW_COMMANDS）
5/8 防火墙（ufw + Oracle iptables 自动识别）
6/8 启动容器 + 健康检查
7/8 配 Caddy + 自动申请 HTTPS 证书
8/8 打印验收信息
```

**脚本可重复执行**，改配置后重跑即可。

## 第 5 步：特斯拉后台加回调（必须）

打开 <https://developer.tesla.cn/dashboard> → 「允许的重定向 URI」新增：

```
https://dash.你的域名.com/auth/callback
```

保存，等 **3~10 分钟**生效。

> ⚠️ 「允许的源 URL」**不用动**（之前加 `sseeee.com` 报「域无效」就是这个字段）。

## 第 6 步：验收

浏览器打开 `https://dash.你的域名.com` → 登录页 → 输密码 → 看到车的数据。

或者在服务器上跑：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dash.你的域名.com/login
# 期望 200
```

---


---

## 1. 三个真实可选项

| 方案 | 真免费 | 要信用卡 | 独立于你的电脑 | 稳定性 |
|---|---|---|---|---|
| **A. Oracle Cloud Always Free** | ✅ 永久 | ✅ 要（验证身份，不扣费） | ✅ 是 | 高（有一个坑，见下） |
| **B. Google Cloud e2-micro** | ✅ 永久 | ✅ 要 | ✅ 是 | 高，但**只在美国 3 个区** |
| **C. Tailscale + 你的 Mac** | ✅ 免费 | ❌ **不要** | ❌ 依赖 Mac 开机 | 取决于 Mac |

> 数据来源：[Free VPS in 2026（2026-09-11 核对官方文档）](https://klymentiev.com/blog/free-vps)
> Oracle 在 2026-06-15 悄悄把免费 ARM 配额**从 4核24G 砍到 2核12G**，未发公告（[报道](https://korben.info/en/oracle-quietly-cuts-free-arm-offer-in-half.html)）。网上还在写「4核24G」的教程，已经过时了。

---

# 方案 A：Oracle Cloud Always Free（推荐）

## 规格（2026 年现状）

| 项 | 额度 |
|---|---|
| ARM Ampere A1 | **2 核 + 12 GB 内存**，常驻 |
| 或 AMD micro | 2 台，各 1/8 核 + 1 GB |
| 存储 | 200 GB 块存储 |
| 流量 | 10 TB/月 |
| 时长 | **永久，不限期** |

这对我们绰绰有余（Node 只吃 60MB 内存）。

## A.1 注册

1. 打开 <https://www.oracle.com/cloud/free>
2. 注册（要信用卡验证，**只要不超额就不会扣费**）
3. **Home Region 选：日本（东京/大阪）、新加坡、韩国首尔**
   - ⚠️ 别选中国大陆/香港（香港有时没免费 ARM 名额）
   - 选好**不能改**，慎重
4. 完成手机+邮箱验证

## A.2 创建实例

进入控制台 → Compute → Instances → **Create Instance**

| 配置项 | 选什么 |
|---|---|
| Image | **Ubuntu 24.04** |
| Shape | **Ampere / VM.Standard.A1.Flex** |
| OCPU | **2**（或先 1 试试） |
| Memory | **12 GB**（或按 1:6 配比） |
| Boot volume | 默认 47GB 够用 |

### ⚠️ 报 `Out of host capacity` 怎么办

这是 Oracle 最常见的坑——免费 ARM 名额抢不到。三个办法：

**① 换可用域（Availability Domain）**
建实例时把 AD-1 / AD-2 / AD-3 挨个试。

**② 降低配置**
1 OCPU + 6GB 更容易抢到，够我们用。

**③ 写脚本定时重试**（放本地 Mac 上跑）

```bash
# 需要先装 OCI CLI 并配置好 ~/.oci/config
while true; do
  oci compute instance launch \
    --compartment-id "$COMPARTMENT_ID" \
    --availability-domain "$AD" \
    --shape VM.Standard.A1.Flex \
    --shape-config '{"ocpus":2,"memoryInGBs":12}' \
    --image-id "$IMAGE_ID" \
    --subnet-id "$SUBNET_ID" \
    --assign-public-ip true \
    --display-name tesla-dash \
    && break
  echo "[$(date +%H:%M)] 容量不足，60 秒后重试"
  sleep 60
done
```

## A.3 ⚠️ Oracle 有「两道防火墙」

这是最容易卡住的地方：

| 层级 | 位置 | 要开什么 |
|---|---|---|
| **① 安全列表（Security List）** | OCI 控制台 → VCN → Security Lists | **80 / 443 / 22** |
| **② 系统 iptables** | 实例内部 | Ubuntu 默认有 iptables 规则 |

OCI 的 Ubuntu 镜像预装了 iptables 规则，**光开安全列表还不够**，实例内部还要放行：

```bash
# 在实例里执行
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

然后再配 ufw（ufw 和 iptables 会叠加，按 DEPLOY-VPS.md 第 2.4 步做）。

## A.4 剩下的步骤

**和 [DEPLOY-VPS.md](DEPLOY-VPS.md) 完全一样**，只有两处差异：

### 差异 1：用 ARM 版二进制

```bash
./scripts/build-linux.sh arm64
```

打包时把 `bin/tesla-control-linux-arm64` 传上去，并改 Dockerfile：

```dockerfile
COPY bin/tesla-control-linux-arm64 /app/bin/tesla-control
```

> 我已经帮你编好了（12MB，静态 ELF aarch64）。

### 差异 2：抢不到 ARM 就换 AMD（x86）

如果一直 `Out of host capacity`，就用 **VM.Standard.E2.1.Micro**（x86，1GB 内存）：

- 用现成的 `bin/tesla-control-linux-amd64`，Dockerfile 不用改
- 1GB 内存跑 Docker + Node 够用（Node 约 60MB）
- **反而更安全**——见下面的「闲置回收」

## A.5 ⚠️ 唯一真实风险：闲置回收

Oracle 有一条**没写在显眼位置**的回收规则：

> 7 天窗口内，如果 95 分位 CPU < 20% **且** 网络 < 20% **且**（A1 机型）内存 < 20%，实例可能被回收。

我们这套应用很轻：12GB 内存只用 60MB（0.5%），CPU 几乎为 0。
**理论上符合「闲置」特征。**

### 三个缓解办法

**① 用 AMD micro 机型（最省心）**
回收规则里的「内存 < 20%」只针对 **A1 机型**。AMD micro 不受这条约束。

**② 加一个轻量常驻任务**

```bash
# 每小时跑一次 30 秒的小计算，把 CPU 分位撑起来
sudo tee /etc/cron.d/keepalive > /dev/null <<'EOF'
0 * * * * root timeout 30 sh -c 'while :; do :; done' > /dev/null 2>&1
EOF
```

> 别用 `yes > /dev/null`，会吃满 CPU 影响服务。上面这个 `while :; do :; done` 加 `timeout 30` 是单核跑 30 秒。

**③ 部署一个监控面板**
顺便装个 Uptime Kuma 或 Beszel，既占一点资源又方便看状态。

---

# 方案 B：Google Cloud e2-micro

## 规格

| 项 | 额度 |
|---|---|
| 实例 | 1 台 **e2-micro**（2 共享 vCPU 突发 + **1 GB 内存**） |
| 磁盘 | 30 GB 标准盘 |
| 流量 | **1 GB/月**出网（仅北美） |
| 地区 | **只能 us-west1 / us-central1 / us-east1** |
| 时长 | 永久 |

## 适合我们吗

| 维度 | 评价 |
|---|---|
| 内存 1GB | ⚠️ 紧但够（Node 60MB + Docker 开销） |
| x86 架构 | ✅ 直接用现成 amd64 二进制 |
| 美国机房 | ⚠️ 访问特斯拉 CN API 多 ~200ms，不影响 |
| 1GB 流量 | ✅ 够——地图瓦片是**浏览器直连 OSM**，不走我们服务器 |
| 稳定性 | ✅ 很好，Google 不会随便回收 |

## 步骤要点

1. <https://console.cloud.google.com> → 建 VM
2. 区域选 **us-central1（爱荷华）**，机器类型 **e2-micro**
3. 启动盘 **Ubuntu 24.04**，30GB 标准永久性磁盘
4. 防火墙勾选 **允许 HTTP / HTTPS 流量**
5. 后面同 [DEPLOY-VPS.md](DEPLOY-VPS.md)

> 注意：GCP 的防火墙是「VPC 网络 → 防火墙规则」，和 ufw 两套都要开。

---

# 方案 C：Tailscale + 你现在的 Mac（零门槛）

**完全免费、不要信用卡、5 分钟搞定、URL 永久固定。**

唯一代价：**你的 Mac 必须开着**。

## 步骤

```bash
# Mac 上
brew install --cask tailscale

# 手机装 Tailscale App，登同一账号

# 开启 HTTPS（免费版默认关闭）
open https://login.tailscale.com/admin/dns
# → Enable HTTPS Certificates + 确认 MagicDNS 已开

# 一条命令拿到固定 HTTPS 地址
tailscale serve --bg 8787
# → https://你的机器名.你的tailnet.ts.net
```

## 让 Mac 不休眠

系统设置 → 电池 → 电源适配器 → 勾选「**防止自动进入睡眠**」

## 让服务开机自启

```bash
npm i -g pm2
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
pm2 start server.mjs --name tesla-dash
pm2 save && pm2 startup
```

## 适合谁

| 场景 | 合适吗 |
|---|---|
| 就自己手机/电脑看 | ✅ **最合适** |
| 想分享给别人 | ❌ 别人不在你 tailnet 里 |
| Mac 经常合盖带走 | ❌ 会断 |
| 不想办信用卡、不想注册云账号 | ✅ **唯一选择** |

---

# ⚠️ 顺便排除：Cloudflare 命名隧道

理论上免费且 URL 固定，但**你这台机器上有坑**：

我们之前实测过，你的 Clash（fake-IP 模式）把 `argotunnel.com` 解析成 `198.18.x.x`，
cloudflared 的 7844 端口连不通。

要用必须**先退掉 Clash**，或者给 cloudflared 加直连规则。不稳定，不建议作为首选。

---

# 最终对比

| | Oracle | GCP e2-micro | Tailscale |
|---|---|---|---|
| 花钱 | **0** | **0** | **0** |
| 要信用卡 | 要 | 要 | **不要** |
| 独立于你的电脑 | ✅ | ✅ | ❌ |
| 抢机器 | 可能抢不到 | 基本都能建 | 不用 |
| 稳定性 | 高（有回收风险） | **最高** | 取决于 Mac |
| 部署难度 | 中（两道防火墙） | 中 | **最低** |
| 适合 | 想要真服务器 | 想要最稳 | 只要自己用 |

---

# 我的建议

**按这个顺序试：**

### 第 1 步：先花 5 分钟试 Tailscale
不用注册云账号、不用信用卡。如果「Mac 一直开着」这个条件你能接受，**事情到这里就结束了**，而且比任何云方案都安全（不暴露公网）。

### 第 2 步：需要脱离 Mac → Oracle
注册约 10 分钟，部署约 30 分钟。记得：
- Home Region 选**日本/新加坡**
- 遇到 `Out of host capacity` 就降配置或换 AD
- **两道防火墙都要开**（OCI 安全列表 + 实例 iptables）
- 用 `arm64` 版本二进制

### 第 3 步：抢不到 Oracle → GCP e2-micro
美国机房、1GB 内存，够用且最稳。

---

# 已为你准备好的东西

| 文件 | 用途 |
|---|---|
| `bin/tesla-control-linux-amd64` | x86 Linux（GCP / Oracle AMD / 普通 VPS） |
| `bin/tesla-control-linux-arm64` | ARM Linux（Oracle A1） |
| `scripts/build-linux.sh` | 需要时重新交叉编译 |
| `Dockerfile` / `docker-compose.yml` | 三套方案通用 |
| `DEPLOY-VPS.md` | 部署主体步骤，A/B 方案都复用 |

> 三个方案的差别只在**买机器**和**开防火墙**，应用本身的部署步骤完全相同。
