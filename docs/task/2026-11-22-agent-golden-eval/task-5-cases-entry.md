<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-5 两组用例内容**：`entry`（单号入口，22 条）与 `miss`（错号与空结果，12 条）。
- **Starts after**：任务 1（格式）。**Waits on it**：任务 7（基线报告）。

## 2. What the developer needs to know

**Read first**

- `scripts/seed-mock-data.mjs` — **期望值的唯一独立来源**：哪张单存在、单号字面、状态。
- `apps/api/src/modules/business-query-agent/tools/document-search-tools.ts` — 三类单号都能进检索，返回里带 `order_ref`。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — `ORDER_SEARCH_REQUIRED`、`ORDER_REF_INVALID`、`AGENT_MAX_TOOL_STEPS` 的语义。
- `docs/review/agent-tool-invocation-audit-2026-10-27.md` — D-2、D-4 是本组要钉的「单号写形差异」。

**Settled**

- 根查询一律以**销售单号**为根。所以 `entry` 组的 `sourcesInclude` 写销售单号 `MOCK-ORD-001/002`，不写采购单号或生产单号。
- `miss` 组不许断言「答案里没有某个词」，因为模型措辞会漂。只断言：终态 `completed`、无内部错误、无超时、无失败预算耗尽、工具次数在预算内。
- 大小写/空格/全角的变体用例是**故意的红**：现实现只有 `insensitive`，没有空白与全角归一。基线报告要说清它们红在哪。
- 每条用例的 `baselineDocs` 必须列出它依赖的单号，运行器据此做前置检查。

**Edges and seam**

- 只新增 `apps/api/test/agent-golden/cases/entry-*.json` 与 `miss-*.json`。
- 不改 `apps/api/src`，不改运行器。

**Run**

- `npm run test:agent-golden -- --validate`（只验格式，不调模型）
- `npm run test:agent-golden -- --group entry --group miss`

**Unknowns**

- `DEMO-ORD-260907` 这类早期演示数据在不在目标库，不确定。**不要引用它**，只用 `MOCK-*`。若发现 `MOCK-*` 也不在，那正是 `baseline_missing` 该出现的地方，不要改用例去迁就库。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 从种子数据抄出单号清单：`MOCK-ORD-001/002`、`MOCK-PO-001/002`、`MOCK-PROD-001/002`、`MOCK-REC-001`。
3. 写 `entry-sales.json`（8 条）：原样单号、小写、前后多一个空格、全角数字、只写后半段、带产品名同句、问状态、问进度。
4. 写 `entry-other-docs.json`（7 条）：采购单号入口 3 条、生产单号入口 3 条、同一句里同时出现销售与采购单号 1 条。
5. 写 `entry-batch.json`（7 条）：不带单号、按客户名找单、按产品名找单、按状态找单、一次问两张单、问「最近有哪些单」、问单号相近的两张。
6. 写 `miss-unknown.json`（6 条）：完全不存在的前缀、相似前缀缺尾号、同号但不同类型、空串、纯空格、超长串。
7. 写 `miss-cross-type.json`（6 条）：把采购单号当销售单号问根查询、把生产单号当销售单号、伪造 `order_ref`、只写产品名、只写客户名、写一个像单号的日期串。
8. `--validate` 全绿，`--group entry --group miss` 跑一次记录基线，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 22 条 `entry` | 全部可 `--validate` 通过 | `loadCases()` |
| 2 | 12 条 `miss` | 全部可 `--validate` 通过 | `loadCases()` |
| 3 | `entry-sales` 首条（原样单号） | `completed` + 来源含 `MOCK-ORD-001` + 调过 `search_documents` | `judge()` |
| 4 | `entry-sales` 小写变体 | 同上（当前实现预期**红**：空白与全角未归一） | `judge()` |
| 5 | `miss-unknown` 首条 | `completed` + 无 `AGENT_*_ERROR/TIMEOUT/RETRIES_EXHAUSTED` | `judge()` |
| 6 | 任一 `entry` 用例 | `baselineDocs` 非空且只含 `MOCK-*` | `parseCase()` |

</task-brief>