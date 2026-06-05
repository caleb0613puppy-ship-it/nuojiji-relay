# 糯叽机 云端中继 (nuojiji-relay)

> 糯叽机专用后端消息生成。

把「调用 AI 生成」从手机搬到一个**永远在线的后端**。这样你切后台、锁屏、被系统杀进程，
这次 AI 回复也会在服务端跑完，等你回来时消息已经在那儿了 —— 不再需要和系统抢「保活」。

> **自带后端 (BYOB)**：你 fork 这个仓库、部署自己的实例、填自己的 AI key，
> 在糯叽机 APP 里指向自己的后端 URL。**糯叽机作者的服务器不碰你的任何数据或 key。**
> 这和 APP 本身「自带 API key (BYOK)」的理念一致。

---

## 它怎么工作

```
手机点发送
  └─ POST /generate  {messages, settings(含你的AI key), meta}   ← 立即返回，不等
                          │
                  后端服务端调你的 AI API（切后台也跑完）
                          │
                  结果存进短期 outbox 队列  +  发推送叫醒手机
                          │
手机（收推送 / 回前台 / 定时轮询）
  └─ GET /outbox  →  写进聊天记录  →  POST /ack 删除
```

- 后端**除了几十分钟的临时 outbox，不持久化任何聊天内容**。
- 推送只是「叫醒」信号，丢了也不丢消息 —— 手机下次拉取会补回（轮询兜底，大陆也能用）。
- 同一条请求 (`requestId`) 只会被处理一次。

---

## 部署方式一：Cloudflare Workers（推荐，免费额度大）

```bash
git clone <你 fork 的仓库>
cd nuojiji-relay
npm install

# 1. 建 KV namespace（存 outbox + 推送订阅）
npx wrangler kv namespace create OUTBOX
#   把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] id

# 2. 设密钥（手机端要填一样的值）
npx wrangler secret put RELAY_SECRET
#   随便一个长随机串，例：openssl rand -hex 32

# 3.（可选）开 Web Push —— 不开就只走轮询
npx web-push generate-vapid-keys      # 得到 public/private
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT  # mailto:you@example.com

# 4. 部署
npx wrangler deploy
```

部署后得到 `https://nuojiji-relay.<你的子域>.workers.dev`，这就是要填进 APP 的**中继 URL**。

---

## 部署方式二：VPS / Docker（长驻 Node 进程，无 CPU 时长限制）

```bash
git clone <你 fork 的仓库>
cd nuojiji-relay
npm install
cp .env.example .env
#   编辑 .env：至少填 RELAY_SECRET；要持久化 outbox 设 RELAY_STORE=sqlite
node server.js
#   默认 http://localhost:8787
```

Docker：
```bash
docker build -t nuojiji-relay .
docker run -d -p 8787:8787 \
  -e RELAY_SECRET=你的密钥 \
  -e RELAY_STORE=memory \
  nuojiji-relay
```

⚠️ **务必挂 HTTPS**（Caddy / Nginx / Cloudflare Tunnel 反代）——AI key 是在请求体里传给后端的，
明文 HTTP 会泄露。填进 APP 的 URL 用你的 HTTPS 域名。

---

## 在 APP 里启用

糯叽机 → 设置 → API 设置 → 「云端中继 (BYOB)」：
- **中继地址**：你的后端 URL（上面拿到的）
- **中继密钥**：和后端 `RELAY_SECRET` 一致
- 打开「启用云端中继」开关
- 点「测试连接」，绿了就成

---

## 环境变量一览

| 变量 | 必填 | 说明 |
|------|------|------|
| `RELAY_SECRET` | ✅ | 手机↔后端共享密钥，两端一致 |
| `RELAY_STORE` | | `memory`(默认) / `sqlite`(持久，需 better-sqlite3) |
| `RELAY_SQLITE_PATH` | | sqlite 文件路径，默认 `./outbox.db` |
| `PORT` | | Node 端口，默认 8787 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | | 开 Web Push 才需要；不填只走轮询 |
| `RELAY_ALLOW_PRIVATE_HOST` | | `=1` 放行内网/本机 AI 地址（本地调试或同机部署 AI 时用） |

---

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（设置页测连接），无需鉴权 |
| POST | `/generate` | 提交生成，202 立即返回；重复 requestId → 409 |
| GET | `/outbox?inboxId=&since=` | 拉取已生成结果 |
| POST | `/ack` | `{inboxId, ids}` 确认删除 |
| GET | `/api/push/vapid-key` | 取 VAPID 公钥 |
| POST | `/api/push/subscribe` | 注册推送订阅 |
| DELETE | `/api/push/unsubscribe` | 退订 |
| POST | `/proactive/register` | 注册主动消息（含手机端拼好的 prompt 模板） |
| POST | `/proactive/sync-messages` | 增量同步滑窗上下文 + lifeState |
| POST | `/proactive/unregister` | 取消主动消息 |
| GET | `/proactive/status?inboxId=` | 查主动消息状态（不含敏感内容） |

除 `/health` 外都需 `Authorization: Bearer <RELAY_SECRET>`。

---

## 主动消息（角色 App 关闭也能找你）

开启后，**App 完全关闭/被杀时**，后端按定时任务（cron，每分钟一次）重算每个角色的「想找你冲动值」，
命中就**实时调你的 AI** 生成一条最新的主动消息，存进 outbox + 发推送叫醒手机。

- **决策算法**（什么时候该主动发）在后端，是**纯数值逻辑**（沉默时长、时段、心情、承诺到点…），开源可见。
- **提示词文本和构建逻辑不在后端代码里**：手机在前台时把拼好的完整 system prompt（含 `{{RECENT_MESSAGES}}` / `{{IMPULSE_REASON}}` 占位符）注册给后端，后端只做字符串替换再发出去。**GitHub 仓库里看不到任何提示词/人设/越狱框架。**
- 你的人设、最近聊天上下文、AI key 会存在**你自己的后端**（KV/sqlite/内存）—— 这是「App 关闭也能主动生成」的物理前提，作者服务器仍然不碰。
- Cloudflare 用 Cron Triggers（`wrangler.toml` 已配 `crons=["* * * * *"]`）；Node 用内置 node-cron。
- ⚠️ Workers 有 CPU 时长/调用配额，适合中小规模；角色数量多、想要更稳的定时主动 → 用 VPS/Docker 长驻进程。

---

## 安全说明

- 单一静态密钥、无轮换。对**个人自用**足够；密钥泄露 = 别人能花你的 AI key，请妥善保管、走 HTTPS。
- 后端会拒绝把请求转发到内网 / 云元数据地址（防 SSRF），除非显式开 `RELAY_ALLOW_PRIVATE_HOST=1`。
- outbox 默认 45 分钟 TTL；手机离线超过这个时长，那条结果会被清掉（视为丢失）。

---

## 路线图

- **Phase 1（已完成）**：服务端跑完手机发起的回复 + outbox 拉取 + Web Push/轮询。
- **Phase 2（已完成）**：后端 cron 定时主动生成（角色主动找你，App 关闭也能用），提示词不进仓库。
- **后续**：iOS APNs / Android FCM 原生推送（`src/push/apns.js` `fcm.js` 已留 stub），让 App 被杀时也能弹推送（当前靠轮询兜底）。
