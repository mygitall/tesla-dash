# 监控体系说明

三层监控，任何一层出问题都会主动通知你。

## 全景

| 层级 | 运行位置 | 频率 | 检测内容 | 通知渠道 |
|---|---|---|---|---|
| 业务层 | VPS（tesla-watch） | 5 分钟 | 令牌/采集/备份/磁盘/容器/接口 | Bark 推送手机 |
| 访问层 | Mac（watch-site） | 5 分钟 | 网站能否从外网访问 | Bark 推送手机 |
| 整机层 | UptimeRobot（云端） | 5 分钟 | 网站是否在线（服务器全挂也能发现）| 邮件 |

---

## 业务层：tesla-watch（VPS）

脚本：`/usr/local/bin/tesla-watch.mjs`
定时：`/etc/cron.d/tesla-watch`（每 5 分钟）
配置：`/etc/tesla-alert.env`

检查项：

| ID | 名称 | 失败含义 |
|---|---|---|
| http | 服务可访问性 | 容器挂了或进程卡死 |
| api | 接口响应 | 鉴权异常 |
| token | 特斯拉令牌 | 超过 30 小时未刷新 → 全站瘫痪 |
| sampler | 数据采集器 | 5 分钟无心跳 → 采集中断 |
| backup | 备份新鲜度 | 30 小时无新备份 |
| disk | 磁盘空间 | 占用 > 85% |
| container | 容器状态 | 非 running/healthy |

去重：同一问题 1 小时内不重复推送；恢复时推一条「已恢复」。

命令：

```bash
tesla-watch.sh status    # 查看当前状态
tesla-watch.sh run       # 立即巡检
tesla-watch.sh test      # 发测试推送
```

配置告警渠道：

```bash
tesla-alert-setup.sh bark     https://api.day.app/你的KEY
tesla-alert-setup.sh dingtalk 'https://oapi.dingtalk.com/robot/send?access_token=xxx'
tesla-alert-setup.sh wecom    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx'
```

---

## 访问层：Mac 端监控

脚本：`~/TeslaDashBackup/watch-site.sh`
定时：`~/Library/LaunchAgents/com.zhangweiwei.teslawatch.plist`（每 5 分钟）
日志：`~/TeslaDashBackup/watch-site.log`

逻辑：连续 2 次访问失败（10 分钟）才推送，避免网络抖动误报。

> 局限：Mac 关机/睡眠时不起作用，所以需要第三层。

---

## 整机层：UptimeRobot

- 地址：https://uptimerobot.com
- 监控 URL：`https://www.zhangweiwei.cc/health`
- 类型：HTTP(s)，5 分钟间隔
- 通知：邮件（zhangweiweiguo@gmail.com）
- 状态：**已配置并验证**（测试通知已收到）

`/health` 是公开端点，只返回 `{"ok":true,"ts":...}`，不含任何敏感信息。

> ⚠️ 如果以后**更换域名**，这里要改 URL；更换 VPS（域名不变）则不用动。

---

## 恢复演练记录

2026-10-24 验证：备份可从七牛完整恢复，12 项检查全部通过（详见 RECOVER.md）。

---

## 换 VPS 后哪些要重配

| 项目 | 需要重配吗 |
|---|---|
| Bark 密钥 | ❌ 在备份里，自动恢复 |
| tesla-watch 巡检 | ❌ 在备份里，自动恢复 |
| Mac 端监控 | ❌ 域名没变，不用动 |
| UptimeRobot | ❌ 配置在它云端，不用动 |
| 换域名时 | ✅ UptimeRobot 改 URL + Mac 脚本改域名 |
