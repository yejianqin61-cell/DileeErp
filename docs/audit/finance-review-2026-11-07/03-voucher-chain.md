# 凭证链路

> 核查口径：本文件只读工作区当前代码（`apps/api/src/modules/finance/**`、`apps/api/prisma/schema.prisma`），不连生产库、不改源码、不做 git 写操作。历史审计 `docs/audit/finance-voucher-ar-ap-audit-2026-10-28.md` 只作背景；它的 7 条结论已逐条回到当前代码复核，其中 1 条已被 2026-11-04 的改动修掉（见 §1.3），其余 6 条仍在。
>
> 结论先行：凭证这条链**不是「借贷方向写反」**，而是三件事叠加：①挂账凭证只落草稿，但下游按「已挂账」记销账；②销账凭证金额取收付款全额而不是核销额；③「会计科目」在系统里有 3 个落点（流水主科目 `subject_id` / 收支类目 `category_subject_id` / 凭证分录 `voucher_lines.subject_label`），凭证只认第 1 个，页面与现金流量表认第 2 个，手工改凭证后第 3 个又各走各的。

## 1 凭证来源全集表

### 1.1 `source_type` 全集（DB 是自由字符串，不是枚举）

`vouchers.source_type` 是 `VarChar(40)`，数据库层没有枚举约束（`apps/api/prisma/schema.prisma:2386`）；全集的唯一权威是 5 个常量：

| 值 | 常量位置 | 代表什么业务动作 | 谁创建 | 自动/手工 | `source_id` 指向 | 落库状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `cash_flow_entry` | `voucher.service.ts:13` | 由一条**收支流水**生成（付款/收款/工资/手工流水的销账分录） | `createFromCashFlowEntry`（`voucher.service.ts:172-194`） | **人工**逐条触发（`voucher.controller.ts:172-175`），无批量、无定时 | `cash_flow_entries.id` | `draft`（`voucher.service.ts:187`） |
| `supplier_payable` | `voucher.service.ts:18` | **应付确认 = 挂账**（钱没动，借成本/存货、贷应付账款） | `createAccrual`（`voucher.service.ts:245-317`） | **自动**：确认应付时由 `SupplierPayableService.accrue` 调用（`supplier-payable.service.ts:273-283`），三条确认入口都走它 | `supplier_payable_entries.id` | `draft`（`voucher.service.ts:411`） |
| `receivable_source` | `voucher.service.ts:17` | **应收确认 = 挂账**（借应收账款、贷收入） | `createAccrual`（同上） | **自动**：`receivable.service.ts:206-219`、`reconciliation.service.ts:184-195` | `receivable_sources.id` | `draft` |
| `voucher` | `voucher.service.ts:14` | **红冲**（把被红冲凭证的借贷对调，另开一张） | `reverse`（`voucher.service.ts:674-698`） | **自动**（红冲动作的副产物） | 被红冲的 `vouchers.id` | `posted`（红字凭证直接过账，`voucher.service.ts:689`） |
| `manual` | `voucher.service.ts:15` | **手工凭证**（折旧/摊销/工资计提/结转成本这类无现金流水的分录） | `createManual`（`voucher.service.ts:210-229`） | 人工（`voucher.controller.ts:166-169`） | `null`（`schema.prisma:2387-2389`） | `draft` |

补充事实：

- 「同一来源只能有一张凭证」由**全量**唯一索引保证（`schema.prisma:2408`），软删的行也占着键，所以「删掉草稿再生成」走的是**原地复活**（`voucher.service.ts:966-993`，注释见 956-965）。
- 凭证号规则 `记-YYYYMM-####`，在**期间内**顺延（`voucher.service.ts:184-185`、`408-409`）；期间取凭证日期前 7 位（`voucher.domain.ts:160-162`）。
- **没有任何地方会在收付款后自动生成凭证**：`createFromCashFlowEntry` 只由控制器的一个逐条路由调用（`voucher.controller.ts:172-175`），Web 端也是一个流水一行「生成凭证」按钮（`apps/web/components/finance/voucher-workspace.tsx:212`、`420`）。这是后面 VC-D-07 的根。
- 期初余额（`accounting_opening_balances`）不是凭证，只进报表取数（`finance-three-statements.service.ts:42-45`），不在这条链上。
- 导出（`voucher-workbook.ts:62-99`）只是「一行一条分录」的同数据视图：借/贷分两列、没有合计列、不参与任何计算（`voucher-workbook.ts:21-34`）。它**不会**暴露「借贷方向错」的问题，只能暴露科目名本身。

### 1.2 `finance-slip*.ts` 是不是「第二套凭证」？——是「第二套借贷记录」，但不是第二套账

判定结论：**它是一张「收/付款单」打印件的存档，不是记账凭证，不会重复记账**；但它带着一套**自己的借贷分录**（总账科目/明细科目/借方/贷方），构成系统里第 2 套借贷记录。

证据与边界：

| 判断项 | 事实 | 证据 |
| --- | --- | --- |
| 数据类型 | `FinanceSlipLine` 的 `general_subject` / `detail_subject` 是**自由文本**，没有指向 `accounting_subjects` 的外键；借贷金额可空（空 ≠ 0） | `finance-slip.ts:56-65`、`schema.prisma:3473-3488` |
| 是否入账 | 保存「**不写收支流水、不生成凭证、不动应付/应收的状态与金额**」，只回答「这张纸存下来」 | `finance-slip-store.service.ts:14-20`、`70-123` |
| 平衡校验 | 有独立的借贷平衡校验（`slipTotals` + `SLIP_NOT_BALANCED`），与凭证的平衡校验**互不相干**，也不共享实现 | `finance-slip.ts:233-259`、`332-352` |
| 与账务的关系 | 只有 `sourceEntryIds`（Json，追溯用），不指向凭证，也不指向流水 | `finance-slip-store.service.ts:148-167`、`schema.prisma:3458`（`sourceEntryIds Json?`） |
| 科目从哪里来 | 付款单「总账科目」优先取**应付条目自己填的科目**，其次取**确认时那条流水的 `subject_id`**；收款单取流水 `subject_id`，兜底「主营业务收入」 | `finance-slip.service.ts:152-167`、`239-258` |

**但它与凭证存在一致性风险（不是重复记账，是同一笔钱两套说法）**：

