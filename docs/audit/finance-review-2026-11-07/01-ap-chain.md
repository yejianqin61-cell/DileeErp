# 应付链路

> 分析对象：当前工作区代码（`apps/api`，Node/NestJS+Prisma），只读核验，未改任何源码。
> 证据路径缩写（后文 `缩写:行号` 均为精确位置）：
>
> | 缩写 | 文件 |
> |---|---|
> | SP | apps/api/src/modules/finance/supplier-payable.service.ts |
> | SPD | apps/api/src/modules/finance/supplier-payable.domain.ts |
> | SPAY | apps/api/src/modules/finance/supplier-payment.service.ts |
> | SPR | apps/api/src/modules/finance/supplier-payable-reconciliation.service.ts |
> | OPI | apps/api/src/modules/finance/other-payable-import.ts |
> | PN | apps/api/src/modules/finance/payment-nature.ts |
> | VS | apps/api/src/modules/finance/voucher.service.ts |
> | VD | apps/api/src/modules/finance/voucher.domain.ts |
> | CFS | apps/api/src/modules/finance/cash-flow.service.ts |
> | CAT | apps/api/src/modules/finance/accounting-subject-catalog.ts |
> | FC | apps/api/src/modules/finance/finance.controller.ts |
> | PNC | apps/api/src/modules/finance/payable-notification.controller.ts |
> | FSS | apps/api/src/modules/finance/finance-slip.service.ts |
> | F3 | apps/api/src/modules/finance/finance-three-statements.service.ts |
> | VCTL | apps/api/src/modules/finance/voucher.controller.ts |
> | BC | apps/api/src/modules/finance/bank-selection.ts |
> | MPG | apps/api/src/platform/authorization/module-permission.guard.ts |
> | RMB | apps/api/src/modules/procurement/raw-material-inbounds.service.ts |
> | PO | apps/api/src/modules/procurement/purchase-orders.service.ts |
> | II | apps/api/src/modules/procurement/incoming-inspections.service.ts |
> | OL | apps/api/src/modules/production/outsource-logistics.service.ts |
> | SCHEMA | apps/api/prisma/schema.prisma |

范围说明：`payment-nature.ts`（PN）只服务收入侧/收付款流水（`CFS:12,289`、`customer-payment.service.ts:80`），**不在应付链路上**；`supplier-payable-reconciliation.service.ts` 只看科目/金额/确认部分。

---

## 1 链路图

```text
采购侧（上游事实，均非财务模块）
  [采购单 PurchaseOrderItem]  金额 = 数量×unit_price + extra_fee（PO:733；unit_price 为含税价，purchase-order-export.service.ts:23）
        │
        ├─(仓库) 原料入库 post ──► PayableSource(pending_finance)
        │        amount = 数量×结算单价（部分入库才用人工结算价；非部分入库强制用 PO 单价）(RMB:180-183)
        │        taxRate 只落库、不参与金额计算 (RMB:200)
        │        idempotencyKey = "inbound:<inboundId>"，唯一 (RMB:150,207; SCHEMA:1391)
        │
        └─(采购) 外加工签收 receipt ──► OutsourcePayableSource(pending_finance)
                 amount = 签收数量×加工单价（含税）(OL:114,120)
                 outsourceReceiptId 唯一 (SCHEMA:1481)，签收幂等键由调用方传 (OL:94-98)

接收应付（财务 + 采购都可；PNC:31,40-43）
  POST /finance/payable-entries/from-source
    ── 锁来源行 → 来源必须未作废/未删除 (SP:167-169,737-747)
    ── source ↔ entry 一对一，重复调用复用（含软删恢复）(SP:170-176; SCHEMA:1520-1521)
    ── 建 SupplierPayableEntry(draft)：quantity/unitPrice/taxRate/amount 全部来自来源快照 (SP:185-198)
    ── 允许覆盖金额，但必须填 amount_reason (SP:186-187)
    ── 来源 status: pending_finance → received（幂等；不回退）(SP:211-215)

其他应付（财务手工，无上游业务单据）
  createOther ──► entry(draft, sourceType="other", subjectId 可选) (SP:540-554)
  Excel 导入 ──► entry(draft) 一个事务全进/全不进；科目按“名称”解析，重名/停用整行拒绝 (SP:603-717,562-567,630-647)

对账（可选）
  SupplierPayableReconciliation(pending) → 差异=0 matched / 有差异 difference → resolve → resolved (SPR:125-158)
  └─ 确认门禁：只有 matched/resolved 可确认 (SPR:187,378)

确认 = 挂账（三个入口，同一账务口径；均不动现金、不写流水）
  confirm(id,{bank_id,subject_id}) / batch-confirm / supplier-payable-reconciliations/:id/confirm-payables
    ── entry: draft → confirmed（各自事务内）(SP:241; SP:321-324; SPR:201)
    ── 事务提交后：逐条 Voucher(source_type="supplier_payable", source_id=entry.id, status=draft)
         借 成本/费用科目 / 贷 应付账款 (VS:27-30,245-317,341-344)
         科目优先级：entry.subjectId > 确认弹窗 subject_id > 按 sourceType 的候选链 (SP:282; SPR:230; VS:272-274)
         例外：金额≤0 不挂账 (VS:261-263)；对方科目属于“库存现金*”算资金搬运，不挂账 (VS:292-297)
    ── 幂等：vouchers(source_type, source_id) 唯一，命中即返回原凭证（不限状态）(VS:265-266; SCHEMA:2408)

付款（钱真正出去）
  POST supplier-payments（草稿）── 银行可选 (SPAY:55; BC:17-21)，科目可选，idempotency_key 可选唯一 (SPAY:58-63; SCHEMA:1572)
    └─ 同供应商+订单+金额+币种的草稿重复会被拒 (SPAY:64-68)
  POST supplier-payments/:id/post
    事务内：锁付款→只能 draft→posted (SPAY:89,122)
            逐条：锁应付→供应商/币种/订单一致→只能 confirmed/partially_paid→核销额≤未核销余额 (SPAY:106-112)
            写 SupplierPaymentAllocation(active)（payment+entry 唯一）(SPAY:119; SCHEMA:1625)
            核销合计≤付款金额（允许小于）(SPAY:121)
            重算 entry 状态：paid / partially_paid / confirmed (SPAY:123; SP:508-521)
    事务外：autoCreateFromPayment 写 CashFlowEntry(posted, direction=expense, amount=付款全额)
            subjectId（对方科目）= 全部被核销应付都已挂账 ? “应付账款” : 人工/单据科目/来源候选链 (SPAY:135-168)
            categorySubjectId（收支类目）= 人工科目 > 金额最大单据的科目 (SPAY:142-174)
            找不到科目显式 422，不静默丢流水 (CFS:383-391)
  最后（人工）：凭证工作台“由流水生成凭证” → Voucher(cash_flow_entry, draft) → 再人工“过账” (VCTL:172-175,188-191)
    付款凭证：支出方向 = 借 对方科目 / 贷 银行存款（或库存现金）(VD:145-157)
    金额 = 流水金额 = 付款全额，不是本次核销额 (VS:180,452; CFS:401)

冲销/回退（联动范围各自不同）
  entry.confirmed --reopen(reason)--> draft；不清挂账凭证 (SP:369-381)
  entry.confirmed/partially_paid/paid --reverse(reason)--> reversed；无 posted 核销时才能做；不红冲挂账凭证 (SP:383-395)
  payment.posted --reverse(reason)--> payment.reversed + allocations.reversed + entry 状态回算 + 流水 reversed；不红冲付款凭证 (SPAY:204-220)
  其他应付 draft/confirmed --delete(reason)--> 软删；旧代码“回冲确认时流水”已失效，不处理挂账凭证 (SP:418-465,442-444)
  入库 posted --reverse(reason)--> source voided + 草稿 entry→voided + inventory_fact 冲减；已确认应付必须先处理 (RMB:286-330)
  外加工签收 --reverseReceipt(reason)--> source voided；不检查、不改应付条目 (OL:161-183)
  对账单 --delete(reason)--> 软删；守护条件查的流水来源类型已不再产生 (SPR:278-306,285-291)
  Voucher(posted) --reverse(reason)--> 红字凭证(posted，日期=当天) + 原证 reversed；不回写应付状态 (VS:674-698,689)
```

---

## 2 环节表

| # | 环节 | 触发者 | 输入 | 写入字段/单据 | 门禁 | 失败与回退 | 代码证据 |
|---|---|---|---|---|---|---|---|
| 1 | 原料入库过账生成应付来源 | 仓库（`@RequireModules("warehouse")`） | 入库单、质检结果、采购单价/人工结算价 | `PayableSource(status=pending_finance, amount, quantity, unitPrice, taxRate, idempotencyKey)` + `inventory_fact(+qty)` | 入库单 draft；入库通知已确认；质检合格；数量≤QC 允许量 | 事务回滚；重复键→`PAYABLE_SOURCE_DUPLICATE` | RMB:146-222,180-210,150,207 |
| 2 | 外加工签收生成应付来源 | 采购（`@RequireModules("procurement")`） | 批次、签收数量、日期、幂等键 | `OutsourceReceipt` + `OutsourcePayableSource(pending_finance, amount=数量×加工单价)` | 批次 dispatched/partially_received；签收量≤未签收量；短收要差异原因 | 幂等键重复：同数量返回原单，否则 409；事务回滚 | OL:85-131,114,120 |
| 3 | 接收应付（来源→应付草稿） | 财务或采购（`@RequireAnyModules("finance","procurement")`） | source_type + source_id (+可选覆盖金额/原因/确认日期) | `SupplierPayableEntry(draft)`；source.status=received | purchase_receipt 来源禁用；来源未作废、关联单据未软删；覆盖金额必须带原因 | 重复调用返回原条目；软删条目被复活；事务回滚 | SP:163-183,185-198,211-215,737-747; PNC:31,40-43 |
| 4 | 其他应付录入（单条/导入） | 财务 | 供应商、金额、币种、说明、可选会计科目、确认日期 | `SupplierPayableEntry(draft, sourceType=other, quantity=1, unitPrice=amount, taxRate=0, subjectId)` | 供应商存在；金额>0；科目存在且启用；导入逐行校验、重名/停用科目整行拒绝 | 单条：422；导入：通过行一个事务落库、错误行逐行回报 | SP:540-554,573-585,562-567,603-717; OPI:173-296 |
| 5 | 应付对账（创建/差异处理/删除） | 财务 | 供应商+币种+期间（可收窄订单/采购单）、外部余额、可选银行/科目 | `SupplierPayableReconciliation(payableAmountSnapshot, paymentAmountSnapshot, adjustment=0, systemBalance, difference, status)` | 期间合法；银行/科目存在且启用；差异处理要说明 | 删除软删；已确认守护依赖死代码（见 AP-D-18） | SPR:125-158,278-306,141,285-291 |
| 6 | 逐条确认应付（挂账） | 财务 | entry id + 可选 bank_id/subject_id | `entry.status=confirmed`（事务内）；事务外挂账 `Voucher(draft)` | 只有 draft；来源未作废；bank/subject 存在且启用 | 状态已提交但凭证失败→confirmed 无凭证（AP-D-01）；重复确认→不可确认 | SP:231-249,267-284 |
| 7 | 批量确认应付 | 财务 | ids[] + 整批可选 bank_id/subject_id | 多条 `status=confirmed`（同一事务）；事务外逐条挂账凭证 | 只捞 draft；作废来源跳过并回报；更新条数不等整批回滚 | 同上；中途失败→部分已确认/部分有凭证（AP-D-01） | SP:303-347,311-336 |
| 8 | 对账确认应付 | 财务 | 对账单 id + 可选覆盖银行/科目 | 范围内草稿→confirmed（事务内）；回写 `reconciliation.bankId/subjectId`；事务外逐条挂账 | 对账必须 matched/resolved；作废来源跳过 | 同上；bank/subject 只回写对账单，不落条目 | SPR:178-261,195-234 |
| 9 | 登记付款草稿 | 财务 | 供应商、日期、金额、币种、方式、可选银行/科目、幂等键 | `SupplierPayment(draft, amount, bankId?, subjectId?, idempotencyKey?)` | 供应商启用；银行启用；科目启用；同供应商/订单/金额/币种的草稿重复拒绝 | 幂等键命中返回原单；422 | SPAY:49-72; BC:17-24; SCHEMA:1569-1603 |
| 10 | 付款过账 + 核销 | 财务 | 付款 id + allocations[{entry,amount}] + 可选 subject_id | `Allocation(active)`；`payment.status=posted`；`entry.status` 重算 | 付款只能 draft；同付款不得重复核销同应付；供应商/币种/订单一致；核销≤应付余额；核销合计≤付款金额；应付只能 confirmed/partially_paid | 整个 SQL 事务回滚；`POST` 后金额不可再改 | SPAY:80-125,106-123; SP:508-521 |
| 11 | 付款写收支流水 | 付款过账成功后自动（服务内） | 付款金额/币种/对方/银行/科目与类目 | `CashFlowEntry(posted, sourceType="supplier_payment", subjectId, categorySubjectId, bankId?)` | 同 source_type+source_id 已有 posted 流水则不重复；科目必须解析成功 | 失败抛 422，但付款已 posted 且不能重过账（AP-D-04） | SPAY:156-177; CFS:324-417,377-391 |
| 12 | 生成/过账付款凭证 | 财务（凭证工作台手动） | 流水 id；再手动过账 | `Voucher(source_type="cash_flow_entry", draft)` → posted；借业务科目/贷资金科目 | 流水必须 posted；同流水只一张；草稿才能改/过账 | 不生成则长期无凭证；生成后不过账则报表看不到（AP-D-03/05） | VCTL:172-175,188-191; VS:172-194,638-651; VD:145-157 |
| 13 | 回退草稿 | 财务（原因必填） | entry id、原因 | `entry.status=draft`，备注追加 | 只有 confirmed；存在 posted 核销则拒绝 | 不清挂账凭证；改金额后重新确认不重算（AP-D-08） | SP:369-381,355-367 |
| 14 | 应付冲销 | 财务（原因必填） | entry id、原因 | `entry.status=reversed`，备注追加 | confirmed/partially_paid/paid；存在 posted 核销则拒绝 | 不红冲挂账凭证（AP-D-06） | SP:383-395 |
| 15 | 付款冲销 | 财务（原因必填） | payment id、原因 | `payment=reversed`、`allocations=reversed`、entry 状态回算；事务外流水 reversed | 只有 posted 付款 | 流水回冲在事务外；不红冲付款凭证（AP-D-04/06） | SPAY:204-220; CFS:629-639 |
| 16 | 删除其他应付（单条/批量） | 财务（原因必填） | entry id(s)、原因 | 软删 entry；`deletedAt/deletedBy` + 备注 | 只有 sourceType=other；只有 draft/confirmed；无 posted 核销；未被对账单覆盖（覆盖判定纯函数） | 单条原子；批量逐条、失败点名；已确认条目的“回冲流水”已是空操作（AP-D-09） | SP:418-465,480-506,442-444; SPD:53-70 |
| 17 | 入库冲销 | 仓库/财务（原因必填） | 入库单 id、原因 | `inbound=reversed`、`inventory_fact(-qty)`、source=voided、草稿 entry=voided | 入库必须 posted；库存不能为负；有 posted 付款拒绝；有非草稿应付拒绝 | 事务回滚；已确认应付要求先冲销付款/应付；不回退已存在的挂账凭证 | RMB:286-330,297-300,323-325 |
| 18 | 外加工签收冲销 | 采购（原因必填） | 签收 id、原因 | `OutsourceReceipt=reversed`、source=voided、批次状态回算 | 签收非已冲销；批次存在 | **不检查/不改应付条目**（AP-D-17） | OL:161-183,173 |
| 19 | 删除对账单 | 财务（原因必填） | 对账单 id、原因 | 软删对账单 | 守护：存在 `sourceType="supplier_payable_reconciliation"` 的已过账流水则拒绝——该来源类型已不再产生 | 无实际拦截；删后覆盖关系消失（影响台账科目显示/付款类目） | SPR:278-306,285-291 |
| 20 | 凭证红冲 | 财务（原因必填） | 凭证 id、原因 | 红字凭证(posted，日期=当天) + 原凭证 reversed | 只有 posted | 不回写应付/付款状态；跨期入账（AP-D-19） | VS:674-698,689 |
| 21 | 台账/报表取数 | 财务/采购（查看） | 筛选条件 | 无写入 | 台账“已付”= 存在 active 且 posted 的核销（SP:118-120）；报表只取 posted 凭证（F3:29,202-203） | — | SP:78-155; F3:202-203,399-400 |

---

## 3 业务规则清单

| 编号 | 规则 | 强度 | 代码证据 |
|---|---|---|---|
| AP-R-01 | 一笔来源最多对应一条应付：`payableSourceId`/`outsourcePayableSourceId` 唯一，重复“接收应付”复用原条目（软删则恢复） | 强制 | SP:170-176; SCHEMA:1520-1521 |
| AP-R-02 | 只有未作废、关联单据未软删的来源可接收为应付 | 强制 | SP:737-747,239-240 |
| AP-R-03 | `purchase_receipt` 来源不允许再新建应付（仅兼容历史行） | 强制 | SP:165 |
| AP-R-04 | 来源→应付时金额默认取来源快照；人工覆盖必须填写原因 | 强制（仅建单） | SP:186-187,185-198 |
| AP-R-05 | 草稿应付可改金额/确认日期/币种；改金额**不需要**原因，也不回写来源 | 未强制 | SP:355-367 |
| AP-R-06 | 接收应付必须把来源推进到 `received`（即使重复接收也幂等） | 强制 | SP:211-215,177-179 |
| AP-R-07 | 只有 `draft` 可确认；来源已作废不可确认 | 强制 | SP:239-240; SPR:187 |
| AP-R-08 | 挂账科目优先级：条目 `subject_id` > 确认弹窗 `subject_id` > 按来源类型候选链 | 强制 | SP:282; SPR:230; VS:272-274 |
| AP-R-09 | 人工科目必须存在且启用，否则 422（不静默换科目） | 强制 | SP:234,355-356; VS:378-382 |
| AP-R-10 | 确认=挂账，不写收支流水、不动银行 | 强制（代码行为） | SP:231-249,211-215 注释; SPR:160-165 |
| AP-R-11 | 一条应付最多一张挂账凭证（`(source_type,source_id)` 唯一 + 先查后建） | 强制 | SCHEMA:2408; VS:265-266 |
| AP-R-12 | 挂账凭证借方=成本/费用科目，贷方=`应付账款`；金额=应付金额；状态=草稿 | 强制 | VS:341-344,411 |
| AP-R-13 | 金额≤0 不挂账；对方科目属于“库存现金*”视为资金搬运不挂账 | 强制 | VS:261-263,292-297 |
| AP-R-14 | 确认与挂账必须同一事务 | 缺失 | SP:235-248,308-336; SPR:183-234（状态在事务内、挂账在事务外） |
| AP-R-15 | 付款过账至少要核销一条应付，且同一付款不得重复核销同一应付 | 强制 | SPAY:82-83; SCHEMA:1625 |
| AP-R-16 | 核销的供应商、币种、订单必须与付款单一致 | 强制 | SPAY:110 |
| AP-R-17 | 单条核销额≤该应付未核销余额；核销合计≤付款金额 | 强制 | SPAY:112,121 |
| AP-R-18 | 只能核销 `confirmed`/`partially_paid` 的应付 | 强制 | SPAY:111 |
| AP-R-19 | 付款过账后按“已过账且 active 的核销额”重算应付状态（0→confirmed，部分→partially_paid，满→paid） | 强制 | SPAY:123; SP:508-521 |
| AP-R-20 | 付款金额必须等于本次核销合计 | 缺失（允许付款额>核销额，多余的挂在付款单上不核销） | SPAY:121,157 |
| AP-R-21 | 付款必须写收支流水，且与付款过账同生共死 | 缺失（流水在事务外） | SPAY:122,126,156-177 |
| AP-R-22 | 付款凭证借方：已挂账→`应付账款`；未挂账→人工/单据科目/来源候选链 | 条件强制（含混核销整笔按未挂账处理） | SPAY:133-155,168 |
| AP-R-23 | “已挂账”判定 = 来源应付存在一张未红冲凭证（**草稿也算**） | 未强制（口径错误，见 AP-D-02） | VS:355-362; SPAY:136-140 |
| AP-R-24 | 付款必须选支付银行 | 未强制（银行可选；无银行时流水不进任何账户余额） | SPAY:55; BC:17-21; CFS:407 |
| AP-R-25 | 应付状态机：draft→confirmed→partially_paid/paid；reversed；voided；软删 | 强制 | SCHEMA:1529; SP:516-521,377,391,445-449; RMB:325 |
| AP-R-26 | 回退草稿：仅 confirmed，且不得存在 posted 核销；原因必填 | 强制 | SP:369-381,375-376,370 |
| AP-R-27 | 应付冲销：仅 confirmed/partially_paid/paid，且不得存在 posted 核销；原因必填 | 强制 | SP:383-395,389-390,384 |
| AP-R-28 | 其他应付删除：仅 other；仅 draft/confirmed；无 posted 核销；未被对账单覆盖；原因必填；软删 | 强制 | SP:418-449,419,428-438 |
| AP-R-29 | 删除/冲销已确认应付必须联动撤销其挂账凭证 | 缺失 | SP:383-395,442-444（均无凭证处理） |
| AP-R-30 | 来源作废必须联动应付条目（作废/冲销） | 部分强制（原料入库有；外加工签收缺失） | RMB:297-300,323-325；OL:161-183 |
| AP-R-31 | 会计科目按名称解析时，重名/停用必须报错，不得静默选一个 | 导入处强制；凭证处未强制 | SP:562-567,630-647；VS:366-375（同名取第一个匹配） |
| AP-R-32 | 凭证必须借贷平衡、每行金额>0、资金行银行账户存在 | 强制 | VS:396-404,399 |
| AP-R-33 | 凭证状态：生成即草稿；只有 posted 进报表；过账/红冲靠人工 | 强制 | VS:187,411,638-651; F3:202-203; VCTL:188-191 |
| AP-R-34 | 对账确认门禁：对账状态必须 matched/resolved，差异未处理不得确认应付 | 强制 | SPR:187,378 |
| AP-R-35 | 对账确认可在确认时覆盖整批银行/科目，并回写对账单 | 强制 | SPR:204-208 |
| AP-R-36 | 对账差异必须生成调整分录/调整应付 | 缺失（`adjustmentAmountSnapshot` 恒 0，无调整写入路径） | SPR:141; SCHEMA:2190 |
| AP-R-37 | 挂账凭证日期=确认当日，而不是应付确认日期；导入的往期应付也会落在当月 | 未强制（口径缺失） | SP:277; SPR:221; SP:196 |
| AP-R-38 | 应付相关动作的权限=拥有 finance 模块即可（无制单/审核分离、无期间锁定） | 未强制 | FC:197-199; MPG:32-48 |
| AP-R-39 | 收支流水已冲销后不得再生成/重算凭证 | 强制 | VS:174-175,449 |
| AP-R-40 | 付款单（supplier_payment）与付款单据（finance_slip 导出）之间无流程/数据关联 | 缺失 | FSS:121-138; 全仓无 supplier_payment 引用（finance-slip*.ts） |

