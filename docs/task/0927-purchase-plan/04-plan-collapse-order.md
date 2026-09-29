# T04 计划 API：按供应商收束下单（复用 collectGroups/orderData，回写 1:1 链接，币种按组）

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §5.3、§2（口径 6/7/10）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T02](./02-plan-api-skeleton.md)（计划的读侧）。与 [T03](./03-plan-save-and-delete.md) 可并行。
后续 [T05](./05-purchase-order-revert-and-readonly.md)、[T10](./10-web-plan-detail-sheet.md) 依赖它。

## 目标

把计划里**勾选的行按供应商收束**落成 N 张采购单，并在**同一个事务**里把计划行与新采购明细
用 1:1 链接接起来（`purchase_order_item_id`）。**不新写一套建单逻辑**——复用采购单既有的
`collectGroups()` + `orderData()`。

## 口径与决策（依据设计文档）

- **口径 6**：多波次下单；勾选本次要下的行（默认全选，前端负责默认值）；下过的行**留在计划里**。
- **口径 7**：数量/单价/供应商的唯一编辑点是计划 —— 所以下单只是"把计划行的值搬进采购明细"。
- **口径 10**：**计划行不存币种**；币种在收束预览里**按供应商分组各选一个**（默认 CNY）。
- **§3.2**：`purchase_order_item_id`（`@unique`）= 已下单的唯一表示；退回计划就是把它清空。
- **§5.3**：复用路径与"回写 id"的做法（`createMany` 不返回 id，所以逐行 `create` 或建完反查）。

## 范围与非范围

**范围**

- `POST /purchase-plans/:id/order`，body `{groups:[{supplier_id, currency, items:[plan_item_id…]}]}`。
- 校验、事务、1:1 回写、审计、返回落成的采购单。
- 单测 `apps/api/test/unit/purchase-plan-order.test.cjs`。

**非范围**

