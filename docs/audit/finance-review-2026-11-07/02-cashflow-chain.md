# 收支流水链路

> 范围：`apps/api/src/modules/finance/cash-flow.service.ts`（全文 664 行逐段读完）、`cash-flow.domain.ts`、`cash-flow-catalog.ts`、`bank.service.ts`、`bank-transfer.service.ts`、`bank-transfer-slip*.ts`、`bank-balance.domain.ts`、`bank-selection.ts`、`opening-balance.service.ts`、`finance-period.ts`、`money.ts`、`prisma/schema.prisma` 的 `CashFlowEntry / BankTransfer / AccountingOpeningBalance / Bank / Voucher / VoucherLine`，以及全部调用方（`finance/`、`hr/`、`web/`）。
> 方式：只读当前代码（HEAD），未连库、未改任何源码。所有结论带 file:line；历史审计 `docs/audit/finance-subject-chain-diagnosis-2026-11-04.md` 只作背景，本文以当前代码为准。
>
> **路径约定**：未带目录前缀的 `xxx.ts` 指 `apps/api/src/modules/finance/xxx.ts`；`salary-payment.service.ts` 指 `apps/api/src/modules/hr/salary-payment.service.ts`；`cash-flow-*.test.cjs` 指 `apps/api/test/unit/`；web 文件写全路径。
> **核验基线**：当前工作区内容（HEAD + 工作区里未提交的 `accounting_subject_categories` 相关改动），行号按核验时文件内容标注；未运行测试、未连数据库。

---

## 1 链路图

```text
┌──────────────────────────── 唯一写入方：CashFlowService ────────────────────────────┐
│ cash-flow.service.ts:128-140 create / :143-191 update / :197-211 reverse            │
│ cash-flow.service.ts:324-417 autoCreateFromPayment                                  │
│ cash-flow.service.ts:440-531 recordConfirmation（**当前无调用方，死代码**）          │
└─────────────────────────────────────────────────────────────────────────────────────┘

【支出侧】SupplierPayment(draft) ──post()──► 事务内：核销 1..N 条应付 + status=posted
          supplier-payment.service.ts:84-125（事务）
              │ 事务**外**才写流水 → 失败时付款已 posted、流水永久缺失
              ▼
          autoCreateFromPayment  supplier-payment.service.ts:156-177
              入参：amount = payment.amount（全额，:157）; direction="expense"(:159)
                    subjectId = 已挂账?null:人工>条目>候选（:129-155,:168）
                    categorySubjectId = 人工>金额最大单据（:174）

【收入侧】CustomerPayment(draft) ──post()──► 核销 1..N 条应收 + posted
          customer-payment.service.ts:85-121（事务）→ 事务外 :134-161
              入参：amount = payment.amount（全额，:135）; direction="income"(:137)
                    subjectId = 已挂账?应收账款:人工>候选（:148）
                    categorySubjectId = 覆盖本次核销的对账单科目（:153）

【工资】SalaryPayment(draft) ──post()──► 核销薪资台账 + posted
          salary-payment.service.ts:309（整行一行代码）→ 事务外 autoCreateFromPayment
              入参：amount = result.amount（全额）; direction="expense"；bank_id 必填；
                    subjectId = 人工>工资支付候选；**无 category / 无 payment_nature / 无 order_no**

【手工】POST /finance/cash-flow-entries       cash-flow.controller.ts:113-115
        PATCH /finance/cash-flow-entries/:id  cash-flow.controller.ts:117-119
        入参 DTO：subject_id 必填(:27)；**create DTO 没有 category_subject_id**(:20-44)
        可写：日期/对方/方向/金额/币种/主科目/结算方式/结算账户/银行账户/款项性质/订单号

                    ▼ 全部落到一张表
CashFlowEntry
  subject_id            = 现金分录的「对方科目」（已挂账付款=应付账款）→ 生成凭证用它
  category_subject_id   = 「收支类目 / 业务科目」（这笔钱算什么）→ 列表/报表/现金流量表落行用它
  bank_id               = 钱实际在哪张卡（银行余额唯一依据）
  settlement_account_id = 老表结算账户字典（只显示，不参与任何计算）
  direction             = income/expense（金额恒为正，库层 CHECK）
  amount                = 正数；自动流水=付款/收款单**全额**
  source_type/source_id = 来源单据（supplier_payment/customer_payment/salary_payment）
  status                = posted（无草稿态）/ reversed

【反向】来源单据冲销 → autoReverseFromPayment：**只把流水 status 改 reversed，不生成反向流水**
          supplier-payment.service.ts:204-220；customer-payment.service.ts:188；salary-payment.service.ts:310
        手工冲销 POST /:id/reverse → 同样只改 status（cash-flow.service.ts:197-211）
        删除其他应付 → reverseSourceFlowInTransaction（supplier-payable.service.ts:442-444），
          但 sourceType="supplier_payable_entry" 的流水**当前无任何写入方**，该分支实际空转

【凭证】（**逐条手工触发，不是自动**）POST /finance/vouchers/from-cash-flow/:entryId
          voucher.controller.ts:171-175 → voucher.service.ts:172-194
          分录：收入 借 银行存款/库存现金 / 贷 subject_id；支出反之
                voucher.domain.ts:145-157（方向由 direction 字符串判断）
          幂等：应用层 findFirst(:176-177) + 库层 @@unique(sourceType,sourceId)(schema:2408)
          改流水后：凭证**不跟随**；草稿可「重新生成」(:436-473)，已过账只能红冲(:674-698)
          流水红冲后：凭证**不红冲**；且该流水**无法再生成新凭证**（:176-177 会返回那张已红冲/已存在的凭证）

【银行】余额 = banks.opening_balance + Σ(posted 且 bank_id 命中的流水收支) + 互转净额
          bank-balance.domain.ts:7-15,36-43；bank.service.ts:74-133
        银行互转（BankTransfer）：**不写流水、不生成凭证**，只进余额
          bank-transfer.service.ts:11-24,70-118；schema.prisma:3253-3258

【报表】三大报表只取 posted **凭证**：finance-three-statements.service.ts:202-213
        期初余额（AccountingOpeningBalance / banks.opening_balance）**直接并入**，不经凭证：
          finance-three-statements.service.ts:245-253,289-313,339-341,366,376
        收支明细/汇总表直接取 posted **流水**、科目=业务科目：
          finance-report-query.service.ts:907-939,955-999,1001-1023
```

