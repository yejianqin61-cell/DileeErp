# 飞书（Lark）群内机器人「收消息 + 回消息」接入事实调研

> 调研范围：open.feishu.cn / open.larksuite.com 官方文档（2026-11 抓取）。
> 目标场景：生产常驻工单机器人，服务器只有 80 端口、已有 nginx 反代、无独立公网 IP 规划。
> 本文只陈述事实与字段，不含实现代码。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 收群消息 | 两种订阅方式：Webhook（HTTP 回调，需 IPv4 公网地址）或 长连接（SDK 建 WebSocket，出站即可，无需公网 IP） |
| 80 端口 + nginx | 两者都可行；Webhook 走 nginx 路径反代，长连接完全不需要入站端口 |
| 回调超时 | 事件推送 3 秒内必须返回 HTTP 200；URL 校验 1 秒内必须回 challenge |
| 重试 | 15 秒、5 分钟、1 小时、6 小时，最多 4 次（窗口约 7.1 小时） |
| 幂等键 | 官方在接收消息事件页明确要求用 `message_id`，**不要依赖 `event_id`**；通用事件文档则推荐 `event_id`（两处口径不一致，见 §3.5） |
| 发消息 | `POST /open-apis/im/v1/messages?receive_id_type=chat_id` |
| 回复/话题 | `POST /open-apis/im/v1/messages/:message_id/reply` + `reply_in_thread`；`root_id` 不是请求参数 |
| 频率 | 同一用户/同一群 5 QPS；接口级 1000 次/分、50 次/秒 |
| 长度 | 文本 150 KB；卡片/富文本 30 KB |
| 审核 | 企业自建应用改权限/事件订阅需发新版本并由企业管理员审核（可配免审） |

---

## 1. 自建应用机器人如何接收群消息

### 1.1 方式一：将事件发送至开发者服务器（Webhook）

- 平台向配置的公网地址 `POST` JSON 事件。
- **硬性要求**：请求地址必须是 **IPv4 协议的、公网可访问**地址，以 `http://` 或 `https://` 开头；每个应用**只能配置一个**请求地址，该应用订阅的所有事件都发到这一个地址。
- 同一应用同时只能有一种事件订阅方式（长连接 vs 开发者服务器，二选一）。
- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server>
- FAQ（公网/防火墙/内网穿透排查）：<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq>

### 1.2 方式二：使用长连接接收事件（WebSocket，推荐）

官方原文要点：

- 通过飞书 SDK 与开放平台建立一条 WebSocket 全双工通道，**你的服务器只需要能访问公网（出站）**。
- **无需提供公网 IP 或域名、无需内网穿透**；内置通信加密与鉴权，**无需自行解密、验签，也无需部署防火墙和配置白名单**。
- 限制：**仅支持企业自建应用**（不支持商店应用）；每个应用**最多 50 个连接**；推送为**集群模式、不支持广播**——同一应用部署多个 client 时，**只有随机一个** client 会收到该条事件。
- 收到消息后需 **3 秒内处理完成且不抛异常**，否则触发超时重推。
- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case>

### 1.3 适用场景与「80 端口 + nginx 反代」判断

| 维度 | Webhook | 长连接 |
|---|---|---|
| 公网 IP/域名 | 必须（IPv4 公网） | 不需要 |
| 入站端口 | 需要（可用 80 端口 + nginx 路径反代） | 不需要任何入站端口 |
| 自建解密/验签 | 需要（若配 Encrypt Key 则必须） | 不需要 |
| 多副本水平扩展 | 每个副本都能收到（自行去重/分流） | 只有随机一个副本收到，**必须靠队列或单实例消费** |
| 订阅方式生效前提 | 保存地址时 challenge 校验通过 | 保存时必须已有在线长连接 |
| 商店应用 | 支持 | 不支持 |

判断：

- 只有 80 端口且有 nginx：**Webhook 可用**。做法是把某一路径（如 `https://your.domain/open/feishu/event`）反代到本地应用；注意三点：保留**原始请求体**（签名是对 raw body 计算）、关闭响应缓冲、nginx 到上游的耗时必须留在 3 秒预算内。
- 若不想在 nginx 上暴露回调路径、或没有可用公网 IPv4：**选长连接**，只需服务器能出站访问飞书。
- 生产工单机器人若要多副本：长连接的「集群模式随机投递」是硬约束，需先落地消息队列再消费。

官方对 Webhook 的优化建议（中国大陆服务器、耗时操作异步化、退订不用的事件）：
<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-callback-optimization-guide>

---

