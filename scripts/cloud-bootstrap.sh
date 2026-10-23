#!/bin/bash
# ============================================================
# 云端一键初始化 —— 在全新 Ubuntu 22.04/24.04 服务器上运行
#
# 用法:
#   sudo ./cloud-bootstrap.sh <域名> <访问密码>
# 例:
#   sudo ./cloud-bootstrap.sh dash.example.com 'MyStr0ngP@ss'
#
# 它会: 装 Docker → 解包 → 配 .env → 开防火墙 → 起容器 → 配 Caddy HTTPS
# 可重复执行（幂等）
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
PASSWORD="${2:-}"
APP_DIR=/opt/tesla-dash
BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()  { echo; blue "──── $* ────"; }

[ "$(id -u)" -eq 0 ] || { red "请用 sudo 运行"; exit 1; }
[ -n "$DOMAIN" ] || { red "缺少域名参数。用法: sudo ./cloud-bootstrap.sh <域名> <密码>"; exit 1; }
[ -n "$PASSWORD" ] || { red "缺少密码参数"; exit 1; }
[ ${#PASSWORD} -ge 8 ] || { red "密码至少 8 位"; exit 1; }

step "0/8 环境检测"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  BIN=amd64 ;;
  aarch64|arm64) BIN=arm64 ;;
  *) red "不支持的架构: $ARCH"; exit 1 ;;
esac
green "  架构: $ARCH → 使用 tesla-control-linux-$BIN"
green "  Ubuntu: $(lsb_release -ds 2>/dev/null || echo unknown)"
[ -f "$BUNDLE_DIR/bin/tesla-control-linux-$BIN" ] || { red "缺少 bin/tesla-control-linux-$BIN"; exit 1; }

step "0.5/8 内存检查（e2-micro 只有 1GB）"
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && [ ! -f /swapfile ]; then
  blue "  内存 ${MEM_MB}MB，创建 2GB swap 防止构建时 OOM…"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  green "  swap 已启用: $(free -m | awk '/Swap/ {print $2" MB"}')"
else
  green "  内存 ${MEM_MB}MB，无需 swap"
fi

step "1/8 安装基础软件"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates ufw tar >/dev/null

step "2/8 安装 Docker"
if command -v docker >/dev/null 2>&1; then
  green "  已安装: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  green "  安装完成: $(docker --version)"
fi
systemctl enable --now docker

# 国内/海外都试一下加速
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
EOF
  systemctl restart docker || true
fi
docker compose version >/dev/null 2>&1 || { red "缺少 docker compose 插件"; apt-get install -y docker-compose-plugin; }

step "3/8 部署应用文件"
mkdir -p "$APP_DIR"
# 如果脚本就在目标目录，跳过复制
if [ "$(readlink -f "$BUNDLE_DIR")" != "$(readlink -f "$APP_DIR")" ]; then
  cp -R "$BUNDLE_DIR/." "$APP_DIR/"
fi
cd "$APP_DIR"

# 选对架构的二进制
cp "bin/tesla-control-linux-$BIN" bin/tesla-control
chmod +x bin/tesla-control

# 权限
chmod 700 keys 2>/dev/null || true
chmod 600 keys/private-key.pem 2>/dev/null || true
green "  文件就位: $APP_DIR"

step "4/8 生成配置"
[ -f .env ] || { red "缺少 .env"; exit 1; }
cp .env ".env.bak.$(date +%s)"

set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    # 用 python 避免 sed 特殊字符问题
    python3 - "$k" "$v" <<'PY'
import sys, re
k, v = sys.argv[1], sys.argv[2]
p = '.env'
s = open(p, encoding='utf-8').read()
s = re.sub(rf'^{re.escape(k)}=.*$', f'{k}={v}', s, flags=re.M)
open(p, 'w', encoding='utf-8').write(s)
PY
  else
    printf '\n%s=%s\n' "$k" "$v" >> .env
  fi
}

set_env TESLA_REDIRECT_URI "https://${DOMAIN}/auth/callback"
set_env APP_PASSWORD "$PASSWORD"
set_env HOST "0.0.0.0"
set_env PORT "8787"
set_env ALLOW_COMMANDS "1"
set_env MODE "fleet"
chmod 600 .env
green "  回调地址 → https://${DOMAIN}/auth/callback"
green "  访问密码 → 已设置"

step "5/8 防火墙"
ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
green "  ufw: 22/80/443（8787 不对外开放）"

# Google Cloud 的防火墙在 VPC 层，实例内部无法修改，只能提示
if grep -qi "google" /sys/class/dmi/id/product_name 2>/dev/null || \
   grep -qi "Google Compute" /sys/class/dmi/id/bios_vendor 2>/dev/null || \
   curl -s -m 2 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name >/dev/null 2>&1; then
  blue "  检测到 Google Cloud"
  yellow "  ⚠️  GCP 还有一层 VPC 防火墙，必须在控制台确认："
  yellow "      VPC 网络 → 防火墙 → 存在 default-allow-http (tcp:80) 和 default-allow-https (tcp:443)"
  yellow "      并且这台 VM 的网络标记里含 http-server 和 https-server"
fi

# Oracle Cloud 有额外 iptables 规则，会挡住 80/443
if grep -qi "oracle" /sys/class/dmi/id/chassis_asset_tag 2>/dev/null || \
   grep -qi "oracle" /sys/class/dmi/id/product_name 2>/dev/null || \
   [ -f /etc/oci-hostname.conf ]; then
  blue "  检测到 Oracle Cloud，放行 iptables…"
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || \
      iptables -I INPUT 6 -m state --state NEW -p tcp --dport $port -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save || true
fi

step "6/8 启动容器"
docker compose down >/dev/null 2>&1 || true
docker compose up -d --build
sleep 6
if curl -sf -o /dev/null -m 10 "http://127.0.0.1:8787/.well-known/appspecific/com.tesla.3p.public-key.pem"; then
  green "  容器已启动，本地健康检查通过"
else
  red "  容器启动异常，查看日志: cd $APP_DIR && docker compose logs"
fi

step "7/8 配置 Caddy（自动 HTTPS）"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || {
    red "  apt 装 Caddy 失败，尝试官方源…"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
  }
fi

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
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
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy
green "  Caddy 已配置，证书会自动申请（约 10-30 秒）"

step "8/8 完成"
IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || echo "?")
cat <<EOF

  本地地址 : http://127.0.0.1:8787
  公网地址 : https://${DOMAIN}
  访问密码 : ${PASSWORD}
  服务器IP : ${IP}

  ⚠️  确认 DNS: ${DOMAIN} 的 A 记录必须指向 ${IP}
     检查命令: dig +short ${DOMAIN}

  接下来必须做（否则登录会失败）：
  1. 打开 https://developer.tesla.cn/dashboard
  2. 「允许的重定向 URI」新增: https://${DOMAIN}/auth/callback
  3. 保存后等 3~10 分钟生效

  常用命令:
    cd ${APP_DIR}
    docker compose logs -f          # 看日志
    docker compose restart          # 重启
    docker compose up -d --build    # 更新后重建

EOF
green "部署完成 ✅"