---

## 2 产生路径表

| # | 路径 | 调用方 file:line | 入参（关键） | 写入字段 | 金额口径 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 手工新增 | `cash-flow.controller.ts:113-115` → `cash-flow.service.ts:128-140`（校验 `prepare` :252-311） | entry_date/对方/direction/amount>0/currency/subject_id(必填)/settlement_*/bank_id/payment_nature/order_no/remark；**DTO 无 category_subject_id**（`cash-flow.controller.ts:20-44`） | entryNo(:653-655)、entryDate、counterpartyName、direction、amount、currency、subjectId(:303)、settlementMethod、settlementAccountId、bankId、paymentNature、orderNo、remark；**status 默认 posted**（schema:2272）；sourceType/sourceId 为 null；categorySubjectId 恒 null | 用户输入正数，无任何来源/核销校验 | **无**（无 idempotency_key、无唯一键，双击=两条） |
| 2 | 手工更正 | `cash-flow.controller.ts:117-119` → `cash-flow.service.ts:143-191` | 任一字段部分更新；category_subject_id 显式传才动(:170-175)；bank/settlement/nature/order 空串=清空(:179-183) | 同 #1 的字段（均可在 posted 后改）；**不看 source_type**，自动流水一样能改 | 可改成任意正数，与来源单据、核销金额脱钩 | 无（每次 PATCH 都落库） |
| 3 | 手工冲销 | `cash-flow.controller.ts:121-124` → `cash-flow.service.ts:197-211` | reason 必填；仅 posted 可冲 | status=posted→reversed；remark 追加冲销原因 | 不改金额、不生成反向行 | 幂等：二次冲销 422(:200) |
| 4 | 供应商付款过账 | `supplier-payment.service.ts:156-177`（事务 :84-125，流水在事务外） | paymentNo/paymentDate/amount=payment.amount(:157)/currency/counterparty=payeeName??供应商(:158)/direction="expense"(:159)/settlementMethod=`方式--银行名账号`(:160)/bankId(:163)/settlementAccountHint(:164)/sourceType="supplier_payment"(:165)/subject_names=已挂账?["应付账款"]:按来源候选(:129-140,:166)/subjectId(:168)/categorySubjectId=人工>金额最大单据(:174)/categorySubjectNames(:175) | 见 #1；sourceType/sourceId 必写；bank_id 来自付款单 | **付款单全额**；核销合计只要求 ≤ 金额(:121)，可小于 | 应用层 `findFirst(sourceType+sourceId+status=posted)`（`cash-flow.service.ts:377-381`）；库层**无唯一键** |
| 5 | 客户收款过账 | `customer-payment.service.ts:134-161`（事务 :85-121） | amount=payment.amount(:135)/direction="income"(:137)/settlementMethod(:139)/settlementAccountId=null(:140)/bankId(:143)/hint(:144)/sourceType="customer_payment"(:145)/subjectNames=已挂账?["应收账款"]:["主营业务收入"]等(:130-132,:146)/subjectId(:148)/categorySubjectId=覆盖本次核销的对账单科目(:153)/categorySubjectNames(:154)/orderNo(:157)/paymentNature(:159) | 同 #4 + order_no + payment_nature | **收款单全额**（:135）；核销合计 ≤ 金额(:117) | 同上（:377-381） |
| 6 | 工资付款过账 | `salary-payment.service.ts:309`（事务后调用 autoCreateFromPayment；事务内 :309 前半段） | amount=result.amount（全额）/direction="expense"/settlementMethod=paymentMethod/bankId=bank.id(必填)/sourceType="salary_payment"/subjectNames=`paymentSubjectNames("salary_payment")`/subjectId=人工>工资支付；**无 category/nature/orderNo** | 同 #4，但 categorySubjectId=null、settlementAccountId=null、paymentNature/orderNo=null | **工资付款单全额**；核销台账合计 ≤ 金额 | 同上 |
| 7 | 确认应收/应付（`recordConfirmation`） | **无调用方**：全仓 grep 只有定义 `cash-flow.service.ts:440` 与一处注释 `voucher.service.ts:262`；单测仍在测 `cash-flow-service.test.cjs:389-447` | sourceType/sourceId/entryDate/amount/currency/direction/subjectNames/subjectId/bankId/paymentNature/orderNo | 只写主科目与金额；**不写 category_subject_id**（:512-530） | **累计确认额**（amount += 本次确认额，:494-498） | 「同来源只有一条流水」+ 累加；`amount<=0` 返回 null(:470) |
| 8 | 来源单据冲销回冲 | `supplier-payment.service.ts:218`；`customer-payment.service.ts:188`；`salary-payment.service.ts:310` → `cash-flow.service.ts:629-639` → `:603-617` | sourceType/sourceId/reason | 命中流水的 status=reversed、remark 追加 | **不生成反向流水**，金额不变 | 只找 `status=posted` 的行；找不到返回 null 不阻断 |
| 9 | 删除其他应付回冲 | `supplier-payable.service.ts:442-444` → `cash-flow.service.ts:603-617` | sourceType="supplier_payable_entry" | 同 #8 | 同 #8 | **空转**：当前无任何代码写该 sourceType（见 §5 CF-D-07） |
| 10 | 银行互转 | `bank-transfer.service.ts:70-118` | 转出/转入账户、币种、双边金额、汇率快照 | **不写 CashFlowEntry**（设计如此，:11-24；schema:3253-3258）；只写 `bank_transfers` | 只影响银行余额：转出−fromAmount、转入+toAmount（`bank.service.ts:106-111`） | 无幂等键；`transferNo` 唯一但每次新建 |
| 11 | 其他应付 Excel 导入 | `other-payable-import.ts:230-271` + `supplier-payable.service.ts:540-554` | 供应商/金额/说明/科目名称/日期 | 只建 `supplier_payable_entries`（含 subject_id），**不写流水** | — | 无（导入按行报错） |
| 12 | 历史「确认即记账」流水 | **无当前写入方**；历史行 sourceType=`receivable_source`/`receivable_reconciliation`/`supplier_payable_reconciliation` | — | 已是库里的存量行 | — | 仍被报表读：`finance-report-query.service.ts:755,874-884`；被对账单删除守卫读：`supplier-payable-reconciliation.service.ts:285-290` |