## 2. HTTP 回调的校验机制

### 2.1 URL 校验（challenge）

保存请求地址时，飞书向该地址发一个 `application/json;charset=utf-8` 的 POST，应用必须在 **1 秒内**把 `challenge` 原样返回。

未配置 Encrypt Key 时请求体：

```json
{ "challenge": "ajls384kdjxxxx", "token": "xxxxxx", "type": "url_verification" }
```

响应：

```json
{ "challenge": "ajls384kdjxxxx" }
```

已配置 Encrypt Key 时请求体是 `{"encrypt": "..."}`，需先解密再取 `challenge`，同样 1 秒内返回。

- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server>
- 自查用 curl 示例与「Challenge code 没有返回」排查：<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq>

> 注意：challenge 请求**不参与**签名校验（官方明确「不包括请求网址校验」）。

### 2.2 事件加密（Encrypt Key）

加密算法（官方「加密原理」）：

1. 对 `Encrypt Key` 做 `SHA256` 得到密钥 `key`；
2. 事件内容用 **PKCS7Padding** 填充；
3. 生成 **16 字节随机数**作为 `iv`；
4. 用 `iv` + `key` 做 **AES-256-CBC** 加密得到 `encrypted_event`；
5. 应用收到的密文 = `base64(iv + encrypted_event)`。

- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server>
- 各语言解密示例：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case>

未配置 Encrypt Key 时事件为明文推送，请求体的 `token` 字段即 Verification Token。

### 2.3 签名校验（X-Lark-Signature）

前提：应用配置了 Encrypt Key（`encrypt_key` 在「事件与回调 > 加密策略」可查）。

请求头：

- `X-Lark-Request-Timestamp`
- `X-Lark-Request-Nonce`
- `X-Lark-Signature`

算法：

```
s = SHA256_hex( timestamp + nonce + encrypt_key + rawBody )
```

- 必须用**原始请求体字符串**参与计算，「不要在反序列化后再计算」。
- 若 `s` 与 `X-Lark-Signature` 相等，则来源可信；该方式**无需解密**即可完成校验（但取内容仍需解密）。
- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case>

> 注意：签名用途是「证明来源」，**官方没有规定时间戳窗口**，因此抗重放要在业务侧自己做（见 §6）。

### 2.4 Verification Token 校验

- 应用默认带一个 Verification Token，可在「事件与回调 > 加密策略 / 安全设置」查看。
- v2.0 事件里在 `header.token`，v1.0 事件里在顶层 `token`。
- 明文比对即可，但官方明确其**安全性较低**（未加密时会明文传输 Token，存在泄露风险）；配置了 Encrypt Key 后必须解密才能拿到 Token，此时推荐改用签名校验。
- 文档（事件结构 v1/v2 的 token 位置）：<https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM>

### 2.5 超时与重试

官方「事件推送」原文：

- 收到请求后必须在 **3 秒内**返回 **HTTP 200**；**TCP 建联超时 2 秒，回调整体超时 3 秒**。
- 失败后按 **15 秒、5 分钟、1 小时、6 小时** 的间隔重推，**最多重试 4 次**；重发最长窗口约 **7.1 小时**。
- 长连接场景：3 秒内处理完且处理函数不抛异常即视为成功。
- 文档：<https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM>
- 日志里的 `retry cnt` > 1 即说明发生了重推：<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq>

⚠️ 官方未公开「每个应用的事件推送 QPS 上限」，也未给出「重试也失败后的事件补拉接口」（事件是 push-only，失败即丢）。这属于**文档未明确**项。

---

## 3. 事件体：`im.message.receive_v1`

事件文档：<https://open.feishu.cn/document/server-docs/im-v1/message/events/receive>

### 3.1 前提

- 应用需开启**机器人能力**；
- 需在「事件与回调 > 事件配置」添加「接收消息 v2.0」事件；
- 需申请对应的消息读取权限（权限决定「能收到哪些消息」，见 §5）。

### 3.2 事件头（v2.0 schema）

| 字段 | 说明 |
|---|---|
| `schema` | 固定 `"2.0"` |
| `header.event_id` | 事件唯一 ID |
| `header.event_type` | `im.message.receive_v1` |
| `header.create_time` | 事件创建时间戳（毫秒，字符串） |
| `header.token` | Verification Token |
| `header.app_id` | 应用 ID（`cli_` 前缀） |
| `header.tenant_key` | 租户标识 |

### 3.3 `event.sender`

