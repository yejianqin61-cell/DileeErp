# 销售单订单号更正（改号）与全链联动 —— 设计

- 日期：2026-09-30（同一天第四批）
- 用户原话：「创建销售单，订单号写错了要支持编辑和修改。要做好全链条订单号的联动调整」
- 前置批次：同一天第三批（采购计划价格字段 + 采购/财务对齐排查），见 `docs/log/2026-09-30.md`

---

## 一、现状：不是「不能改」，是「能输入、保存时被丢掉」

排查出的第一件事比预想的更糟 —— 界面**看起来**是能改的（下表行号是**改之前**的状态）：

| 位置 | 行为 |
| --- | --- |
| `apps/web/components/sales/sales-order-editor.tsx:41` | `订单号` 在 `BASE_FIELDS` 里，与其它 13 个基础字段一起渲染成普通 `Input`，**编辑态没有 readOnly / disabled** |
| `apps/web/components/sales/sales-order-editor.tsx:374` | 保存时 `delete payload.order_no` —— 用户敲进去的新单号**从来没发出去** |
| `apps/api/src/modules/sales/sales-orders.service.ts:242` | `SalesOrderUpdate = Partial<Omit<SalesOrderInput, "order_no" \| ...>>` —— 服务层直接把 `order_no` 排除 |
| `apps/api/src/main.ts:31` | `forbidNonWhitelisted: true` —— 就算前端发了 `order_no`（DTO 里没有这个键），也是 **400**，不是静默忽略 |

所以真实体验是：改完点保存 → 不报错 → 提示「销售单已保存」→ 列表里还是旧号。**静默丢弃**比报错更难查（用户会以为系统"没保存上"，反复重试）。这一条本身就是 bug，与"能不能改号"是两回事。

## 二、为什么不能只改一格：订单号是全库引用键，不是一格数据

`sales_orders.order_no` 是**唯一**的业务主键（`CREATE UNIQUE INDEX "sales_orders_order_no_key"`，见 `apps/api/prisma/migrations/20260821120000_sales_domain_foundation/migration.sql:96`），另外 **40 个列**存了它的副本（`@map("order_no")`，扫 `schema.prisma` 得到）：

- **销售**：`sales_orders.order_no`（源头）
- **下游 38 张业务表**：`boms`、`purchase_orders`、`purchase_plans`、`purchase_receipts`、`incoming_inspections`、`raw_material_inbound_notices`、`raw_material_inbounds`、`inventory_facts`、`payable_sources`、`outsource_logistics_batches`、`outsource_receipts`、`outsource_payable_sources`、`supplier_payable_entries`、`supplier_payments`、`supplier_payment_allocations`、`outsource_return_transfers`、`outsource_direct_shipments`、`finished_goods_inspection_submissions`、`finished_goods_qc_records`、`finished_goods_inbound_notices`、`finished_goods_inbounds`、`finished_goods_defectives`、`finished_goods_outbounds`、`finished_goods_outbound_notices`、`customer_returns`、`receivable_sources`、`customer_payments`、`receivable_adjustments`、`receivable_reconciliations`、`supplier_payable_reconciliations`、`cash_flow_entries`、`production_orders`、`raw_material_movements`、`operation_daily_reports`、`employee_daily_reports`、`production_daily_alerts`、`production_payroll_sources`、`payroll_payable_entries`
- **审计**：`audit_events.order_no`（事实记录，见 §五.2）
- **另一张销售单上的引用**：`sales_orders.reorder_from_order_no`（返单来源）

更关键的是：**读路径大量按 `order_no` join，而不是按 `sales_order_id`**。例如

