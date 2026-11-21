# LLM 调度器与进度播报精简

日期：2026-11-20｜版本：1.0｜状态：**已设计，待实施**｜类型：设计

上游：[Agent 应用层架构](agent-application-layer-architecture-2026-11-14.md)、
[自主部署与 GitHub 推送](autonomous-deploy-and-github-push-2026-11-16.md)。

## 0. 两条要求

2026-11-19 晚，用户提出：

> 自由度不高，Coordinator 可以换成 LLM，需要派发工单的时候，调用工具开会话。不要再用正则
> 去匹配用户说的话了，自由度太低了。

> 群里的进度播报太多啰嗦，信息刷屏。要精简。保留小部分的进度播报。

## 1. 现状的问题

### 1.1 正则判定自由度太低

`intent.ts` 用 ~40 组关键词做意图分类，`triage.ts` 用关键词做「模块 / 期望 / 入口」抽取。
2026-11-19 的两次漏判（「再次尝试部署」被判成需求）已经说明：**词表覆盖不了人的说话方式**。
每加一种说法就要补一条词，词表越长，误判面越大，且无法覆盖没见过的说法。

### 1.2 播报刷屏

`runTicket` 里每 `progressNoticeMs`（默认 5 分钟）发一条心跳，部署阶段同样每 5 分钟一条，
加上开工、验证、收尾各一条，一次 20 分钟的 run 会在群里留下 5–7 条消息。用户要的是
「别刷屏，保留关键的」。

## 2. 设计：Coordinator 换成 LLM 调度器

### 2.1 分层不变，换掉「判断」这一层

三层职责保持不变：**飞书只收发，Coordinator 只编排，DSH 只干活。**
变化的是 Coordinator 内部「这条消息要做什么」的判断：从**正则词表**换成**LLM 工具调用**。

```
飞书群 → 事件网关 → Coordinator
                        ├─ dispatcher（LLM + 工具）   ← 新增：判断要做什么
                        ├─ decideRoute（结构硬规则）    ← 保留：判断追加还是新单
                        ├─ ticket-store
                        ├─ prompt-builder
                        ├─ harness-runner
                        ├─ progress
                        └─ deploy
```

### 2.2 工具契约

调度器是**唯一**的模型入口，一次调用返回一个归一化动作。模型只能通过工具表达意图，
工具就是它的「话术」：

| 工具 | 参数 | 语义 |
|---|---|---|
| `create_ticket` | `text`、`title?`、`module?`、`expected?`、`entry?` | 建新单并排队改代码 |
| `append_ticket` | `ticketNo`、`text`、`module?`、`expected?`、`entry?` | 追加到已有工单 |
| `start_run` | `ticketNo` | 为某张单开会话（重跑/续跑） |
| `status` | `ticketNo?` | 查进度（**不调模型**，本地事实） |
| `ask_more_info` | `question`、`ticketNo?` | 需求不够，追问 |
| `reply` | `text` | 直接回一句（闲聊、致谢、应答、提问） |
| `deploy` | 无 | 触发部署 |

设计取舍：

- **`status` 不调模型**：进度是可枚举的本地事实（状态、时长、阶段、工具数、改动文件数），
  模型只会重述，还可能编出「已完成 70%」这种没依据的话。模型只负责「该不该问」，
  答案仍由 `progress.ts` 的纯函数生成。这条原则与改造前一致，不能因为换了 LLM 就松掉。
- **`reply` 由模型直接产出文本**：不再单独走 `answerer.ts`。一次调用既选动作又写回复，
  避免「问一句要等两次模型」。回答的边界（不臆造、不承诺、不假装是人）写进调度器的
  system prompt。
- **`module/expected/entry` 由模型抽取**：`prompt-builder` 的结构化提示段保留，
  但字段来源从正则变成模型。模型没抽到就留空，提示段自动省略。

### 2.3 卡片规则：代码硬判定，不由模型决定

**「回复工单卡片 = 追加」继续由代码判定**（读 `parent_id` / `root_id` 命中 `cardMessageId`）。
用户 2026-11-14 拍板，并在 2026-11-19 再次确认：误归单比漏归单代价高，一条需求被塞进
错单，Agent 会拿着不相关上下文改代码。

调度器可能对卡片回复返回 `create_ticket`（它未必意识到这条消息挂在卡片下）。
Coordinator 做**强制纠偏**：

```
若 route.kind === 'append' 且 action.kind === 'create_ticket'
  → 改写为 append_ticket(route.ticket.no, text)，并记日志
```