**同一笔业务生成几条流水**：供应商付款/客户收款/工资付款**各 1 条**，与核销条数无关（`supplier-payment.service.ts:156-177` 只调一次；`:129-130` 把多来源合并成一条）；银行互转 **0 条**；确认应收/应付 **0 条**（当前口径）。反过来，一条流水**可能对应多张来源单据**（多核销）。

---

## 3 字段语义表

| 字段 | 中文界面名 | 谁写 | 默认/候选 | 可改性 | 被谁消费 |
|---|---|---|---|---|---|
| `subject_id` | 流水页 =「记账对方科目」（悬停/信息行，`apps/web/components/finance/cash-flow-workspace.tsx:283`）；收支明细表 =「记账对方科目」（`finance-report.tables.ts:599,645`）；**凭证页/凭证纸 =「会计科目」**（`voucher.domain.ts:149-152`） | 手工：用户必选；自动：`autoCreateFromPayment`(:383-391)/`recordConfirmation`(:475-487，死代码，仅作现状说明) | 手工无默认；供应商付款：已挂账→「应付账款」，否则人工>条目科目>按来源候选（`supplier-payment.service.ts:129-155,166-168`）；收款：已挂账→「应收账款」，否则人工>「主营业务收入」候选（`customer-payment.service.ts:130-132,146-148`）；工资：「工资支付」>「临时工资」>「基本生产成本」（`accounting-subject-catalog.ts:387`） | **可改**：PATCH subject_id（`cash-flow.controller.ts:52`）；坏处见 CF-D-04；另被 `voucher.service.ts:850` 直接改库（资金搬运纠正） | 生成凭证的业务分录科目（`voucher.service.ts:579-580`）、凭证摘要（:454）、现金流量表**无类目时**的兜底（`finance-three-statements.ts:682`）、收支明细「记账对方科目」列（`finance-report-query.service.ts:922`）、收付款单预填（`finance-slip.service.ts:159-161,315-317`） |
| `category_subject_id` | 流水页/收支明细/汇总表/凭证模块流水表的「**会计科目**（分类/项目）」（`apps/web/components/finance/cash-flow-workspace.tsx:242,279`；`finance-report-query.service.ts:913-933`） | 仅自动流水（供应商付款 :174、客户收款 :153）；手工新增**没有这个入参**（DTO `cash-flow.controller.ts:20-44`） | 供应商：人工>核销单据中金额最大者>按来源候选；客户：覆盖核销的对账单科目>「主营业务收入」候选；工资：无（null） | **可改**：PATCH category_subject_id（`cash-flow.controller.ts:60`；`cash-flow.service.ts:170-175`）；空串=清空 | 列表显示/筛选（`cash-flow.service.ts:83-93,111`；`cash-flow.domain.ts:48-84`）、收支明细/汇总（`finance-report-query.service.ts:920-933,968,983`）、**现金流量表落行优先用它**（`finance-three-statements.service.ts:219-240`；`finance-three-statements.ts:671-684`） |
| `direction` | 「收支」（列表）/「收支方向」（表单） | 手工用户选；供应商/工资写死 `"expense"`（`supplier-payment.service.ts:159`；`salary-payment.service.ts:309`），客户写死 `"income"`（`customer-payment.service.ts:137`） | income/expense | **可改**（`cash-flow.controller.ts:49`；`cash-flow.service.ts:149`），自动流水也能改 | 银行余额符号（`bank.service.ts:98-99`，非 income 一律按支出）、凭证借贷方向（`voucher.domain.ts:147-157`）、收支明细两列（`finance-report.tables.ts:648-649`） |
| `amount` | 金额 | 手工用户；自动=单据金额 | >0，库层 CHECK（迁移 `20260914190000_cash_flow_entries/migration.sql:131-133`） | **可改**（`cash-flow.controller.ts:50`；`cash-flow.service.ts:150`），与核销/来源脱钩 | 银行余额、凭证金额（`voucher.service.ts:180,452`）、收支报表、现金流量表 |
| `currency` | 币种 | 手工用户；自动=单据币种 | 币种字典（`cash-flow.service.ts:253`） | 可改（`cash-flow.service.ts:151`） | 报表分段、凭证币种（`voucher.service.ts:189`）、银行账户匹配 |
| `settlement_method` | 结算方式 | 手工用户；自动=拼串：供应商/客户 `paymentMethod--银行名账号`（`supplier-payment.service.ts:160`；`customer-payment.service.ts:139`）；工资=paymentMethod | 自由文本 | 可改（`cash-flow.controller.ts:61`） | 显示；凭证资金科目猜「现金」（`voucher.domain.ts:70-72,125`） |
| `settlement_account_id` | 结算账户 | 手工用户（校验必须是 `settlement_account` 字典启用项，`cash-flow.service.ts:276-283`）；自动靠 `matchSettlementAccount`（:394,:572-591） | 匹配规则：账号数字完全一致 + 银行名 CJK 前缀互含；匹配不上=null（不造假关联） | 可改/可清空（`cash-flow.controller.ts:62`） | **只显示**：收支明细「结算方式」拼接（`finance-report.tables.ts:651`）；凭证资金行科目名的账户后缀优先取它（`voucher.domain.ts:107-121`）；**不参与余额/任何统计** |
| `bank_id` | 银行账户 | 手工用户（requireActiveBank，`bank-selection.ts:19-25`）；自动=付款单 bankId（`supplier-payment.service.ts:163`；`customer-payment.service.ts:143`；工资 bank 必填） | 可空：没选就不进任何账户余额 | 可改/可清空（`cash-flow.controller.ts:63`；清空语义 :179-183） | **银行余额唯一依据**（`bank.service.ts:80-99`）；凭证资金行的 `bank_id` 引用（`voucher.domain.ts:113-122`）；收付款单预填银行（`finance-slip.service.ts:148,237`） |
| `source_type` / `source_id` | 界面不显示 | 仅自动路径写入（:165/:145/:309）；手工为 null | supplier_payment / customer_payment / salary_payment（+ 历史 receivable_* / supplier_payable_reconciliation） | **不可改**（DTO 无此字段） | 自动流水幂等判断（:377-390）、冲销回冲（:603-616）、外汇表归属（`finance-report-query.service.ts:755,874-884`）、凭证关联、资金搬运纠正（`voucher.service.ts:750`） |
| `payment_nature` | 款项性质（收入用） | 手工用户；客户收款过账参数可选（`customer-payment.service.ts:159`）；供应商/工资不传 | 空=未标注（报表进「其他到账」） | 可改/清空（`cash-flow.controller.ts:65`） | 外汇一览表按定金/货款/尾款分列（`finance-report-query.service.ts:730-766`） |
| `order_no` | 订单号（收入用） | 手工用户（填了必须真实存在，`cash-flow.service.ts:292-296`）；客户收款自动带 `payment.orderNo`（:157）；**供应商付款不传**；工资不传 | 可空 | 可改/清空（`cash-flow.controller.ts:66`） | 外汇一览表按订单归集（`finance-report-query.service.ts:738,791-801`）、销售单改号的 38 张表联动（`sales-order-order-no.ts:121`） |
| `status` | 不直接显示（列表默认只给生效） | 创建即 posted（schema:2272）；reverse 置 reversed | posted / reversed | 只能通过冲销 | 列表/报表过滤（`cash-flow.service.ts:109`；`finance-report-query.service.ts:1007`）、银行余额（`bank.service.ts:82`） |
| `entry_no` / `entry_date` / `counterparty_name` / `remark` | 单号/日期/对方名称/备注 | 手工用户；自动=单据日期/对方/备注前缀「自动生成：sourceType / 单号」（`cash-flow.service.ts:412`） | entryNo=`CF-YYYYMMDD-8HEX`（:653-655） | 日期/对方/备注可改；entryNo 不可改 | 凭证日期/期间（`voucher.service.ts:181,453`）、报表期间、审计 |
| `exchange_rate` / `local_amount` | 不显示 | **无任何写入方**（全仓 grep 只有 schema） | — | — | —（死列） |
| `sales_order_id` | 不显示 | **无任何写入方**（只按 order_no 文本关联，`sales-order-order-no.ts:121`） | — | — | —（死列） |

