<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-2 的机器可读参数清单 `accepts`**：35 条各自声明模型可传的参数名，并用测试证明它与执行器实际接受的一致。
- **Starts after**：任务 1。**Waits on it**：任务 4（展开时带出）、阶段 3 的 `report_gap` 核对。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/order-root.ts` — `parseOrderRootInput`：带页与不带页两种允许集合。
- `apps/api/src/modules/business-query-agent/tools/rooted-operations.ts` — 每个根查询的 `parse` 用的是哪种。
- `apps/api/src/modules/business-query-agent/tools/{order-query-tools,document-search-tools,list-documents-tools,unrooted-operations}.ts` — 另外四个入口的 `ALLOWED_KEYS`。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts`（`resolveRootCall`）— `order_ref` 在进执行器前被剥掉并还原成 `order_no`。

**Settled**

- `accepts` 是**模型侧**参数名数组。根查询写 `order_ref`（模型不直接传 `order_no`），解析器那一侧对应的是 `order_no`。
- 允许的参数词表固定为：`order_ref`、`page`、`q`、`status`、`customer_q`、`product_q`、`from`、`to`。不得新增词。
- 对账的真源是**解析器自己**：同一个参数名，解析器接受就必须在 `accepts` 里，反之亦然。不以阅读代码得出的结论当期望。

**Edges and seam**

- 改 `tools/tool-catalog-specs.ts`（`OperationSpec` 加必填字段 `accepts`）；新增测试 `agent-tool-catalog-accepts.test.cjs`。**不改**任何解析器与执行器。
- Seam：`ROOTED_OPERATIONS[op].parse`、`UNROOTED_OPERATIONS[op].parse`、`parseSearchOrdersInput`、`parseSearchDocumentsInput`、`parseListDocumentsInput`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-catalog-accepts.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 测试用「基础合法参数 + 一个探测参数」去调解析器：解析器不抛错就算接受。基础参数——根查询 `{order_no:"SO-1"}`，两个检索 `{q:"x"}`，其余 `{}`。若某个解析器对探测值另有校验（例如 `status` 只认 `draft/confirmed/closed`、日期要 `YYYY-MM-DD`），探测值必须取合法值，取不到就停下报告，不要放宽解析器。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写测试的用例 1（`list_documents` 的六个参数），红。
3. 给 `OperationSpec` 加必填 `accepts`，类型检查会逼出 35 处缺失。
4. 逐模块补齐 35 条，依据是解析器探测结果，不是印象。
5. 写探测函数：对每个 operation、每个词表参数各探测一次，把「接受」集合与 `accepts` 比较（`order_ref` 探测时换成 `order_no`）。
6. 转绿用例 2 至 5。
7. 跑 Run 的两条命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `list_documents` 的 `accepts` | 恰为 `status`、`customer_q`、`product_q`、`from`、`to`、`page`（来源：提供方输入 schema 里「仅 list_documents」的五个说明加 `page`） | 规格表 |
| 2 | `get_order_overview` 与 `get_order_timeline` | 前者 `accepts` 恰为 `["order_ref"]`，后者恰为 `["order_ref","page"]`（来源：`rooted-operations.ts` 的 `withPage:false` 与默认） | 解析器探测 |
| 3 | `list_low_stock_materials`、`list_overdue_arrivals` | `accepts` 恰为 `["page"]`，且**不含** `order_ref`（来源：设计 §3.1 示例「无需单据根；可选 `page`」） | 解析器探测 |
| 4 | 35 个 operation × 词表 | 对每一格，「解析器接受」与「在 `accepts` 里」相等 | 解析器探测 |
| 5 | 故意把 `accepts` 里 `get_order_timeline` 的 `page` 去掉（测试内局部拷贝） | 用例 4 的比较函数报告不一致 | 比较函数 |

</task-brief>
