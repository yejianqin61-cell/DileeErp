# 迪礼顾问大治理：前端换装、工单桥接、查询工具治理

日期：2026-11-22｜版本：1.0｜状态：**设计基线，待施工**｜类型：架构设计

上游：[Agent 应用层架构](agent-application-layer-architecture-2026-11-14.md)、
[工具调用改进计划](agent-tool-uid-root-improvement-plan-2026-10-27.md)、
[自生成工具架构](../SelfEnvolvingTry/business-query-agent-generated-tools-architecture-2026-10-29.md)。

## 0. 结论

**顾问换前端，不换权威；工单桥接走回环，不开公网；查询治理先立尺子，再造工具。**

三句话对应三个决定：

| # | 决定 | 一句话 |
|---|---|---|
| 1 | 前端 | 移植 deepseek chat-demo 的**会话层与渲染层**（纯模块 + 行为），服务端事件日志仍是唯一真源，浏览器只做缓存 |
| 2 | 桥接 | ticket bot 只监听 `127.0.0.1`，Nest API 是唯一入口；web 与飞书是两个 `Channel`，Coordinator 不变 |
| 3 | 工具 | 先建评测黄金集（尺子），再改实体解析与工具面；Builder/Validator 只用于**造工具**，不进实时问答路径 |

本轮拍板（用户 2026-11-22）：

| # | 拍板 | 含义 |
|---|---|---|
| 1 | 不开联网搜索，用 `deepseek-chat` | 不新增 Anthropic Messages 通道，chat-demo 的搜索/读链接 UI 不渲染 |
| 2 | 全部暴露，人人可改生产代码 | 取消工单白名单；靠审计 + 部署门禁 + 自动回滚兜底 |
| 3 | web 加工单看板 | 排队 / 施工中 / 待部署 / 已部署 + 阻塞单列 |
| 4 | 每工单一会话，改需求在该会话里改 | 追加判定从「回复卡片」扩到「同一工单线程」 |
| 5 | 查询工具失败率高，需治理；C/W/V 搬进 bot，新查询工具工单化 | 分两件事：运行时止血 + 造工具拓扑 |
| 6 | 只取 chat-demo 前端/UX/UI/SSE/续接 | 见 §5 移植清单 |
| 7 | 工单记录从服务器同步，会话写数据库 | bot 是工单权威，ERP 库存投影与会话 |
| 8 | **注释全量删除，禁止再写注释** | 见 §7；功能性指令不是注释，保留 |

**本轮唯一对用户原话的改动**：第 5 点「把新编写查询工具作为 tickbot 工单」按字面执行；
但**不把 C/W/V 放进实时问答路径**（见 §4.2 的边界论证）。

## 1. 现状事实（本轮实测）