- 采购单侧的只读化与退回（[T05](./05-purchase-order-revert-and-readonly.md)）。
- 收束预览的**界面**（[T10](./10-web-plan-detail-sheet.md)）——本任务只定契约。
- 采购单打印字段（付款方式/交期条款/交货地址/回签）——那是 [T05](./05-purchase-order-revert-and-readonly.md) 的保留项。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-plans.controller.ts` | `@Post(":id/order")` 与 `PlanOrderDto`（`groups` 嵌套校验） |
| `apps/api/src/modules/procurement/purchase-plans.service.ts` | `order(id, groups, user)`：校验 → 复用采购单建单 → 事务内回写链接 → 审计 |
| `apps/api/src/modules/procurement/purchase-plans.module.ts` | `imports` 加 `ProcurementModule`（拿 `PurchaseOrdersService`）——**不要**把建单逻辑抄一份过来 |
| `apps/api/src/modules/procurement/purchase-plans.domain.ts` | 计划行 → `SplitGroupDto.items` 的字段映射（纯函数，可单测） |
| `apps/api/test/unit/purchase-plan-order.test.cjs` | 新建（约 10 条） |

## 实施要点

### 1. 请求契约

```jsonc
{
  "groups": [
    { "supplier_id": "…", "currency": "CNY", "items": ["plan-item-1", "plan-item-2"] },
    { "supplier_id": "…", "currency": "USD", "items": ["plan-item-3"] }
  ]
}
```

- **一组 = 一张采购单**（既有不变式：一张采购单一个供应商、一个币种）。
- 前端默认"全选未下单行"，但**默认值不是契约**：服务端只处理请求里给的行。
- 传空 `groups`（或所有 `items` 都空）→ 422（没有要下的东西，静默成功会让用户以为下了）。

### 2. 校验（写库前全部做完）

1. 计划存在、未删。
2. 每个 `plan_item_id` 属于该计划、且**未下单**（`purchase_order_item_id` 为空）；
   - 已经被别的波次下过的行再下一次 → 422（否则会重复采购，而重复采购正是这一列存在要防的事）。
3. 每组必须有 `supplier_id` 且是启用的供应商（复用采购单既有的供应商校验，不要另写一套）。
4. 同一 `plan_item_id` 不能出现在两个分组里（前端可能发重；报错要求去重只会变成用户看不懂的 400，
   所以**后写覆盖先写**或按"第一次出现"归位，选一种并在决策记录里写明）。
5. `currency` 每组必填且在币种字典内（复用 `CurrencyService.assertSupported` 的既有写法）。

### 3. 复用采购单建单（§5.3）

映射成采购单那套字段（字段名要换：`material_id` / `unit_id` / `supplier_id` / `quantity` /
`unit_price` / `expected_date` / `bom_item_id`），然后：

- 走 `PurchaseOrdersService` 既有的 **`collectGroups()` + `orderData()`**；
- `place_order: true` → 「一个供应商一张单」的不变式、`assertOrderableItems` 的下单前校验、
  金额/快照/审计**全部沿用**；
- 币种由请求的 `groups[].currency` 传入（口径 10）——不要从销售单或客户币种猜。

### 4. 回写 1:1 链接（本任务的技术难点）

`createMany` **不返回 id**，所以二选一（实现时选定并写进决策记录）：

- **逐行 `create`**：能直接拿到每条采购明细的 id，然后精确回写（推荐，逻辑最直白）；
- 建完后按 `(purchase_order_id, bom_item_id, material_id, sequence)` **反查**再回写
  （实现更绕，但在既有 `orderData()` 用 `createMany` 时是唯一选择）。

**回写必须在同一个事务里**：采购单建了但链接没写上，等于"这行看起来没下单"，下次会被重复下单。

### 5. 返回与审计

- 返回落成的采购单（至少 `purchase_order_no` / 行数 / 金额），前端据此提示"已下单 N 张"。
- 审计 `purchase_plan.order`（含计划号、落成的 PO 号数组、行数、按组的币种）。

### 6. 不变量：下过的行留在计划里

下单**不删任何计划行**、不改 `quantity`/`unit_price`/`supplier_id` —— 只写 `purchase_order_item_id`。
这条要在测试里钉住（它是口径 6 的落点）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 3 组 → 3 张采购单，每组一张、组内一个供应商 | `purchase-plan-order.test.cjs` |
| 2 | 币种按组落（同一次请求里 CNY + USD 两张单，各自币种正确） | 同上 |
| 3 | 每个被下单调用的计划行都拿到 `purchase_order_item_id`（1:1） | 同上 |
| 4 | 未被勾选的行**原样未动**（链接仍空、其它列不变） | 同上 |
| 5 | 已下过的行再下一次 → 422 | 同上 |
| 6 | 空 groups / 空 items → 422 | 同上 |
| 7 | 跨计划的 plan_item_id → 422 | 同上 |
| 8 | 同一行出现在两组 → 按定稿规则处理，且**只落一张单里** | 同上 |
| 9 | 建单失败时**不留半截数据**（事务回滚：没有采购单、没有链接） | 同上 |
| 10 | 下单后计划状态从"未下单"变"部分下单/已完成"（派生口径） | 同上 |
| 11 | 审计 `purchase_plan.order` 含 PO 号与行数 | 同上 |
| 12 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **复用 `collectGroups()`/`orderData()` 而不是新写建单**：设计文档口径 7 的整个立论就是
  "唯一编辑点是计划"，而建单的校验（供应商/币种/金额/快照）必须只有一份。
  抄一份出来的代价是两条路径慢慢漂移，最终以"计划下的单没有快照"这种形式爆掉。
- **回写方式（逐行 create vs 反查）**在本任务定稿，写进决策记录——两种都能用，但必须只选一种。
- **同一行出现在两组**的处理规则在本任务定稿（见"校验 4"）。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |
