# T07 供应商快照扩字段：地址与联系人冻结进采购单

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §5.4、§2（口径 4）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T05](./05-purchase-order-revert-and-readonly.md)（退回与只读化定稿后再动快照，避免两处同时改 `refs()`）。

## 目标

下单时把**当时的**供应商地址与联系人**冻结**进采购单的 `supplier_snapshot`：
供应商主数据以后被改名/改地址，历史采购单上留下的仍是**下单那一刻**的那一份。

## 口径与决策（依据设计文档）

- **口径 4**：供应商地址/联系人在**计划里**是"选中那家供应商的只读派生"，**不可改**；
  「这批送到别处」走采购单已有的「交货地址」字段（`purchase_orders.delivery_address`）。
- **§5.4**：现在 `refs()` 的 `supplierMap` 只装 `{id, name}`，写进 `supplierSnapshot` 的就这两个字段；
  本次扩成 `{id, supplierCode, name, contactName, phone, address}`。
- **§5.4 末句**：这是**对既有行为的加强**（原来根本没冻结地址），**不需要迁移**：
  旧单的快照里没有这两格，前端按 `-` 显示。

## 范围与非范围

**范围**

- `apps/api/src/modules/procurement/purchase-orders.service.ts`：`refs()` 的 supplier 查询与
  `supplierMap` 的类型；`orderData()` 写 `supplierSnapshot` 的地方。
- 单测：`apps/api/test/purchase-orders.test.cjs` 或新增 `apps/api/test/unit/supplier-snapshot-fields.test.cjs`。

**非范围**

- **不给**计划行加地址/联系人列（口径 4：那是只读派生，落了列就有两个真源）。
- **不改** `suppliers` 主数据的结构（`contact_name` / `phone` / `address` 都已经有）。
- **不写迁移**（§5.4：旧快照缺字段是允许的）。
- 不动计划页显示"地址/联系人"的读侧（[T10](./10-web-plan-detail-sheet.md) 从供应商关系/快照取）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-orders.service.ts` | `supplierMap` 类型从 `{ id, name }` 扩为 `{ id, supplierCode, name, contactName, phone, address }`；建明细时的 `supplierSnapshot` 带上这些字段 |
| `apps/api/test/unit/supplier-snapshot-fields.test.cjs` | 新建（约 6 条） |
| `apps/api/test/purchase-orders.test.cjs` | 断言"快照里现在是哪几个键"的既有用例按新形状同步 |

## 实施要点

### 1. 扩哪一处

三处引用同一个 `supplierMap`（设计文档 §5.4 指的 `:262`/`:279`/`:320` 一带，当前文件里
类型声明在 `:40`、按明细分组取用在 `:278`、写入在 `:321`）：

1. **类型**：`supplierMap: Map<string, { id: string; name: string }>` → 扩成六个字段。
2. **构造**：`new Map(suppliers.map(row => [row.id, row]))` —— 查询的 `select` 要跟着加上
   `supplierCode` / `contactName` / `phone` / `address`（Prisma 不会自动带出来）。
3. **写入**：`supplierSnapshot` 从 `{ id, name }` 变成带地址与联系人的形状。

### 2. 快照的键名与口径

- 快照是 **JSON 快照**，键名用 camelCase（与既有的 `{id, name}` 一致，与 Prisma 列名同形），
  **不要**在这里发明 snake_case —— 快照是"当时那一行长什么样"的记录，不是 API 契约。
- 供应商是 `null`（这行没选供应商）时写 **`Prisma.DbNull`**，不是 `Prisma.JsonNull`（README 红线）。
- 地址/联系人**为空也要写 `null`**，不要省略键：省略键与"当时就是空的"在读侧分不开。

### 3. 前端读侧（不在本任务改，但要知道后果）

- 采购单详情/打印读 `supplierSnapshot`：**旧单**里没有 `contactName`/`phone`/`address` 三格 →
  按 `-` 显示（§5.4）。不要为了"好看"回退到读当前供应商主数据 —— 那会让历史单显示**今天**的地址。
- "这批货送哪"是 `purchase_orders.delivery_address`（口径 4 明确），**不是**供应商地址。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 下单后采购明细的 `supplier_snapshot` 含 `supplierCode` / `contactName` / `phone` / `address` | `supplier-snapshot-fields.test.cjs` |
| 2 | 快照取的是**下单当时**的值（改主数据后旧快照不变） | 同上（构造两个时点断言） |
| 3 | 没选供应商时 `supplier_snapshot` 写 `DbNull`（SQL NULL） | 同上 |
| 4 | 地址/联系人为空时写 `null`（键仍在），不是省略键 | 同上 |
| 5 | 旧快照（只有 `{id,name}`）读侧不炸、按 `-` 显示 | `purchase-orders.test.cjs` 或前端既有用例 |
| 6 | `refs()` 的查询真的 select 了那四列（避免"类型扩了、数据没查"） | 同上（断言查询参数） |
| 7 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **不改主数据、只加强快照**：改 `suppliers` 结构会影响主数据页与它的审计；而需求是"冻结当时值"。
- **不写迁移**：旧快照缺字段是**允许**的状态（§5.4），补数据属于编造历史。
- **地址不落计划列**：计划上那两格是只读派生（口径 4）——落了列就有两个真源。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 | 2026-09-27 / `a3028b3` |
| 实际交付物（文件 + 条数） | `apps/api/src/modules/procurement/purchase-orders.service.ts`（`Refs` 类型改宽，如实描述 `refs()` 的供应商查询形状）、`apps/api/test/purchase-orders.test.cjs`（地址 / 联系人冻结回归用例） |
| 验证命令与结果 | `npm run typecheck`：双绿；`npm run test:unit:api`：2207/2207；`purchase-orders.test.cjs` 全绿（本机实测） |
| 与设计的差异（含理由） | **核实结果与本文档初稿不同**：`refs()` 的供应商查询**本来就没有 `select`**，所以地址与联系人一直就在快照里；真正有问题的是 `Refs` 的**类型写窄了**（只声明了 `name`，读 `address` / `contactName` 时看起来像不存在）。所以本任务的实际交付是「**类型说实话 + 加回归用例**」，**不是**"新增冻结逻辑"——初稿按"要补冻结"写，核对代码后改了结论 |
| 未验证项（环境阻断） | 快照内容的真库形状（`address` / `contactName` 是否随供应商主数据变更而变）只有单测层面的断言，没在真库上改一次供应商验证过 |
| 踩到的坑 | 类型写窄让一段**已经正确**的行为看起来像没实现——差一点就去加一段多余的"冻结"逻辑，而那段逻辑会把正确的行为改坏 |