> **「会计科目」这个界面词到底对应哪个字段**：在**收支流水页 / 收支明细 / 收支汇总**里 = `category_subject_id`（有则用，手工流水退回 `subject_id`，`cash-flow.domain.ts:48-53`）；在**凭证页 / 凭证纸**里 = `voucher_lines.subject_label`（由 `subject_id` 生成，`voucher.service.ts:579-580`）；在**收付款单预填**里 = 应付条目 `subject_id` / 流水 `subject_id`（`finance-slip.service.ts:159-161,244`）。同一个词至少三个落点，且流水页的编辑框会按数据状态**改到不同的列**（自动流水写 `category_subject_id`、手工流水写 `subject_id`，`apps/web/components/finance/cash-flow-workspace.tsx:255,279`）。

---

## 4 业务规则清单

| 编号 | 规则 | 强度 | file:line |
|---|---|---|---|
| CF-R-01 | 金额恒为正数，收/支由 `direction` 决定 | 强制（服务 + 库 CHECK） | `cash-flow.service.ts:263-273`；`cash-flow.domain.ts:12-15`；迁移 `.../20260914190000_cash_flow_entries/migration.sql:131-133` |
| CF-R-02 | `direction` 只能是 income/expense | 强制 | 同上 + `cash-flow.controller.ts:23,49` |
| CF-R-03 | 每条流水必须归到一个**存在且启用**的会计科目（主科目） | 强制 | `cash-flow.service.ts:273-274,223-232` |
| CF-R-04 | 收支类目可空；自动写入时宽松（单据科目停用/被删则退回候选链），人工更正时严格 422 | 半强制（宽松默认） | `cash-flow.service.ts:392-393,170-175,556-562`；测试 `cash-flow-autocreate.test.cjs:91-113` |
| CF-R-05 | 状态只有 posted/reversed；已冲销不可编辑、不可再冲销 | 强制 | `cash-flow.service.ts:145,200`；schema:2272 + 迁移 CHECK |
| CF-R-06 | 只有 posted 流水计入余额/报表；`include_reversed` 才列出已冲销 | 强制 | `cash-flow.service.ts:109`；`bank.service.ts:82`；`finance-report-query.service.ts:1007` |
| CF-R-07 | 冲销必须填原因 | 强制 | `cash-flow.service.ts:198` |
| CF-R-08 | 结算账户必须是 `settlement_account` 字典启用项 | 强制（仅手工入口） | `cash-flow.service.ts:276-283` |
| CF-R-09 | `bank_id` 必须是存在、未删除、未停用的银行账户 | **手工强制 / 自动未复核** | `bank-selection.ts:19-25`；`cash-flow.service.ts:286`（手工）vs `:407`（自动直接落库，过账时不复核） |
| CF-R-10 | 款项性质白名单：定金/货款/尾款/其他，空=不标注 | 强制 | `cash-flow.service.ts:242-247,382`；`payment-nature.ts:20-44` |
| CF-R-11 | 手工流水的订单号必须真实存在 | 强制（仅手工） | `cash-flow.service.ts:292-296`；自动路径 `:411` 不校验 |
| CF-R-12 | 同一 `source_type+source_id` 只写一条流水（已存在则跳过） | **未强制**（应用层 findFirst，库层无唯一键） | `cash-flow.service.ts:377-381`；schema:2220-2295 无 unique |
| CF-R-13 | `recordConfirmation` 同来源累计金额、0 元不建流水 | 已实现但**无调用方** | `cash-flow.service.ts:470,489-511` |
| CF-R-14 | 付款/收款过账必须核销 ≥1 条，且核销合计 ≤ 单据金额 | 强制 | `supplier-payment.service.ts:82,121`；`customer-payment.service.ts:84,117`；`salary-payment.service.ts:309` |
| CF-R-15 | 流水金额必须等于核销合计 | **缺失**（只限制上限） | `supplier-payment.service.ts:121`（仅 gt 拦截）；`customer-payment.service.ts:117` |
| CF-R-16 | 流水金额/科目/方向必须与来源单据一致 | **缺失**（改流水不回写、不校验来源） | `cash-flow.service.ts:143-191`；DTO `cash-flow.controller.ts:46-68` |
| CF-R-17 | 列表/报表的科目口径 = 业务科目（类目优先，手工退回主科目） | 强制 | `cash-flow.domain.ts:48-84`；`cash-flow.service.ts:110-111`；`finance-report-query.service.ts:920-933,968,983` |
| CF-R-18 | 凭证由流水生成：收入 借资金/贷科目，支出 借科目/贷资金，一借一贷、金额相等 | 强制 | `voucher.domain.ts:139-157`；`voucher.service.ts:172-194` |
| CF-R-19 | 一条流水只能有一张凭证（幂等），已冲销流水不生成凭证 | 强制（库唯一键） | `voucher.service.ts:172-177`；schema:2408；已冲销拦截 `:175` |
| CF-R-20 | 凭证草稿可改/可重新生成，已过账只能红冲 | 强制 | `voucher.service.ts:602-605,436-439,674-677` |
| CF-R-21 | 银行余额 = 期初 + 生效收入 − 生效支出 + 转入 − 转出；只算 `bank_id` 命中的流水 | 强制（唯一算法） | `bank-balance.domain.ts:7-15,36-43`；`bank.service.ts:74-133` |
| CF-R-22 | 银行互转不写流水、不产生收入/支出 | 强制（无写流水代码） | `bank-transfer.service.ts:11-24,70-118`；schema:3253-3258 |
| CF-R-23 | 互转同币种两边金额必须相等；跨币种必须显式到账数 | 强制 | `bank-balance.domain.ts:50-82`；`bank-transfer.service.ts:79-80,150-151` |
| CF-R-24 | 期初余额整批替换、同一(建账日,科目,币种)唯一、不强制试算平衡 | 强制/半强制 | `opening-balance.service.ts:17-24,109-161`；schema:2445 |
| CF-R-25 | 期间只是日期范围，**没有关账/锁定** | **缺失** | `finance-period.ts:9-25`；`cash-flow.service.ts:143-184`（可改任意日期） |