| 事实 | 证据 | 对设计的约束 |
|---|---|---|
| chat-demo 是纯静态前端，浏览器直连 DeepSeek | 其 README「No application backend is required」；`src/services/api/client.ts` 直连 `${API_ORIGIN}/anthropic/v1/messages` | 它的「基础设施」是**客户端会话层**，不是服务端 agent infra；搬运范围天然受限 |
| 顾问已有服务端事件日志，seq 化 | `apps/api/prisma/schema.prisma` 的 `agent_sessions / agent_runs / agent_run_events`，`@@unique([runId, seq])` | 续接能力的数据底座已经正确，问题在前端与上下文厚度 |
| 上下文只有 8 轮问答，工具结果全丢 | `context-manager.ts:29-40` 只挑 `state==="completed"`，只保留 `question/answer` | 「记不住上一句查到的单」是设计选择，不是 bug；治理要改这条 |
| 流式渲染无节流 | `agent-markdown.tsx:17` 每个 delta 全量 `parseMarkdown` | 长答案必卡；chat-demo 有 `useThrottleMarkdownRender` |
| 渲染能力只有自写 markdown | `apps/web/lib/agent-markdown.ts`，无 KaTeX/Mermaid/高亮 | 表格与公式退化为纯文本 |
| 单号检索仍区分空白与大小写 | `order-query-tools.ts:43` 是裸 `contains`（只有 insensitive），无空白/全角归一 | 黄金集第一条用例就会红 |
| 单号入口已覆盖三类单据 | `document-search-tools.ts:44-60` 查 `salesOrder/purchaseOrder/productionOrder` | D-1 已修；不要重做 |
| 失败预算耗尽会出部分答案 | `agent-orchestrator.ts:194-203` | D-6 已修 |
| bot 已是不折不扣的 Coordinator | `tools/ticket-agent/src/coordinator.ts`（`handle()` / `decideRoute` / 串行队列）；`dispatcher.ts` 是 LLM 7 工具调度器 | 桥接只需加通道，不改判断层 |
| bot 工单是文件权威，原子写 | `ticket-store.ts`（`writeJsonAtomic` = 临时文件 + rename） | 库里的工单只能是投影，不能反向写 |
| 子 Agent 能力未在真实 run 上验证过 | `agent-application-layer-architecture` §12.5：「两次 run 都是 0 次 subagent 调用」 | C/W/V 规则必须先用一次最小工单证明「事件流里能看到两个子会话」 |
| UDSH headless 每工单一会话 | 同上 §2 三条实测（会话可续接、`--session-id` 语义） | 工单对话天然成立，不需要再造会话模型 |

## 2. 目标拓扑

```
        ┌──────────────── 浏览器 ────────────────┐
        │  /agent           顾问（chat-demo 前端）│
        │  /agent/tickets   工单看板 + 工单对话   │
        └───────────────┬────────────────────────┘
                        │ 同一份事件信封 + Last-Event-ID
                ┌───────▼────────┐
                │   Nest API     │  鉴权 / 审计 / 限流 / 投影
                └───┬────────┬───┘
        ┌───────────▼──┐  ┌──▼──────────────────────────┐
        │ 顾问运行时    │  │ 工单桥接（ticket-bridge）    │
        │ deepseek-chat │  │ 只读代理 + 转投 + 事件转译   │
        │ 实体解析      │  └──┬───────────────────────────┘
        │ 扁平工具 ~10  │     │ HTTP 127.0.0.1:7xxx（共享密钥）
        │ 校验-修复环   │  ┌──▼───────────────────────────┐
        └───────────────┘  │ ticket-bot（服务器，单实例） │
                           │ Coordinator + Dispatcher     │
                           │ WebChannel / FeishuChannel   │
                           │ DSH headless（每工单一会话）  │
                           │ 部署门禁 + 自动回滚           │
                           └──────────────────────────────┘
```

三条硬边界：

1. **bot 不监听公网**。只绑 `127.0.0.1`，只认共享密钥头 `x-bridge-key`。
2. **web 永不直连 bot**。鉴权、审计、限流全在 API；bot 不认识 ERP 用户身份，只认识 API 传来的 `actor`。
3. **工单状态只有一个写者**（bot）。ERP 库里的工单是投影，写入只发生在同步任务，用户操作一律转发给 bot。

## 3. 统一事件信封

顾问与工单共用一种信封，前端只写一套渲染器。沿用现有顾问形状，只把 `run_id` 泛化成 `stream_id`：

```jsonc
// id: <stream_id>:<seq>
{
  "v": 1,
  "stream_id": "3f0c…",          // 顾问 = agent_runs.id；工单 = "tk:<ticket id>"
  "seq": 42,                      // 单调递增，断线续接的游标
  "type": "tool_status",          // 见下表
  "at": "2026-11-22T14:03:11.201Z",
  "data": { }
}
```

