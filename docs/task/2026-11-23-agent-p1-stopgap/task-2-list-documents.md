<task-brief>

## 1. Where this task sits

- **Phase P1 止血**，目标是工具调用失败率归零。
- **本任务交付 R-2 列表与筛选入口 `list_documents`**：让「最近有哪些订单」「已确认的有哪些」有工具可调。
- **Starts after**：任务 1（归一）。**Waits on it**：任务 6（报告对比）。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — operation 清单与 `maxRows`，新 operation 要登记在这里。
- `apps/api/src/modules/business-query-agent/tools/tool-executor.ts` — 三条分支：`search_orders`、`search_documents`、其余走根表。新 operation 走第一条支线。
- `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts` — `domainInputSchema` 是所有 operation 共用一个宽松 schema，执行器才是严格的那一层。
- `apps/api/test/agent-golden/cases/entry-batch.json` — 这正是本任务要转绿的两条：`entry-batch-recent`、`entry-batch-status-filter`。

**Settled**

- 挂在 `order_query` 工具下，operation 名 `list_documents`。不新增工具名：工具数量是模型上下文的成本。
- 只读、只返回非财务字段（单号 / 产品 / 数量 / 单位 / 状态 / 交期 / 客户名）。
- 分页固定 20 行、页码 1..1000，与既有检索一致。
- 状态用白名单枚举校验，不做模糊匹配：`draft/confirmed/closed/cancelled` 之类。若模型的 `status` 不在白名单，返回可读的参数错误并列出允许值。

**Edges and seam**

- 新增 `tools/list-documents-tools.ts`；注册进 `tool-registry.ts`；执行器加一条分支；`domainInputSchema` 加四个可选字段。
- 不动既有 31 个 operation 的行为。

**Run**

- `node --test apps/api/test/unit/agent-tool-list-documents.test.cjs`（本任务新建）
- `npm run build --workspace=@dilee/api`
- `npm run test:unit:api`（既有 operation 不许回归）

**Unknowns**

- 「最近」没有时间词时按什么排序？按 `updatedAt desc` 即可，与工作台一致。若模型给的 `from`/`to` 格式不合法，停下来报告，别猜成「忽略该条件」——静默忽略会让用户以为筛过了。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 先写失败测试：`parseListDocumentsInput({status:"confirmed"})` 解析成功；`{status:"已确认"}` 抛错并列出允许值；未知字段抛错。
3. 写 `listDocuments(client, input)`：软删过滤 + 可选 `status` / `customer_q` / `product_q` / `from` / `to`，`updatedAt desc`，分页 20。
4. 补测试：无参数时返回全部（受分页）；`status` 过滤生效；`customer_q` 命中客户名。
5. 注册 registry（`implemented: true`, `maxRows: 20`），执行器加分支，`domainInputSchema` 补字段。
6. 跑 `test:unit:api` 确认 31 个既有 operation 不回归，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `{status:"confirmed"}` | 解析成功，返回该状态 | `parseListDocumentsInput()` |
| 2 | `{status:"已确认"}` | 抛错，消息含允许的状态值 | `parseListDocumentsInput()` |
| 3 | `{bogus:1}` | 抛错，消息含 `bogus` | `parseListDocumentsInput()` |
| 4 | `{}` | 解析成功，`page` 默认 1 | `parseListDocumentsInput()` |
| 5 | 种子数据无过滤 | 至少含 `MOCK-ORD-001` | `listDocuments()` |
| 6 | `{customer_q:"海风"}` | 返回 `MOCK-ORD-001`，不含 `MOCK-ORD-002` | `listDocuments()` |

</task-brief>