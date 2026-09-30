# 采购链路 ↔ 财务链路：金额对齐度排查（2026-09-30）

用户 2026-09-30：

> 「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。
> 你也排查一下采购链路和财务链路的对齐度」

**一句话结论**：钱的**真源只有一处**，而且它就在采购计划的「单价」那一格里 ——
`应付金额 = 实际入库数量 × 采购明细单价`，而采购明细的单价是计划下单时原样带过去的。
所以整条链的**算术是对的、没有第二套算法**。对不上的地方全都不在"算"，而在三处：

1. **入口不设防**：单价可以是 0（本轮已修，见 §2.1）；
2. **币种在中间三层丢了**：应付/付款/凭证都有币种，但采购明细、到货、入库、质检**没有**，
   于是"这一行到货是美元还是人民币"只能回到采购单头去猜（本轮把计划侧的币种补上了，见 §2.2）；
3. **几处汇总把不同币种的金额加成了一个数**，而它看起来是对的（§3.5、§3.7）。

排查方式：只读通读 + 逐条落到 `文件:行号`；**本机没有 PostgreSQL**，
凡是需要真实数据才能确认的一律标【未验证】（§4）。

---

## 1. 链路事实（金额是怎么一路传到财务的）

### 1.1 真源与唯一入口

| 环节 | 唯一入口 | 金额表达式 |
|---|---|---|
| 应付来源 `payable_sources` | `raw-material-inbounds.service.ts:129`（建在 `:169-193`；全仓库只有这一处 `create`） | **入库数量 × 采购明细单价**（`:163-184`） |
| 应付条目 `supplier_payable_entries` | `supplier-payable.service.ts:116` → `createEntry()` `:138-151` | `input.amount ?? 来源金额`（`:139`） |
| 付款 | `supplier-payment.service.ts`（核销强制同币种 `:96`） | 按应付条目核销 |
| 凭证 | `voucher.service.ts:212-217`（幂等键 `(sourceType, sourceId)`） | 抄应付条目（`supplier-payable.service.ts:216-222`） |

- 正常质检：`amount = raw_material_inbounds.quantity × purchase_order_items.unit_price`（`:165-166`）。
- `partial_inbound` / `partially_accepted`（部分入库 / 让步接收）：
  `amount = settlement_total_amount ?? quantity × (settlement_unit_price ?? item.unit_price)`（`:165-166`），
  人工填结算价必须写原因（`:358`）。
- 到货单**不是**应付来源：`supplier-payable.service.ts:118` 直接拒（`PURCHASE_RECEIPT_PAYABLE_DISABLED`）。

### 1.2 采购明细的单价只有三个写入点，且都不会"事后偷改"

`purchase-orders.service.ts:351`/`:359`（新建）、`:392-394`（整单替换）、
`purchase-plans.service.ts:632`（计划下单带入）。用户能改价的窗口**严格早于**应付产生的窗口：

- 计划里已下单的行被硬锁（`purchase-plans.service.ts:420-427` + 字段比对 `:548-556`）；
- 唯一能改采购明细的 `POST /purchase-orders/:id/split`（`splitExisting()` → `replaceOrder()`）
  要求**这张单没有任何到货事实**（`assertEditable()` `:208-213`），而入库必须有到货；
- 采购单打印导出**不重算**金额，直接用落库值（`purchase-order-export.service.ts:221-223`、`:238`）。

**结论：不存在"下单后单价被改、应付仍按旧价"（或反过来）的路径。** 这一点是干净的。

### 1.3 数量口径

schema 里**没有** `ordered/arrived/received_quantity` 列，都是现算聚合：
下单量 = `purchase_order_items.quantity`（`schema.prisma:819`）；到货量 = Σ `purchase_receipts.quantity`；
入库量 = Σ `raw_material_inbounds.quantity`（`status = posted`）；
质检合格 = `accepted + conditional`（`:978-979`）。
**应付按已过账的入库量**，上限 = `accepted + conditional`（`raw-material-inbounds.service.ts:143-145`），
拒收不可入库（`:95`/`:142`/`:220`）。超收要填原因（`purchase-orders.service.ts:519`），
应付按实际入库量算 —— 这是有意的"到多少算多少"。

