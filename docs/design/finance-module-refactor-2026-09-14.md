# 财务模块重构：四板块一级页 + 应收/应付子栏目 + 工资筛选

- 日期：2026-09-14（第三轮）
- 状态：已实施
- 范围：`apps/web`（财务全部页面）、`apps/api/src/modules/finance`、`apps/api/src/modules/hr`（工资台账查询）、一次 `receivable_reconciliations` 迁移
- 需求来源：用户 2026-09-14 直接指令 + `docs/design/finance-module-improvement-spec-2026-09-02.md` + `.agent/constitution/constitution.md`
- 任务拆分：`docs/task/0914-finance-module-refactor/`

## 1. 问题

重构前财务是一张「全部板块平铺 + 可折叠」的大页（`components/finance/finance-workspace.tsx`）：

1. 一次进入 `/finance` 就要并发拉 11 个列表接口，页面长、慢、难读；
2. 7 个平铺板块（应收来源 / 收款 / 原料入库应付来源 / 应付条目 / 付款 / 普通对账 / 供应商应付对账）与业务人员的口头划分（应收、应付、工资、凭证）对不上，找不到入口；
3. 列表只给 UUID（`customerId`、`supplierId`、`outboundId`），财务对账时无法核对客户、供应商与出库单；
4. 应收对账必须挂单个订单号，而财务实际按「客户 + 月份」对账；
5. 「先创建对账，再确认应收/应付」只存在于纸面：没有对账完成后的批量确认动作；
6. 工资台账只能按员工关键字与期间筛选，拿不到部门与岗位，也不支持按月筛选。

## 2. 已确认的业务规则（本轮实现）

| 编号 | 规则 |
| --- | --- |
| R1 | 财务一级页 `/finance` 只展示 4 个板块入口：应收管理、应付管理、薪资台账、凭证管理；点击才进入二级页 |
| R2 | 应收管理子栏目 = 成品出库条目 / 应收对账 / 确认应收；应付管理子栏目 = 原料入库条目 / 外加工签收 / 应付对账 / 确认应付 |
| R3 | 只要有成品出库过账，财务就有对应的成品出库条目；只要有原料入库过账或外加工签收，就有对应的待接收应付来源 |
| R4 | 应收对账单按「客户 + 期间」创建，系统自动汇总该期间的出库条目为对账明细；对账完成后可一键批量确认该范围内的草稿应收。应付对账同构（供应商 + 期间） |
| R5 | 收款登记与核销放在「确认应收」；付款登记与核销放在「确认应付」 |
| R6 | 双击任意列表行弹出居中详情弹窗，展示该条目的全部字段与当前可执行操作 |
| R7 | 工资管理是满页表格视图，按「月 + 部门 + 岗位」筛选（服务端筛选），原有工资动作全部保留 |
| R8 | 凭证管理本期为占位：只显示「待生成凭证的已确认应收/应付条目数」，不写任何数据 |
| R9 | 「采购到货」不单独成栏（用户选定）：后端明确禁用到货单作为可接收应付来源 |

## 3. 路由与目录

```
/finance                      → 4 个板块入口（components/finance/finance-board-index.tsx）
/finance/receivable?tab=…     → 应收管理（outbound-entries | reconciliations | confirmed）
/finance/payable?tab=…        → 应付管理（raw-inbound-entries | outsource-entries | reconciliations | confirmed）
/finance/salary               → 工资管理（满页表格）
/finance/voucher              → 凭证管理（占位）
/finance/<旧 section>         → 301 到上面某个二级页（保留收藏地址）
```

- 子栏目的 tab 走**查询参数**并在 Server Component 里读取（`searchParams`），客户端组件接收 `tab` 属性：
  客户端不需要 `useSearchParams()`，避免静态构建时的 Suspense 边界问题；
- 板块与子栏目清单仍放在无 `"use client"` 的 `lib/finance-sections.ts`。
  这是硬约束：Server Component 从 client 模块导入普通常量会拿到 client reference 代理，
  `next build` 直接以 `FINANCE_SECTIONS.map is not a function` 失败（typecheck 与 vitest 都发现不了），
  仓库已有守卫 `apps/web/lib/server-client-boundary.test.mjs`；
- 旧地址映射写在 `FINANCE_LEGACY_REDIRECTS`，`app/finance/[section]/page.tsx` 做白名单重定向，白名单外 `notFound()`；
- 一级页不再等数据加载：它没有数据要拉，因此页面根 testid `page-finance` 立即可见。

## 4. 后端调整