| 位置 | 用法 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-orders.service.ts:560,568` | `salesOrder.findFirst({ where: { orderNo: input.order_no } })`，BOM 也要 `orderNo: input.order_no` 一起匹配 |
| `apps/api/src/modules/production/raw-material-movements.service.ts:481-482` | `purchaseOrderItem.aggregate({ where: { purchaseOrder: { orderNo: order.orderNo } } })`、`rawMaterialInbound.aggregate({ where: { orderNo } })` |
| `apps/api/src/modules/finance/finance-report-query.service.ts:705` | 报表按 `salesOrder.findMany({ where: { orderNo: { in: orderNos } } })` 反查客户 |
| `apps/api/src/modules/finance/reconciliation.service.ts:249-250` | 对账单范围 `scopeWhere` 直接按 `orderNo` 取数 |
| `apps/api/src/modules/order-workbench/order-workbench.service.ts:20` | 工作台详情按订单号取单 |

结论：**「改一半」比不改更糟** —— 会同时存在新旧两个订单号，上表每一条 join 都会静默查不到另一半数据（不报错、只少数据），而这类缺失只会在对账时以差额的形式暴露。这就是必须做全链联动的原因，也是本设计把"联动清单"做成**一张登记表 + 一条覆盖守卫测试**（§四.1）的原因。

## 三、口径（用户 2026-09-30 拍板，四项）

| # | 决策 | 落地 |
| --- | --- | --- |
| 1 | **任何时候都能改**，全链同步 | 含已确认、已有 BOM/采购/生产/入库/应付/凭证的单；改号必须填原因；保存前先给影响面确认 |
| 2 | **版本快照跟着改，审计保留** | `sales_order_versions.snapshot.order_no` 同改；`audit_events` 一个字都不回写，另记一条 `sales_order.rename_order_no` 事件带 from→to |
| 3 | **不新增「曾用单号」列** | 不加列、不加表、不加迁移；按旧号反查靠审计事件 |
| 4 | **只在销售单编辑页改** | 单一写入口；列表页不加「改号」快捷按钮 |

第 3 条的直接后果：**本批不需要任何数据库迁移**（没有新列），但**历史里已经存在的错号需要人工改一次**（见 §六）。

## 四、实现

### 4.1 联动清单：一张登记表，一处都不许漏

新增 `apps/api/src/modules/sales/sales-order-order-no.ts`，导出 `ORDER_NO_RENAME_TARGETS`：38 项，每项 `{ key, label, sweep, count }`，`sweep` 就是一条
`tx.<model>.updateMany({ where: { orderNo: 旧 }, data: { orderNo: 新 } })`。

**为什么可以「按值改」而不必证明来源**：`sales_orders.order_no` 全局唯一，所以"值 = 旧单号"与"指向这张销售单"是同一件事 —— 任何一行只要该列等于旧号，它引用的就只可能是这张单。这条性质让联动清单不必逐表判断语义，只需要不漏表。

**为什么用 `updateMany` 按列名而不是 raw SQL**：Prisma 的模型名/列名由生成的客户端校验，写错一个模型名是**编译错误**而不是运行时静默漏改。

**残留校验**：改完（含返单来源引用与版本快照）再对每一项 `count(旧号)`，任一非零 → `409 ORDER_NO_RENAME_CONFLICT` 并整事务回滚。它挡的是"改号与下游建单并发"这类窗口（见 §五.3），宁可让用户重试，也不要留下半个改名。

**守卫测试**：`apps/api/test/unit/sales-order-order-no-rename.test.cjs` 扫 `schema.prisma` 里全部 `@map("order_no")` 列，逐条断言「要么在登记表里、要么在豁免清单里（只剩 `sales_orders.order_no` 与 `audit_events.order_no`，各自带理由）」。以后有人新增一张带 `order_no` 的表而忘了登记，测试直接红。

### 4.2 事务：先锁源头，再扫，再校验，最后改源头

改在 `SalesOrdersService.update()` 的**同一个事务**里（改号不是一个额外动作，而是"这次保存"的一部分）：

```
BEGIN
  SELECT id FROM sales_orders WHERE id = :id FOR UPDATE   -- ① 先锁（与生产单/采购单建单同一把锁）
  38 × updateMany(order_no: 旧 → 新)                        -- ② 扫全链
  sales_orders.updateMany(reorder_from_order_no: 旧 → 新)    -- ③ 别的单上的返单来源引用
  重写本单全部版本快照的 snapshot.order_no                    -- ④
  38 × count(旧) + count(reorder_from_order_no = 旧)          -- ⑤ 残留校验，非零即回滚
  UPDATE sales_orders SET order_no = 新 WHERE id = :id       -- ⑥ 最后改源头
  INSERT sales_order_versions (第 N+1 版，快照里的 order_no = 新)
COMMIT
```

① 放在最前是有意的：`production-orders.service.ts:29`、`raw-material-inbounds.service.ts` 等下游建单路径在建单前就对同一行 `FOR UPDATE`，先锁源头能把「并发建单」压到改名提交之后再发生 —— 那时它们读到的是新号，天然一致。

②③④ 都在源头仍是旧值的时候做，任何一步失败整体回滚，不存在"改了一半"的可见状态。

### 4.3 守卫

| 守卫 | 位置 | 行为 |
| --- | --- | --- |
| 新号必填且非空 | DTO `@IsNotEmpty()`（不加 `EmptyStringToUndefined`） | 空串 → 400，**不**降级成"不动"（静默丢弃正是本轮要修的病） |
| 改号必须填原因 | `update()` | `422 CORRECTION_REASON_REQUIRED`，文案带旧号→新号 |
| 新号不能被占用 | `update()` 预检 + 兜底 `P2002` | `409 ORDER_NO_CONFLICT`；预检**不带 `deletedAt` 过滤** —— 唯一索引跨软删行，软删单占的号也不能用 |
| 已关闭单只能单独改号/补货号 | `update()` 的 `onlyTagFields` | 已关闭单的既有例外从「只有 `item_no`」扩到「`item_no` / `order_no`」，两者都要原因；带上任何其它字段仍 `422 SALES_ORDER_CLOSED` |
| 与旧号相同 | `update()` | 不触发联动（`renaming` 为假），不写改名审计 |

`order_no` **不进 `coreFields`**：那份清单锁的是"会改变下游事实/金额"的字段（`product_name`/`quantity`/`currency`/金额…），改号不改任何一张单的数量与金额，所以已有 BOM/采购/生产的已确认单**允许直接改号**，不要求先回退下游 —— 否则用户最常见的场景（下单后发现号写错）仍然走不通，而这正是本轮要解决的。

### 4.4 影响面预览

`GET /sales-orders/:id/order-no-impact?order_no=新号`（新路由，声明在 `:id` 之前不成问题 —— 路径是 `:id/...` 两段）：

```
{ sales_order_id, current_order_no, next_order_no, changed,
  conflict: { order_no, order_id, status, deleted, message } | null,
  reason_required: true,
  targets: [{ key, label, count }...],   // 只列非零项，按 count 降序
  total }