| 字段 | 说明 |
|---|---|
| `sender.sender_id.union_id` | 用户 union_id |
| `sender.sender_id.user_id` | 用户 user_id（需 `contact:user.employee_id:readonly`） |
| `sender.sender_id.open_id` | 用户 open_id |
| `sender.sender_type` | `user` 或 `bot` |
| `sender.tenant_key` | 租户标识 |

事件体**不含发送者姓名**，需要显示名要另行调用通讯录接口（这是官方文档结构决定的，不是限制说明）。

### 3.4 `event.message`

| 字段 | 说明 |
|---|---|
| `message_id` | 消息 ID，`om_` 前缀；用于回复/查询/幂等 |
| `root_id` | 根消息 ID，**仅回复场景有值** |
| `parent_id` | 父消息 ID，**仅回复场景有值** |
| `thread_id` | 话题 ID，`omt_` 前缀；不返回说明非话题消息 |
| `create_time` / `update_time` | 消息发送/更新时间（毫秒，字符串） |
| `chat_id` | 群/会话 ID（`oc_` 前缀） |
| `chat_type` | `p2p`（单聊）或 `group`（群组） |
| `message_type` | `text`/`post`/`image`/`file`/`audio`/`media`/`sticker`/`interactive`/`share_chat`/`share_user`/`system` 等 |
| `content` | **JSON 序列化后的字符串**，随 `message_type` 变化 |
| `mentions` | 被 @ 的用户/机器人数组 |
| `user_agent` | 客户端 UA，需 `im:user_agent:read` |

文本消息 content 形如 `{"text":"@_user_1 hello"}`；@ 会被替换成 `@_user_N` 占位符（N 为第几个被 @）。接收内容结构：<https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content>

### 3.5 群聊中「@机器人」如何识别

事件体的 `mentions[]` 元素字段：

| 字段 | 说明 |
|---|---|
| `key` | 序号占位符，如 `@_user_1`（与 content 中的占位符对应） |
| `id.open_id` / `id.union_id` / `id.user_id` | 被 @ 者 ID（嵌套结构） |
| `name` | 被 @ 者姓名 |
| `tenant_key` | 租户标识 |
| `mentioned_type` | **`user` 或 `bot`** ← 判别"被 @ 的是机器人"的直接依据 |

机器人自己的 open_id 通过 `GET /open-apis/bot/v3/info` 获取（响应 `bot.open_id`）：
<https://open.feishu.cn/document/ukTMukTMukTM/uAjMxEjLwITMx4CMyETM>

因此判定「这条群消息 @ 了我」＝ `chat_type === "group"` 且 `mentions` 中存在 `id.open_id === 本机器人 open_id`（可辅以 `mentioned_type === "bot"`）。

三点官方事实，会直接影响实现：

1. **权限即过滤**。只申请 `im:message.group_at_msg:readonly` 时，平台本身就「仅接收用户 @ 当前机器人的消息」；要收群内全部消息必须申请 `im:message.group_msg`（官方标注为**敏感权限**）。权限说明见事件文档「权限要求」。
2. **机器人自己发的消息不会推给该机器人**（`im:message.group_msg.include_bot:read` 描述为「不包含当前机器人自己发送的消息」），天然避免自触发。
3. **官方明确重复推送存在**，且在该页写：「如有幂等需求请使用 **`message_id`** 去重，**不要依赖 `event_id`**」。

### 3.6 幂等去重（重要口径冲突）

- 接收消息事件页：用 `message_id` 去重，不要依赖 `event_id`。
- 事件概述 / FAQ：v2.0 事件用 `header.event_id` 判断唯一性（v1.0 用 `uuid`）。

工程结论（两者都记，但以更严的为准）：

- **业务幂等键用 `message_id`**（同一条消息的重推 `message_id` 不变）；
- **同时把 `header.event_id` 落库**，用于排查"同一事件被投递了几次"；
- 去重存储需覆盖**至少 7.1 小时**（重试窗口），建议 24 小时。

---

## 4. 发送消息

### 4.1 `tenant_access_token`

旧版（仍广泛使用）：

- `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- 请求体：`{"app_id": "cli_xxx", "app_secret": "xxx"}`
- 响应：`{"code":0,"msg":"ok","tenant_access_token":"t-xxx","expire":7200}`
- 有效期**最大 2 小时**；剩余有效期 **< 30 分钟**时调用会返回**新** token（新旧同时有效），≥30 分钟则返回原 token。
- 文档：<https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal>

新版（JWT 格式，官方推荐）：

- `POST https://accounts.feishu.cn/oauth/v3/token`
- 遵循 OAuth 2.0 Client Credentials，`grant_type=client_credentials`；认证方式 `client_secret_basic` 或 `client_secret_post`，二者只能选一（否则 20070）。
- 响应字段变为 `access_token` / `expires_in` / `token_type`（**不要再读旧字段 `tenant_access_token`**）。
- **凭证长度显著增加**，官方提示预留至少 **4 KB** 存储/Header 长度。
- 文档：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token>