### 4.1 列表富化（只为展示，不改口径）

宪法《Reconciliation/可追溯》要求「列表以订单号、来源编号、客户/供应商名称展示，UUID 仅作内部关联键」，但重构前的列表大量只返回 UUID。本轮补齐：

| 接口 | 新增 |
| --- | --- |
| `GET /finance/receivable-sources` | `customer` 对象、`outbound`（出库单号/状态/产品/规格/签收时间）、`allocated_amount`、`outstanding_amount`、`customer_name/customer_code/outbound_no/product_name/product_specification` |
| `GET /finance/customer-payments` | `customer`、`allocations.receivableSource`、`allocated_amount` |
| `GET /finance/payable-entries` | `supplier`、`paid_amount`、`outstanding_amount`、`supplier_name/supplier_code` |
| `GET /finance/supplier-payments` | `supplier`、`allocated_amount` |
| `GET /finance/reconciliations` | `customer` |

已付/未付口径统一为「有效核销（`status=active`）+ 已过账付款（`payment.status=posted`）」，与详情、对账一致；草稿付款与已冲销核销都不计入。

### 4.2 应收对账：客户 + 期间

- `ReconciliationDto`：`customer_id` 与 `order_no` 至少给一个；只给 `order_no` 时客户由销售单反查（兼容旧调用方），
  两者都给出且指向不同客户时 422 `RECONCILIATION_CUSTOMER_MISMATCH`；
- 快照范围（应收/收款/调整）从「按订单」改为「有订单号按订单，否则按客户」，
  与对账明细共用同一个 `scopeWhere`，避免列表与快照口径漂移；
- `GET /finance/reconciliations/:id` 增加 `details`：纳入对账的应收条目（含草稿）、待确认条数与金额、`can_confirm_receivables`；
- 新增 `POST /finance/reconciliations/:id/confirm-receivables`：一次事务内 `SELECT … FOR UPDATE` 锁定对账单，
  逐条锁定并确认范围内的草稿应收，返回确认条数与金额。
  **只有 `matched`（已对平）或 `resolved`（差异已处理）才允许**：`difference` 状态下批量确认等于把没核对清楚的金额记成生效应收。

### 4.3 应付对账：明细 + 批量确认

- `GET /finance/supplier-payable-reconciliations/:id` 的 `details` 补 `draft_entries`、`entry_count/draft_count/draft_amount`、`can_confirm_payables`；
- 新增 `POST /finance/supplier-payable-reconciliations/:id/confirm-payables`：同样的门禁与逐条行锁，
  来源已作废（`voided`）的草稿会被跳过并在结果里回报（`skipped`），因为「上游冲销后不得确认」是既定规则。

### 4.4 修复：应付款项的采购单关联从未落库

`SupplierPayableEntry.purchaseOrderId / purchaseOrderItemId / outsourceLogisticsBatchId` 三个字段在全仓从未被写入，
而应付对账在给了 `purchase_order_id` 时按 `purchaseOrderId` 过滤明细 —— 结果「按采购单对账」的系统余额恒为 0。
本轮在 `createFromSource` 落库这三个字段（来源快照本来就带着它们），并加单测钉住。

### 4.5 工资台账：月 / 部门 / 岗位筛选

- `GET /hr/payroll-ledgers` 新增 `month`（`YYYY-MM`，与 `from/to` 同为「期间有交集」语义）、
  `department_id`、`position_id`、`employee_type`；
- 返回的 `employee` 改为 `include: { department: true, position: true }`，前端才能显示与筛选部门/岗位；
- 列表与详情的应发/已付/未付改由同一个 `balances()` 计算：
  此前 `GET /:id` 反而**没有**这三个字段，详情与列表口径不一致。

### 4.6 数据迁移

`20260914180000_receivable_reconciliation_customer_period`：

```sql
ALTER TABLE "receivable_reconciliations" ALTER COLUMN "order_no" DROP NOT NULL;
```

只放宽约束，不迁移、不改写任何历史行（宪法：保留历史事实）。迁移只做加法，失败可安全重跑（`DROP NOT NULL` 幂等）。

## 5. 前端组件

| 组件 | 职责 |
| --- | --- |
| `components/finance/finance-board-index.tsx` | 一级页 4 个板块入口卡片 |
| `components/finance/finance-tabs.tsx` | 二级页子栏目切换条（真实链接，可收藏） |
| `components/finance/receivable-workspace.tsx` | 应收管理三个子栏目 + 全部动作 |
| `components/finance/payable-workspace.tsx` | 应付管理四个子栏目 + 全部动作 |
| `components/finance/voucher-workspace.tsx` | 凭证占位 + 待生成凭证预览 |
| `components/finance/record-detail-dialog.tsx` | 双击行的居中详情弹窗（字段网格 + 明细分区 + 操作） |
| `components/finance/finance-status.ts` | 财务状态中文化（按应收/应付/来源/对账四种口径） |