- 付款单预填：每行一条应付、**借记条目科目（如「管理费用」）**，末尾一行**贷记银行存款**（`finance-slip.service.ts:163-177`）。
- 而同一笔业务在凭证里（两步口径）是：挂账「借 管理费用 / 贷 应付账款」，付款「借 应付账款 / 贷 银行存款」（`supplier-payment.service.ts:127-177`）。
- 所以**单据上借方是费用科目，付款凭证借方是应付账款**。财务拿单据对凭证时必然看到两个「会计科目」，这正是用户反馈的「会计科目不令人满意」的一部分。收款单同形（单据贷方=收入科目，`finance-slip.service.ts:244-258`；凭证贷方=应收账款，`customer-payment.service.ts:130-132`）。
- 也不存在「单据 → 凭证」的勾对：单据里的科目名换成同音错字、或者与凭证科目不同，系统不会报任何差异（`finance-slip.ts:294-317` 只校验非空与金额格式）。

### 1.3 与历史审计（2026-10-28）的差异

| 历史审计结论 | 当前代码是否仍成立 | 依据 |
| --- | --- | --- |
| 现金流量表漏归位应付付款（`应付账款`被写进资产类分支） | **已修**：已改为「资产类/负债类」双分支，注释写明 2026-11-04 修正 | `finance-three-statements.ts:314-327` |
| 红冲后报表出现反向余额 | **仍成立**（见 VC-D-04） | `voucher.service.ts:689`、`693`；`finance-three-statements.service.ts:202-203` |
| 挂账草稿被当成「已挂账」 | **仍成立**（见 VC-D-01） | `voucher.service.ts:355-362` |
| 确认状态与凭证创建分两次提交 | **仍成立**（见 VC-D-14） | `supplier-payable.service.ts:235-248`、`receivable.service.ts:174-186` |
| 部分核销按整笔全额入账 | **仍成立**（见 VC-D-02） | `supplier-payment.service.ts:121`、`customer-payment.service.ts:117` |
| 业务冲销未同步凭证 | **仍成立**（见 VC-D-05） | `cash-flow.service.ts:603-617` |
| 原料入库默认借「主营业务成本」 | **仍成立**（见 §7） | `accounting-subject-catalog.ts:389` |
| 手工凭证只校验科目字符串 | **仍成立**（见 VC-D-10） | `voucher.service.ts:1008-1035` |

## 2 借贷方向规则矩阵

> 说明：以下「借/贷」是**自动生成路径**实际落库的分录；`draft` 表示生成后默认是草稿，要财务在凭证页过账才进三大报表（`finance-three-statements.service.ts:202-203`）。所有自动路径都只生成**固定两行、金额相等**（挂账：`voucher.service.ts:336-344`；流水：`voucher.domain.ts:145-157`），多借多贷只有手工/编辑器路径（见行 9）。

| 业务动作 | 借 | 贷 | 金额口径 | 触发 | 状态 | file:line |
| --- | --- | --- | --- | --- | --- | --- |
| 1 应收确认（逐条/批量/按对账单） | **应收账款**（按名称解析） | 收入科目：`contra_subject_id` 优先，否则候选链「主营业务收入 → 营业外收入」 | 应收来源**全额** `receivable_source.amount`；金额 ≤ 0 不挂账 | 确认应收（三条入口，确认状态先提交、再挂账） | draft | `voucher.service.ts:245-317`（科目 271-274、分录 336-340、金额 261-263、草稿 301-315）；`receivable.service.ts:200-219`；`reconciliation.service.ts:184-195`；`accounting-subject-catalog.ts:402` |
| 2 应付确认（挂账：原料入库/外加工/其他应付） | 成本/存货科目：**条目科目 `subjectId` > 弹窗临时科目 > 按来源类型候选链 > 主营业务成本/原材料** | **应付账款**（按名称解析） | 应付条目**全额** `entry.amount` | 确认应付（逐条/批量/按对账单） | draft | `voucher.service.ts:245-317`（341-344）；`supplier-payable.service.ts:267-284`；`supplier-payable-reconciliation.service.ts:217-233`；`accounting-subject-catalog.ts:376-410` |
| 2b 应付确认的**例外**：对方科目是「库存现金（备用金）」族（资金搬运） | **不生成挂账凭证**（只记审计 `voucher.accrual_skipped`） | — | — | 同上；判定在 `createAccrual` 内部，三条入口自动同口径 | 无凭证 | `voucher.service.ts:277-297`；`voucher.domain.ts:84-86` |
| 3 应付付款（销账） | **全部被核销应付都已挂账 → 应付账款**；否则 → 弹窗/付款单人工科目 > 条目科目 > 按来源类型候选链 | 银行存款（带具体账户：科目名快照「银行存款—结算账户」，`bank_id` 落库） | **付款单全额** `payment.amount`（核销合计只校验 ≤ 付款额） | 付款过账时写收支流水 → 财务在凭证页**逐条点生成** | draft | `supplier-payment.service.ts:135-177`（121 的 ≤ 校验、155 的借方优先级、156-177 写流水）；`cash-flow.service.ts:377-415`；`voucher.service.ts:172-193`、`568-589`；`voucher.domain.ts:145-157`、`113-128` |
| 4 客户收款（销账） | 银行存款（带具体账户） | **全部被核销应收都已挂账 → 应收账款**；否则 → 收入科目（主营业务收入）；**但人工选定科目会覆盖「应收账款」**（见 VC-D-03） | **收款单全额** `payment.amount`（核销合计 ≤ 收款额） | 收款过账写流水 → 逐条生成凭证 | draft | `customer-payment.service.ts:117-161`（128-132 判定、148 覆盖）；`cash-flow.service.ts:377-415`；`voucher.domain.ts:145-157` |
| 5 工资付款 | 工资科目：**工资支付 → 临时工资 → 基本生产成本**，或人工选定科目 | 银行存款 | **工资付款单全额** `salary_payment.amount` | 工资付款过账写流水 → 逐条生成凭证 | draft | `apps/api/src/modules/hr/salary-payment.service.ts:305-309`（`paymentSubjectNames("salary_payment")`、`subjectId: effectiveSubjectId`）；`accounting-subject-catalog.ts:387` |
| 6 其他应付付款（常规：房租/水电/运费等） | 分两步：确认时 **借 条目科目（如房租费）/ 贷 应付账款**；付款时 **借 应付账款 / 贷 银行存款** | 见左 | 每步全额（确认额 / 付款额） | 同行 2 + 行 3 | 两张 draft | `supplier-payable.service.ts:530-551`（条目科目）、`267-284`；`supplier-payment.service.ts:147-168` |
| 7 其他应付付款（资金搬运：条目科目=「库存现金（备用金）」） | **借 库存现金（备用金）**（取条目自己的科目） | 银行存款 | 付款单全额 | 确认不挂账（行 2b）→ 付款写流水（借方=条目科目）→ 逐条生成凭证 | draft | `voucher.service.ts:292-297`；`supplier-payment.service.ts:150-168`；`voucher.domain.ts:113-128`（现金族业务科目 → 资金侧只判银行存款） |
| 8 银行转账 / 账户间划转（现金调拨） | （**无凭证**；会计上应为 借 银行存款-转入户） | （**无凭证**；应为 贷 银行存款-转出户） | 转账金额 | 只在 `BankService.balances()` 里转账出方 −、转入方 +，**不写收支流水、不生成凭证** | 无凭证 | `bank-transfer.service.ts:12-16`（该文件全文没有 voucher / cashFlow 引用） |
| 9 手工凭证（折旧/摊销/工资计提/结转成本） | 由提交的 `direction` 决定，行数不限（可多借多贷） | 同左 | 每行 > 0，且借方合计 = 贷方合计 | `POST /finance/vouchers`（createManual） | draft | `voucher.controller.ts:166-169`；`voucher.service.ts:210-229`、`391-420`（校验 396-404）、`1008-1035` |
| 10 手工收支流水 → 凭证 | 支出：**借 流水 `subject_id`（业务科目）**；收入：**借 资金科目** | 支出：贷 资金科目；收入：贷 流水 `subject_id` | 流水**全额** `cash_flow_entry.amount` | `POST /finance/vouchers/from-cash-flow/:entryId`（人工逐条） | draft | `voucher.domain.ts:145-157`；`voucher.service.ts:172-193`、`568-589`（科目取 `entry.subject` 579-580） |
| 11 红冲 | 原凭证的**贷方行** | 原凭证的**借方行** | 每行金额不变（借贷对调） | `POST /:id/reverse`（只允许 posted，原因必填） | 红字凭证 **posted**；原凭证 **reversed** | `voucher.service.ts:674-698`（对调 682-684、红字 687-692、原凭证 693）；`voucher.domain.ts:168-180` |

