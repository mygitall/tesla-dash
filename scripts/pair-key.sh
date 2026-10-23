#!/bin/bash
# 给车辆添加虚拟密钥（必须蓝牙范围内运行 —— 把电脑拿到车旁边）
# 用法: ./scripts/pair-key.sh [VIN] [ROLE] [FORM_FACTOR]
#   ROLE        : owner | driver | fm | vehicle_monitor | charging_manager
#   FORM_FACTOR : cloud_key | nfc_card | ios_device | android_device
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

KEY="keys/private-key.pem"
PUB="keys/public-key.pem"
TOKFILE="/tmp/tesla-pair-token.txt"

[ -f "$KEY" ] || { echo "✗ 找不到 $KEY"; exit 1; }
[ -f "$PUB" ] || { echo "✗ 找不到 $PUB"; exit 1; }

# 取 token
python3 - "$TOKFILE" <<'PY'
import json, sys
d = json.load(open('data/.tokens.json'))
open(sys.argv[1], 'w').write(d['access_token'])
PY
chmod 600 "$TOKFILE"

# 取 VIN
if [ -n "${1:-}" ]; then
  VIN="$1"
else
  VIN=$(python3 - <<'PY'
import json, urllib.request, urllib.parse, sys
env = {}
for line in open('.env', encoding='utf-8'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1); env[k.strip()] = v.strip()
aud = 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
tok = json.load(open('data/.tokens.json'))['access_token']
req = urllib.request.Request(aud + '/api/1/vehicles', headers={'Authorization': 'Bearer ' + tok})
try:
    d = json.loads(urllib.request.urlopen(req, timeout=20).read())
    print(d['response'][0]['vin'])
except Exception as e:
    print('', end='')
PY
)
fi
[ -n "$VIN" ] || { echo "✗ 拿不到 VIN，请手动传入：./scripts/pair-key.sh <VIN>"; exit 1; }

ROLE="${2:-owner}"
FORM="${3:-cloud_key}"

echo "  车辆 VIN : $VIN"
echo "  角色     : $ROLE"
echo "  形态     : $FORM"
echo
echo "⚠️  现在请在【中控屏】上准备刷钥匙卡确认（约 30 秒内）"
echo

./bin/tesla-control \
  -key-file "$KEY" \
  -vin "$VIN" \
  -token-file "$TOKFILE" \
  -command-timeout 90s -connect-timeout 60s \
  add-key-request "$PUB" "$ROLE" "$FORM" 2>&1 | tail -6

echo
echo "如果看到成功提示，配对完成。回页面点「开启」试试空调。"