---

## 5 流程性缺陷

### CF-D-01 「会计科目」一个词三个字段，且界面编辑框按数据状态改不同的列
- **现象**：流水页显示/编辑的「会计科目」= `category_subject_id`；凭证页的「会计科目」= `voucher_lines.subject_label`（来自 `subject_id`）；收付款单/确认弹窗的「会计科目」= 单据 `subject_id`。财务在流水页改完，凭证纹丝不动。
- **根因**：业务科目（类目）与记账对方科目被拆成两列（`cash-flow.service.ts:36-47`；`cash-flow.domain.ts:34-53`；schema:2232-2244），但只有部分链路传递类目；界面沿用同一个词。
- **影响**：用户报障「确认应付选的科目到了收支流水全变成应付账款」的直接机制；同一笔业务在三个页面显示三个科目（历史审计 §1 已在生产复现）。
- **建议**：界面词彻底分家（列表列名固定为「收支类目」「记账对方科目」），编辑框只改类目；凭证页显示「来源流水类目」并禁止直接改业务科目。
- **证据**：`apps/web/components/finance/cash-flow-workspace.tsx:242,255,279,283`；`cash-flow.service.ts:83-93,170-175`；`voucher.service.ts:568-589`；`supplier-payable.service.ts:267-284`；`docs/audit/finance-subject-chain-diagnosis-2026-11-04.md:39-50`。

### CF-D-02 同一笔付款的两列科目按**两套不同的「金额最大」规则**取值，可互相矛盾
- **现象**：**默认路径**（未人工选科目、未挂账）下，`subject_id` 按「金额最大的**来源类型**」选（采购/外加工/其他，`supplier-payment.service.ts:129-130,166`），`category_subject_id` 却按「金额最大的**单据**」选（`dominantDocumentSubject`，`:142,174`）。多来源混合付款时两列可能指向不同业务口径；人工选科目时两列的关系还会随「是否已挂账」变化：**未挂账**→两列都取人工值（`:155,168,174`）；**已挂账**→主科目固定「应付账款」、只有类目取人工值（`:138-139,155,174`）。
- **根因**：两列各自实现了一套主导规则（`supplier-payment.service.ts:93-118,129-130,142,168,174`；`cash-flow.domain.ts:96-106`），没有统一的「按核销行拆」。
- **影响**：报表按类目统计、凭证按主科目记账，两者对不上；「管理费用」与「主营业务成本」可能同时出现在一笔付款的两列上。
- **建议**：一笔付款有多个来源类型时禁止单值科目（要求拆单或按核销行生成多行分录），不要用「最大者」猜测。
- **证据**：同上；`cash-flow.domain.ts:86-106` 注释自认「一条流水只有一格，所以取占钱最多那条」。

### CF-D-03 流水金额是付款/收款单**全额**，与核销合计无等式关系，未核销部分没有会计科目
- **现象**：部分核销（付款 100、核销 60）时：流水 100、银行减 100、应付只减 60；流水/凭证仍按 100 记现金，40 的预付/预收没有科目，应付台账与银行账的差额无处解释。
- **根因**：`autoCreateFromPayment` 的 amount 直接取单据金额（`supplier-payment.service.ts:157`；`customer-payment.service.ts:135`；`salary-payment.service.ts:309`），核销只校验上限（`:121`/`:117`），凭证金额又照抄流水（`voucher.service.ts:180,452`）。
- **影响**：利润表/资产负债表多记费用或收入，预付账款/预收账款永远为 0；核销明细与流水无法逐笔勾稽。
- **建议**：明确「付款金额=核销额」或引入预付/预收分录（见 §6-2）；凭证金额按核销额生成、差额另立往来科目。
- **证据**：`supplier-payment.service.ts:121,156-177`；`customer-payment.service.ts:117,134-161`；`voucher.service.ts:179-190`。