| type | 来源 | 语义 |
|---|---|---|
| `state` | 两者 | 状态机推进（顾问 `planning/querying/responding`；工单九态） |
| `answer_delta` | 两者 | 文本增量（工单侧由 `text` 事件转译） |
| `thinking_delta` | 工单侧新增 | 思考增量（DSH `thinking` 事件转译） |
| `tool_status` | 两者 | 工具开始/结束（工单侧由 `tool_call/tool_result` 转译） |
| `subagent_status` | 工单侧新增 | 子会话开始/结束，带 `role: builder\|validator\|other` 与 `capability_id` |
| `source` | 顾问 | 单据来源（`sources[] + as_of`） |
| `artifact` | 工单侧新增 | 工件引用（提交 sha、改动文件数、候选目录、报告路径） |
| `usage` | 两者 | token / 工具次数 / 子会话次数 |
| `completed` / `cancelled` / `error` | 两者 | 终态 |

**内部事件**（`tool_args`、`internal_*`）照旧只落库、不下发（`stream-transport.ts:31` 的 `INTERNAL_EVENT_TYPES` 机制直接沿用）。

前端只需要一个客户端函数 `followStream({ streamId, cursor, signal, onEvent })`，两个页面共用。

## 4. 桥接契约（这是本轮工程主线）

### 4.1 bot 侧：`/internal/*`（新增，只读 + 三条写动作）

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| GET | `/internal/tickets?since=<revision>&state=<csv>` | 列表 + 增量同步源 | 只读 |
| GET | `/internal/tickets/:no` | 单张详情（含 turns / progress / result） | 只读 |
| GET | `/internal/tickets/:no/events?after=<seq>` | 事件流（SSE，同一信封） | 断线续接 |
| POST | `/internal/tickets` | 建单（body 含 `actor`、`text`、`channel:"web"`） | `client_message_id` |
| POST | `/internal/tickets/:no/turns` | 追加一轮（= 工单对话里再发一言） | `client_message_id` |
| POST | `/internal/tickets/:no/actions` | `{action:"cancel"\|"deploy"\|"retry"}` | `action_id` |

所有响应带 `meta.revision`（bot 的单调版本号，随任何写动作递增），供 API 侧做增量同步与乐观校验。

### 4.2 通道抽象

新增 `Channel` 契约，Coordinator 只认它：

```ts
type OutboundChannel = {
  readonly kind: 'feishu' | 'web'
  postCard(ticketNo: string, card: TicketCard): Promise<{ ref: string }>
  updateCard(ref: string, card: TicketCard): Promise<void>
  replyThread(ref: string, text: string): Promise<void>
  broadcast(ticketNo: string, text: string): Promise<void>
}
```

- 现有 `feishu-transport.ts` / `feishu-rest.ts` 包成 `FeishuChannel`，行为不变。
- 新增 `WebChannel`：卡片 = 一条事件，`ref` = `stream_id`。
- **追加判定**：`decideRoute`（`coordinator.ts:160`）现在读 `parent_id/root_id`。改为读规范化消息的 `threadKey`：飞书 = 卡片 message_id，web = `tk:<ticket id>`。规则本身不变，仍然是**代码掌握、不听模型**（`dispatcher` 说建新单会被纠偏）。

### 4.3 会话与身份

| 字段 | 飞书 | web |
|---|---|---|
| `channel` | `feishu` | `web` |
| `actor.id` | open_id | ERP user id（UUID） |
| `actor.display` | 飞书昵称 | ERP 姓名 |
| `threadKey` | 主卡片 message_id | `tk:<ticket id>` |
| `replyRef` | message_id | `stream_id` |

用户拍板「人人可改生产代码」→ 取消白名单，但**保留两项不可省**：

1. `actor` 必须落进工单 turns（谁提的），审计可查；
2. 部署触发仍走门禁（工作区干净、基线不倒挂、无未应用迁移、磁盘、快进、测试门禁），失败自动回滚。**放开的是人，不是门禁。**

## 5. 数据落库

### 5.1 新增两张投影表（Prisma）