---

## 4 流程性缺陷

> 严重度：致命 = 直接导致账面错/丢数；高 = 造成口径分叉或无法纠错；中 = 治理/体验级。

| 编号 | 现象 | 根因 | 影响 | 建议 | 证据 |
|---|---|---|---|---|---|
| AP-D-01【致命】 | 确认应付成功后，挂账凭证可能根本没生成：先提交 `status=confirmed`，再在事务外调 `createAccrual`；任一步失败（科目停用、期间编号冲突、DI 异常）都会留下“已确认、无凭证”的应付 | 状态与凭证分属两个事务（逐条/批量/对账确认三条入口都一样） | 应付台账显示已确认，总账没有应付账款；重试只能“回退→再确认”，批量场景下已生成的凭证与未生成的条目混杂 | 把确认+挂账合并进同一事务（或引入 outbox/重试任务 + `accrual_status` 列）；批量失败要整批回滚并明确回报 | SP:235-248,308-336；SPR:183-234 |
| AP-D-02【致命】 | “已挂账”判定只看是否存在未红冲凭证，**草稿凭证也算已挂账**：付款过账时若挂账凭证还是 draft（系统默认就是 draft，没人强制过账），付款凭证会借`应付账款`，而挂账凭证从未进总账 | `accruedSourceIds` 只排除 reversed，不要求 posted；账务判断与“凭证是否生效”脱节 | 应付账款只有借方（付款）没有贷方（挂账），成本/存货也永远没入账；两账都错且报表上互相掩盖 | 判定改为 `status="posted"` 才算已挂账；未过账的挂账凭证要么自动过账，要么在付款前强制拦截并提示 | VS:355-362；SPAY:133-140 |
| AP-D-03【致命】 | 确认应付只产生**草稿**凭证；三大报表只取 `status=posted` 的凭证；全仓没有任何自动过账路径，过账只能由人在凭证工作台逐张点 | 两步挂账方案把“生成凭证”与“过账”都留给了人工，却没有流程门禁/清单 | 确认应付后资产负债表看不到应付账款，直到财务逐张过账；批量确认几十条就要点几十次，漏点无人发现（仅报表侧统计草稿张数） | 确认时可选自动过账或提供“本期应付挂账凭证批量过账”；报表侧把“应付已确认但凭证未过账”做成显式告警 | VS:411,638-651；F3:29,202-203,399-400；VCTL:188-191 |
| AP-D-04【高】 | 付款过账先提交 `payment=posted`，事务外才写收支流水；写流水失败（科目候选全缺失等）后付款已是 posted，无法再次过账，只能先冲销再重录 | 单据状态与现金流水不在同一事务，且 `post` 只接受 draft | 付款单已过账但收支流水/银行余额里没有这笔钱；财务以为付了、账上没付 | 流水写入并入付款过账事务；或改为“流水失败则整笔回滚”，并给已 posted 的失败单提供“补写流水”入口 | SPAY:122,126,156-177,89 |
| AP-D-05【高】 | 付款凭证不会在付款过账时生成：必须人工到凭证工作台“由流水生成凭证”，再人工过账；接口无任何提醒/计数约束 | 设计把凭证生成留成独立动作，付款链只到流水为止 | 应付已付款、流水有、凭证长期缺失或与流水不一致，月末结账时靠人回忆补录 | 付款过账后自动生成草稿凭证（幂等已有唯一键），并在付款单上显示凭证状态 | SPAY:156-177（无凭证调用）；VCTL:172-175；VS:172-194 |
| AP-D-06【致命】 | 冲销/红冲互不联动：付款冲销只冲付款/核销/流水，不红冲付款凭证；应付冲销只改状态，不红冲挂账凭证；凭证红冲不回写应付/付款状态 | 各模块只维护自己的状态，来源单据的“账务结果”没有反向指针 | 账上残留红冲前的凭证：付款冲销后凭证仍借应付账款/贷银行存款；应付冲销后挂账凭证仍贷应付账款；凭证红冲后应付仍是已确认 | 建立“来源单据 → 凭证”双向联动表/状态；冲销按凭证状态自动红冲或删除草稿，并回写来源状态 | SPAY:204-220；SP:383-395；VS:674-698（均无对手方回写） |
| AP-D-07【高】 | 挂账凭证被红冲后，再次“确认应付”会因幂等命中返回那张**已红冲**凭证：`existing` 查询不筛状态，且已红冲凭证不能删除、不能再红冲 → 该应付永远无法重新挂账 | 幂等键只按来源 id 去重，未区分“有效/已红冲/已删除草稿” | 应付保持 confirmed，但总账上没有有效挂账；付款时因 `accruedSourceIds` 排除 reversed 又走成本口径，形成应付/成本双口径混用 | 幂等命中时校验凭证状态：reversed/deleted 应允许重建（或明确报错并给出“重新挂账”动作）；红冲时同步应付状态 | VS:265-266,355-362；VS:654-666（删除仅草稿）,674-677（红冲仅 posted） |
| AP-D-08【高】 | 回退草稿→改金额→重新确认：`createAccrual` 命中旧凭证直接返回，金额/科目都不重算；只有手工“重新生成”才更新 | 幂等逻辑不比较金额/科目；回退不清凭证 | 应付金额 100 改成 120，挂账凭证仍是 100；台账与凭证不一致，报表按 100 记 | 确认前比对凭证金额/科目与当前应付，不一致则重建（或禁止改金额，要求先删草稿凭证）；回退时提示“挂账凭证仍存在” | SP:355-367,369-381,282；VS:265-266 |
| AP-D-09【高】 | 删除已确认的其他应付：代码仍执行“回冲确认时写的支出流水”，但确认早已不写流水 → 空操作；挂账凭证既不删除也不红冲 | 两步挂账改造后旧联动未清理，删除逻辑仍按“确认即记账”口径实现 | 条目从台账消失、挂账凭证仍贷`应付账款`，账上多出一笔无来源负债；对账/审计时找不到对应单据 | 删除 confirmed 条目时按凭证状态处理（草稿删、posted 红冲），并在审计里记录凭证号；删除流水那段改为历史兼容分支 | SP:418-465,442-444,439-441 注释 |
| AP-D-10【高】 | 确认弹窗选择的会计科目/银行**不落库**：`options.subject_id` 只参与本次挂账凭证；`bank_id` 只做存在性校验后丢弃；`PATCH payable-entries/:id` 的 DTO 接受 `subject_id` 但 service 入参没有该字段，静默忽略 | 科目/银行被当成“凭证参数”而不是“应付单据属性”；草稿编辑接口未同步 | 台账“会计科目”列、付款凭证借方、收支类目都读不到用户在确认时选的科目；银行选择完全无效（付款时还要再选一次） | 确认时把 subject_id/bank_id 回写到条目（其他应付已有该列，原料/外加工应付可加或用关联表）；PATCH 补齐字段或 DTO 删除该字段避免误导 | SP:231-249,282,355,550；FC:107；SP:58-62,134（台账取值链无 confirm 参数） |
| AP-D-11【高】 | 金额口径不一致：采购明细金额 = 数量×单价 + `extra_fee`，而应付金额 = 数量×结算单价，**漏加附加费**；且“全额入库”时人工结算单价/总价被忽略，强制用 PO 单价 | 应付来源在入库时自行重算金额，没有复用采购金额口径；部分入库判定写死 | 有附加费的采购单，应付少计附加费；仓库人工结算价在正常入库时被丢弃，与采购口径打架 | 应付金额取采购明细 `amount`（或明确按行拆分附加费），人工结算价与 PO 价不一致时必须走金额差异原因并留痕 | PO:733；RMB:180-183,195-201；purchase-order-export.service.ts:23,26（注释声称“与财务应付金额同口径”） |
| AP-D-12【高】 | 含税/未税未拆：系统采购单价是含税价，挂账凭证按含税全额 借 成本/费用、贷 应付账款，**没有进项税行**；`taxRate` 只存不用 | 全链把含税金额当唯一金额；自动凭证只有一借一贷 | 成本/费用虚增（含进项税），应交税费-进项税永远为 0；若财务手改每张凭证，又回到“系统外记账” | 在挂账凭证模板中按票价类型拆税（专票/普票/不可抵扣），或至少生成“含税+进项税”两行草稿由财务确认；把 `tax_rate` 接入分录拆分 | RMB:200；VS:341-344；voucher-template.ts:107-111（模板有进项税行，但自动挂账不用它）；finance-slip.ts:30（“不自动拆进项税”是另一处的既定口径） |
| AP-D-13【高】 | 采购入库的默认借方科目是**损益类“主营业务成本”**（候选链首位），不是存货类“原材料/库存商品”：入库即费用化 | 科目映射把“原材料 成本”归到损益类，并作为 `raw_material_inbound` 候选首位 | 制造业存货不增、成本提前确认，毛利/存货/资产负债表失真；月末无法做“材料入库→领用→结转”的存货核算 | 入库挂账应借存货类科目（原材料/库存商品），领用时再结转成本；若坚持简化口径，需财务书面确认并在报表脚注披露 | CAT:321,389；SP:281；VS:272 |
| AP-D-14【高】 | 科目来源与金额来源分离：同一笔应付有 4 套科目取值——台账显示（条目>对账单>候选首位）、挂账凭证（条目>确认弹窗>候选首位存在项）、付款凭证借方（是否挂账决定，不看科目）、收支类目（条目/对账单）；金额始终来自条目 | 各环节各自实现“科目优先级”，没有单一快照字段；确认参数又不回写条干 | 台账、挂账凭证、付款凭证、类目可能显示 4 个不同科目；用户“会计科目不令人满意”的直接来源 | 应付条目增加“挂账科目快照”（写入时定稿），凭证/台账/类目共用它；付款借方按快照决定 | SP:58-62,134,282；SPAY:117,135-155,174；VS:272-274 |
| AP-D-15【高】 | 允许付款金额 > 本次核销合计，且凭证按**付款全额**记 `借 应付账款`：多付/未核销部分没有“预付账款”科目承接 | `post` 只校验核销≤付款，不要求相等；流水金额取付款单金额 | 应付账款借方虚增（多付的那部分本应是预付/其他应收）；供应商余额与账面不一致；也导致“付款额-核销额”差额无账可查 | 要么强制核销合计=付款金额，要么差额自动记“预付账款-供应商”；流水/凭证金额与核销额分别落列 | SPAY:121,157；VS:180,452；CFS:401 |
| AP-D-16【中】 | 预付款无流程：付款过账必须核销至少一条已确认应付，不能对“未到货/未确认”的供应商先付款 | 付款单与应付核销强绑定，没有无核销付款/预付单类型 | 实际业务中的定金、预付货款只能走“其他应付”或系统外，科目/余额都失真 | 增加“预付款”单据类型（借预付账款/贷银行存款），到货后核销到应付 | SPAY:82,111 |
| AP-D-17【高】 | 外加工签收冲销/退货不联动应付：签收冲销只把来源置 voided，不检查也不改应付条目；外加工材料/成品退货调拨完全不碰应付 | 生产侧只维护来源状态，没有应付联动；与原料入库冲销（会校验并作废草稿条目）不对称 | 来源已作废，应付仍 confirmed/partially_paid/paid；应付凭证与上游事实脱节，对账时找不到依据 | 与原料入库同口径：有已确认应付时拒绝冲销，或按付款状态走“先冲销付款→冲销应付→冲销来源”；退货数量联动调整应付金额 | OL:161-183,173,208-298；RMB:297-300,323-325 |
| AP-D-18【中】 | 两处守护是死代码：①对账单删除检查 `voucher/流水 sourceType="supplier_payable_reconciliation"`，该来源类型已不再产生；②采购侧多处检查 `payableSource.status==="posted"`，该状态全仓从未写入；对账差异也不生成调整分录（adjustment 恒 0） | 两步挂账改造后旧的“确认写流水/来源已过账”语义没有同步删除或替换 | 已用于确认应付的对账单可被直接删除（覆盖关系、付款类目科目来源丢失）；旧 purchase_receipt 来源可绕过应付保护被撤销；对账差异对账面零影响 | 守护改为查 `supplier_payable` 凭证或应付状态；删除无用的 status 检查；对账差异要么生成调整应付/调整分录，要么明确标注“仅归档” | SPR:285-291,141；PO:600-601,678；II:149；OL:173（对照） |
| AP-D-19【中】 | 期间口径缺失：挂账凭证日期取“确认当天”而非 `entry.confirmation_date`；红字凭证日期取 `new Date()`；系统没有会计期间关闭/锁定 | 凭证日期由动作时点决定，确认日期只用于台账/对账 | 补录往期其他应付时，凭证落在错误月份；跨月红冲扭曲当月；期间无法关账，历史账可被随时改 | 挂账凭证日期取应付确认日期（可配置）；红冲回原期间或增加“以前年度损益调整”；引入期间关闭（已关账期间禁止新增/红冲） | SP:277；SPR:221；VS:689；全仓无期间表/关账逻辑 |
| AP-D-20【中】 | 应付凭证没有供应商维度：`voucher_lines` 只有科目文本快照+银行引用，无供应商/单据引用；应付账款无法按供应商/账龄出明细账，只能反查应付单据表 | 凭证模型只服务“收支流水→科目”，没有往来辅助核算 | 用户想按供应商看应付余额/账龄只能看单据表，无法与总账勾稽；红冲/调账后明细更难追 | 凭证行增加往来单位/单据类型/单据号（辅助核算），或增加“应付明细账”视图按 entry+凭证联合取数 | SCHEMA:2481-2510；VS:996-1005；与 SCHEMA:1512-1567 无外键 |
| AP-D-21【中】 | 付款单（supplier_payment）与“付款单据”导出（finance_slip）是两套单据：后者预填银行/总账科目时查 `sourceType="supplier_payable_entry"` 的流水，而该流水已不再产生，预填必为空 | 旧“确认即记账”联动未清理；两套付款单据没有关联 | 财务导出的付款单丢失“从哪张卡付/记哪个科目”，只能手填，与系统内付款凭证口径再次分叉 | 付款单预填改查 `supplier_payment` 的流水/付款单（或直接用付款单自身 bank/subject）；长期把 finance_slip 与 supplier_payment 关联（或合并） | FSS:136-138,148,159-161,172-173；SPAY:156-177；SP:247-248 |
| AP-D-22【中】 | 资金搬运判定只认“库存现金*”前缀：其他应付科目填的是银行存款明细科目时照旧挂账 | `isCashFamilySubject` 只判断 `库存现金`，`isBankFamilySubject` 导出但全仓未使用 | 确认 → 借 银行存款 / 贷 应付账款；付款 → 借 应付账款 / 贷 银行存款；货币资金虚增、应付凭空产生 | 资金族判定同时覆盖银行存款族；或禁止应付科目选资金类科目（引导走资金调拨单） | VD:84-91；VS:292-297；全仓无 `isBankFamilySubject` 调用 |
| AP-D-23【中】 | “其他应付”没有上游业务来源：来源就是本次手工录入/Excel 本身；科目可空，留空默认“管理费用” | 系统没有费用申请/发票/合同等业务单据；科目由录单人自由选 | 备用金、房租、水电、运费混在 `other` 一个来源类型里，默认全部记管理费用；无法与业务事实核对，也没有审批链 | 为其他应付增加费用类型字典并强制映射科目（备用金→库存现金/其他应收款），接入发票/合同附件校验；科目改为必填 | SP:573-585,550；CAT:395；OPI:315 |
| AP-D-24【中】 | 权限与流程治理：应付的确认、付款、冲销、删除全部只要求 `finance` 模块权限，没有制单/审核分离、没有金额阈值审批、没有期间锁定 | 权限模型只到模块级（MPG 只校验模块） | 同一人可确认并付款并冲销并删除，错账无法通过流程拦截；事后只能靠审计日志追 | 引入财务角色细分（制单/审核/出纳）与金额阈值审批；关键动作（删除/冲销/红冲）要求管理员或双人确认 | FC:197-199；MPG:32-48；SP:418-465；SPAY:204-220 |