### 1.4 币种在哪一层存在

| 有币种 | 没有币种 |
|---|---|
| `purchase_orders`（`:759`）、`payable_sources`、`supplier_payable_entries`、`supplier_payments`、凭证、对账单 | **`purchase_order_items`**、**`purchase_plans` / `purchase_plan_items`（本轮只补了后者）**、`purchase_receipts`、`incoming_inspections`、`raw_material_inbounds` |

应付的币种是抄采购单头的（`raw-material-inbounds.service.ts:182`），
所以**一张单一个币种**这条不变式成立；但"这一行到货是美元还是人民币"在明细/到货/入库三层问不出来。
汇率与折合人民币只存在于 `cash_flow_entries` / `bank_transfers` / `finance_slips` 与本币折算处，
**应付、付款、凭证、采购单上都没有本位币金额**。

### 1.5 往返可追溯

应付 → 采购单/明细：`supplier_payable_entries.purchase_order_id / purchase_order_item_id`（`schema.prisma:1290`、`:1292`）。
计划行 → 采购明细：`purchase_plan_items.purchase_order_item_id`（`@unique`，`:920`）；
反向的"这条采购明细来自哪一行计划"只有 **JSON 标记** `purchase_order_items.extension_data.purchase_plan_item_id`
（写 `purchase-plans.service.ts:633`，读 `:656`）。
计划 → BOM → 销售单：`purchase_plans.bom_id` → `boms.sales_order_id`。

**断掉的一跳只有一个**：采购明细 → 计划没有列（只有 JSON），
且「退回采购计划」会主动清空这个链接并把那张单置 `cancelled`（`purchase-plans.service.ts:291`、`:314-315`）——
历史单与退回过的单，"这笔钱为哪张 BOM 买的"查不到。追溯视图也没有采购计划这一组单据
（`reorder.domain.ts:175-193`、`reorder.service.ts:272-314`）。

---

## 2. 本轮已修（都属于"钱对不上"这一类）

### 2.1 单价 0 的行可以一路下单 → 一张 0 元应付（**高**，已修）

**现象**：从 BOM 新建的计划行单价写死 `0`（`purchase-plans.service.ts:752`），
而两侧门禁都只要求"不为负"（计划 `:777`、采购单 `assertOrderableItems`）。
于是 `0 单价 → 0 元采购单 → 到货入库 → 应付 0 元`是一条**合法路径**，
而全链路不会报任何错。0 元应付确认时也不挂账（`voucher.service.ts:213-214`），
成本报表取价把 0 当有价（`finance-report-cost.service.ts:80`），缺价表尾也不会列它 ——
表现是"毛利虚高"，而不是"缺一张单"。

**修法**（用户选定）：收束下单前逐行要求单价 > 0，
错误码 `PURCHASE_PLAN_PRICE_REQUIRED`（`purchase-plans.service.ts` 的 `order()`），
**并且**把采购单侧的下单门禁从 `isNonNegative` 收紧成 `isPositive`
（`purchase-orders.service.ts:411`）—— 否则同一个洞留在 `POST /purchase-orders`
与 `POST /purchase-orders/split` 两个原始接口上（没有前端调用点，但接口是活的）。
前端在选择下单前也先拦一次并指出是第几行（`plan-detail-sheet.tsx`）。
**草稿不受影响**：单价可以先留 0（还没谈价），不能做的是带着 0 单价下单。

### 2.2 计划里没有金额、也没有币种落点（**低**，已修）

计划行只有 `quantity` / `unitPrice`，列表接口不返回任何金额（`summaryOf`）。
用户要的「总价」补成了三处：明细表的**行总价**列、
表下的**计划合计 + 其中未下单**（按币种分列）、列表的**计划金额**列。
币种按**行**记（新列 `purchase_plan_items.currency`，默认人民币），
收束下单时按该供应商组选的币种**写回这一组每一行** ——
写回之后已下单行的币种永远等于那张采购单的币种，合计按币种分列时才不会说谎。
设计与口径见 [`purchase-plan-pricing-2026-09-30.md`](./purchase-plan-pricing-2026-09-30.md)。

