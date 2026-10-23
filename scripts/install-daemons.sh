#!/bin/bash
# 安装 launchd 守护：开机自启 + 崩溃自动重启 + 防睡眠 + 每日备份
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/Users/zhangweiwei/.nvm/versions/node/v24.16.0/bin/node"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/tesla-dash"
mkdir -p "$LA" "$LOGS"

install_agent() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
  echo "  ✓ $label"
}

# ---------- 1. 主服务 ----------
cat > "$LA/com.tesladash.server.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tesladash.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$PROJ/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
EOF
install_agent com.tesladash.server "$LA/com.tesladash.server.plist"

# ---------- 2. 隧守护 ----------
cat > "$LA/com.tesladash.tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tesladash.tunnel</string>
  <key>ProgramArguments</key>
  <array><string>$PROJ/scripts/tunnel.sh</string><string>8787</string></array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOGS/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/tunnel.err.log</string>
</dict>
</plist>
EOF
install_agent com.tesladash.tunnel "$LA/com.tesladash.tunnel.plist"

# ---------- 3. 防睡眠（插电时） ----------
cat > "$LA/com.tesladash.caffeinate.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tesladash.caffeinate</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-s</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
install_agent com.tesladash.caffeinate "$LA/com.tesladash.caffeinate.plist"

# ---------- 4. 每日备份 03:00 ----------
cat > "$LA/com.tesladash.backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tesladash.backup</string>
  <key>ProgramArguments</key>
  <array><string>$PROJ/scripts/backup.sh</string></array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/backup.log</string>
  <key>StandardErrorPath</key><string>$LOGS/backup.err.log</string>
</dict>
</plist>
EOF
install_agent com.tesladash.backup "$LA/com.tesladash.backup.plist"

echo
echo "  日志目录: $LOGS"
echo "  备份目录: $HOME/tesla-backups"