矩阵里**方向/金额口径有问题**的行（详见 §6）：

1. **行 3、行 4、行 5 的金额口径错**：取的是「收付款单全额」，不是「本次核销额」，而核销合计允许小于单据金额（`supplier-payment.service.ts:121`、`customer-payment.service.ts:117`）→ 往来科目被多冲/少记（VC-D-02）。
2. **行 4 的贷方科目会错**：已挂账时本应固定「应收账款」，但 `subjectId` 显式传入时被覆盖（`customer-payment.service.ts:148` + `cash-flow.service.ts:383-391`）→ 贷方记成收入，收入重复、应收不销（VC-D-03）。
3. **行 2/1 的状态错**：生成的是草稿，但行 3/4 的「已挂账」判定把草稿也算作已挂账（`voucher.service.ts:359`）→ 现金侧按「已挂账」记，挂账侧从未进报表（VC-D-01）。
4. **行 8 缺整行**：银行互转没有凭证，`银行存款` 科目账 ≠ `banks` 余额（VC-D-08）。
5. **行 5 缺「应付职工薪酬」**：工资付款直接借成本类「工资支付」，系统没有任何自动「计提工资」凭证，若财务又手工计提，则 `应付职工薪酬` 永挂、成本重复（VC-D-16）。
6. **行 2 的借方科目对原料入库可能错**：候选链首位是 `主营业务成本` 而不是 `原材料`（`accounting-subject-catalog.ts:389`），属会计口径问题（§7）。

## 3 科目解析规则（含资金科目识别）

### 3.1 挂账凭证：往来科目按**名字**、对方科目可**按 id**

- 「应收账款/应付账款」这一侧是**硬编码名称**：`ACCRUAL_SUBJECT_NAMES`（`voucher.service.ts:27-30`），经 `subjectByName` 解析（`voucher.service.ts:271`、`366-375`）。
- 对方科目：`contra_subject_id` 给了就**按 id** 校验（存在 + 未删 + `isActive`，取不到直接 422，`voucher.service.ts:272-274`、`378-382`）；没给就按**名称候选链**取第一个存在的（`voucher.service.ts:274`、`366-375`）。
- `subjectByName` 的三个风险（`voucher.service.ts:366-375`）：
  1. 只按 `name in (...)` 查，**不过滤 category**，也**没有 `orderBy`**；`accounting_subjects` 的唯一键是 `(category, name)`（`schema.prisma:2340`），同一个名字可以合法地存在于两个分类下 —— 此时 `candidates.find(...)` 取到的是**数据库返回顺序的第一条**（`voucher.service.ts:372`），同一份数据在不同数据库/不同查询计划下可能挂到不同分类的同名科目上（借贷方向、报表行都跟着变）。
  2. 只查 `isActive: true`（`voucher.service.ts:369`）：**「应收账款/应付账款」被停用后，所有确认操作 422**，而确认状态已在另一个事务里提交（见 VC-D-14），业务单会停在「已确认、无凭证」。
  3. 与 `CashFlowService.firstCandidateSubject` 的口径**不一致**：那边按 `sortOrder` 排序后再挑（`cash-flow.service.ts:540-548`），这边不排序。同名科目在两个入口可能选到不同行。
- 模板解析是「名称候选、优先启用中的科目」（`voucher-template.ts:158-164`），全部落空时 `subject_id: null` + 把**建议名**写进 `subject_key`（`voucher-template.ts:167-178`）。

### 3.2 由流水生成凭证：取 `subject_id`，**不取** `category_subject_id`

- `draftForEntry` 传给 `voucherLinesFor` 的是 `entry.subject`（即 `cash_flow_entries.subject_id`），`category_subject_id` 完全不参与凭证（`voucher.service.ts:568-589`，具体 579-580；`voucher.domain.ts:145-157`）。
- 两者的**设计分工**写在流水服务里：`subject_id` = **销账那条现金分录的对方科目**（已挂账付款 = 应付账款、收款 = 应收账款）；`category_subject_id` = **这笔钱算什么**（业务科目，只给报表/页面看，不参与记账）（`cash-flow.service.ts:83-93`、`348-366`；`schema.prisma:2232-2244`）。
- 结果是：**流水页面与凭证工作台显示的「会计科目」是类目（业务科目），凭证分录上写的是主科目（往来科目）**。Web 端把这一点写死在注释里：「这张表显示的是财务认的会计科目（`categorySubject ?? subject`）……`subject`（现金分录的对方科目）只在悬停里提示，生成凭证仍用它」（`apps/web/components/finance/voucher-workspace.tsx:40-45`）。现金流量表也是**按类目落行**、没有类目才退回凭证科目（`finance-three-statements.ts:670-684`），于是同一笔钱：资产负债表/利润表用 A 科目、现金流量表用 B 科目、页面显示的又是 B（VC-D-15）。

