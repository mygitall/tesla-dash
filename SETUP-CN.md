# 接真实车辆数据 — 中国区完整步骤

> 目标：让页面上显示你自己车的实时数据。
> 状态：**代码已就绪**，只差特斯拉给你的凭证。

---

## ✅ 已经替你做好的部分

| 项 | 状态 | 位置 |
|---|---|---|
| HTTPS 隧道 | ✅ 已起（公网可访问） | `https://vital-opposite-competing-open.trycloudflare.com` |
| CN 区 OAuth 端点 | ✅ 已配（`auth.tesla.cn`） | `server.mjs` 按区域自动切换 |
| 完整 OAuth 流程 | ✅ 已实现 | `/auth/login` + `/auth/callback` |
| token 自动刷新 | ✅ 已实现 | 过期前 60 秒自动续期，存 `.tokens.json` |
| EC P-256 密钥对 | ✅ 已生成（**只读暂时用不到**） | `keys/private-key.pem`（600，勿泄露） |
| 公钥托管路由 | ✅ 可用（**只读暂时用不到**） | `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` |

> 密钥对和公钥托管是给**下发指令**准备的；只读看数据不需要，见第 5 步。

**你的公钥内容**（以后加指令功能时才会用到）：

```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXE/IxPlv+sVcZO6tqyAfvLZ3kIzQ
oxlULBeWTNVGP5q2DMRjFsbK2O7joj6t4q7qghRUtmlrt0Vy6mBKOY9Z9Q==
-----END PUBLIC KEY-----
```

---

## 第 1 步：拿一个 HTTPS 回调地址

特斯拉**只接受 HTTPS** 的回调地址，而你现在是 `http://localhost:8787`。用 cloudflared 的免费快速隧道解决：

```bash
cloudflared tunnel --url http://localhost:8787
```

会输出类似：

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://random-words-here.trycloudflare.com                                               |
+--------------------------------------------------------------------------------------------+
```

**记住这个地址**，你这一轮的所有配置都要用它：`https://随机词.trycloudflare.com`

> ⚠️ 快速隧道的域名**每次重启都会变**。变了就要回特斯拉后台改回调地址，否则报 `redirect_uri mismatch`。
> 所以：**一次配完，中途别关隧道。** 配完想长期用，再考虑命名隧道或自有域名。

验证隧道通了：

```bash
curl https://随机词.trycloudflare.com/api/status
# 应返回 {"mode":"demo",...}
```

---

## 第 2 步：在特斯拉建开发者应用

1. 打开 <https://developer.tesla.cn>（中国区）或 <https://developer.tesla.com>，用**车主本人的特斯拉账号**登录
2. 点 **Create Application** / **新建应用**

### ⚠️ 注册类型：选「仅适合我」