---

## 5 会计口径待确认（需用户/会计拍板）

1. **采购入库的借方科目**：入库挂账应借存货类“原材料/库存商品”，还是继续借损益类“主营业务成本”？若是简化口径，月末是否做“领用结转成本”？现在默认是后者（CAT:321,389）。
2. **含税/未税与进项税**：采购单价是含税价（purchase-order-export.service.ts:23）。挂账凭证是否要自动拆“借 原材料(未税) + 借 应交税费-进项税，贷 应付账款(含税)”？普票/不可抵扣/部分抵扣怎么处理？现在自动挂账不拆（VS:341-344），而凭证模板里其实预留了进项税行（voucher-template.ts:107-111）。
3. **应付入账时点**：现在是“入库过账即按采购单价确认应付”，没有发票/三单匹配，也没有月末暂估。是否要改为“发票到达确认”或“月末暂估应付”？
4. **采购附加费 `extra_fee`**：应付金额是否应包含采购明细的附加费（PO:733）？现在不含（AP-D-11），请确认哪种是财务口径。
5. **对账差异的处理**：应付对账 `difference` 只改状态、`adjustmentAmountSnapshot` 恒 0（SPR:141）。差异最终应如何入账（调整应付/营业外/下期抵扣/仅归档）？
6. **多付/预付款**：是否允许“付款金额>核销金额”？多出部分应记“预付账款-该供应商”还是“其他应收款”？系统目前没有预付账款流程（AP-D-15/16）。
7. **资金搬运**：备用金取现/存现应走“其他应付+科目=库存现金（备用金）”这种间接单据，还是应做成直接的资金调拨单？银行存款类科目是否也应视为“资金科目”而不挂账（AP-D-22）？
8. **挂账凭证的过账主体与时点**：确认后是自动过账、还是出纳/主管复核后过账？需不需要制单/审核分离（AP-D-03/24）？
9. **红冲与期间**：红字凭证应记在原凭证期间、还是冲销当期？是否要引入“以前年度损益调整”？系统目前红冲记当天且无期间关闭（AP-D-19）。
10. **应付辅助核算**：应付账款是否要按供应商/订单/币种出明细账与账龄？若要，凭证行需要增加往来单位维度（AP-D-20），否则只能看单据表。
11. **其他应付的科目归属**：备用金、房租、水电、运费是否必须逐一指定科目（现可空→默认管理费用，CAT:395；OPI:315）？是否需要费用类型字典+审批？