### 3.3 资金类科目（银行存款/库存现金）如何识别与替换

| 规则 | 实现 | file:line |
| --- | --- | --- |
| 「现金」判定 | 文本里含「现金」→ 库存现金，否则银行存款 | `voucher.domain.ts:70-72` |
| 现金族（备用金） | 名称以 `库存现金` 开头（`库存现金（备用金）` 等） | `voucher.domain.ts:84-86` |
| 银行族 | 名称以 `银行存款` 开头（`银行存款 中国银行（美元）` 等） | `voucher.domain.ts:89-91`（**该函数全仓无调用点**，`isCashFamilySubject` 才被用：`voucher.service.ts:292`、`503`、`723`） |
| 资金行科目 + 账户（判定顺序） | ⓪ 业务科目本身是现金族 → 资金侧**只能是银行存款**；① 流水有 `bank_id` → 银行存款 + 该账户；② 否则按结算方式/结算账户名含「现金」猜 | `voucher.domain.ts:96-128`（判定顺序 96-111、第 0 条实现 123-124、结算账户优先 107-121） |
| 科目名快照 | 科目名恒为「银行存款」，账户名进 `subject_label`：`银行存款—{结算账户名}`；没有结算账户退回银行池「银行名+账号」；都没有只写「银行存款」 | `voucher.domain.ts:113-127` |
| 账户引用 | 资金行 `bank_id` 指向 `banks`；落库前校验存在性，否则 422 | `schema.prisma:2494-2498`；`voucher.service.ts:399`、`1043-1050` |

**资金科目没有被「替换」出业务侧**：`fundLineFor` 只处理「业务科目本身就是现金族」这一种（`voucher.domain.ts:124`）；如果业务科目是**银行族**（例如手工流水把会计科目选成「银行存款 中国银行（美元）」，做账户间调拨），收入方向会生成「借 资金行 / 贷 银行存款 中国银行（美元）」，两行都是银行存款族；若 `bank_id` 也为空，则两行 `subject_key` 完全相同 → **同一科目自借自贷**（`voucher.domain.ts:125-127`、`145-157`）。系统没有任何「借方不得等于贷方」的校验（`voucher.service.ts:396-404` 只查平衡；`voucher.domain.ts:189-199` 只比较合计）。

**「资金行科目名」的回填**（`fundLabel`）：2026-11-05 起资金行科目名改成「结算账户优先（`银行存款—农业银行5706`）」（`voucher.domain.ts:107-121`），但**已经生成出来的草稿凭证不会自动变**，所以要靠 `fund-label-refresh` 预览/执行两个接口按来源流水重算**草稿**凭证资金行的科目名（`voucher.service.ts:884-891`、`893-915`、`918-953`；路由 `voucher.controller.ts:131-139`）。它只动 `subject_key`/`subject_label`，金额、业务分录、财务手改过的行都不动（`voucher.service.ts:889-891`）；已过账凭证不在范围内 —— 这正确，但也意味着 2026-11-05 之前的已过账凭证资金行仍是旧账户名，且不会有人提示。

### 3.4 手工凭证/编辑器：科目只校验「非空字符串」

`normalizeLines` 只检查 `subject_label ?? subject_key` 非空，`subject_label` 直接落库（`voucher.service.ts:1008-1035`，具体 1012-1013、1024-1025），**不查 `accounting_subjects`**。所以手工凭证、模板落空后的 fallback 名、以及财务在编辑器里改出来的任意科目名都能保存并过账；报表侧只能把这些科目丢进「未归位」（`finance-three-statements.ts:500-507`、`555-596`）→ 报表行少一笔而借贷仍然平（VC-D-10）。

## 4 生命周期与回退

### 4.1 状态机

```
createManual / createAccrual / createFromCashFlowEntry
        │  (全部落 draft)
        ▼
      draft ──update(整组分录/摘要)──► draft
        │  ├─templates(套模板，只读返回) 
        │  ├─regenerate(按来源整张重算，覆盖手工改动)
        │  ├─delete(软删，仍占唯一键)
        │  └─post ──► posted ──reverse(原因必填)──► reversed(终态)
        │                        └─ 同事务新建一张红字凭证(posted, source_type=voucher)
        └────────────────────────────────────────────────────────────
```

| 动作 | 允许的状态 | 副作用 | file:line |
| --- | --- | --- | --- |
| `update` | 仅 draft | 整组分录重写（`deleteMany`+`createMany`），重算借贷合计；**不校验来源、不回写来源单据** | `voucher.service.ts:602-635`（605、606-612、618-627） |
| `post` | 仅 draft | 只改 status=posted 并记录审计；**再次校验借贷平衡，但不校验来源流水/来源单是否已冲销或改动** | `voucher.service.ts:638-651` |
| `remove` | 仅 draft | 软删除（`deletedAt`），行仍在库、唯一键仍占用；重建时走复活 | `voucher.service.ts:654-666`、`966-993` |
| `reverse` | 仅 posted | ① 新建红字凭证：借贷对调、`source_type=voucher`、`status=posted`、**`voucherDate=now` 但 `period=原凭证期间`**；② 原凭证置 `reversed`；③ 不触碰来源流水/收付款单/应付应收状态 | `voucher.service.ts:674-698`（682-684、687-692、693） |
| `regenerate` | 仅 draft 且来源= `cash_flow_entry` 或 `supplier_payable` | 按来源**现在**的内容整张重算（摘要/分录/账户/金额/期间），行号重排；**会覆盖手工改动**；`voucherNo` 不变 | `voucher.service.ts:436-473`（439、443-444、447-449、455-465） |
| `regenerateAccrual` | 仅 draft 且来源=`supplier_payable` | 按应付单现在的科目/金额重建，与首次生成共用 `accrualDraft`；若来源科目已是资金科目则 422 并提示删草稿 | `voucher.service.ts:485-523`（499-505） |
| `templates` / `templates()` | 任意状态（只读） | 从科目表解析候选，资金行借用本凭证现有资金行的科目与账户 | `voucher.service.ts:534-563`；`voucher-template.ts:89-129`、`167-178` |
| `fund-label-refresh` | 仅 draft、来源=流水 | **只改**草稿资金行的 `subject_key`/`subject_label`（2026-11-05 结算账户优先口径的回填），金额与业务行不动 | `voucher.service.ts:893-953`；`voucher.controller.ts:131-139` |