---

## 3. 未修：按严重度排序（本轮只排查，不动账务链路 —— 用户选定）

> 下面每一条都**不属于**"采购计划加价格字段"这个范围，而且多数需要先定口径再动账（见"建议"）。
> 建议按表内顺序单独开批次，一条一个提交。

### 3.1 应付冲销 / 删除「其他应付」不回冲已挂账凭证（**高**）

- 现象：`reverse()` 只把条目置 `reversed`（`supplier-payable.service.ts:324-336`）；
  `removeOther()` 去回冲一笔 `sourceType = "supplier_payable_entry"` 的流水（`:383-385`），
  而 `cash_flow_entries` 的这个来源类型**全仓库没有写入方** ——
  该字符串只出现在审计实体名与这两处查询里（`cash-flow.service.ts:548-550` 按
  `(sourceType, sourceId)` 查 `cash_flow_entries`，必然查不到任何行，回冲是**空操作**）。
  同一条链上的注释还停在旧口径（`:380`「已确认的应付在确认那一刻写过一条支出流水」）——
  2026-09-24 改成"确认即挂账"之后，确认写的是**凭证**、不再写流水（`:196`、`:216-222`）。
- 影响：台账说"已冲销"，总账里的「应付账款」贷方与成本/存货借方仍然挂着 →
  三大报表虚增负债与成本。人工可以去凭证里红冲（凭证列表有这个入口），
  但**系统不会提示、也不会联动**，只有知道内情的人才会去做。
- 建议：冲销/删除时对 `(sourceType = supplier_payable, sourceId = 条目 id)` 的已过账凭证执行红冲；
  或者先禁止冲销、提示"请先红冲挂账凭证"。

### 3.2 外加工签收冲销不校验应付状态（**高**）

- 现象：`outsource-logistics.service.ts:161-173` 无条件作废 `outsource_payable_sources`；
  原料入库侧有对称的门禁（`raw-material-inbounds.service.ts:279-283`）。
- 影响：已确认、甚至**已付款核销**的应付，其来源被上游冲销后仍是 `confirmed` / `paid`，
  金额留在台账与对账范围内，同时再也无法被确认/追溯。
- 建议：把原料侧那道"已有非草稿应付 / 已挂账就拒绝"的闸门复制过去。

### 3.3「回退草稿 → 改金额 → 再确认」不会更新凭证（**高**）

- 现象：`accrue()` → `createAccrual` 按 `(sourceType, sourceId)` 幂等，
  命中就直接返回旧凭证（`voucher.service.ts:212-217`），
  而 `reopen()`（`supplier-payable.service.ts:310-322`）允许把已确认的应付改回草稿并改金额（`:296-308`）。
- 影响：凭证金额 = 第一次确认时的量，应付金额 = 改后的量，两者**永久不一致**，期间/科目也停在旧值。
- 建议：幂等命中但来源金额或币种已变时拒绝并提示先红冲；或在 reopen 时同步红冲。

### 3.4「接收应付」可以覆盖金额，且覆盖后与 `数量 × 单价` 脱钩（**高**）

- 现象：`amount = input.amount ?? 来源金额`（`:139`），只要求"与来源金额不同时填原因"（`:140`），
  但 `quantity` / `unitPrice` 仍写来源值（`:148`）。
- 影响：报表上「单价 × 数量 ≠ 金额」（`finance-report.tables.ts:227-236` 三者同排打印），
  而「含税金额 = 金额」使这个错误**不可自证**；也没有"应付不超过采购单金额"的约束。
- 建议：覆盖金额时同步按覆盖值回写单价（或增列「调整金额」），并在报表里标注。

### 3.5 采购对账明细的合计行跨币种相加（**高**，与仓库约定直接冲突）

- 现象：`PURCHASE_TOTAL_COLUMNS = [15, 16]`（`finance-report.tables.ts:188`）+ 合计行（`:238`、`:698-710`）
  对**全部行**求和，而币种过滤是可选的（`finance-report.controller.ts:49`）。
  导出同值（`finance-report-workbook.ts:114-126`）。