Node SDK 会自动获取/缓存/刷新 token，并在 `expire` 基础上**提前 3 分钟**置为失效：
<https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/invoke-server-api>

### 4.2 发送文本消息

- `POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
- Header：`Authorization: Bearer <tenant_access_token>`、`Content-Type: application/json; charset=utf-8`
- 请求体：

| 字段 | 必填 | 说明 |
|---|---|---|
| `receive_id` | 是 | 与 `receive_id_type` 匹配；群聊填 `chat_id`（`oc_`） |
| `msg_type` | 是 | `text` |
| `content` | 是 | **JSON 序列化后的字符串**，如 `"{\"text\":\"test content\"}"` |
| `uuid` | 否 | 自定义去重串，**相同 uuid 在 1 小时内至多成功发送一条**，最大 50 字符 |

- `receive_id_type` 可选：`open_id` / `union_id` / `user_id` / `email` / `chat_id`（发送接口**不含** `thread_id`）。
- 响应关键字段：`message_id`、`root_id`、`parent_id`、`thread_id`、`chat_id`、`create_time`。
- 文档：<https://open.feishu.cn/document/server-docs/im-v1/message/create>
- content 结构（text/post/image/file/interactive…）：<https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json>

> `uuid` 是最省事的**发送侧幂等**手段：同一个工单通知重试时复用同一 uuid，1 小时内不会重复发出。

### 4.3 回复某条消息 / 话题

- `POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply`
- 请求体：`content`（必填）、`msg_type`（必填）、`reply_in_thread`（布尔，默认 `false`）、`uuid`（可选）。
- `reply_in_thread=true` 表示**以话题形式回复**（在普通消息群里即"把这条消息变成话题"）；若该消息本身已是话题消息，则**默认**以话题形式回复。
- **`root_id` / `parent_id` 是响应字段，不是请求参数**——回复目标由路径里的 `message_id` 决定，`root_id`/`parent_id` 由服务端推导返回。
- 已知错误：`230071` 该群不支持以话题形式回复；`230072` 已聚合的消息不支持话题回复；`230019` 话题不存在。
- 文档：<https://open.feishu.cn/document/server-docs/im-v1/message/reply>
- `root_id`/`parent_id`/`thread_id` 语义（含"话题内回复的 root_id 与 parent_id 均指向话题根消息"）：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro>
- 话题机制与 `group_message_type: "thread"`：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction>

工单机器人建议：**回复原消息**（形成消息树、上下文可追溯）；若群是话题群/话题形式群，则消息自带 `thread_id`，直接对该 `message_id` 回复即可留在话题内。

### 4.4 卡片消息（interactive）与卡片按钮回调

发送卡片：`msg_type: "interactive"`，`content` 为以下三种之一（序列化字符串）：

1. 卡片实体：`{"type":"card","data":{"card_id":"7371713483664506900"}}`
2. 卡片模板：`{"type":"template","data":{"template_id":"AAq...","template_version_name":"1.0.0","template_variable":{...}}}`
3. 卡片 JSON（schema 2.0）：直接放卡片 JSON

文档：<https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json>

按钮回调（新版）：回调类型 **`card.action.trigger`**

- **不是事件**，在「事件与回调 > **回调配置**」页签单独订阅，与事件订阅方式各自独立（也可选长连接）。
- 请求体结构（v2.0）：`schema`、`header.{event_id,token,create_time,event_type,tenant_key,app_id}`、`event.operator.{tenant_key,user_id,union_id,open_id}`、`event.token`、`event.action.{value,tag,name,form_value,input_value,option,options,checked,timezone}`、`event.host`、`event.context.{open_message_id,open_chat_id,url,preview_token}`。
- 其中 `action.value` 就是按钮里开发者自定义的 `value`（string 或 object）——按钮传工单 ID 就放这里。
- 响应要求：**3 秒内返回 HTTP 200**；**禁止 HTTP 3xx 重定向**（否则客户端报错）。响应体可选 `toast`（`type`: info/success/error/warning + `content`/`i18n`）与 `card`（`type`: `raw`/`template` + `data`）。
- 延时更新：`event.token` 是「更新卡片用凭证」，**有效期 30 分钟，同一 token 最多更新 2 次**；必须**先响应回调、再**调用延时更新接口。
- 时效：已发送卡片的**可交互有效期 30 天**；**可更新有效期 14 天**。
- 文档：<https://open.feishu.cn/document/feishu-cards/card-callback-communication>
- 处理流程（三种响应方式）：<https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks>
- 主动更新已发卡片：`PATCH /open-apis/im/v1/messages/:message_id`，要求前后都声明 `config.update_multi: true`，仅 14 天内、仅卡片消息、单消息更新 **5 QPS**：<https://open.feishu.cn/document/server-docs/im-v1/message-card/patch>

### 4.5 长度与频率限制

长度（`230025`）：

- 文本消息请求体 **≤ 150 KB**
- 卡片消息、富文本消息请求体 **≤ 30 KB**（用模板时，模板数据也计入）
- 样式标签会放大实际体积

频率：

- **同一用户 5 QPS；同一群 5 QPS（群内所有机器人共享）** —— 发送与回复接口都适用。
- 接口级频控：**1000 次/分钟、50 次/秒**。
- 触发限流返回 **HTTP 429**（部分旧接口为 400），`code=99991400`，响应头 `x-ogw-ratelimit-reset` 给出建议等待秒数。
- 文档：<https://open.feishu.cn/document/server-docs/im-v1/message/create>、<https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN>

> 「群内共享 5 QPS」是工单机器人在大群里最大的容量约束：多个工单同时更新同一群时必须串行排队。

---

## 5. 权限与发布

### 5.1 所需 scope（应用身份 / tenant_access_token）

接收（按需选一，权限决定能收到哪些消息）：

| scope | 作用 |
|---|---|
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的**单聊**消息 |
| `im:message.p2p_msg` | 同上（历史版本） |
| `im:message.group_at_msg:readonly` | **仅接收用户 @ 机器人的群消息**（工单机器人首选，最小权限） |
| `im:message.group_at_msg` | 同上（历史版本，已下线但存量应用不受影响） |
| `im:message.group_at_msg.include_bot:readonly` | 群内**用户及其他机器人** @ 本机器人的消息 |
| `im:message.group_msg` | 群内**所有**消息（官方标注**敏感权限**） |
| `im:message.group_msg.include_bot:read` | 群内所有用户+机器人消息（不含自己发的） |

发送 / 回复 / 更新卡片：

| scope | 作用 |
|---|---|
| `im:message` | 获取与发送单聊、群组消息 |
| `im:message:send_as_bot` | **以应用身份发消息**（推荐，配合 tenant_access_token） |
| `im:message:send` | 发送消息 V2（历史版本） |
| `im:message:update` | 更新消息（更新卡片可用） |
| `im:resource` | 获取与上传图片/文件 |

其他可能用到：

- `contact:user.employee_id:readonly` —— 才返回 `user_id` 字段（字段级权限）
- `im:user_agent:read` —— 才返回 `user_agent`
- `event:ip_list` —— 调用「获取事件出口 IP」接口
- `im:chat.members:bot_access` —— 订阅机器人进/出群事件
- `im:chat:readonly` / `im:chat` —— 读群信息（如需群名、群类型）

依据：<https://open.feishu.cn/document/server-docs/im-v1/message/events/receive>、<https://open.feishu.cn/document/server-docs/im-v1/message/create>、<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-v1/outbound_ip/list>

### 5.2 把应用机器人加入群

官方帮助文档给出的客户端路径（目前**仅支持在飞书电脑端添加机器人**）：
`···` > **设置** > **群机器人** > **添加机器人**；删除：**群设置** > **群机器人** > 选中机器人 > **删除机器人**。
文档：<https://open.feishu.cn/document/ukTMukTMukTM/uATM04CMxQjLwEDN>

机器人需在群内且**有发言权限**才能发消息，否则报 `230002`（不在群）、`230018`（被群设置禁止，如"仅指定成员可发言"）、`230035`（禁言/被屏蔽/租户沟通权限管控）。

群设置相关开关（文档可证部分）：

- 「群机器人」列表（添加/删除机器人）— 帮助文档明确。
- 群发言权限/禁言/「仅指定成员可发言」— 由错误码 `230018`/`230035` 的排查建议间接体现。
- 群消息形式 `group_message_type = thread`（话题形式群）— 群信息接口字段，影响回复是否落话题。
- 「谁可以添加机器人」这类细粒度开关：**未在官方开放平台文档中找到明确条目**（见 §9 不确定项）。

外部群另需开启**对外共享**能力（仅企业自建应用、需企业认证或个人实名认证）：
<https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group>

### 5.3 是否需要审核 / 发布

- **需要**。官方：「当应用的 **基本信息**、**权限范围**、**应用功能** 和 **事件订阅** 等信息发生变更时，都需要发布新的应用版本，并且通过企业管理员的审核后才能生效。」
- 添加事件后**即使权限已批，也必须发布应用**才生效。
- 审核方式：管理后台「工作台 > 应用审核」或飞书审批；管理员可为单个应用开**免审**，也可设置**自建应用免审规则**（按范围）。
- 开发者小助手会推送审核结果。
- 文档：<https://open.feishu.cn/document/best-practices/intro-to-custom-app-review>、<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/subscription-event-case>

> 实践提示（官方原文亦有类似建议）：审核耗时不可控，测试期建议用独立测试企业或先申请免审。

---

## 6. 安全实践

### 6.1 证明请求来自飞书

优先级：

1. **配置 Encrypt Key + 校验 `X-Lark-Signature`**（官方称"安全性高"，且无需解密即可判定来源）。
2. 其次：解密后比对 `header.token` / 顶层 `token` 与 Verification Token。
3. 官方明确警告：Token 明文校验"安全性较低"。

必须注意：签名基于 **raw body**。任何会重写 body 的中间件（如先 `JSON.parse` 再 `JSON.stringify`、或改写空白的代理）都会导致签名不匹配。

### 6.2 防重放

官方只说明「配置 Encrypt Key 可防重放攻击」，**没有给出具体的时间窗阈值或 nonce 缓存时长**。可落地的组合（工程实践，非文档规定）：

- 校验签名；
- 用 `X-Lark-Request-Timestamp` 做时间窗过滤（社区常用 ±5 分钟）；
- 用 `X-Lark-Request-Nonce` 做短期去重缓存；
- 业务层用 `message_id` / `uuid` 幂等（这是官方明确推荐的兜底）。

### 6.3 IP 白名单 / 回调地址校验（两个概念别混）

| 机制 | 方向 | 说明 |
|---|---|---|
| 应用「安全设置 > IP 白名单」 | **限制谁可以调用飞书 API**（你的服务器 → 飞书） | 仅支持单个 IPv4 公网地址，不支持网段/IPv6；不在白名单的请求被拒，错误码 **99991401**；对 access_token 相关接口不生效；配置后立即生效。文档：<https://open.feishu.cn/document/ukTMukTMukTM/ucTMxYjL3ETM24yNxEjN> |
| 事件出口 IP | **飞书 → 你的回调地址** | 用于配置你的防火墙/安全组放行。官方提供查询接口 `GET /open-apis/event/v1/outbound_ip`（scope `event:ip_list`），并明确「IP 有变更可能，建议定期拉取并自动更新防火墙规则」。文档：<https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-v1/outbound_ip/list> |
| 回调地址校验 | 配置时一次性 | 保存 URL 时飞书发 `url_verification`，1 秒内返回 `challenge`；每应用仅 1 个地址，必须 IPv4 公网。 |

出口 IP 变更公告（Lark 侧，2026-09-20 生效，含 26 个 IP 清单）：
<https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/breaking-change/event-subscription-and-card-callback-outbound-ip-change>

> 结论：官方**没有**"飞书回调固定 IP 段永不变化"的承诺，因此**不要把 IP 白名单当作唯一鉴权手段**；签名校验才是主控制。

---

## 7. 中国大陆版（feishu.cn）vs 国际版（larksuite.com）

| 项 | 飞书（中国） | Lark（国际） |
|---|---|---|
| 开放平台站点 | `open.feishu.cn` | `open.larksuite.com` |
| API base | `https://open.feishu.cn/open-apis/...` | `https://open.larksuite.com/open-apis/...` |
| 路径 | `/open-apis/...`（两侧一致） | 同左 |
| OAuth / token（新版） | `https://accounts.feishu.cn/oauth/v3/token` | `https://accounts.larksuite.com/oauth/v3/token` |
| 开发者后台 | `open.feishu.cn/app` | `open.larksuite.com/app` |
| Node SDK domain | `lark.Domain.Feishu`（默认） | `lark.Domain.Lark` |