### 4.2 `regenerate` 的适用范围与边界（重要）

- 只对**草稿**开放（`voucher.service.ts:439`）；已过账只能红冲。
- 来源只认两种：`cash_flow_entry` 与 `supplier_payable`（`voucher.service.ts:443`）；其余（红冲凭证、手工凭证）直接 422。**应收挂账（`receivable_source`）不支持重新生成** —— 代码注释承认「应收挂账的对方科目是候选链推的，重算会把它换掉（应收侧等有了科目快照再开）」（`voucher.service.ts:440-442`）。但错误文案是「红冲凭证不能重新生成」（`voucher.service.ts:444`），财务看到的原因与真实原因不符。
- 来源流水已冲销时拒绝（`voucher.service.ts:449`）。
- 重算会**覆盖手工改动**，且不改 `voucherNo`、不改状态（仍是 draft）；审计里记改前/改后科目（`voucher.service.ts:466-471`）。

### 4.3 `repairCashTransferVouchers`：它在修什么历史问题（历史上「借贷方向」到底错在哪）

**历史错误链路（真实语义是「科目错位」，不是「借/贷写反」）**：

- 财务给「其他应付」的会计科目填的是**资金科目本身**，例如「资产类 / 库存现金（备用金）」。这条业务实际是**资金搬运**（从银行取现进备用金），不是「欠谁的钱」。
- 旧口径把它当负债走两步（`voucher.service.ts:702-718` 的注释完整记录了这两张凭证）：
  1. 确认（挂账）：**借 库存现金（备用金） / 贷 应付账款**；
  2. 付款（销账）：**借 应付账款 / 贷 银行存款**。
- 于是用户点开凭证纸看到的那张付款凭证上，「会计科目」写着**应付账款**，而她要的是**库存现金（备用金）**（用户 2026-10-16 报障，`voucher.service.ts:278-290`、`702-718`；Web 端同一段背景见 `apps/web/components/finance/voucher-workspace.tsx:63-71`）。
- 严格说：两张凭证各自借贷平衡、金额也对；错的是**往来科目被塞进了资金搬运的两侧**（挂账凭证多出一笔本不存在的应付账款，付款凭证的借方被应付账款顶替）。这就是「借贷方向错过」的准确表述 —— 方向符号没错，**两侧的科目与业务语义错位**。

**当前口径（2026-10-16 之后）**：确认时不挂账（`voucher.service.ts:292-297`），付款时借方取条目自己的科目（`supplier-payment.service.ts:150-168`），资金侧按 `fundLineFor` 判银行存款（`voucher.domain.ts:113-128`）。

**修复动作（`repairCashTransferVouchers`，`voucher.service.ts:831-882`）**：

1. 找出所有「其他应付的 `subject_id` 是现金族科目」的应付（资产类 + `isCashFamilySubject`，`voucher.service.ts:720-728`），再经**生效核销 → 已过账付款单 → 已过账流水 → 该流水的凭证**追到旧凭证（`voucher.service.ts:739-755`）。
2. 挂账凭证：草稿**软删**；已过账**先红冲、再把红字凭证软删**（`voucher.service.ts:835-844`、`811-823`）—— 一对在账上必须净为 0。
3. 付款流水：把 `subject_id` 改成条目自己的科目（并把**分类一起换掉**，否则会出现「负债类/库存现金（备用金）」这种不存在的科目）（`voucher.service.ts:849-853`）。
4. 付款凭证：草稿→按新口径重建分录；已过账→先红冲（旧内容留痕）→再连同红字一起撤掉→**把这张凭证打回 draft**（`voucher.service.ts:855-873`，状态回草稿见 868-871）。
5. 一条流水核销了多条应付、且混着非资金搬运时**整体跳过并点名**（`voucher.service.ts:767-770`），不硬改。
6. 历史处理范围只有「现金族」：**银行族（`银行存款 中国银行（美元）` 这类账户间调拨）不在修复清单里**，因为判定只用了 `isCashFamilySubject`（`voucher.service.ts:723`；`isBankFamilySubject` 定义了却无人调用，`voucher.domain.ts:89-91`）。

**这个修复自身的副作用**：它把**已过账的红字凭证软删除**、并把**已过账凭证打回草稿**（`voucher.service.ts:817`、`868-871`），在财务重新过账之前，报表里这笔付款是**缺失**的；且「已过账凭证不可消失」这条纪律在这条路径上被打破（VC-D-13）。

### 4.4 `accruedSourceIds` 的语义与漏洞（问题 6）

```ts
// voucher.service.ts:355-363
where: { sourceType, sourceId: { in: ids }, deletedAt: null, status: { not: "reversed" } }
```

- **语义**：只要某条应收/应付**存在一张未被红冲的挂账凭证**（不区分 draft/posted），就认为它「已挂账」。
- **漏洞**：`status: { not: "reversed" }` **包含 `draft`**。而挂账凭证生成时是草稿（`voucher.service.ts:411`），三大报表只认 `posted`（`finance-three-statements.service.ts:202-203`）。
- **后果**：确认应收/应付后、财务尚未过账时就去登记收款/付款 → 销账凭证按「已挂账」记成「贷 应收账款 / 借 应付账款」，但挂账凭证从未进报表。报表里于是出现：**现金已记、往来反向余额**（应收账款为负/应付账款在借方），收入或成本完全缺失；借贷仍然平，靠试算平衡发现不了（历史审计用内存桩复现过同一条路径，`docs/audit/finance-voucher-ar-ap-audit-2026-10-28.md:26`）。
- 追加漏洞：`delete` 一张草稿挂账凭证、或 `repairCashTransferVouchers` 删掉它，会**翻转**同一笔付款的贷/借方科目（应付款从「应付账款」变回成本科目）——记账口径取决于一张草稿是否存在（`voucher.service.ts:355-362` 与 `supplier-payment.service.ts:135-140`）。

## 5 业务规则清单

强度：**强制** = 代码/DB 会拦；**部分** = 只在某条路径拦；**缺失** = 没有任何检查。