- 对照：同一个文件里收支明细/汇总表明确不做合计（`:588`、`:673-682`），
  应付台账导出在多币种时也不合计（`ledger-workbook.ts:17`、`:238-242`）——
  **同一批功能里两种口径**。销售对账明细/汇总/毛利是同样的问题。
- 建议：合计改为按币种分段（照 `:673-682` 的做法），或强制币种过滤后再给合计。

### 3.6 采购明细的 `extra_fee` 不进应付金额（**高**，本轮按用户选定只写进口径）

- 现象：采购明细 `amount = 数量 × 单价 + extra_fee`（`purchase-orders.service.ts:596`），
  采购单 `total_amount` 是它之和（`:329`）；而应付 `amount = 入库数量 × 单价`，**不含** `extra_fee`。
- 影响：用到额外费用（运费/模具）的采购单，Σ应付 < 采购单金额，差额没有单据承载，对账必有差异。
- 现状与决策：**前后端界面都没有这个字段**（只有原始 API 能传），所以现实中不会产生差异。
  用户选定：保留字段，把"应付不含额外费用"写进口径（本节即落点）。
- 若要彻底对齐：二选一 —— 不再接受 `extra_fee`（采购单总额 = Σ数量×单价，与应付同口径），
  或让应付也带上按入库批次摊分的额外费用（需要多一套摊分与冲销逻辑）。

### 3.7 工作台与订单应付汇总跨币种相加，并把合计标成首行的币种（**中**）

`order-workbench.service.ts:100-101` 的 `amount()` 把多行相加后把 `currency` 标成 `rows[0].currency`
（采购/应付/应收/收款卡片都用它）；`GET /finance/payable-order-summary`
也一样（`supplier-payable.service.ts:423-428`、`supplier-payment.service.ts:181-187`）。
对照：批量确认应付是**分币种**的（`supplier-payable.service.ts:276`、`:282-283`），
返单追溯有现成的 `sumByCurrency`（`reorder.domain.ts:84`）。
**建议**：汇总一律返回 `[{currency, amount}]`，界面按币种分列。

### 3.8 成本报表取价不按币种（**中**）

`finance-report-cost.service.ts:105-123` 的 `latestPurchasePrices()` 只按时间取最近一次
`purchase_order_items.unit_price`，再乘销售单汇率（`finance-report.tables.ts:353`、`:472`）
或直接当本币（`:469`、`:481-483`）。用美元采购的物料，成本会被当成人民币 → 毛利错。
**建议**：取价时带上采购单币种，按目标币种筛选或折算；缺汇率时留空并进表尾。

### 3.9 到货接口自己算并返回一个「应付金额」（**中**）

`purchase-orders.service.ts:521-522` 写入 `payable_amount = 到货数量 × item.unitPrice` 与
`payable_status: "pending_finance"`，并在 `:532` 返回（幂等命中时 `:517` 还会再算一遍）；
而同一文件 `:462` 给到货写的是 `payable_amount: "0.0000"` + `not_applicable_until_inbound_posted`。
**同一个概念两个数**，且与真实应付（要 QC 合格 + 入库过账）在部分入库/拒收场景下必然不等。
前端目前没展示它（`apps/web/app/procurement/inbounds/page.tsx:116` 展示的是应付来源的金额），
属**潜在陷阱**。**建议**：移除，或改名成明确的前瞻值并去掉 `pending_finance` 这个状态词。

### 3.10 四处「已财务过账不可撤销」是死条件（**中**）

四处都在比 `payable_sources.status === "posted"`（`purchase-orders.service.ts:463`、`:464`、`:541`；
`incoming-inspections.service.ts:108`），而这一列的取值只有
`pending_finance` / `received` / `voided`（`schema.prisma:1145`、`supplier-payable.service.ts:165`）——
**从来没有 `posted`**。目前靠旁路条件（有质检量 / 有入库 / 有应付条目）兜住，
一旦旁路条件变化就会漏。**建议**：改成"存在未作废的应付来源或应付条目"。