```prisma
model AgentTicket {
  no          String   @id @db.VarChar(12)      // T-0007
  ticketId    String   @map("ticket_id")        // bot 内部 id
  state       String   @db.VarChar(24)          // 九态投影
  phase       String?  @db.VarChar(24)          // 施工阶段
  kind        String   @db.VarChar(24)          // defect / feature / tool_gap
  title       String?  @db.VarChar(200)
  channel     String   @db.VarChar(12)          // feishu / web
  actorId     String   @map("actor_id")         @db.VarChar(64)
  actorName   String?  @map("actor_name")       @db.VarChar(64)
  sessionId   String?  @map("session_id")       @db.VarChar(64)
  revision    BigInt                            // bot 侧版本号
  queuedAhead Int      @map("queued_ahead")
  startedAt   DateTime? @map("started_at")
  endedAt     DateTime? @map("ended_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  syncedAt    DateTime @map("synced_at")

  @@index([state, updatedAt])
  @@map("agent_tickets")
}

model AgentTicketEvent {
  id        String   @id @default(uuid()) @db.Uuid
  ticketNo  String   @map("ticket_no") @db.VarChar(12)
  seq       Int
  type      String   @db.VarChar(24)
  payload   Json
  createdAt DateTime @default(now()) @map("created_at")

  @@unique([ticketNo, seq])
  @@map("agent_ticket_events")
}
```

### 5.2 权威归属（避免双真源）

| 数据 | 权威 | ERP 库的角色 |
|---|---|---|
| 工单状态 / turns / progress / result | bot 文件（原子写） | 只读投影，仅同步任务可写 |
| 工单事件流 | bot（内存 + result 快照） | 追加式镜像，供看板与审计 |
| 顾问会话 / run / 事件 | ERP 库（`agent_*`） | 权威 |
| 工单与顾问会话的关联 | ERP 库 `agent_tickets.session_id` | 权威（关联关系属 ERP 域） |

同步策略：API 启动拉全量 → 之后按 `revision` 增量（`GET /internal/tickets?since=`），并订阅 `/events` 做近实时。**同步只 upsert 投影，永不回写 bot**。

### 5.3 用户拍板「会话写数据库」

- 顾问会话：沿用 `agent_sessions / agent_runs / agent_run_events`，**不改为浏览器本地权威**（理由见 §8.1）。
- 工单对话：DSH 会话内容由 bot 持有；ERP 侧只存 `session_id` 与事件镜像。看板点进工单看到的对话，走 API 事件流。

## 6. 查询工具治理

### 6.1 先立尺子（P0 第一步，其余一切在此之前不做）

`scripts/agent/eval-golden.mjs` + `apps/api/test/agent-golden/*.json`：

| 分组 | 用例数 | 内容 |
|---|---|---|
| 单号入口 | ≥20 | 销售/采购/生产单号各若干，含小写、多余空格、全角、缺后缀 |
| 错号与空结果 | ≥10 | 不存在单号、前缀相似单号、跨单据类型同号 |
| 关系根查询 | ≥15 | 检索 → 概览/状态/时间线/来源（含伪造句柄） |
| 跨单聚合 | ≥10 | 「本月采购超期」「库存不足物料」等非订单根 |
| 追问链 | ≥10 | 第二轮沿用上一轮单据句柄（现会丢，预期红） |
| 权限与越权 | ≥5 | operational 不得触达 finance |

产出：成功率、失败码分布（`ORDER_*` / `AGENT_TOOL_*` / `MODEL_*`）、每用例的模型步数与工具次数。**基线必须先跑出来，否则「失败率高」不可度量、改进不可证明。**

### 6.2 运行时止血

| 措施 | 取代现在的什么 | 预期收益 |
|---|---|---|
| **实体解析器** `entity-resolver.ts` | 模型直接传 `order_ref/order_no`（`agent-orchestrator.ts:250-269`） | 单号复制保真问题彻底消失；归一（空白/全角/大小写/模糊）在服务端一次做对 |
| **工具面扁平化** | 6 域工具 × 31 operation 的嵌套枚举（`tool-registry.ts`） | 「选错 operation」这一整类失败消失；每个工具参数与必填显式 |
| **校验-修复环** | 失败直接消耗模型失败预算（`AGENT_MAX_RECOVERABLE_TOOL_FAILURES=3`） | 一次内部重试即可自愈，不惊动模型 |
| **来源统一** | 顾问 `source` 事件 | 答案里的数字可点回单据 |