### CF-D-04 自动流水可被任意改（金额/方向/日期/科目/银行），系统不回写来源、不校验来源
- **现象**：PATCH 一条 `supplier_payment` 流水把金额从 100 改成 80、方向改成 income、科目改成「差旅费」都能成功；来源付款单仍是 100/expense，核销仍是 60。
- **根因**：`update()` 不看 `source_type`（`cash-flow.service.ts:143-191`），合并后只做「科目启用、金额>0、方向枚举、银行存在」这类字段级校验（`:252-311`）；DTO 也不限制自动流水（`cash-flow.controller.ts:46-68`）。
- **影响**：流水、来源单据、核销分配、凭证四份事实永久不一致；银行余额与凭证金额随一次 PATCH 同时漂移且互不校验。
- **建议**：自动流水的金额/方向/币种/来源单据日期只读；要改必须冲销来源单据后重做；至少加「来源单据存在 + 金额一致」护栏。
- **证据**：`cash-flow.service.ts:143-191`；`apps/web/components/finance/cash-flow-workspace.tsx:270-299`（自动流水与手工流水共用同一套可编辑字段）。

### CF-D-05 流水改了科目，已生成凭证不跟随；已过账凭证红冲后也无法为该流水重开
- **现象**：流水科目改成 A、凭证仍是 B；流水红冲后凭证仍 posted；把凭证红冲后，再点「生成凭证」返回的是那张已红冲的旧凭证（`replayed:true`），永远生成不出新凭证。
- **根因**：流水写入口完全不触碰凭证（`cash-flow.service.ts:143-211`）；`createFromCashFlowEntry` 的幂等查询不区分凭证状态（`voucher.service.ts:176-177`）；`regenerate` 只对草稿开放（`:436-439`）、流水已冲销时拒绝（`:449`）。
- **影响**：收付款冲销后三大报表仍按旧凭证计这笔钱（报表只取 posted 凭证），而银行余额已扣回 —— 两套账对不上；红冲后无法重做，形成死路。
- **建议**：来源流水变更/冲销时把其凭证置为「待重算」并要求人工确认；允许「已红冲凭证的来源再次生成」（复活新凭证号）；冲销付款前先检查并提示其凭证。
- **证据**：`voucher.service.ts:172-194,436-473,674-698`；`supplier-payment.service.ts:204-220`（只冲流水、无凭证动作）。

### CF-D-06 同一事实两种冲销模型：流水改状态位，凭证开红字
- **现象**：流水冲销=原行 `status=reversed`；凭证冲销=另开一张红字凭证并把原凭证标 reversed。
- **根因**：两套实现各自演进（`cash-flow.service.ts:197-211` vs `voucher.service.ts:674-698`），未统一「冲销是否生成反向单据」的口径。
- **影响**：报表（只认 posted）与银行余额（只认 posted 流水）在「已冲销」这一状态下口径不同；审计里看到「已冲销流水 + 仍生效凭证」，无法只用一条规则解释。
- **建议**：在会计层统一为「红字/反向分录」，流水保留冲销状态但必须联动凭证红冲（见 §6-7）。
- **证据**：同上。

### CF-D-07 「确认应收/应付」已改成两步挂账，但旧契约、旧注释、旧测试、死代码都还在
- **现象**：① `recordConfirmation` 无调用方却仍被单测覆盖；② 确认接口仍接收并校验 `bank_id`，但确认**不写流水**，返回 `cash_flow_entry_id: null` / `bank_missing: false`；③ 前端确认弹窗仍让财务选「入账银行/支付银行」，并提示「确认应付现在同时记账」；④ `finance-slip` 仍从 `sourceType="supplier_payable_entry"/"receivable_source"` 的流水取「确认时实际用的银行与科目」，而当前代码根本不写这些 sourceType。
- **根因**：2026-09-24 两步制改造只改了后端写入，没清理接口契约、前端文案与下游读取（`supplier-payable.service.ts:217-249,303-347`；`receivable.service.ts:157-220`；`supplier-payable-reconciliation.service.ts:178-260`）。
- **影响**：财务以为确认时代扣了钱（选银行）→ 到收支流水里找不到（因为确认不写流水）→ 直接对应「收付款过账后流水对不上」的用户体感；收付款单打印的银行/科目预填为空或取到候选链。
- **建议**：删除/冻结 `recordConfirmation` 与相关测试；确认接口去掉 `bank_id`（或改为「付款银行预填」并在文档说明）；前端确认弹窗去掉银行选择、改文案；`finance-slip` 改从付款单/银行账户池取数。
- **证据**：`cash-flow.service.ts:440-531`（无调用方）；`supplier-payable.service.ts:231-248`；`receivable.service.ts:170-187`；`supplier-payable-reconciliation.service.ts:241,253`；`apps/web/components/finance/payable-workspace.tsx:717,745,862-888`；`finance-slip.service.ts:136-138,148,161,228,237,244,315-317`；测试 `apps/api/test/unit/cash-flow-service.test.cjs:389-447`。

### CF-D-08 资金科目判定靠名称前缀，且两处定义不一致 → 银行存款类「资金搬运」仍会被挂账
- **现象**：其他应付的会计科目填「库存现金（备用金）」时不挂账（正确）；填「银行存款 中国银行（美元）」时仍走「挂账+付款」，产生一笔不存在的应付账款。
- **根因**：`isCashFamilySubject` 只认 `库存现金` 前缀（`voucher.domain.ts:84-86`），而报表侧 `isFundSubject` 认「银行存款 + 库存现金族」（`finance-three-statements.ts:66-78`）；两套「资金科目」定义并存。
- **影响**：资金搬运凭证出现「借 银行存款 明细 / 贷 应付账款」，凭证科目与业务事实不符（用户原报障同型）；资产负债表多出应付账款。
- **建议**：把「资金科目族」抽成唯一函数（含银行存款族），挂账跳过、现金流量表内部划转、凭证资金行三处共用。
- **证据**：`voucher.domain.ts:84-91`；`voucher.service.ts:292,503,723`；`finance-three-statements.ts:64-78`。