```

前端拿它在保存前弹一张确认框：**「DL26001 → DL260001：将同步更新 12 类下游单据共 87 条（采购单 3、生产单 2、…），另改 4 个历史版本快照」**，并要求填原因。预览与执行走**同一份登记表**（`ORDER_NO_RENAME_TARGETS`），所以"说会改的表"和"真的改了的表"不可能不一致 —— 与返单预览"预览过不了的单建不出来"是同一个套路。

### 4.5 审计

`update()` 在既有 `sales_order.update` 事件之外，改号时多记一条：

```
sales_order.rename_order_no  entity=sales_order  entityId=销售单 id
details = { from, to, reason, targets: [{label,count}], total, version_snapshots, reorder_references }
```

`audit_events.order_no` 列**不回写**：审计是"什么时候发生了什么"的事件流，改名事件里的 `from` 就是旧号的落点，回写会让"这张单曾经叫过 XX"这件事彻底消失。版本快照相反（它是"这一单"的历史，用户回看时不该看到一个已作废的号），所以按 §三.2 同改。

## 五、刻意不做 / 已知边界

1. **JSON 快照不追改**。有 5 处 JSON 里嵌着订单号：`sales_order_versions.snapshot`（**已改**，见 §四.2）、`purchase_orders.bom_snapshot`、`purchase_plans.bom_snapshot`、`production_orders.bom_snapshot`、`production_payroll_sources.source_snapshot` / `payroll_ledgers.source_snapshot`。后四处 **不改**，理由是它们**只写不读**：全仓库对 `bomSnapshot` / `sourceSnapshot` 的引用共 12 处，全部是写入与类型声明，没有任何一处 `select` 回显（`grep -n 'bomSnapshot\|sourceSnapshot' apps/api/src`）。它们是"存档证据"，与审计同性质；等哪天有人把它们显示出来，应当按"这是当时的存档"呈现，而不是指望它们是活的引用。
2. **`audit_events.order_no` 不回写**（同上 §四.5）。
3. **并发窗口**：不存在"锁定所有下游表"的廉价做法，所以窗口没有被彻底消除 —— ① 的 `FOR UPDATE` 挡掉了会锁同一行的写入方，⑤ 的残留校验挡掉了其余情况里的绝大多数（提交前可见的），极端时序下仍可能有一行带旧号落库。取舍：**宁可让改号失败重试，也不留下半个改名**；真要绝对，需要数据库触发器或给每张下游表加"改名序号"列，代价与收益不成比例。
4. **不改号不能改**：客户（`customer_id`）仍不可改（既有口径，与本轮无关）。
5. **存量错号不批量迁移**：没有迁移文件（本批无新列），历史里已经写错的号由用户在界面上逐张改 —— 批量改哪张、改成什么，只有业务知道。

## 六、部署

**无数据库迁移**（无新列/新表）。仅代码发布。发布后需要业务做一件人工事：把历史上写错的单号按 §四.4 的入口逐张改一次；改号会自动带上全链 38 张表。

## 七、验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（api + web） | 干净 |
| API 单测（`test:unit:api`） | **2275/2275**（基线 2245，新增 30）。新增两个文件：`sales-order-order-no-rename.test.cjs`（13 条：登记表覆盖守卫、扫全链、残留回滚、版本快照、返单来源引用、影响面、归一，另 4 条 DTO/路由/源码守卫）与 `sales-order-order-no-update.test.cjs`（17 条：正常改名、锁序、两条审计、未改不联动，8 条守卫，4 条影响面预览） |
| web lib（`test:lib`） | 301/301（本批未动 lib） |
| web 组件（`test:components`） | **1035/1035**（60 文件；`sales-order-editor.test.tsx` 18 → 22：改号四步流程、未改号不打扰影响面、冲突当场提示、后端拒绝时弹窗不关，另 3 条影响面文案向量） |
| `test:deploy` | 32/32 |
| `npm run build --workspace=@dilee/web` | 通过 |

**没验证到的**：`test:api`（HTTP 契约）与集成/e2e 需要真实 API + PostgreSQL，本机没有 ——
`sales-orders-contract.test.cjs` 里新增的 `:id/order-no-impact` 路由探针与改号后的 PATCH 断言
是按源码口径写的，**没有在真实服务上跑过**；`ORDER_NO_RENAME_TARGETS` 的 38 条 `updateMany`
也没有在真实数据库上执行过（单测用的是假事务桩）。