- `DataTable` 新增可选 `onRowDoubleClick` / `rowTitle`，并提供 `.table-row-clickable` 样式；
  不传这两个属性时行为与之前完全一致（其余 20+ 页面的既有测试不受影响）；
- 详情弹窗的数据来源：应收来源、收款、对账、应付条目、付款、应付对账都用各自的 `:id` 接口；
  **应付来源没有 `:id` 接口**，而列表接口已带齐供应商/物料/质检字段，因此直接用行数据（不再多发一次必然 404 的请求，有测试钉住）；
- 状态中文化单独成模块：`partially_paid`/`paid` 在应收侧是「部分收款/已收清」、应付侧是「部分付款/已付清」，
  同一个英文枚举语义不同；`matched`/`difference`/`resolved` 只出现在对账上。未登记的枚举回落到全站字典 `lib/display-text.ts`。

### 「确认应收 / 确认应付」为什么是台账全量而不是只列已确认

需求是「先创建对账，再确认应收/应付」。如果「确认应收」只列已确认记录，
那么「成品出库条目 → 确认应收」这条**逐条确认**路径就没有入口，确认只能通过对账批量完成，
单条业务（例如客户只对其中一张出库单有异议）将无法处理。因此两个台账子栏目都列**全部状态**：

- 草稿：可确认、可编辑、可取消（应收）／可编辑、可确认（应付）；
- 已确认 / 部分收付 / 已收付清：可登记收款/付款、核销、冲销、回退（受后端状态机约束）。

「成品出库条目」保留来源视角（带出库单、产品、数量列），「确认应收」用台账视角（到期日、已收、未收列）。

## 6. 影响与风险

- **已确认事实不被静默改写**：批量确认只把 `draft → confirmed`，不触碰金额与来源关联；对账快照仍是创建时固化。
- **对账快照 vs 明细**：快照（应收/已收/调整/系统余额）在创建时落库、不随后续业务漂移；
  「纳入对账的条目」列表是按 `scopeWhere + 期间` 实时查询的**工作集**（用于展示与批量确认），不是冻结快照。
  这样做的代价：对账创建后若该期间又新增出库，明细会多出条目。收益：不需要为对账明细再存一份 JSON，
  且「待确认」本身就是待处理态而非已固化事实。**若业务要求明细也冻结，需要新增快照列并重新对账生成新快照。**
- **旧地址重定向**是 `redirect()`（服务端 307），不是 301：地址语义已经变了，不应被浏览器永久缓存。
- 迁移**未在真实 PostgreSQL 上验证**（见第 7 节）。

## 7. 验证

- `npm run typecheck`（api + web）：通过。
- `npm run test:unit:api` → **908 / 908 通过**（新增对账客户+期间 4 条、批量确认应收 4 条、批量确认应付 3 条、
  应付创建关联 2 条、工资筛选 5 条、导出数值单元格 2 条、迁移守卫 2 条；改写进度表版式 3 条、货币迁移排序 1 条）。
- `cd apps/web && npm run test:unit` → **517 组件用例 + 121 lib 用例全部通过**
  （财务页测试整体重写为 21 条，工资页测试重写为 32 条，`testid-pages` 增加「纯重定向页面」约定）。
- `npm run build --workspace=@dilee/web`：通过（真实 RSC 边界与路由产物只有这一步能验证）。
- **未执行**：`db:migrate:deploy`、`apps/api/test/http`、`apps/api/test/integration`、Playwright ——
  本机 Docker 守护进程未运行、5432 未监听，无可用 PostgreSQL。因此新迁移、批量确认接口的真实事务行为与
  两处新端点的 DTO/鉴权/错误信封尚未端到端验证。

## 8. 未决事项

1. 对账明细是否需要与快照一样冻结（见第 6 节）；
2. 凭证管理的单据编号规则、会计科目与期间结账口径（本期明确占位）；
3. 「应付来源已接收」目前靠正式应付条目反查，来源列表自身没有 `received` 标记；若要显示「已接收」徽标，需要后端补字段；
4. 应收来源列表没有出库通知号与发票号列（详情里有），是否需要进列表由业务确认。