依据：发送消息文档两版（`https://open.feishu.cn/open-apis/im/v1/messages` vs `https://open.larksuite.com/open-apis/im/v1/messages`）：
<https://open.feishu.cn/document/server-docs/im-v1/message/create>、
<https://open.larksuite.com/document/server-docs/im-v1/message/create>

SDK domain 参数与默认值：<https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/invoke-server-api>、<https://github.com/larksuite/node-sdk>

补充事实：长连接的 WebSocket 端点由 SDK 内部发现（`wss://...`），文档**未给出固定域名**；SDK 支持 `connectionHost` 覆盖握手 host，但属高级选项（README「WebSocket connection host and handshake headers」）。

---

## 8. Node.js SDK

**包名**：`@larksuiteoapi/node-sdk`（官方，MIT）
仓库：<https://github.com/larksuite/node-sdk>

版本门槛（官方明确）：

- 长连接 `WSClient` 需 **≥ 1.24.0**
- 新版卡片回调（`card.action.trigger`）验签需 **≥ 1.27.0**（低版本会"验签失败"）
- Node 18+ 上传文件需 **≥ 1.17.1**
- 数组型 query 参数需 **≥ 1.37.2**

核心对象与用法要点（仅事实）：

| 对象 | 作用 |
|---|---|
| `new lark.Client({appId, appSecret, domain?})` | API 调用；自动管理 token；`lark.withTenantToken()` / `withTenantKey()` 可覆盖 |
| `new lark.EventDispatcher({encryptKey, verificationToken})` | 事件分发；`.register({'im.message.receive_v1': handler})` |
| `new lark.WSClient({appId, appSecret})` + `.start({eventDispatcher})` | 长连接；启动后会打印 `ws client ready` |
| `lark.adaptDefault(path, dispatcher, {autoChallenge:true})` | 原生 http 适配，自动回 challenge |
| `lark.adaptExpress` / `adaptKoa` / `adaptKoaRouter` | 框架适配；同样支持 `autoChallenge` |
| `new lark.CardActionHandler({encryptKey, verificationToken}, handler)` | 卡片回调；返回卡片对象即"立即更新" |
| `new lark.AESCipher(encryptKey).decrypt(s)` | 手动解密 |
| `createLarkChannel({appId, appSecret})` | 更高层的会话机器人封装（`channel.on('message'|'cardAction')`、`channel.send`、流式回复），README 称其为对话机器人的推荐入口 |

