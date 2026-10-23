#!/bin/bash
# 一键查看服务状态
cd "$(dirname "$0")/.." || exit 1
echo "════════ 守护进程 ════════"
for L in server tunnel caffeinate backup; do
  line=$(launchctl list | grep "com.tesladash.$L")
  if [ -n "$line" ]; then
    pid=$(echo "$line" | awk '{print $1}')
    [ "$pid" = "-" ] && st="待命" || st="运行中 PID=$pid"
  else
    st="已停用"
  fi
  printf "  %-26s %s\n" "$L" "$st"
done

echo
echo "════════ 本地服务 ════════"
code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:8787/.well-known/appspecific/com.tesla.3p.public-key.pem 2>/dev/null)
[ "$code" = "200" ] && echo "  ✓ http://localhost:8787 正常" || echo "  ✗ 本地服务异常 (HTTP $code)"

echo
echo "════════ 访问入口 ════════"
TSIP=$(/usr/local/bin/tailscale ip -4 2>/dev/null | head -1)
LANIP=$(ipconfig getifaddr en0 2>/dev/null || echo "-")

printf "  本机      : http://localhost:8787  "
[ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8787/login 2>/dev/null)" = "200" ] && echo "✓" || echo "✗"

if [ -n "$TSIP" ]; then
  printf "  Tailscale : http://%s:8787  " "$TSIP"
  [ "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$TSIP:8787/login" 2>/dev/null)" = "200" ] && echo "✓（手机用这个）" || echo "✗"
else
  echo "  Tailscale : 未运行"
fi

printf "  局域网    : http://%s:8787\n" "$LANIP"

echo "════════ 采集器 ════════"
pw=$(grep '^APP_PASSWORD=' .env 2>/dev/null | cut -d= -f2-)
[ -n "$pw" ] && curl -s -c /tmp/.st.jar -X POST -d "password=$pw" -o /dev/null http://127.0.0.1:8787/login 2>/dev/null
curl -s -b /tmp/.st.jar http://127.0.0.1:8787/api/recorder 2>/dev/null | python3 -c "
import sys,json,time
try:
    d=json.load(sys.stdin)
    last = d.get('lastSampleTs')
    ago = f'{round(time.time()-last)} 秒前' if last else '无'
    print(f\"  车辆状态: {d.get('vehicleState')}\")
    print(f\"  最后采样: {ago}\")
    print(f\"  轮询次数: {d.get('polls')} | 休眠跳过: {d.get('sleeps')}\")
    print(f\"  错误    : {d.get('lastError') or '无'}\")
except Exception:
    print('  读取失败（可能需要密码）')
"

echo
echo "════════ 备份 ════════"
ls -1t ~/tesla-backups/tesla-data-*.tar.gz 2>/dev/null | head -1 | xargs -I{} echo "  最新: $(basename {})" || echo "  还没有备份"