按[官方文档](https://developer.tesla.cn/docs/fleet-api/authentication/overview#token-types)，特斯拉把身份分两类，正好对应这两个选项：

| 官方分类 | 对应选项 | 用于 |
|---|---|---|
| **第三方令牌** | **仅适合我** ✅ | ①第三方开发者做的 App 与**个人拥有**的车交互<br>②**业余爱好者**把自有特斯拉产品接进来 ← **就是你** |
| **合作伙伴令牌** | 适用于我的公司 | ①**企业**自有车队自动化<br>②对自家应用做配置更改<br>③**所有合作伙伴端点的调用** |

**选「仅适合我」**，理由：
- 你是个人、一台车、自己看数据，属于文档里明确写的「业余爱好者」场景
- 选「公司」要填企业信息、走资质核验，多耗几天，而且你的场景用不上
- 选了公司但没有真实公司主体 = 信息不实，没必要
- 以后真要商业化，再单独注册一个企业应用即可，不影响现在这个

> 注册类型在同一个应用上**通常不能改**，所以这一步要选对。

### 填表

| 字段 | 建议填法 |
|---|---|
| Application Name | `My Tesla Dash`（随便，自己认得出就行） |
| Description | `Personal read-only vehicle dashboard` |
| **Allowed Origin(s)** | `https://vital-opposite-competing-open.trycloudflare.com` |
| **Allowed Redirect URI(s)** | `https://vital-opposite-competing-open.trycloudflare.com/auth/callback` |
| Scopes / Permissions | 勾 `openid`、`offline_access`、`vehicle_device_data`、`vehicle_location` |

3. 创建后拿到 **Client ID** 和 **Client Secret**（Secret 只显示一次，立刻复制存好）

> 💡 **中文区的 OAuth 域名是 `auth.tesla.cn`，不是 `auth.tesla.com`。** 代码已按区域自动切换，你不用管。

---

## 第 3 步：填进 `.env`

编辑 `tesla-dash/.env`：

```ini
MODE=fleet
PORT=8787
TESLA_CLIENT_ID=你的ClientID
TESLA_CLIENT_SECRET=你的ClientSecret
TESLA_REDIRECT_URI=https://随机词.trycloudflare.com/auth/callback
TESLA_REGION=cn
```

重启服务：

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
node server.mjs
```

启动日志应该显示：

```
  ⚡ Tesla Dash
  模式     : fleet  (Fleet API)
  区域     : cn  →  https://fleet-api.prd.cn.vn.cloud.tesla.cn
  回调地址 : https://随机词.trycloudflare.com/auth/callback
  OAuth    : 已配置
  Token    : 无
```

---

## 第 4 步：登录授权

1. 打开 <http://localhost:8787>
2. 点 **「用特斯拉账号登录」**
3. 跳到 tesla.com 登录 → 授权你的应用 → 自动跳回
4. 页面上应该出现你的车

---

## 第 5 步：合作伙伴账号注册（CN 区**必需**）

> ⚠️ 我之前说过"只读数据不需要注册"，**这条在 CN 区是错的，已实测推翻**。
> 不注册会直接报 `412 Account ... must be registered in the current region`，连车辆列表都读不到。

### 5.1 前置条件

| 条件 | 说明 |
|---|---|
| **允许的源必须是可注册域名** | `localhost` **不行**（API 报 `Invalid domain: localhost`）。必须填 tunnel 或真实域名，并在开发者后台「允许的源 URL」里登记 |
| **公钥必须公网可访问** | `https://<域名>/.well-known/appspecific/com.tesla.3p.public-key.pem`，内容是 P-256 公钥 PEM |
| **需要合作伙伴令牌** | `client_credentials` 授权，不是第三方令牌 |

### 5.2 三步操作

**① 确认公网能拿到公钥**

```bash
curl https://你的域名/.well-known/appspecific/com.tesla.3p.public-key.pem
# 必须返回 -----BEGIN PUBLIC KEY----- 开头的内容
```

本项目已内置该路由（`server.mjs`），公钥在 `keys/public-key.pem`。

**② 取合作伙伴令牌**

```bash
curl -X POST 'https://auth.tesla.cn/oauth2/v3/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$TESLA_CLIENT_ID" \
  --data-urlencode "client_secret=$TESLA_CLIENT_SECRET" \
  --data-urlencode 'scope=openid vehicle_device_data' \
  --data-urlencode 'audience=https://fleet-api.prd.cn.vn.cloud.tesla.cn'
```

**③ 注册**

```bash
curl -X POST 'https://fleet-api.prd.cn.vn.cloud.tesla.cn/api/1/partner_accounts' \
  -H "Authorization: Bearer $PARTNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"domain":"你的域名"}'
```

成功返回：

```json
{"response":{"account_id":"...","domain":"你的域名","name":"MyGarage",
 "client_id":"...","public_key":"04...","public_key_hash":"..."}}
```

### 5.3 ⚠️ 必须知道的坑

**配置有 3~5 分钟传播延迟。**
改完开发者后台（allowed origin / scopes）后立刻调注册，会一直返回 412。实测**等了约 5 分钟才突然通过**（第 6 次重试）。

所以别急着判定失败，挂个循环重试 10 分钟：

```bash
for i in $(seq 1 15); do
  # 调用注册，成功就 break
  sleep 60
done
```

**域名绑死后不能随便换。**
注册把域名和公钥绑定。如果用的是 `*.trycloudflare.com` 快速隧道，**隧道重启域名就变，注册立刻失效**（公钥也拿不到了）。
想长期稳定，必须用固定域名（见下方方案）。

### 5.4 完成后验证

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://fleet-api.prd.cn.vn.cloud.tesla.cn/api/1/vehicles
```

应该返回你的车，而不是 412。

---

## 备选方案：如果开发者注册卡住

| 方案 | 能拿到什么 | 说明 |
|---|---|---|
| **官方数据导出** | 历史行程、充电记录（CSV/JSON） | Tesla 账户 → 隐私 → 申请我的数据副本。几天后邮件给你。**不是实时**，但完整 |
| **OBD + Scan My Tesla** | CAN 级原始数据（电池单体、电机、逆变器） | 买 OBD 适配器，最全，仅车内可用 |
| **TeslaMate** | 自建、带 Grafana 仪表盘 | 但**同样需要 token**，绕不开第 2、4 步 |

---

## 排错速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `Endpoint deprecated` | 用了老 Owner API | 只能走 Fleet API，删掉老代码 |
| `client_not_found` | Client ID 不对/区域不对 | 核对 ID，确认 `TESLA_REGION=cn` |
| `redirect_uri mismatch` | 回调地址和后台不一致 | 隧道重启后域名变了，两边同步改 |
| `invalid_scope` | 勾了没权限的 scope | 先只留 `vehicle_device_data` `vehicle_location` `openid` `offline_access` |
| `401 NO_TOKEN` | 没授权成功 | 重点看第 4 步有没有跳回 |
| 车辆列表空 | 车没授权给应用 | 做第 5 步 |
| 数据不更新 | 车休眠 / GPS 陈旧 | 正常现象，看页面「数据新鲜度」 |

---

## 安全提醒

- `keys/private-key.pem` 是给你的应用签指令用的，**永远不要提交到 git、不要发给任何人**
- `client_secret` 同理
- `.tokens.json` 已 gitignore，里面是长期有效的 refresh_token
- 本项目的 `.gitignore` 已包含以上三项

---

# ✅ 最终落地方案（2026-10-23 实测通过）

## 架构

```
┌─────────────────────┐        ┌──────────────────────────────┐
│ 你的 Mac            │        │ Netlify (永久)               │
│ localhost:8787      │        │ dapper-platypus-2424c9       │
│  ├ 看板（读真实数据）│        │  └ /.well-known/…public-key  │
│  └ OAuth 回调        │        │     → 200 重写到 pubkey.pem  │
└─────────┬───────────┘        └──────────────┬───────────────┘
          │ 读数据                            │ Tesla 抓公钥
          ▼                                   ▼
   fleet-api.prd.cn.vn.cloud.tesla.cn   （伙伴注册校验）
```

**关键点**：公钥托管在那里**永久有效，不依赖你的 Mac 开机**；看板仍然只跑在本地。

## 最终配置

| 项 | 值 |
|---|---|
| 模式 | `fleet` |
| 区域 | `cn` |
| OAuth 回调 | `http://localhost:8787/auth/callback` |
| 公钥托管 | `https://dapper-platypus-2424c9.netlify.app` |
| 已注册域名 | `dapper-platypus-2424c9.netlify.app` |

## ⚠️ 踩过的坑（按顺序）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | 老 Owner API 已废弃 | `Endpoint deprecated` | 只能走 Fleet API |
| 2 | 中国区 auth 域名不同 | 登录失败 | 必须用 `auth.tesla.cn` |
| 3 | **CN 区必须做伙伴注册** | `412 must be registered in the current region` | `POST /partner_accounts` |
| 4 | **配置传播延迟 3~10 分钟** | 改完后台一直 412 | 挂循环重试 25 分钟 |
| 5 | `localhost` 不能当注册域名 | `Invalid domain: localhost` | 必须是公网域名 |
| 6 | 自建域名的根域证书 | 根域自签名 → 「域无效」 | 根域也要绑有效证书 |
| 7 | **Netlify 丢弃点开头的目录** | 部署后 `.well-known` 404 | 用 `_redirects` 200 重写 |
| 8 | Netlify 匿名站点有密码保护 | 401 Password protected | 认领后点 `Make public` |
| 9 | 拖拽上传会漏隐藏目录 | 只有 `index.html` | 用 API/zip 部署 |

## Netlify 绕过点目录的写法

Netlify 部署时会**丢弃以 `.` 开头的文件/目录**（原生的 `.well-known` 传不上去）。
用 `_redirects` 做 200 重写，效果完全一致：

```
# _redirects
/.well-known/appspecific/com.tesla.3p.public-key.pem  /pubkey.pem  200
```

文件结构：
```
/
├── index.html
├── pubkey.pem      ← 公钥本体（普通文件名，不会被过滤）
└── _redirects      ← 一行重写规则
```

已验证：Tesla 能正常抓取，`public_key` 校验与本地一致（`045c4fc8…`）。

## 用 API 部署（避免拖拽丢文件）

```bash
curl -X POST \
  -H "Authorization: Bearer $NETLIFY_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@netlify-rewrite.zip" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys"
```

## 日常使用

```bash
cd ~/Documents/deepseek-harness/default-workspace/tesla-dash
node server.mjs
# 打开 http://localhost:8787
```

Token 有效期 8 小时，refresh_token 3 个月且自动续期（存在 `.tokens.json`）。

## 唯一需要记住的维护点

**Netlify 站点别删**。删了公钥就没了，伙伴注册失效，得重新走一遍。
需要改公钥时（比如换密钥对）：重新生成 → 替换 `pubkey.pem` → 用 API 重新部署 → 重新 `POST /partner_accounts`。
