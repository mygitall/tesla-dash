# 监控告警配置

## 它能监控什么

| 检查项 | 判定 | 告警示例 |
|---|---|---|
| 服务可访问性 | `/health` 200 且在 4 秒内响应 | 服务挂了 / 容器崩了 |
| 接口响应 | `/api/status` 能用免密密钥登录取到 | 鉴权坏了、进程卡死 |
| 特斯拉令牌 | 有令牌且 30 小时内刷新过 | **令牌失效（全站瘫痪）** |
| 数据采集器 | 5 分钟内有心跳 | 采集停了 |
| 备份新鲜度 | 30 小时内有新备份 | 备份任务失败 |
| 磁盘空间 | 占用 < 85% | 磁盘快满 |
| 容器状态 | running + healthy | 容器异常 |

每 5 分钟跑一次。同一问题 **1 小时内不重复推送**，恢复后推一条「已恢复」。

---

## 配置告警渠道（三选一）

### 方案 A：Bark（iPhone 推荐，2 分钟）

1. App Store 搜 **Bark** 安装（免费）
2. 打开 App，首页会显示一个地址，形如：
   ```
   https://api.day.app/AbCdEfGh123456
   ```
3. 复制该地址，在服务器执行：
   ```bash
   tesla-alert-setup.sh bark https://api.day.app/AbCdEfGh123456
   ```
4. 立刻会收到一条测试推送

### 方案 B：钉钉群机器人

1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义
2. 安全设置选「自定义关键词」，填 **Tesla**
3. 复制 Webhook，执行：
   ```bash
   tesla-alert-setup.sh dingtalk 'https://oapi.dingtalk.com/robot/send?access_token=xxx'
   ```

### 方案 C：企业微信机器人

1. 群 → 添加群机器人 → 复制 Webhook
2. 执行：
   ```bash
   tesla-alert-setup.sh wecom 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx'
   ```

---

## 检测「整机宕机」（可选，2 分钟）

上面的检查全跑在这台服务器上 —— 如果服务器直接断电/断网，它自己发不出告警。

补救办法：注册 [healthchecks.io](https://healthchecks.io)（免费）：

1. 新建 Check，Period 选 5 分钟，Grace 选 15 分钟
2. 复制 ping URL
3. 在服务器填入：
   ```bash
   sed -i 's|^HC_PING_URL=.*|HC_PING_URL=https://hc-ping.com/你的UUID|' /etc/tesla-alert.env
   ```
4. 之后服务器每 5 分钟 ping 一次；超过 15 分钟没 ping，healthchecks.io 会发邮件告警

---

## 常用命令

```bash
tesla-watch.sh status          # 查看当前所有检查项
tesla-watch.sh run             # 立即巡检一次
tesla-watch.sh test            # 发一条测试推送
tail -20 /var/log/tesla-watch.log   # 看历史巡检记录
```
