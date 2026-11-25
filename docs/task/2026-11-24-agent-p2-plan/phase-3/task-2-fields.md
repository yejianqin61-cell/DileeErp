<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务交付 R-5 的字段核对**：把声明里的所需字段对照 Prisma 元数据分成「存在」与「未核实」两组，从不拒绝。
- **Starts after**：无。**Waits on it**：任务 3。

## 2. What the developer needs to know

**Read first**

- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §2.3 — 第 3 条为什么只标注不驳回。
- `apps/api/prisma/schema.prisma` — `model SalesOrder` 与 `model PurchaseOrder` 的字段名，测试的独立来源。
- `apps/api/src/modules/business-query-agent/tools/finance-query-tools.ts` 第 1 行 — 本模块里 `Prisma` 从 `@prisma/client` 导入的写法。

**Settled**

- 合法格式恰为 `<模型名>.<字段名>`，大小写敏感，恰一个点；模型与字段都在 `Prisma.dmmf.datamodel.models` 里才算存在。关系字段也算字段。
- 不做模糊匹配、不做中文名映射、不改写输入（设计 §2.3）。
- 两组都保持输入顺序，各自去重。

**Edges and seam**

- 新文件 `tools/gap-fields.ts`，导出 `splitNeededFields(fields, models?)`，返回 `{ verified: string[], unverified: string[] }`；`models` 默认取 DMMF。不改别的文件。
- Seam：`splitNeededFields` 纯函数。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-fields.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- `Prisma.dmmf` 在运行时为 `undefined` 或类型上不可访问：停下报告，不要自己解析 `schema.prisma`。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1，红，再实现函数。
3. 写用例 2、3，红，再补格式与大小写判断。
4. 写用例 4（顺序与去重），红，再补。
5. 写用例 5（默认取 DMMF），确认绿。
6. 跑 Run 的命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `["SalesOrder.orderNo","SalesOrder.supplierName"]` | `verified` 为 `["SalesOrder.orderNo"]`，`unverified` 为另一项（来源：`schema.prisma`，销售单有单号、没有供应商名） | `splitNeededFields` |
| 2 | `["供应商名称","orderNo","SalesOrder.orderNo.x","Nope.id"]` | 四项全进 `unverified` | 同上 |
| 3 | `["salesorder.orderNo","SalesOrder.OrderNo"]` | 两项全进 `unverified` | 同上 |
| 4 | `["a","SalesOrder.orderNo","a","SalesOrder.orderNo"]` | `verified` 与 `unverified` 各恰一项 | 同上 |
| 5 | `["PurchaseOrder.purchaseOrderNo"]`，不传 `models`；另传 `[]` 与手造模型 `[{name:"M",fields:[{name:"f"}]}]` 配 `["M.f"]` | 第一次进 `verified`；空数组得两个空组；手造模型下 `M.f` 进 `verified` | 同上 |

</task-brief>
