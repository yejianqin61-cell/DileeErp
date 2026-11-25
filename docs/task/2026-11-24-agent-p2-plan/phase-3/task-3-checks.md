<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务交付 R-5 的三条驳回核对**：给一个已解析的声明与本轮执行记录，返回放行或驳回。
- **Starts after**：任务 1、2。**Waits on it**：任务 5。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/phase-3/README.md` — 核对 2、核对 4 的口径，错误码与 message 原文。
- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — `candidateOperations`（可见性唯一出口）与 `DescribedOperation` 的五字段加 `accepts`。
- `tools/report-gap.ts`、`tools/gap-fields.ts`（任务 1、2）— 声明类型与字段分组。

**Settled**

- 顺序固定：先「最近邻可见」，再「参数本来就接受」，再「缺数据」；命中第一条即返回。
- 可见性只经 `candidateOperations("", accessLevel)`，不另写过滤（计划 R-13）。
- 条目 JSON 的键：`operation,question_shape,input,output,boundary,accepts`，与 `describeModule` 返回的单条一致。
- 放行结果：声明各字段 + `needed_fields`（核实过的）+ `unverified_fields`。驳回结果：`{ code, message }`，message 逐字按 README。

**Edges and seam**

- 新文件 `tools/gap-check.ts`，导出 `checkGap(declaration, { accessLevel, executed })`，`executed` 为 `{operation, rows}[]`；返回 `{accepted:true, gap}` 或 `{accepted:false, code, message}`。不改别的文件。
- Seam：`checkGap` 纯函数。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-check.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 能力表里若出现两个工具有同名 operation：停下报告（本批假定 operation 名全局唯一）。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（放行），红，再实现骨架。
3. 写用例 2（最近邻不可见），红，再补核对 1。
4. 写用例 3、4（参数本来就接受），红，再补核对 2。
5. 写用例 5、6、7（缺数据口径），红，再补核对 4。
6. 跑 Run 的命令，提交。

## 4. The test cases

「声明」基准：`nearest_operation:"list_low_stock_materials", missing:"group_by", missing_detail:"按仓库分组", needed_fields:["SalesOrder.orderNo","仓库"]`。

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 基准，`operational`，`executed:[]` | 放行；`needed_fields` 为 `["SalesOrder.orderNo"]`，`unverified_fields` 为 `["仓库"]` | `checkGap` |
| 2 | `nearest_operation:"get_receivables"`，`operational`；另一次 `"made_up"`，`full` | 都驳回 `AGENT_GAP_OPERATION_UNKNOWN`；前者 message 不含 `get_receivables`、不含任何财务 operation 名 | 同上 |
| 3 | `nearest_operation:"list_documents", missing:"filter", missing_param:"status"` | 驳回 `AGENT_GAP_PARAM_SUPPORTED`；message 含「list_documents 本来就接受参数 status」与 `"question_shape"` | 同上 |
| 4 | `nearest_operation:"get_bom", missing:"filter", missing_param:"status"`；另一次 `list_documents` 且不填 `missing_param` | 都放行（`get_bom` 只接受 `order_ref`、`page`，来源：目录规格） | 同上 |
| 5 | 基准，`executed:[{operation:"list_low_stock_materials",rows:0}]` | 驳回 `AGENT_GAP_NO_DATA`，message 含「查到 0 行」 | 同上 |
| 6 | 基准，`executed` 为同一 operation 两次，行数 0 与 3 | 放行 | 同上 |
| 7 | 基准，`executed:[{operation:"search_documents",rows:0}]` | 放行（别的 operation 落空不算，来源：用户 2026-11-25） | 同上 |

</task-brief>