扁平工具建议集合（10 个）：`find_documents` / `order_overview` / `order_timeline` / `order_alerts` / `order_attachments` / `sales_detail` / `procurement_detail` / `production_detail` / `warehouse_detail` / `finance_detail`。
`finance_detail` 档位不变（仅 `full`）。

### 6.3 C/W/V：搬进 bot，但只用于造工具

**边界（必须先认同）**：C/W/V 是「**造工具/修工具**」的拓扑，不是「答问题」的拓扑。让每题都过三角色，在 2 核机器上会把 30 秒变 5 分钟，而且失败率不会降——失败是工具语义问题，审一遍只告诉你它错在哪。

| 场景 | 谁跑 | 时延 |
|---|---|---|
| 用户问业务问题 | 顾问运行时（单 agent，扁平工具 + 解析器 + 修复环） | 秒级 |
| 判定「能力不存在 / 口径总是错」→ `tool_gap` 工单 | bot：Coordinator → Builder ∥ Validator | 分钟级，异步 |
| 业务功能改动（界面/流程/报表） | bot：现有单 agent | 分钟级，异步 |

### 6.4 Agent 运行规则（用户拍板「Builder/Validator 作为同一会话的两个子 agent」）

你说得对：网关已经是 Coordinator，B/V 只需落成**运行规则**。规则落三层，缺一层就退化成「靠模型自觉」：

**第一层 · 契约（prompt-builder）**
`tool_gap` 工单生成固定契约块，写死四件事，不写具体代码方向：
1. 角色与产物路径：`builder-<capability_id>` 写 `manifest + implementation + tests` 到候选目录；
2. 次序：Builder 提交后**必须**起 `validator-<capability_id>`（独立子会话，不看 Builder 的推理过程，只看产物与测试）；
3. Validator 结论只有三种：`pass` / `rework(原因)` / `reject(原因)`；`rework` 必回 Builder 一轮；
4. 硬禁止：不得改业务模块、迁移、权限策略、编排器、部署脚本（沿用自生成工具架构的既有边界）。

**第二层 · 事件（coordinator 侧证据）**
`coordinator.ts` 现在只统计 `counts.subagentCalls`（数字），不足以判定「谁审了谁」。升级为**结构化子会话记录**：

```ts
type SubagentRecord = {
  role: 'builder' | 'validator' | 'other'
  capabilityId: string
  sessionRef: string
  startedAt: string
  endedAt: string | null
  verdict?: 'pass' | 'rework' | 'reject'
}
```

从 DSH `--json` 事件的 `subagent` 相关条目解析，产出 `builder → validator` 时序证据，写进工单 `progress.subagents` 并转译为 `subagent_status` 事件（看板可直接显示「Builder 完成 → Validator 审查中」）。

**第三层 · 门禁（代码拒绝，不看模型自述）**
run 成功后、部署前核对：
- 每个 capability 都有 `builder` 与 `validator` 两条记录，且 validator 起点晚于 builder 终点；
- validator 的 `verdict === 'pass'`，且其审查绑定的产物哈希 = 当前候选哈希（沿用 `apps/coding-worker/src/revision-evidence.ts` 的绑定思路）；
- 候选目录路径在白名单内、测试报告存在且通过；
- 任一不满足 → 工单不进 `gated`，回 `needs_info`/`failed` 并写明缺哪条证据。

**必须承认的前提风险**：DSH 子会话在真实 run 里**从未被观察到成功触发**（历史两次 run 都是 0 次）。所以 P4 的第一件事是一个**最小验证工单**（例如「新增一个只读工具：按供应商查最近三次到货」），验收标准是事件流里能看到 `builder` 与 `validator` 两条记录；看不到就先修观测，不往下做。

`apps/coding-worker/` 的 phase1 实现（`single-parent-*`、`candidate-gate`、`independent-gate`、`revision-evidence`、`job-policy`）是这套规则的现成原型：**搬状态机与证据规则，不留两套实现**。