### 3.11 对账单删除守卫查一条从不存在的流水（**中**）

`supplier-payable-reconciliation.service.ts:276-282` 查
`cash_flow_entry.sourceType = "supplier_payable_reconciliation"`，
而确认对账单时明确写的是 `cash_flow_entry_id: null` + 只挂凭证（`:232`、`:244`、`:210-224`）。
**影响**：已确认应付的对账单可以删除，谁按什么范围确认的从此无从追查。
**建议**：改为检查该范围内是否存在非 draft 的应付条目或已挂账凭证。

### 3.12 追溯链缺列 + 退回计划主动断链 + 追溯视图没有采购计划（**中**）

见 §1.5。**建议**：给 `purchase_order_items` 加 `purchase_plan_item_id` 列（只读留痕），
并把采购计划纳入 `DOCUMENT_GROUPS` / 追溯查询。

### 3.13 术语与死代码（**低**）

- `payable_sources` 没有 `deleted_at`（`outsource_payable_sources` 有），
  两处取源漏过滤（`supplier-payable.service.ts:588`、`supplier-payable-reconciliation.service.ts:90`）。
- 收款侧同类死词汇：`cash_flow_entries.sourceType` 只被写 `supplier_payment` / `customer_payment`，
  却在读 `receivable_source` / `receivable_reconciliation` / `supplier_payable_entry`
  （`finance-report-query.service.ts:644`、`:667-668`、`finance-slip.service.ts:136`/`:222`）；
  `cash-flow.service.ts:398` 的 `recordConfirmation` 已无调用方。
  表现：付款单预填的开户行/科目永远走兜底值，外汇一览表"回捞旧流水"的分支永不命中。

---

## 4. 需要真实数据库才能确认的（本机没有 PostgreSQL）

| 待确认 | 怎么查 |
|---|---|
| 是否存在**残留的到货级** `payable_sources`（`raw_material_inbound_id IS NULL` 且 `status != 'voided'`）—— 迁移 `20260906100000_...` 声称已全部作废，而取源查询不校验这一列（`supplier-payable.service.ts:583`） | `SELECT count(*) FROM payable_sources WHERE raw_material_inbound_id IS NULL AND status <> 'voided';` |
| 是否存在 `amount <> quantity * unitPrice` 的应付条目（金额覆盖入口的实际使用情况） | `SELECT count(*) FROM supplier_payable_entries WHERE abs(amount - quantity * unit_price) > 0.0001;` |
| 是否存在 0 价采购单与由此产生的 0 元应付（§2.1 修的是入口，历史数据还在） | `SELECT count(*) FROM purchase_order_items WHERE unit_price = 0 AND deleted_at IS NULL;` |
| 同一 `order_no` 下是否真的出现过**多币种**采购/应付（决定 §3.5/§3.7 是现实缺陷还是理论缺陷） | `SELECT order_no, count(DISTINCT currency) FROM supplier_payable_entries GROUP BY 1 HAVING count(DISTINCT currency) > 1;` |
| 是否存在 `outsource_payable_sources.deleted_at` 非空的行 | `SELECT count(*) FROM outsource_payable_sources WHERE deleted_at IS NOT NULL;` |

---

## 5. 刻意不一致（不是缺陷，别改）

- **到货不产生应付**：到货只是"东西到了"，应付要等 QC 合格 + 入库过账。
  所以"到货了但还没入库"时财务看不到应付 —— 这是口径，不是漏。
- **`tax_rate` 不参与采购金额**：`finance-report.tables.ts:31` 的 R3 口径
  「系统采购单价即含税价」，所以报表里「含税单价 = 单价、含税金额 = 金额」。
  采购明细上的 `tax_rate` 列目前不参与任何金额计算（前端也没有这一格）。
- **超收按实际入库量产生应付**：会超过采购单金额，是有意的"到多少算多少"（要填超收原因）。
- **计划与采购明细的金额列形状不同**：采购明细落 `amount`（因为含独立的 `extra_fee`），
  计划**不落**金额列（`数量 × 单价` 的纯派生量，落列就会有第二个真源）。