反过来，`append_ticket` 指向的工单必须存在且非终态；不存在或已终态则拒绝并回 `reply`。

### 2.4 兜底

模型不可用（无 key / 超时 / 5xx / 空返回）时，回一句固定的出错话术，**不建单、不开工、
不部署**。宁可少做，不可乱做。兜底动作不做任何业务判断。

### 2.5 删除的模块

| 模块 | 处理 | 理由 |
|---|---|---|
| `intent.ts` | 删除 | 正则意图分类，被调度器取代 |
| `triage.ts` | 删除 | 正则分诊，字段抽取改由模型完成 |
| `ticket-flow.ts` | 删除 | Phase 2 遗留，只被 `triage` 使用，不在 Coordinator 路径上 |

`normalizeText` / `extractTicketNo` 这类纯文本工具若仍被别处使用则保留；不再作为
「判断用户意图」的依据。

## 3. 设计：进度播报精简

### 3.1 分清两个通道

| 通道 | 形态 | 保留 |
|---|---|---|
| **卡片原地更新** | 内容被替换，不新增群消息 | 保留（但不刷屏），行数精简 |
| **群内新消息** | 每条都是一条新消息 | **只保留三条** |

### 3.2 群内只留三条

1. **开工一条**：`T-0018 已开工，预计 10–20 分钟。`（去掉承诺式长句）
2. **收尾一条**：进入 `finishing` 阶段时，一句话
3. **结束/结果一条**：run 结果卡 + 部署结果（已有）

**周期性心跳一律去掉**：`runTicket` 的 `setInterval` 心跳、部署阶段的心跳、以及
「验证阶段播报」全部移除。`progressNoticeMs` 默认改为 `0`（关闭）；需要时用环境变量
`PROGRESS_NOTICE_MS` 重新打开，间隔由运维自己定。

### 3.3 卡片行数

施工中卡片从 5 行精简到 3 行：

```
**已用**：6 分 32 秒
**当前**：在改代码（edit apps/web/a.tsx）
**改动**：已触及 3 个文件
```

去掉「最新原文」这类噪音行。状态回答（用户主动问「T-0007 进度」）保持完整——那是
**查询通道**，不是播报，信息量要足。

## 4. 接口

### 4.1 `dispatcher.ts`

```ts
export type DispatchAction =
  | { kind: 'create_ticket'; text: string; title?: string; hint?: RequestHint }
  | { kind: 'append_ticket'; ticketNo: string; text: string; hint?: RequestHint }
  | { kind: 'start_run'; ticketNo: string }
  | { kind: 'status'; ticketNo: string | null }
  | { kind: 'ask_more_info'; question: string; ticketNo: string | null }
  | { kind: 'reply'; text: string }
  | { kind: 'deploy' }

export interface DispatchInput {
  text: string
  tickets: readonly TicketSummary[]      // no / state / 首句
  gatedCount: number
  activeRunCount: number
  deployEnabled: boolean
}

export interface DispatchResult {
  readonly action: DispatchAction
  readonly source: 'model' | 'fallback'
  readonly error?: string
}

export async function dispatch(input: DispatchInput, options: DispatchOptions): Promise<DispatchResult>
```

### 4.2 `CoordinatorOptions` 变化

- 新增 `dispatchImpl?: typeof dispatch`（注入用，测试不真调模型）
- 移除 `answererImpl` / `answererKey` / `answererBaseUrl` / `answererModel`（并入调度器）
- `progressNoticeMs` 默认 `0`

## 5. 验收

1. `npm test` 全绿；`tsc --noEmit` 干净。
2. 调度器单测：给定固定模型返回，断言动作归一化、兜底、卡片纠偏。
3. 端到端：服务器上重启机器人，用真实群消息试「建单 / 问进度 / 闲聊 / 部署」四类，
   群里只出现预期的三条播报，无心跳。
4. 回归：`replay-intents.ts` 用假模型跑通，建单数与预期一致。

## 6. 风险

| 风险 | 应对 |
|---|---|
| 模型误判动作 | 卡片规则代码硬判定 + 终态校验 + 兜底不动作；动作全量记日志 |
| 每条消息多一次模型调用 | 单次调用、短 prompt、`status` 走本地事实不调模型 |
| 提示注入 | 用户原话进数据区块；调度器只有工具能触发动作，自由文本只作回复 |
| 模型抽不到结构化字段 | 字段可选，缺了就省略提示段，原话始终是权威输入 |