已注册 key 再次 `register` 会覆盖（并打 warning），也可用 `.unregister(key)` 移除。

文档：<https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events>、<https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/invoke-server-api>

⚠️ 长连接 + 多副本：SDK 不会广播，必须自行引入队列或保证单消费者。

---

## 9. 事实核对清单

### 9.1 文档明确写的（可直接引用）

| 结论 | 依据 |
|---|---|
| Webhook 需 IPv4 公网地址，每应用仅 1 个请求地址 | [send-notifications-to-developers-server](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server) |
| 长连接无需公网 IP/域名，仅需出站；仅企业自建应用；≤50 连接；集群随机投递；3 秒处理 | [request-url-configuration-case](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case) |
| challenge 1 秒内原样返回；加密时先解密 | [send-notifications-to-developers-server](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server) / [faq](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq) |
| AES-256-CBC + SHA256(key) + PKCS7 + base64(iv+ct) | 同上 |
| 签名 = SHA256(timestamp+nonce+encrypt_key+rawBody)，头为 X-Lark-Request-Timestamp/Nonce/Signature | [encrypt-key-encryption-configuration-case](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case) |
| 3 秒超时（TCP 2 秒）；重试 15s/5min/1h/6h，最多 4 次，窗口≈7.1h | [事件概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM) |
| receive 事件全字段（含 `mentioned_type`、`chat_type`、`thread_id`） | [receive](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) |
| 接收消息去重用 `message_id`、不要依赖 `event_id` | [receive](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)（注意事项） |
| 通用事件去重用 `header.event_id`（v2）/`uuid`（v1） | [事件概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM) |
| token 最大 2 小时，<30min 返回新 token | [tenant_access_token_internal](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal) |
| 新版 token 走 accounts.feishu.cn/oauth/v3/token，返回 `access_token`/`expires_in`，JWT 变长需预留 4KB | [tenant_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token) |
| 发送 `POST /open-apis/im/v1/messages?receive_id_type=chat_id`，`uuid` 1 小时内至多一条 | [create](https://open.feishu.cn/document/server-docs/im-v1/message/create) |
| 回复 `POST /open-apis/im/v1/messages/:message_id/reply`，`reply_in_thread` | [reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply) |
| `root_id`/`parent_id` 是响应字段；话题内回复两者都指向话题根消息 | [消息管理概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro) |
| 文本 150KB / 卡片·富文本 30KB | [create](https://open.feishu.cn/document/server-docs/im-v1/message/create) / `230025` |
| 同用户 5 QPS、同群 5 QPS（共享）；接口 1000/min 50/s；429 + x-ogw-ratelimit-reset | [create](https://open.feishu.cn/document/server-docs/im-v1/message/create) / [频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN) |
| `card.action.trigger` 3 秒内 HTTP 200、禁止 3xx、`event.token` 30 分钟最多更新 2 次、卡片可交互 30 天/可更新 14 天 | [卡片回传交互](https://open.feishu.cn/document/feishu-cards/card-callback-communication) / [处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks) |
| 机器人能力需开启；加群路径 `··· > 设置 > 群机器人 > 添加机器人`（仅 PC 端） | [机器人使用指南](https://open.feishu.cn/document/ukTMukTMukTM/uATM04CMxQjLwEDN) |
| 自建应用改权限/事件订阅需发版 + 企业管理员审核，可免审 | [发布与审核自建应用](https://open.feishu.cn/document/best-practices/intro-to-custom-app-review) |
| 应用 IP 白名单限制「调用飞书 API 的源 IP」，99991401，仅单个 IPv4 | [设置 IP 白名单](https://open.feishu.cn/document/ukTMukTMukTM/ucTMxYjL3ETM24yNxEjN) |
| 事件出口 IP 可查询（event:ip_list），且会变更 | [获取事件出口 IP](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-v1/outbound_ip/list) |
| 国际版域名 `open.larksuite.com`，路径 `/open-apis` 相同 | [Lark send message](https://open.larksuite.com/document/server-docs/im-v1/message/create) |
| Node SDK 包名、1.24.0 起支持长连接、1.27.0 起支持新卡片回调验签 | [handling-events](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events) / [README](https://github.com/larksuite/node-sdk) |

### 9.2 社区经验 / 工程推论（文档未直接写）

| 结论 | 说明 |
|---|---|
| 「@ 我」= `mentions[].id.open_id === bot open_id` | 文档给了 `mentioned_type`（user/bot）和 `/bot/v3/info` 的 `bot.open_id`，但**没有一句原文**把两者组合成判定规则；这是业界通行写法 |
| 防重放用时间窗（±5 分钟）+ nonce 缓存 | 文档只说"配置 Encrypt Key 可防重放"，无阈值规定 |
| 去重记录保留 ≥24 小时 | 由"重试窗口 7.1 小时"推导的工程余量 |
| 80 端口 + nginx 路径反代可行 | 文档只要求"IPv4 公网地址 + http/https"，未限制端口；反代需保 raw body / 关缓冲属通用代理知识 |
| 卡片回调与事件回调是两套订阅入口 | 文档分「事件配置」「回调配置」两个页签，但未用一句话总结；由两篇独立配置文档可推得 |
| 长连接多副本会丢事件（需队列） | 由"集群模式、只有随机一个 client 收到"直接推出，但官方没有"请用队列"的建议原话 |
| 网关/中间件改写 body 会导致签名失败 | 由"用原始 body 计算、不要反序列化后计算"推出 |

### 9.3 不确定 / 未找到官方依据

| 项 | 状态 |
|---|---|
| 群设置中「谁可以添加机器人」的细粒度开关 | 未在 open.feishu.cn 找到条目；帮助中心《在群组中使用机器人》只描述添加/删除路径，正文抓取被截断 |
| 事件订阅是否有每应用 QPS 上限 | 未公开 |
| 事件重试全部失败后是否有补拉接口 | 未见；事件为 push-only，倾向"丢失即丢失"，生产需自建对账（如定时拉 `GET /open-apis/im/v1/messages` 历史） |
| 飞书（中国版）回调出口 IP 的固定清单页 | 只找到接口 `event/v1/outbound_ip` 与 Lark 侧变更公告；未找到 feishu.cn 的等价静态清单页 |
| 长连接 WebSocket 固定端点域名 | 文档未给出（SDK 内部发现） |
| `card.action.trigger` 失败是否重试 | 文档明确回调"是同步操作，不提供补推机制"（针对回调），但未逐条列 card.action.trigger 的重试行为 → 按"不重试"设计 |
| 群内「机器人可发言」是否独立于「仅指定成员可发言」 | 仅有错误码 230018/230035 的排查建议，无字段级说明 |
| 国际版与企业版/专有版（open.larkenterprise.com 等）域名体系 | 仅确认 larksuite.com 与 feishu.cn 两条主线，其他部署形态未逐一核实 |