| 编号 | 规则 | 强度 | file:line |
| --- | --- | --- | --- |
| VC-R-01 | 同一 `(source_type, source_id)` 只能有一张凭证（软删行也占键，重建走复活） | 强制（DB 唯一索引） | `schema.prisma:2408`；`voucher.service.ts:956-993` |
| VC-R-02 | 生成幂等：来源已有凭证则返回原凭证（`replayed=true`），不新建 | 强制 | `voucher.service.ts:176-177`、`265-266` |
| VC-R-03 | 已冲销的收支流水不能生成/重算凭证 | 强制 | `voucher.service.ts:175`、`449` |
| VC-R-04 | 凭证至少两条分录、借方合计=贷方合计、借方合计>0 | 强制（生成/编辑/过账三处） | `voucher.service.ts:396-404`、`606-612`、`640-642` |
| VC-R-05 | 每行方向只能是 debit/credit，金额必须 > 0 | 强制 | `voucher.service.ts:1011-1020` |
| VC-R-06 | 只有草稿可编辑/删除/重新生成/过账 | 强制 | `voucher.service.ts:605`、`640`、`657`、`439` |
| VC-R-07 | 只有已过账可红冲，红冲原因必填，红字凭证同事务直接过账 | 强制 | `voucher.service.ts:675`、`677`、`687-692` |
| VC-R-08 | 挂账金额 ≤ 0 不挂账（返回 null，不报错） | 强制 | `voucher.service.ts:261-263` |
| VC-R-09 | 挂账只支持 `receivable_source` / `supplier_payable` 两种来源 | 强制 | `voucher.service.ts:259-260` |
| VC-R-10 | 「应收账款/应付账款」按名称解析，必须存在且启用 | 强制 | `voucher.service.ts:271`、`366-375` |
| VC-R-11 | 人工指定对方科目按 id 校验（存在/未删/启用），取不到 422 | 强制 | `voucher.service.ts:272-274`、`378-382` |
| VC-R-12 | 对方科目是「库存现金」族（资金搬运）时，应付不挂账 | 强制（仅应付侧） | `voucher.service.ts:292-297` |
| VC-R-13 | 资金行引用的银行账户必须存在 | 强制 | `voucher.service.ts:399`、`1043-1050` |
| VC-R-14 | 一条来源一张凭证；同一条应付/应收不会被挂两遍账（幂等） | 强制（依赖 R-01） | `voucher.service.ts:242-243`、`265-266` |
| VC-R-15 | 分录科目必须来自科目表 | **缺失**（只校验非空字符串） | `voucher.service.ts:1012-1013`、`1024-1025` |
| VC-R-16 | 过账时校验来源流水/来源单仍然有效、未被冲销 | **缺失** | `voucher.service.ts:638-651`（无来源查询） |
| VC-R-17 | 冲销收付款/流水时，回冲由该流水生成的已过账凭证 | **缺失** | `cash-flow.service.ts:603-617`、`629-639` |
| VC-R-18 | 收付款单据金额必须等于本次核销合计 | **缺失**（只校验核销合计 ≤ 单据金额） | `supplier-payment.service.ts:121`；`customer-payment.service.ts:117` |
| VC-R-19 | 「已挂账」只认已过账凭证 | **缺失**（把 draft 也算） | `voucher.service.ts:355-362` |
| VC-R-20 | 已红冲的凭证不得令「同来源已有凭证」短路（否则无法补开正确凭证） | **缺失** | `voucher.service.ts:176`、`265`（只按 `deletedAt` 过滤，不按 status） |
| VC-R-21 | 借方科目与贷方科目不得为同一科目 / 不得使用资金科目做业务科目 | **缺失**（只比较合计） | `voucher.service.ts:396-404`；`voucher.domain.ts:189-199` |
| VC-R-22 | 自动生成的挂账凭证被手工改后，要把改动回写来源单据或禁止改动 | **缺失** | `voucher.service.ts:602-635`（无来源校验） |
| VC-R-23 | 银行账户互转必须生成凭证（资金科目之间的一借一贷） | **缺失** | `bank-transfer.service.ts:12-16` |
| VC-R-24 | 挂账与「确认」必须同事务（失败则一起回滚） | **缺失**（先提交状态，后建凭证） | `supplier-payable.service.ts:235-248`；`receivable.service.ts:174-186`；`reconciliation.service.ts:166-197` |

## 6 流程性缺陷

