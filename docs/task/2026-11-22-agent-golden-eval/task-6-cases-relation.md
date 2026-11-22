<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-6 三组用例内容**：`relation`（16 条）、`followup`（6 条）、`permission`（5 条）。
- **Starts after**：任务 1。**Waits on it**：任务 7。

## 2. What the developer needs to know

**Read first**

- `scripts/seed-mock-data.mjs` — 期望值的独立来源：`MOCK-ORD-001` 有 BOM、生产单、采购单、到货、入库、应付。
- `apps/api/src/modules/business-query-agent/tools/rooted-operations.ts` — 30 个根 operation 各自的业务口径。
- `apps/api/src/modules/business-query-agent/context-manager.ts` — 追问只带最近 8 轮**问答文本**，不带工具事实；`followup` 组钉的就是这件事。
- `apps/api/src/modules/business-query-agent/access-level.ts` — `administrator` 只是 `operational`，财务需 `laoban/caiwu`。

**Settled**

- `relation` 组全部以 `MOCK-ORD-001` 为根，断言来源含它 + 终态 `completed`。
- `followup` 组是多轮（`turns`）：第一轮问单据，第二轮用「那它的…」追问，两轮各自成一个 run。
- `permission` 组只做**负向**：`operational` 账号问财务问题，断言来源里没有 `finance` 类型、无 `AGENT_INTERNAL_ERROR`。
- 正向财务用例（`laoban` 账号能查到）**本批不做**：本地库只有 `administrator`。这条写进任务 7 报告的「未覆盖」一节。

**Edges and seam**

- 只新增 `apps/api/test/agent-golden/cases/relation-*.json`、`followup-*.json`、`permission-*.json`。

**Run**

- `npm run test:agent-golden -- --validate`
- `npm run test:agent-golden -- --group relation --group followup --group permission`

**Unknowns**

- 「那它的采购单到货了吗」这句话第二轮能不能自己再检索到，取决于模型。若两轮都通过，说明上下文够用；若第二轮红，说明上下文确实丢了工具事实。**两种结果都是基线，不改用例。**
- `permission` 组问财务时的 `business_type` 命名未确认。若来源里根本没有 `finance`，用 `sourcesExcludeTypes` 会恒真；此时改为断言「来源里的 business_type 集合不含任何财务类词」，并在报告里说明该校验偏弱。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 写 `relation-order.json`（6 条）：概览、状态、时间线、告警、附件、同日多问。
3. 写 `relation-chain.json`（6 条）：采购到货、来料质检、生产进度、工序报工、原料库存、成品入库。
4. 写 `relation-cross.json`（4 条）：跨单聚合（本月到货超期、库存不足物料、某客户全部订单、某产品全部订单）。
5. 写 `followup-context.json`（6 条）：三组两轮、三组三轮，覆盖「换单据继续问」与「同一单据换主题」。
6. 写 `permission-finance.json`（5 条）：问应收、问应付、问成本利润、问工资、问对账，全部以 `operational` 身份。
7. `--validate` 全绿，按组分批跑一次记录基线，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 16 + 6 + 5 条 | 全部 `--validate` 通过 | `loadCases()` |
| 2 | `relation-order` 概览 | `completed` + 来源含 `MOCK-ORD-001` | `judge()` |
| 3 | `relation-chain` 采购到货 | `completed` + 来源含 `MOCK-ORD-001` | `judge()` |
| 4 | `followup` 三条两轮用例 | 只建一个 session、三个 run | `runCase()` |
| 5 | `permission` 任一条 | 来源 `business_type` 不含财务类、无内部错误 | `judge()` |
| 6 | `followup` 任一条 | `turns` 长度 ≥2 且无 `question` 字段 | `parseCase()` |

</task-brief>