### CF-D-09 期初余额绕过凭证直接进报表，且存在两套互不约束的期初
- **现象**：`accounting_opening_balances` 与 `banks.opening_balance` 都直接加进报表，不生成任何凭证、不可红冲；改期初即改历史报表数字；两套期初谁为准没有强制关系。
- **根因**：期初按「建账日+科目+币种」整批替换（`opening-balance.service.ts:109-161`），报表把期初当外部输入直接并入（`finance-three-statements.service.ts:245-253,289-313,366,376`）；银行余额则用 `banks.opening_balance`（`bank-balance.domain.ts:36-43`），现金流量表只有在科目期初没有货币资金时才用银行期初兜底（`finance-three-statements.service.ts:339-341`）。
- **影响**：报表可被直接改数（无凭证轨迹）；科目期初的银行存款≠银行账户期初时，两张报表各说各话；不强制试算平衡（`opening-balance.service.ts:22-23`）让「不平」成为常态。
- **建议**：期初作为「年初余额凭证」或结账流程落库（可审计、可红冲）；银行账户期初从科目期初派生（或反之），禁止两套并存；保存时强制试算平衡（或至少阻断保存并只允许暂存）。
- **证据**：`opening-balance.service.ts:17-24,109-161,163-208`；`finance-three-statements.service.ts:245-253,339-341,366,376,413-416`；schema:3230,2414-2448。

### CF-D-10 银行互转不进流水、不进凭证、不进三大报表，跨币种差额无科目承载
- **现象**：A 账户转 B 账户 100 万后，银行余额明细变化正确，但资产负债表/现金流量表/凭证里完全看不到；跨币种互转（1 USD → 7.1 CNY）的差额没有汇兑损益科目。
- **根因**：设计上 `bank_transfers` 只参与余额（`bank-transfer.service.ts:11-24`；schema:3253-3258），而报表只取 posted 凭证（`finance-three-statements.service.ts:202-213`）；`amountError` 注释承认「差额没有科目可以承载」（`bank-transfer.service.ts:150-151`）。
- **影响**：期末货币资金（凭证口径）与银行账户余额（流水+互转口径）长期不勾稽；跨币种划转的损益无处落账。
- **建议**：互转生成一张「借 银行存款B / 贷 银行存款A」的自动凭证（跨币种加汇兑损益行）；或至少在报表缺口里显式列出互转金额。
- **证据**：`bank-transfer.service.ts:11-24,70-118,150-151`；schema:3253-3258；`bank.service.ts:85-111`；`finance-three-statements.service.ts:202-213`。

### CF-D-11 无期间关账/锁定：流水可改到任意日期，凭证不跟随
- **现象**：财务可以把 9 月流水日期改成 10 月（跨期），已生成的 9 月凭证仍留在 9 月；也可改已锁账期间（系统无锁）的流水；期初整批替换可改任意历史建账日。
- **根因**：`finance-period.ts` 只是日期区间解析（:9-25），没有「期间状态/关账」表；流水更新不检查期间（`cash-flow.service.ts:143-191`）；凭证日期在生成时取流水日期（`voucher.service.ts:181,453`）。
- **影响**：报表期间归属可由一次 PATCH 改变，而凭证/余额不跟随；月结后数字仍可能变化。
- **建议**：引入期间状态（开放/已结账）与流水日期变更护栏；结账后流水/凭证只读；跨期更正走红冲+重新入账。
- **证据**：同上；`opening-balance.service.ts:109-161`（任意 as_of_date 可整批替换）。

### CF-D-12 流水幂等只靠应用层，且流水写入在付款事务之外
- **现象**：付款/收款/工资的 `post()` 事务提交后才写流水（`supplier-payment.service.ts:84-125` 之后 `:156`）；若写流水因科目缺失等抛 422（`cash-flow.service.ts:389-391`），付款已 posted，流水永久缺失；再次点过账被「只有草稿付款可以过账」拦住（`supplier-payment.service.ts:89-90`），财务只能手工补一条 `sourceType=null` 的流水（永远不会与付款联动、冲销也找不到它）。
- **根因**：两张表没有事务边界共享；`CashFlowEntry` 没有 `(source_type,source_id)` 唯一键（schema:2220-2295 无 unique），幂等只是 `findFirst`（`cash-flow.service.ts:377-381`）。
- **影响**：资金动账从流水/银行余额里消失（历史缺陷同类）；并发/重试窗口下可能重复建流水。
- **建议**：流水写入放进来源单据同一事务；给 `cash_flow_entries (source_type, source_id)` 加部分唯一索引；失败时回滚整个过账。
- **证据**：`supplier-payment.service.ts:84-125,156-177`；`customer-payment.service.ts:85-121,134`；`salary-payment.service.ts:309`；`cash-flow.service.ts:377-381,395-416`；schema:2220-2295。

### CF-D-13 「资金搬运纠正」只改 `subject_id`，不改 `category_subject_id` → 修完列表仍显示旧科目
- **现象**：执行纠正后，凭证按条目科目（库存现金（备用金））重记，但流水列表/收支报表的「会计科目」仍显示旧类目（管理费用），用户会认为又没修好。
- **根因**：`repairCashTransferVouchers` 只更新 `cashFlowEntry.subjectId`（`voucher.service.ts:848-853`），而显示/报表口径优先取 `category_subject_id`（`cash-flow.domain.ts:48-53`；`finance-report-query.service.ts:920`）。
- **影响**：修复动作与用户看到的界面再次不一致（与 CF-D-01 同根）；凭证与流水列表继续「两个科目」。
- **建议**：纠正时同时把类目对齐到同一条目的科目（并在预览里说明两列都会改）。
- **证据**：`voucher.service.ts:831-882,848-853`；`cash-flow.domain.ts:48-53`。