| 编号 | 现象 | 根因 | 影响 | 建议 | 证据 |
| --- | --- | --- | --- | --- | --- |
| VC-D-01 | 挂账凭证只是草稿，但收付款按「已挂账」记销账；报表只认已过账 | `accruedSourceIds` 用 `status != reversed` 判已挂账，含 draft；报表只取 `posted` | 确认后未过账就收付款 → 报表出现负应收/应付借方余额、收入或成本缺失；借贷仍平，试算平衡发现不了 | 「已挂账」只认 `posted`；或销账时同时过账挂账凭证（同事务）；报表增加「已确认未过账」差额勾对 | `voucher.service.ts:355-362`、`411`；`supplier-payment.service.ts:135-140`；`customer-payment.service.ts:128-132`；`finance-three-statements.service.ts:202-203` |
| VC-D-02 | 收付款凭证金额=单据全额，核销可能只覆盖一部分 | 核销只校验 `合计 ≤ 单据金额`，写流水/生成凭证用 `payment.amount` | 部分核销/预付预收场景：往来科目被多冲（付款 100 核销 60 → 借应付账款 100），差额没有科目承接；应收出现贷方余额 | 凭证金额取**核销合计**；差额按口径记「预付账款/预收账款/其他应付款」单独一行，禁止无科目挂账 | `supplier-payment.service.ts:121`、`156-157`；`customer-payment.service.ts:117`、`134-135`；`voucher.service.ts:180`、`575` |
| VC-D-03 | 客户收款在「已挂账」时贷方仍可能记成收入（不是应收账款） | `subjectId` 显式传入会越过「已挂账 → 应收账款」的候选链（供应商付款侧相反：`allAccrued` 时 `mainSubjectId=null`） | 收入重复确认（挂账已记收入）+ 应收账款永不销账；两套口径同一业务两种结果 | 已挂账时强制「应收账款」，人工科目只写进 `category_subject_id`（与供应商付款对称） | `customer-payment.service.ts:130-132`、`148`；`cash-flow.service.ts:383-391`；对照 `supplier-payment.service.ts:137-140`、`155` |
| VC-D-04 | 红冲后报表出现**反向余额**，而不是净 0 | 红冲把原凭证置 `reversed`（不进报表），红字凭证自己 `posted`（进报表）→ 报表只剩反向分录；服务注释却写「已红冲的原凭证由红冲件抵消」 | 原来借银行 100 的凭证红冲后，货币资金 = **-100**；所有红冲过的科目都留反向数 | 二选一：①原凭证保持 `posted`、红字凭证抵消（净 0）；②红冲时把原凭证与红字都排除/都计入。并修 `period`/`voucherDate` 一致性 | `voucher.service.ts:687-693`；`finance-three-statements.service.ts:29-30`、`202-203`；`finance-three-statements.ts:631` |
| VC-D-05 | 收付款/流水冲销后，由流水生成的已过账凭证仍在账上 | 冲销只改 `cash_flow_entries.status`；生成时只拒绝「已冲销流水」，从不回冲已有凭证 | 付款撤回后，凭证仍「借成本/贷银行」→ 成本与银行同时虚增；报表与流水不一致 | 在冲销事务里查找 `source_type=cash_flow_entry, source_id=流水` 的凭证并红冲；或禁止已生成凭证的流水被直接冲销 | `cash-flow.service.ts:603-617`、`629-639`；`supplier-payment.service.ts:217-219`；`voucher.service.ts:172-177` |
| VC-D-06 | 凭证红冲后**无法补开**正确凭证：点「生成凭证」返回的是那张已红冲的 | 幂等查询只按 `deletedAt null` 过滤（不按 status），红冲凭证 `reversed` 仍占唯一键；`createOrReviveVoucher` 也只 `findFirst` 复活 | 一旦红冲，这条流水/应付就再也生不出新凭证；财务报表永远缺这笔（唯一出路是手工凭证） | 幂等查询加 `status != reversed`；红冲时把旧凭证视作「已作废」，允许同来源新建一张；在 UI 上明确「红冲后请重新生成」 | `voucher.service.ts:176-177`、`265-266`、`966-993`；`schema.prisma:2408` |
| VC-D-07 | 收付款凭证要人工逐条点「生成」，无批量、无强制、无遗漏提示（只有页脚条数） | 只有 `POST /from-cash-flow/:entryId` 一个逐条路由；没有批量入口，也没有「收付款过账自动生成凭证」 | 漏生成的流水 = 报表缺一笔现金业务；财务侧「生成凭证」变成一项容易遗忘的手工工序 | 付款/收款/工资过账时自动生成草稿凭证（或提供「本期间全部生成」批量）；报表把「有流水无凭证」按金额列缺口 | `voucher.controller.ts:172-175`；`apps/web/components/finance/voucher-workspace.tsx:212`、`420`、`472`、`537`；`finance-three-statements.service.ts:56-62` |
| VC-D-08 | 银行账户互转/现金调拨**没有凭证**（也没有流水），银行余额与凭证账两套 | 设计上只让互转进 `BankService.balances()` | 银行存款明细账与银行对账单对不上；两个账户的现金搬家在账上看不见（现金流量表按设计可以不算，但资产负债表/明细账必须记） | 互转生成一张「借 银行存款-转入户 / 贷 银行存款-转出户」的凭证（资金来源记 `bank_transfer`），或明确把银行余额表作为独立台账并在报表口径里声明 | `bank-transfer.service.ts:12-16`；`finance-three-statements.ts:664-668`（内转只在有凭证时才识别） |
| VC-D-09 | 科目按名字解析：同名科目取数据库返回的第一条；停用即整条业务 422；与流水侧排序口径不一致 | `subjectByName` 不过滤 category、无 `orderBy`；唯一键是 `(category,name)`，同名可跨分类存在 | 财务在不同分类下建了同名科目后，挂账可能挂到另一分类的同名科目（借贷方向/报表行都变）；「应收账款」停用会让所有确认失败 | 科目解析只用 id（确认弹窗选 id）；必须按名字时同时带 category 并 `orderBy sortOrder`；停用科目给出明确可操作提示 | `voucher.service.ts:366-375`；`schema.prisma:2330-2340`；`cash-flow.service.ts:540-548`（对照：那边有 sortOrder） |
| VC-D-10 | 手工凭证/编辑器可保存**科目表里不存在**的科目名，借贷仍平 | `normalizeLines` 只校验非空字符串；模板候选落空也把建议名写库 | 报表「未归位」丢行，账实不符却查不出（借贷平、金额对）；历史凭证的科目可能是手误名 | 保存时按科目表校验（可选 id 或 name+category）；对已存在的坏科目名给出「一键映射」修复入口 | `voucher.service.ts:1008-1035`、`1012-1013`；`voucher-template.ts:167-178`；`finance-three-statements.ts:500-507` |
| VC-D-11 | 自动挂账凭证可被任意手改，且**不回写来源单据**；改乱了只有「重新生成」能拉回，而应收挂账不支持重新生成 | `update` 不校验来源、无告警；`regenerate` 只覆盖流水与**应付**挂账 | 用户 2026-11-04 报障的正是这条（挂账凭证被改成「借 管理费用服务费 / 贷 银行存款」）；应付科目与凭证永久不一致，应收侧无系统入口修复 | 挂账凭证的分录编辑按来源角色限制（往来科目行不可改）；`regenerate` 支持应收挂账；编辑时提示与来源单据的差异 | `voucher.service.ts:602-635`、`440-446`、`485-523`；`docs/audit/finance-subject-chain-diagnosis-2026-11-04.md:1-20` |
| VC-D-12 | 混合「已挂账/未挂账」核销时整体按未挂账处理 | 判定是 `every(accrued.has)`，只要一条没挂就整体退回老口径 | 已挂账的那条应付账款永不冲销，同时成本/费用被重复记一次 | 逐条按各自挂账状态生成分录（一条凭证可多借多贷，见 VC-R-04） | `supplier-payment.service.ts:135-140`；`customer-payment.service.ts:128-132` |
| VC-D-13 | 「资金搬运纠正」会软删**已过账的红字凭证**、把已过账付款凭证**打回草稿** | 纠正逻辑用「删草稿 / 红冲再删红字 / 重开成草稿」实现 | 重新过账前报表缺这笔付款；「已过账凭证不可消失」被打破；若财务忘记重新过账则永久缺失 | 纠正应走「红冲旧凭证 + 新建一张新凭证」的标准件，不删除任何已过账凭证、不把已过账打回草稿；或一次性生成「更正凭证」 | `voucher.service.ts:811-823`、`835-844`、`855-873` |
| VC-D-14 | 业务单「已确认」与挂账凭证创建**跨事务**：科目缺失/DB 失败时单据已确认、凭证没有，且不能再确认 | 确认事务先提交 `confirmed`，随后才调用 `createAccrual`（不在同一事务） | 已确认应付/应收永远缺挂账凭证；重试被「只有草稿可确认」挡住，只能改库或走手工凭证 | 确认与挂账同事务（或挂在 outbox 上可重试）；提供「补挂账」入口；确认前先校验往来科目存在 | `supplier-payable.service.ts:235-248`、`308-336`；`receivable.service.ts:174-186`；`reconciliation.service.ts:166-197` |
| VC-D-15 | 同一笔业务有 3 个「会计科目」：凭证分录科目、流水主科目、收支类目；页面显示类目、凭证用主科目、现金流量表用类目 | 两列科目（`subject_id`/`category_subject_id`）分工是刻意的，但没有「一致性」约束，也没有双向提示 | 用户选的是「销售费 推广费」，凭证上却是「应付账款」（挂账口径正确时的必然结果），于是判断「会计科目、借贷记录不对」；三表勾稽口径分叉 | 凭证纸同时打印「业务科目（类目）」，或在凭证页明确「销账对方科目 / 业务科目」两栏；现金流量表与其他两表统一口径 | `cash-flow.service.ts:83-93`、`348-366`；`voucher.service.ts:579-580`；`apps/web/components/finance/voucher-workspace.tsx:40-45`；`finance-three-statements.ts:670-684` |
| VC-D-16 | 工资付款直接借「工资支付」（成本类），系统没有自动「计提 应付职工薪酬」，付款也不冲「应付职工薪酬」 | 工资付款的科目=候选链「工资支付/临时工资/基本生产成本」；hr 侧没有 `createAccrual` 调用 | 若财务按会计口径手工计提了「应付职工薪酬」，付款时不会冲它 → 应付职工薪酬永挂 + 成本重复；若不计提则费用与负债都缺 | 工资应付确认时自动挂账（借 成本/费用、贷 应付职工薪酬），付款销账（借 应付职工薪酬、贷 银行存款）；或在口径上明确「不做计提」并把候选链改成语义正确的科目 | `apps/api/src/modules/hr/salary-payment.service.ts:305-309`；`accounting-subject-catalog.ts:387`；全仓 hr 目录无 `createAccrual` 调用（grep 结果仅 finance 模块 5 处） |
| VC-D-17 | 业务科目是「银行存款」族时，凭证出现同科目自借自贷（且资金侧不替换） | `fundLineFor` 只对现金族做「资金侧只能是银行存款」；银行族没有对应分支；无「借≠贷」校验 | 手工流水把会计科目选成「银行存款 中国银行（美元）」做账户调拨时，凭证两行都是银行存款科目，账户信息可能只有一侧 | 业务科目属于任一资金族时，另一侧必须换成具体账户或另一科目；禁止一张凭证借贷同一科目 | `voucher.domain.ts:84-91`、`124-127`、`145-157`；`voucher.service.ts:396-404` |