## 7. 前端移植（chat-demo → Next 15）

### 7.1 移植 / 不移植

| 移植 | 说明 |
|---|---|
| `services/api/sse.ts`、`parseEvent.ts`、`errors.ts` | 五类错误分类（http/stream/network/interrupted/protocol）比现在的单一 `SSE_REFUSED_*` 精细 |
| `services/chat/reply.ts`、`branches.ts`、`drafts.ts`、`describe.ts`、`view.ts` | 发送/停止/**继续**、编辑重发与分支、草稿、自动标题 |
| `services/chat/db.ts` | 本地缓存（降级为缓存 + 草稿 + 分支，不是真源，见 §8.1） |
| `services/markdown/*`、`useThrottleMarkdownRender`、`components/markdown/*` | KaTeX / Mermaid / 高亮 / 节流渲染 |
| `components/messages/*` | MessageList / BranchSwitcher / ReplyArea / useReplyView / scrollContext |
| `components/chatInput/*` | 附件、拖拽、草稿、录音 UI（语音后端能力 P5 再评估） |
| `components/search/SourceCard.tsx` | **改造成单据来源卡片**：网页来源 → 单据 + `as_of` + 深链 |
| `i18n/zh.ts`、`app/theme.ts` | 中英切换、明暗主题 |

| 不移植 | 原因 |
|---|---|
| `services/api/client.ts` 的直连与 `API_ORIGIN` | 我们走后端代理，key 不下发浏览器 |
| `components/settings/*`、`useApiKeyForm` | 模型与开关由后端定 |
| `components/base/*`（Button/Menu/Modal/Select/Tooltip） | 我们有 Radix，不引入第二套设计系统 |
| `rspack.config.ts`、`*.module.css.d.ts` | Next 原生支持 CSS Modules，不需要声明文件 |
| 搜索面板、读链接、引用标记 | 用户拍板不开联网搜索 |

### 7.2 落位

```
apps/web/app/agent/                 ← 顾问（沿用现有 /business-query 的 URL 由路由重定向接管）
apps/web/app/agent/tickets/         ← 看板
apps/web/app/agent/tickets/[no]/    ← 工单对话（= 对话流 + 状态 + 事件 + 工件）
apps/web/features/agent-chat/       ← 移植进来的模块（自带 *.module.css）
```

CSS Modules 自成一套，**不写进现有 116KB `globals.css`**；ERP 表单页继续用 Radix。

### 7.3 与现有测试的关系

现有 `tests/e2e/business-query-recovery.spec.mjs` 与 `apps/web/lib/business-query-state.ts` 的 reducer 单测是**可复用资产**：信封形状不变，reducer 逻辑可直接迁移到新前端；改名时同步改文档（`agent-chat.ts:44` 的注释已写明这条纪律）。

## 8. 两个必须提前说清的风险

### 8.1 会话权威：服务端权威 + 本地缓存（已获拍板）

chat-demo 的会话只活在浏览器 IndexedDB：换设备即丢、服务端无记录。我们有三个它没有的硬需求：
① 工单桥接要让服务端知道「这个问题对应哪个 run」；
② 财务档位被降权后，历史 full 答案不得还能从本地读出来（`stream-transport.ts:78` 的 `ACCESS_REVOKED` 机制依赖服务端权威）；
③ 运维要能回答「用户到底问过什么」。

所以：**服务端事件日志继续做权威，IndexedDB 只做「缓存 + 草稿 + 分支」。** 首屏从本地秒开 → 后台按游标补差量，体感与 chat-demo 一致。

### 8.2 注释全量删除的边界

用户拍板「注释全量删除，禁止再写注释」。执行前必须分清两种东西：

| 类别 | 例子 | 处理 |
|---|---|---|
| 散文注释 | `// 单号是业务自己编的，可能带产品名` | **删除** |
| 功能性指令（形似注释，删了就坏） | `// eslint-disable-next-line`、`// oxlint-disable`、`// @ts-expect-error`、`// @ts-nocheck`、`/// <reference types="…" />`、`#!` shebang | **保留**，进白名单 |
| **!** 许可头 | 移植进来的 chat-demo 文件（MIT） | **必须保留**；MIT 要求保留版权与许可声明。删掉是法律问题，不是风格问题 |
| Prisma `///` | `schema.prisma` 的文档注释 | 会进入生成客户端的文档；删了不影响运行，但需单独一轮，不掺在 TS 清理里 |

做法：
1. `scripts/strip-comments.mjs` 用 TypeScript Compiler API（`ts.createSourceFile` + `getLeadingCommentRanges` / `getTrailingCommentRanges`）按语法删，**不用正则**（正则会打坏 URL、正则字面量、JSX 文本、模板字符串）；
2. 先跑 `.ts/.tsx/.mjs/.cjs`，分批提交（api / web / tools / scripts），每批跑 `typecheck` + 相关测试；
3. CI 加守卫：**新增或修改的文件里不得出现白名单外的注释**；
4. 「为什么这么做」的信息不留在代码里 → 全部迁进 `docs/design`、`docs/review`、`docs/log`（本仓已有这套习惯，只是代码里重复了一遍）。

## 9. 阶段与验收

| 阶段 | 交付 | 验收（可执行） |
|---|---|---|
| **P0 尺子** | `eval-golden.mjs` + ≥60 用例 + 基线报告 | 跑出基线成功率与失败码分布；报告进 `docs/review/` |
| **P1 止血** | 实体解析器、扁平工具 ~10、修复环、来源统一 | 黄金集成功率相对基线显著上升；`finance` 档位用例不回归 |
| **P2 前端换装** | `/agent` 移植树 + 共享事件客户端 | 首屏本地秒开；长答案流式无 jank；reducer 单测迁移后全绿 |
| **P3 桥接** | bot `/internal/*` + `WebChannel` + API `ticket-bridge` + 投影同步 | 网页发一句 → 出工单 → 进度在与顾问同一个渲染器里滚动；断网重连不丢事件 |
| **P4 看板** | `/agent/tickets` 四栏 + 工单对话 + 取消/部署/重试 | 刷新后阶段与队列位次正确；阻塞单可见原因 |
| **P5 C/W/V 进 bot** | `tool_gap` 工单 + 三层运行规则 + 证据门禁 | 最小验证工单里事件流出现 builder+validator 两条记录；缺证据时门禁拒绝 |
| **P6 清理** | 注释清除、删重复实现、文档 | `typecheck` + 全量测试绿；CI 注释守卫生效 |

顺序理由：P0 先做，因为**没有尺子就不知道任何改动是否真的变好**。

## 10. 未定与风险

1. **DSH 子会话观测**（最高）：`subagent` 事件是否稳定携带 `id/name/parent` 未实测；P5 第一件事就是验证它，验证不过就停在观测层。
2. **bot 单车道**：web 用户并发提交会排队；看板必须显示位次（`progress.ts:288` 的 `statusText` 已有队列位次能力，直接复用）。
3. **投影延迟**：同步是拉取式，最坏有秒级偏差；看板显示「最后同步时间」，不假装实时。
4. **无白名单**：任何登录用户都能改生产代码。兜底只剩审计 + 门禁 + 回滚；建议 P4 顺手加一条「部署后 30 分钟内任何失败自动回滚并在看板红标」。
5. **chat-demo 组件与 Next 15 的适配成本**：它是 rspack + CSS Modules + 构建期常量；移植时**只取纯模块与行为**，组件按我们的设计系统重画，避免出现第二套视觉。
6. **注释清除的回归面**：`@ts-expect-error` 之类的指令若被误删会直接编译失败——所以白名单必须先写，脚本先 dry-run 出 diff 再提交。

## 变更记录

- 2026-11-22：建立。依据用户本轮六条决定 + 本轮三处实测（chat-demo 为纯静态前端、顾问事件表已 seq 化、摘要/工具面现状）与既有三份设计文档。