---

## 6 结论

1. 应付链路的“事实→单据”这一半是清楚的（来源→应付 1:1、幂等键、状态机、核销余额都有强制约束），但“单据→账”这一半是断的：确认、付款、凭证是三段各自提交的动作，没有原子性也没有自动衔接（AP-D-01/03/04/05）。
2. 最致命的会计错误是“草稿凭证被当成已挂账”（AP-D-02）和“冲销/红冲不联动凭证”（AP-D-06/07/09）：应付账款会只借不贷或只贷不借，而报表只取已过账凭证，错误会被“草稿没进表”进一步掩盖。
3. 科目问题是结构性的：同一笔应付在台账、挂账凭证、付款凭证、收支类目上各有一套取值链，确认时选的科目又不落库（AP-D-10/14），所以“会计科目、借贷不令人满意”不是显示 bug，而是没有单一科目快照。
4. 金额口径存在三处硬差异：漏采购附加费、含税不拆进项税、采购入库默认借损益类成本（AP-D-11/12/13）；再叠加“付款额可大于核销额且按全额记应付”（AP-D-15），应付余额很难与供应商对账单对平。
5. 建议按顺序修：先把“确认+挂账”和“付款+流水+凭证”各自并成原子动作并统一“已挂账=已过账凭证”，再补科目快照与金额口径，最后做冲销联动与期间/权限治理。