## 7 会计口径待确认

以下 7 项决定「正确科目是什么」，代码不能替财务定；当前实现只是「按候选链猜第一个」（`accounting-subject-catalog.ts:364-374` 的注释自认「万一将来出现重名，按 sortOrder 取第一个」）：

1. **原料入库挂账借方是「原材料」还是「主营业务成本」**：候选链首位是 `主营业务成本`（`accounting-subject-catalog.ts:389`），注释也写「原料入库 → 原材料 成本」。若采用「入库存货、领用/销售时结转成本」，则资产负债表存货与利润表成本会同时错列（历史审计 P1）。
2. **工资是否需要两步**：是否要求「计提（借 成本/费用、贷 应付职工薪酬）→ 实发（借 应付职工薪酬、贷 银行存款）」。当前自动路径只有实发，且借方直接进成本类「工资支付」（`salary-payment.service.ts:305-309`、`accounting-subject-catalog.ts:387`）。
3. **部分核销/超额收付款的差额入什么科目**：预收账款/预付账款/其他应付款，还是要求「单据金额必须=核销金额」？（当前 `合计 ≤ 单据金额` 放行，`supplier-payment.service.ts:121`、`customer-payment.service.ts:117`）
4. **红冲的报表口径**：原凭证排除+红字计入（当前实现，净额为 -X），还是原凭证保留+红字抵消（净 0）？这决定所有历史红冲金额在报表里的方向（`voucher.service.ts:687-693`、`finance-three-statements.service.ts:202-203`）。
5. **「资金搬运」的范围**：只有「库存现金（备用金）」族不挂账，还是「银行存款」族（账户间调拨）也应同样处理？后者目前仍会造出应付账款过桥分录，且修复清单不覆盖（`voucher.service.ts:292`、`723`；`voucher.domain.ts:89-91` 定义了银行族却没用）。
6. **同名科目（不同分类）是否允许、挂账取哪一条**：唯一键只到 `(category, name)`（`schema.prisma:2340`），而 `subjectByName` 不排序（`voucher.service.ts:372`）。
7. **现金流量表用「收支类目」、资产负债表/利润表用「凭证分录科目」** 是否就是财务要的口径？如果不是，需要把两套科目合并成一套（`finance-three-statements.ts:670-684` 对照 `voucher.service.ts:579-580`）。

另外两个结论必须先确认再动代码：**手工凭证是否强制从科目表选科目**（当前可任意文本，VC-D-10）、**已过账凭证是否允许被「纠正工具」软删/打回草稿**（当前 `repairCashTransferVouchers` 会，VC-D-13）。

## 8 结论

1. 凭证链的**借贷方向本身没有写反**：矩阵 11 行里，凡是实际生成凭证的路径（行 1-7、9-11），借/贷符号与金额都算得对；问题集中在**状态、金额口径与科目选择**三处（行 8 是整行缺失：互转没有凭证）。
2. 最严重的三条：挂账只落草稿却被下游当已挂账（VC-D-01）、收付款凭证用单据全额而非核销额（VC-D-02）、客户收款的人工科目可以顶掉「应收账款」（VC-D-03），三者叠加正好解释了用户看到的「应付/应收余额不对、收入像记了两次」。
3. 红冲是第二个系统性错误：原凭证被排除、红字被计入，报表净额变成 -X（VC-D-04）；而红冲又会让同来源再也无法生成新凭证（VC-D-06）。
4. 覆盖性缺口同样计入错账：收付款凭证靠人工逐条生成（VC-D-07）、银行互转完全没有凭证（VC-D-08）、流水冲销不回冲凭证（VC-D-05）。
5. `finance-slip` 不是第二套账（不写流水、不生成凭证），但它的借贷分录与凭证口径必然不同；真正的「三个会计科目」问题在 `subject_id` / `category_subject_id` / 手工改后的 `subject_label` 之间，修口径前先定 §7 的 7 个问题。