### CF-D-14 方向/金额不是派生字段，可被独立改写；下游还用 else 兜底
- **现象**：自动流水的 direction/amount 与来源单据完全独立（可改），而凭证借贷方向只由 `direction === "income"` 判断、银行余额用 `if income ... else 支出`。
- **根因**：方向/金额在流水上被当作可编辑事实（`cash-flow.service.ts:149-150,254-271`），但下游把它当「业务类型的派生值」使用（`voucher.domain.ts:147-157`；`bank.service.ts:98-99`）。
- **影响**：一次方向改错就把银行余额方向与凭证借贷同时翻转，且没有任何字段能校验它「应该」是哪个方向；非 income 的脏值会被静默当成支出。
- **建议**：方向由来源类型/科目性质派生且对自动流水只读；下游禁止 else 兜底（显式枚举 + 未知值报错）。
- **证据**：`cash-flow.service.ts:149-150,254-260`；`bank.service.ts:98-99`；`voucher.domain.ts:147`；`cash-flow.domain.ts:12-15`（写入口已校验，但历史/直接 SQL 仍是字符串）。

### CF-D-15 手工流水无法在新增时设置「收支类目」，只能在建完后 PATCH
- **现象**：手工录一笔房租，新增弹窗只有一个「会计科目」，落库到 `subject_id`、`category_subject_id=null`；要让它出现在按类目统计的报表里，必须再编辑一次（此时 UI 认为它是手工流水，仍然写 `subject_id`）。
- **根因**：`CashFlowEntryDto`（create）没有 `category_subject_id`（`cash-flow.controller.ts:20-44`），而 update DTO 有（:46-68）；UI 也按「有没有类目」决定写哪一列（`apps/web/components/finance/cash-flow-workspace.tsx:255,279`）。
- **影响**：手工流水的「业务科目」与「记账科目」永远是同一列，无法表达「这笔钱算什么 vs 现金分录另一头是谁」；后续想拆也拆不开。
- **建议**：新建/更正统一只提交业务科目，后端负责派生记账科目（或明确两者都必填）；不要按数据状态切换字段名。
- **证据**：同上。

### CF-D-16 字段空转：`exchange_rate`/`local_amount`/`sales_order_id` 从不写入；`settlement_account_id` 不参与任何计算
- **现象**：schema 保留了三个「看起来有用」的列，代码里没有任何写入方；结算账户只是一段显示文本。
- **根因**：历史迁移预留（schema:2230-2231,2269-2270；`cash-flow.service.ts` 无对应赋值）；结算账户与银行账户池两套并存（`voucher.domain.ts:107-121`）。
- **影响**：报表/凭证若按这些列取数会永远为空；财务以为选了结算账户就关联了银行账，实际余额只看 `bank_id`。
- **建议**：删除死列或补齐写入；合并结算账户字典与银行账户池（或明确「结算账户仅历史展示」并在界面标注）。
- **证据**：schema:2230-2231,2269-2270；`cash-flow.service.ts:297-310,395-416`；`voucher.domain.ts:107-121`；`bank-balance.domain.ts:7-15`。

---

## 6 会计口径待确认

1. **「会计科目」是否允许一分为二**：两步挂账下，付款凭证借方按准则必须是「应付账款」，而用户要求「科目一条龙、三大报表都用它统计」。需要拍板：类目只作辅助核算维度（凭证另落一行/备注），还是流水只保留一个科目、挂账与付款合并成一张凭证。证据：`supplier-payment.service.ts:129-155,168-174`；`voucher.service.ts:245-317`。
2. **未核销/部分核销的差额记什么科目**：现在按全额记现金、按核销额减应付，差额无科目。是否引入「预付账款/预收账款」，凭证金额按核销额还是付款额。证据：CF-D-03。
3. **一笔付款核销多张不同来源单据**：允许单科目猜测（现状）还是强制拆流水/拆凭证行。证据：CF-D-02。
4. **工资是否走「应付职工薪酬」两步**：现在工资付款直接借「工资支付」（付款即费用），与采购/其他应付的挂账+销账不一致；工资台账/工资应付没有自动挂账凭证。证据：`salary-payment.service.ts:309`；`hr/` 目录无 `createAccrual`（grep）；`voucher.service.ts:245-317` 只支持应收/应付。
5. **银行互转是否要凭证与汇兑损益科目**：现在完全在凭证体系之外；跨币种差额无科目。证据：CF-D-10。
6. **期初余额的合法入口**：是否允许直接进报表（现状）还是必须走年初余额凭证/结账流程；银行账户期初与科目期初以谁为准。证据：CF-D-09。
7. **冲销模型**：流水冲销是否应生成反向流水/反向凭证（现在流水改状态、凭证开红字）；已红冲凭证的来源是否允许重新生成。证据：CF-D-05/06。
8. **资金科目族边界**：「银行存款 *」是否与「库存现金 *」一样视为资金搬运（涉及其他应付不挂账的判定）。证据：CF-D-08。
9. **期间关账**：是否引入月结/期间锁；结账后期初与流水是否只读。证据：CF-D-11。
10. **结算账户字典与银行账户池是否合并**：现在两套账户概念并存，结算账户不参与任何计算（只影响凭证科目名后缀）。证据：CF-D-16。

---

## 7 结论

1. 收支流水只有 4 个真实写入口（手工新增/更正、供应商付款过账、客户收款过账、工资付款过账），确认应收/应付已改为只挂账不写流水，但 `recordConfirmation` 死代码、旧接口契约、旧前端文案和旧测试仍在，是「确认后流水对不上」的主要认知来源。
2. 一笔业务只生成一条流水，金额取单据**全额**而非核销合计；多来源付款的 `subject_id` 与 `category_subject_id` 由两套不同的「金额最大」规则各自猜测，导致两列科目可互相矛盾。
3. 「会计科目」在流水页、凭证页、收付款单上分别对应 `category_subject_id`、`voucher_lines.subject_label`、单据 `subject_id` 三个落点，且流水页编辑框会按数据状态改到不同列 —— 这是用户报障「科目不令人满意」的直接结构原因。
4. 流水与凭证之间**没有联动**：改流水不更新凭证、冲销流水不红冲凭证、凭证红冲后该流水再也生成不出新凭证；而银行余额由流水推导、三大报表由凭证+期初推导，两套口径在「冲销」「未生成凭证」「互转」「期初」四类场景必然对不上。
5. 期初余额、银行互转、工资、资金搬运判定各自绕开了凭证/科目体系，叠加「无期间关账」「流水可任意改」两个缺失护栏，构成了当前财务链路的系统性流程错误，需要在 §6 的口径拍板后统一返工。
