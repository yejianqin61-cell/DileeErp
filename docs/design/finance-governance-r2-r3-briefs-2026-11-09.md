# 财务收口 R2 / R3 任务简报（2026-11-09）

> 前置：R1（2026-11-09）已落地「原材料存货 / 确认即过账 / 业务科目辅助」三口径，见
> [finance-accrual-policy-2026-11-09.md](finance-accrual-policy-2026-11-09.md) 与 `docs/log/2026-11-09.md`。
> 本文件是 R2/R3 的**全部**任务简报：先写完再动代码。每份简报四部分：任务位置、开发者须知、步骤、测试用例。

## 0. 本轮新增口径（用户 2026-11-09 第二次拍板）

| 代号 | 用户原话 | 落地含义 |
|---|---|---|
| D4 | 强制核销额=单据额 | 核销（销账）时每条核销金额必须**等于该单据的未核销余额**，一张付款/收款单的核销合计必须**等于单据金额**。不做部分核销、不做多付/少付、不引「预付/预收」。 |
| D5 | 含税/未税按专票/普票拆进项税 | 应付条目新增发票类型（专票/普票/无票）。**专票**挂账时拆：借 业务科目（不含税）+ 借 应交税费-进项税（税额）/ 贷 应付账款（含税），`不含税 = 含税 ÷ (1+税率)`；**普票/无票/未录**不拆，全额进成本。 |

⚠️ **D5 取代 2026-09-20 的旧口径**（「凭证模板金额一律留空、不按税率自动拆进项税」）。
旧口径的理由是「取得普票/优惠税率时按价内税拆会填错」；D5 用**发票类型**把「该不该拆」先判定，
所以顾虑消失。旧注释必须同步改写：`voucher-template.ts`、`apps/web/lib/voucher-lines.ts`、
`apps/web/components/finance/payable-workspace.tsx`（约 689 行那条注释）。**这是决策记录，不是代码注释美化。**

## 1. 共享契约（所有任务按此实现，不得各自发明）

### A. 强制核销额=单据额（R2-1）

- 应付：`supplier-payment.post` 每条核销必须 `amount === balance.available`（该应付未核销余额，新单据即单据金额），
  否则 422 `ALLOCATION_MUST_SETTLE_PAYABLE`，`details: [{ payable_amount, available_amount, requested_amount }]`。
- 应收：`customer-payment.post` 同理，422 `ALLOCATION_MUST_SETTLE_RECEIVABLE`，`details: [{ receivable_amount, available_amount, requested_amount }]`。
- 两侧都要求 `Σ核销金额 === 单据金额`，否则 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`
  （应付/收款共用同一 code，message 区分），`details: [{ payment_amount, allocated_amount }]`。
  这条同时封死「一张付款核销半张应付、余额下次再付」和「付多了留作预付」。
- 允许的核销前置状态：应付 `confirmed`（`partially_paid` 只可能是历史数据，其 `available = amount - 已核销`，
  仍按 available 全额结清即可）；应收 `confirmed` / `partially_paid` 同理。
- 不新增 schema 字段、不改 `refreshStatus`；`paid_amount/outstanding_amount` 口径不变。
- 历史「部分核销」数据不迁移：再次核销时按剩余 available 结清即可；**不允许**再产生新的部分核销。

### B. 进项税拆分（R2-2 / R2-3）

- 数据：`supplier_payable_entries.invoice_type`（迁移 `20261109130000_finance_governance_r3` 已加），
  取值 `special` / `general` / `none` / `null`（未录）。`amount` 是**含税总额**，`taxRate` 是价内税率。
- `VoucherService.createAccrual` 输入新增可选 `invoice_type?: string | null; tax_rate?: string | Prisma.Decimal | null`。
  判定顺序：
  1. `invoice_type === "special"` 且税率 `r > 0` → **三行**：借 业务科目 `net`、借 应交税费-进项税 `tax`、贷 应付账款 `amount`；
     `net = round(amount / (1+r), 4, HALF_UP)`，`tax = amount - net`（保证借贷严格相等，不四舍五入两次）。
  2. `invoice_type === "special"` 且税率缺失/≤0 → 422 `INVOICE_TAX_RATE_REQUIRED`（专票必须能算出税额，不许猜 13%）。
  3. 其余（`general` / `none` / `null`）→ 保持两行，全额进业务科目。
  4. 找不到进项税科目 → 422 `INPUT_TAX_SUBJECT_MISSING`，details 列出候选名。
- 进项税科目候选名（新增导出常量 `INPUT_TAX_SUBJECT_NAMES`，按顺序找第一个存在的启用科目）：
  `["应交税费-进项税", "应交税费-应交增值税（进项税额）", "应交税费"]`。候选全不存在时 422，不静默换成别的科目。
- 贷方仍是 `ACCRUAL_SUBJECT_NAMES[SOURCE_PAYABLE]`（应付账款），金额为**含税**总额。
- 应收侧本轮**不拆销项税**（用户只拍进项；写进「明确不做」）。
- 台账/接口字段（R2-3）：`invoice_type`、`tax_rate`、`amount`（含税）、`amount_net`（不含税，非专票为 null）、
  `tax_amount`（税额，非专票为 null）。不含税/税额只在**专票**下给出。

### C. 凭证行科目 id 与辅助维度（R3-1 / R3-2）

- 迁移已加列：`voucher_lines.subject_id`（记账科目）、`business_subject_id`（业务科目/辅助核算）、
  `business_subject_label`（业务科目名快照），并对历史行按「唯一同名」回填了 `subject_id`。
- 写入（R3-1）：所有生成分录的路径都要落 `subject_id`；能拿到业务科目录入的路径要落
  `business_subject_id` + `business_subject_label`：
  - 挂账凭证：`subject_id` = 该行记账科目（业务科目候选链/人工科目/进项税科目解出来的那条），
    `business_subject_id` = `createAccrual` 输入新增的 `business_subject_id`（应付条目/对账单科目；应收为空）。
  - 流水凭证：`business_subject_id` = 流水的 `categorySubjectId`，label 取科目名。
  - 手工凭证：`subject_id` 按名称解析；`business_subject_id` 为空。
  - 解析不到唯一科目时 **`subject_id` 留空**，`subject_label` 照旧写文本（报表靠 label 兜底）。
- 读取（R3-2）：三大报表/明细按 `subject_id` 归集，`subject_id IS NULL` 的行回退按 `subject_label` 文本匹配
  （历史行）。**同一行不能既按 id 又按 label 被计两次。**
- 展示（R3-9）：凭证详情/打印在「业务科目（辅助）」一栏显示 `business_subject_label`（与记账科目相同时可不重复显示）。

### D. 红冲后按来源重算（R3-4）

- 迁移已把 `(source_type, source_id)` 全局唯一键换成部分唯一索引
  `WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`。
- 代码里所有「按来源找凭证」必须带 `deletedAt: null, status: { not: "reversed" }`（新增私有 helper 统一，禁止散落）。
- `createAccrual(post=true)`：来源已有**已红冲**挂账凭证时**允许新建**（此前 422 `VOUCHER_ACCRUAL_REVERSED`），
  新凭证 `posted`；红冲历史行原样保留（红字凭证另存 `source_type='voucher'`）。
- 业务单据挂账状态（R3-6）：`accrual_status: "posted" | "reversed" | "draft" | "none"` 由 `postedAccrualOf` + 是否红冲推导，
  台账/详情返回；`POST /finance/payables/:id/reaccrue` 与 `POST /finance/receivables/:id/reaccrue` 用于「按来源重算」
  （内部只调 `createAccrual(post=true)`；已 posted 时 422 `ACCRUAL_ALREADY_POSTED`）。

### E. 冲销联动矩阵（R3-5）

| 动作 | 必须联动 |
|---|---|
| 付款/收款冲销（`*.reverse`） | ① 回冲核销分配、业务单据状态回退（已有）；② 冲销其收支流水（已有）；③ **红冲该流水生成的凭证**（新增） |
| 收支流水冲销（`cash-flow.reverse`） | 若该流水有已过账凭证 → 同一事务外红冲该凭证（新增）；流水来自收/付款单时，业务单据状态由付款冲销那条链路负责，不得重复红冲 |
| 凭证红冲（`voucher.reverse`，来源=应付/应收/流水） | 不再改业务单据状态；业务单据侧通过 `accrual_status` 暴露「挂账已红冲」，用「按来源重算」补（新增） |

红冲一律走既有 `voucher.reverse`（生成红字凭证，`source_type='voucher'`），不得直接改 `status` 了事。

### F. 收付款凭证自动过账（R3-7）

- 由收/付款单/流水自动生成的凭证：生成即 `posted`（与 D2「确认即过账」同一口径，用户已拍）。
  手工凭证仍 `draft`（人录的账由人过）。
- 已过账凭证的来源流水**不可再改**：`cash-flow.update` 遇已过账凭证 → 422 `CASH_FLOW_HAS_POSTED_VOUCHER`；
  要改先冲销（冲销会红冲凭证），再重开流水。
- 这是行为变更：验收文档必须写「收付款凭证不再需要人工过账；改流水需先冲销」。

## 2. 批次、依赖与所有权

| 任务 | 所有权 | 写作用域（disjoint） | 前置 |
|---|---|---|---|
| R2-1 强制核销额=单据额 | ap-chain | `supplier-payment.service.ts` `customer-payment.service.ts` `*.domain.ts` 对应单测 | — |
| R2-2 进项税拆分（凭证侧） | voucher-chain | `voucher.service.ts` `accounting-subject-catalog.ts` 对应单测 | —（schema 已就绪） |
| R2-3 发票类型落库 + 台账字段 | ap-chain | `supplier-payable.service.ts` `supplier-payable-reconciliation.service.ts` `finance.controller.ts` 对应单测 | R2-1、R2-2 契约 |
| R2-4 Web 付款全额核销 | web-ui | `apps/web/components/finance/payable-workspace.tsx` `apps/web/test/payable-page.test.tsx` | R2-1 契约 |
| R2-5 Web 应付发票类型/税额 | web-ui | 同上（串行） | R2-3、R2-4 |
| R2-6 Web 应收全额核销 + 确认弹窗清理 | web-confirm | `receivable-workspace.tsx` + 其测试 | R2-1 契约 |
| R3-3 迁移与回填 | lead | `prisma/schema.prisma` `prisma/migrations/20261109130000_finance_governance_r3` | 已完成 |
| R3-1 凭证行落科目 id/辅助维度 | voucher-chain | `voucher.service.ts` 对应单测 | R2-2 |
| R3-2 报表按 id 匹配 + label 兜底 | subject-reports | `finance-three-statements.service.ts` `finance-three-statements.ts` `finance-report-query.service.ts` 对应单测 | R3-3 |
| R3-4 红冲后按来源重算 | voucher-chain | `voucher.service.ts` 对应单测 | R3-1 |
| R3-5 冲销联动矩阵 | cashflow-chain | `cash-flow.service.ts` `voucher.service.ts`（仅 reverse 段） | R3-4 |
| R3-6 业务单据护栏 + 挂账状态 + reaccrue | ap-chain | `supplier-payable.service.ts` `receivable.service.ts` `finance.controller.ts` 对应单测 | R3-4、R2-3 |
| R3-7 收付款凭证自动过账 + 流水护栏 | cashflow-chain | `cash-flow.service.ts` `voucher.service.ts`（仅创建状态段） | R3-5 |
| R3-8 存量数据盘点与修复脚本 | prod-evidence | 新文件：`apps/api/prisma/maintenance/**`、`tmp/**` | — |
| R3-9 凭证页显示业务科目（辅助） | web-confirm | `apps/web/components/finance/voucher-*.tsx` + 测试 | R3-1 |
| R3-10 决策/设计/日志/收口总结 | cashflow-chain | `docs/**` | 先写决策记录，收尾写总结 |
| R3-11 独立验证 + 全量门禁 | test-sync | `.agent/verify/**` `tmp/**` | 全部实现完成 |

串行约束：voucher-chain R2-2 → R3-1 → R3-4 →（交棒）cashflow-chain R3-5 → R3-7；
ap-chain R2-1 → R2-3 → R3-6。**跨任务的同一个文件禁止并行改**。

---

# R2 批次：口径收口

## R2-1 强制核销额=单据额（应付 + 应收）

### 1. 任务位置

- 属于 **R2 口径收口**，目标是「核销（销账）只允许整单结清，不允许部分核销/多付少付」。
- 本任务移动 **D4 强制核销额=单据额**：核销入口的金额校验从「≤可用余额」收紧为「=未核销余额」，并封死付款金额 ≠ 核销合计。
- 前置：无。后续等它：R2-3（同文件）、R2-4 / R2-6（前端按此契约改）。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/supplier-payment.service.ts` — 应付过账/核销的实现与错误码风格（`post` 方法）。
- `apps/api/src/modules/finance/customer-payment.service.ts` — 应收过账/核销（`post` 方法）。
- `apps/api/src/modules/finance/supplier-payable.service.ts` 的 `allocationBalance` — 未核销余额的定义。
- `apps/api/test/unit/supplier-payment-service.test.cjs` — 现有 fake Prisma 与断言风格。

**Settled**

- 契约 A 全部条款（错误码、details、允许状态）不得改。
- 不引入预付/预收科目、不新增 schema 字段、不改 `refreshStatus`。

**Edges and seam**

- 只动两个 `post()` 的校验与错误信息；核销写入、状态刷新、流水生成保持原样。
- 不动 `*Payment.updateDraft`、不动 `reverse`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/supplier-payment-service.test.cjs apps/api/test/unit/customer-payment-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 历史 `partially_paid` 应付/应收可能没有 `available` 字段（要按 `allocationBalance` 返回值算）；若发现 `available` 已含本次未过账草稿（不应有），停下来说明。
- 若某条既有单测断言「部分核销可通过」，那是旧口径，改断言并在测试名里写明「2026-11-09 D4」。

### 3. 工作流

1. 读上述文件，用一句话复述本任务（回复给 lead）。
2. 改应付 `post`：`amount` 必须等于 `balance.available`（用 Decimal.eq），否则 422 `ALLOCATION_MUST_SETTLE_PAYABLE`；循环后校验 `total.eq(lockedPayment.amount)`，否则 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`。
3. 改应收 `post`：同构，错误码 `ALLOCATION_MUST_SETTLE_RECEIVABLE`。
4. 更新/新增单测（见表），跑 targeted 测试。
5. 跑 typecheck，回报 gate 结果与改动文件清单。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 应付 100，核销 60 | 422 `ALLOCATION_MUST_SETTLE_PAYABLE`，details.available_amount=100 | `supplier-payment.post` |
| 2 | 应付 100 全额核销，付款单金额 120 | 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION` | `supplier-payment.post` |
| 3 | 应付 100 全额核销，付款单金额 100 | 过账成功，entry 变 `paid`，流水/核销各 1 条 | `supplier-payment.post` |
| 4 | 应收 80，核销 80，收款单 80 | 成功；应收 `paid` | `customer-payment.post` |
| 5 | 应收 80，核销 50 | 422 `ALLOCATION_MUST_SETTLE_RECEIVABLE` | `customer-payment.post` |

## R2-2 进项税拆分（凭证侧）

### 1. 任务位置

- 属于 **R2 口径收口**，目标：专票挂账时拆出进项税、普票/无票不拆。
- 本任务移动 **D5** 的凭证侧：`createAccrual` 支持 `invoice_type` / `tax_rate`，生成 2 行或 3 行分录。
- 前置：schema 已由 lead 加好（`SupplierPayableEntry.invoiceType`）。后续等它：R2-3（业务侧传参）、R3-1（同文件）。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/voucher.service.ts` 的 `createAccrual`（约 256 行起）与 `normalizeLines` — 现在两行怎么造的。
- `apps/api/src/modules/finance/accounting-subject-catalog.ts` — `ACCRUAL_SUBJECT_NAMES`、`paymentSubjectNames` 与「候选名列表 → 找启用科目」的既有写法（照它加 `INPUT_TAX_SUBJECT_NAMES`）。
- `apps/api/test/unit/voucher-service.test.cjs` — 挂账用例与 fake Prisma 科目表。
- `apps/api/prisma/schema.prisma` 的 `SupplierPayableEntry.invoiceType` — 取值与「amount 是含税」的注释。

**Settled**

- 契约 B 全部条款；`amount` 是含税、`tax_rate` 是价内税率。
- 贷方必须是含税总额的应付账款；净额与税额 4 位小数、合计严格等于含税额（不得出现 0.0001 差）。

**Edges and seam**

- 只动 `createAccrual` 内「生成挂账分录」这一段与目录常量的新增；不改付款/流水生成的凭证。
- 不碰 `SupplierPayableService`（R2-3 负责传参）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/voucher-service.test.cjs apps/api/test/unit/accounting-subject-catalog.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 现有挂账分录是否还有第三处生成路径（`regenerateAccrual` 复用同一段吗）——若复用，天然生效；若另写一段，必须同样处理并在回报里点明。
- 税率可能是 `Decimal`，不要用浮点比较。

### 3. 工作流

1. 读上述文件，复述任务。
2. 加 `INPUT_TAX_SUBJECT_NAMES` 与解析 helper（候选名 → 唯一启用科目 id，找不到返回 null）。
3. `createAccrual` 入参加 `invoice_type` / `tax_rate`，按契约 B 生成行；专票税率缺失 422、进项税科目缺失 422。
4. 更新单测（见下表），跑 targeted。
5. typecheck + 回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | amount=11300，专票，税率 13% | 借 业务科目 10000.00、借 应交税费-进项税 1300.00、贷 应付账款 11300.00 | `createAccrual` |
| 2 | amount=11300，专票，税率 13% | debitTotal=creditTotal=11300.0000（严格相等） | `createAccrual` |
| 3 | amount=1000，普票，税率 13% | 只有 2 行，业务科目 1000.00，无进项税行 | `createAccrual` |
| 4 | invoice_type=null | 2 行，全额；不报错 | `createAccrual` |
| 5 | 专票但 tax_rate 缺失 | 422 `INVOICE_TAX_RATE_REQUIRED` | `createAccrual` |
| 6 | 专票但科目表无「应交税费-进项税」 | 422 `INPUT_TAX_SUBJECT_MISSING` | `createAccrual` |

## R2-3 发票类型落库 + 台账字段

### 1. 任务位置

- 属于 **R2 口径收口**，目标：应付侧能录发票类型/税率，确认时传给挂账，台账显示含税/不含税/税额。
- 本任务移动 **D5** 的业务侧。
- 前置：R2-1、R2-2 契约。后续等它：R2-5（前端）、R3-6（同文件）。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/supplier-payable.service.ts` — `createFromSource` / `createOther` / `createEntry` / `otherEntryData` / `confirm` / `batchConfirm` / `accrue` / `list`。
- `apps/api/src/modules/finance/supplier-payable-reconciliation.service.ts` — `confirmPayables`（一键确认应付）。
- `apps/api/src/modules/finance/finance.controller.ts` — 应付/对账确认的 DTO 与路由（`bank_id`/`subject_id` 怎么传的，照抄）。
- `apps/api/test/unit/supplier-payable-service.test.cjs` — fake Prisma 与确认用例。

**Settled**

- 契约 B 字段口径；`amount` 含税不变。
- `invoice_type` 只在**草稿**可改/可传；已确认条目改发票类型一律 422 `INVOICE_TYPE_LOCKED`（要改先红冲挂账 → 回退）。
  实际做法：确认时把 `invoice_type` 写入条目；`updateDraft` 类入口若存在（没有就跳过）允许改。
- 确认入口（单条/批量/对账）都接受可选 `invoice_type`，批量/对账下发给每条**尚未录**的条目；已有值不覆盖。

**Edges and seam**

- 动 `supplier-payable.service.ts` + 对账确认 + controller DTO；不动 voucher.service（R2-2 已就位）。
- 台账 `list` 增加 `invoice_type`/`tax_rate`/`amount_net`/`tax_amount`，不删旧字段。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/supplier-payable-service.test.cjs apps/api/test/unit/supplier-payable-reconciliation-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 对账确认 DTO 的形状（批次级一个类型 vs 每条）——按「批次级 `invoice_type` 下发给未录条目」实现；若 DTO 已有更细粒度，沿用更细的。
- 其他应付 `taxRate` 恒为 0，专票 + 税率 0 会触发 422：其他应付要求专票时必须同时传 `tax_rate`（例如房租 9%）。若表单无法传，允许 `none`/`null`。

### 3. 工作流

1. 读上述文件，复述任务。
2. 建单/导入/其他应付路径写入 `invoice_type`（可空）；确认路径把 `invoice_type` 落库并 `accrue` 时传 `invoice_type` + `tax_rate`。
3. 台账/详情补 4 个字段（专票才算 net/tax；其余 null）。
4. controller DTO 补字段与校验（枚举白名单 `special|general|none`）。
5. 单测（下表），targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 草稿应付，确认时 `invoice_type=special` 且 taxRate=13% | 条目落 `special`；`createAccrual` 收到 `invoice_type="special"`、`tax_rate=0.13`（fake 断言） | `confirm` |
| 2 | 确认时 `invoice_type=general` | 条目落 `general`，`createAccrual` 收到 general | `confirm` |
| 3 | 已确认条目再次确认并传不同 invoice_type | 422 `SUPPLIER_PAYABLE_NOT_CONFIRMABLE`（既有守卫优先），不得静默改值 | `confirm` |
| 4 | 台账行，专票 11300/13% | `amount_net="10000.0000"`、`tax_amount="1300.0000"`、`amount="11300.0000"` | `list` |
| 5 | 台账行，普票 | `amount_net=null`、`tax_amount=null` | `list` |

## R2-4 Web 付款全额核销

### 1. 任务位置

- 属于 **R2 口径收口**，目标：付款/合并付款弹窗只能「整单结清」，核销金额不可手改成部分。
- 本任务移动 **D4** 的前端侧。
- 前置：R2-1 契约（后端可能尚未合入，用契约定义先行）。

### 2. 开发者须知

**Read first**

- `apps/web/components/finance/payable-workspace.tsx` — 「登记付款」「合并付款」弹窗与核销明细行。
- `apps/web/components/finance/payment-dialog.tsx`（若存在）/ 同目录付款组件 — 核销行编辑。
- `apps/web/test/payable-page.test.tsx` — 现有 70 个用例与 mock 形状。
- `apps/api/src/modules/finance/supplier-payment.service.ts` 的 `post` — 422 code 文案（契约 A）。

**Settled**

- 前端不再允许编辑单条核销金额：勾选应付即按该应付未核销余额整笔核销；付款金额默认=Σ勾选余额，且必须等于它。
- 后端仍会校验（前端只是提前拦），前端校验文案与后端 code 对齐。

**Edges and seam**

- 只动付款/合并付款弹窗与对应测试；不动应付台账其它按钮。
- 不新增接口。

**Run**

- `cd apps/web && npx vitest run test/payable-page.test.tsx`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 合并付款可能允许「付款金额 > 核销合计」用于手续费/差额——若现状如此，按 D4 一律禁止（差额应另记其他应付/费用），并在回报里点明改了几处。

### 3. 工作流

1. 读文件，复述任务。
2. 改核销行：金额只读、默认整笔；勾选变化时自动更新付款金额。
3. 提交前校验：任一核销金额 ≠ 该单据余额 → 阻断并提示；付款金额 ≠ 合计 → 阻断。
4. 更新测试（下表）。
5. 跑 vitest + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 勾选应付 100 | 核销金额显示 100 且不可编辑；付款金额自动 100 | 付款弹窗 |
| 2 | 勾选应付 100、80 | 付款金额自动 180 | 合并付款 |
| 3 | 手改付款金额为 150 后提交 | 前端阻断，提示「核销合计必须等于付款金额」 | 合并付款 |
| 4 | 取消勾选一张 | 核销合计与付款金额同步扣减 | 付款弹窗 |

## R2-5 Web 应付发票类型与税额展示

### 1. 任务位置

- 属于 **R2 口径收口**，目标：录发票类型/税率、台账与确认弹窗显示含税/不含税/税额。
- 本任务移动 **D5** 的前端侧；同时改写 2026-09-20 旧口径注释。
- 前置：R2-3、R2-4（同文件，串行）。

### 2. 开发者须知

**Read first**

- `apps/web/components/finance/payable-workspace.tsx` — 确认应付弹窗、「其他应付」新建表单、台账列定义、约 689 行旧口径注释。
- `apps/web/lib/voucher-lines.ts` — 模板金额留空的旧口径注释（要改写）。
- `apps/api/src/modules/finance/supplier-payable.service.ts` — R2-3 新增字段名。
- `apps/web/test/payable-page.test.tsx`。

**Settled**

- 发票类型选项：专票 `special` / 普票 `general` / 无票 `none` / 未录（空）。
- 台账新增列/详情：发票类型、税率、不含税金额、税额；非专票的不含税/税额显示「—」。
- 确认弹窗选「专票」而条目税率为空/0 → 前端阻断并提示填税率。

**Edges and seam**

- 只动应付前端与两个旧口径注释文件；不动应收。
- 不改后端。

**Run**

- `cd apps/web && npx vitest run test/payable-page.test.tsx`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 台账列已很多，新增 4 列可能挤压；优先放详情抽屉/行展开，列表只加「发票类型」一列。若测试断言列数，按可读性取舍并在回报里说明。

### 3. 工作流

1. 复述任务。
2. 确认弹窗加发票类型选择 + 税率输入（默认取条目 taxRate）。
3. 台账/详情展示 4 个字段。
4. 改写 `payable-workspace.tsx` 与 `lib/voucher-lines.ts` 的旧口径注释（写明 2026-11-09 D5 取代 2026-09-20）。
5. 测试 + vitest + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 确认弹窗选专票、税率 13% | 请求体带 `invoice_type:"special"` | 确认应付 |
| 2 | 专票但税率空 | 阻断并提示 | 确认应付 |
| 3 | 台账行 `invoice_type=special` | 显示专票 + 不含税/税额 | 台账 |
| 4 | 台账行 `invoice_type=general` | 不含税/税额显示「—」 | 台账 |

## R2-6 Web 应收全额核销 + 确认弹窗清理

### 1. 任务位置

- 属于 **R2 口径收口**：应收收款同样整单结清；顺带清掉 R1 遗留的应收确认弹窗旧口径（入账银行 / `bank_missing` 文案）。
- 本任务移动 **D4 应收侧 + 历史遗留清理**。
- 前置：R2-1 契约。

### 2. 开发者须知

**Read first**

- `apps/web/components/finance/receivable-workspace.tsx` — 确认应收弹窗、收款/合并收款弹窗、核销行。
- `apps/web/test/receivable-page.test.tsx`（若存在；否则找覆盖应收的测试文件）。
- `apps/api/src/modules/finance/customer-payment.service.ts` — 契约 A 错误码。

**Settled**

- 与 R2-4 同一套交互：核销金额只读、收款金额=Σ核销余额。
- 确认应收弹窗删除「入账银行」等旧口径字段与 `bank_missing` 提示（确认应收不写现金，与应付同理）。

**Edges and seam**

- 只动应收前端 + 测试；不动应付、不动后端。

**Run**

- `cd apps/web && npx vitest run test/receivable-page.test.tsx`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 应收确认弹窗是否仍传 `bank_id`；若有，后端确认逻辑已不写现金，删除即可，但要在回报里列清单。

### 3. 工作流

1. 复述任务。
2. 清理确认弹窗旧字段/文案。
3. 改收款/合并收款核销行与金额联动。
4. 更新测试；vitest + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 确认应收弹窗 | 无「入账银行」字段、无 `bank_missing` 文案 | 确认应收 |
| 2 | 勾选应收 80 | 核销金额 80 只读，收款金额自动 80 | 收款弹窗 |
| 3 | 收款金额改成 50 | 阻断提示「核销合计必须等于收款金额」 | 收款弹窗 |

---

# R3 批次：工程收口

## R3-3 迁移与回填（lead，已完成）

- `apps/api/prisma/schema.prisma`：`SupplierPayableEntry.invoiceType`、`VoucherLine.subjectId/businessSubjectId/businessSubjectLabel`、
  `Voucher` 全局唯一键改普通索引。
- `apps/api/prisma/migrations/20261109130000_finance_governance_r3/migration.sql`：加列 + 外键 + 索引 + 历史 `subject_id` 回填 +
  部分唯一索引 `vouchers_source_active_key`。
- 已跑 `prisma format/validate/generate` 与 `tsc --noEmit`（全绿）。

## R3-1 凭证行落科目 id 与辅助维度

### 1. 任务位置

- 属于 **R3 工程收口**，目标：凭证分录不再只有文本科目，记账科目/业务科目都落 id。
- 移动 **D3 业务科目只作辅助维度** 的数据落地。
- 前置：R2-2（同文件）、R3-3 迁移。后续等它：R3-2（报表读取）、R3-4、R3-9。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/voucher.service.ts` — `normalizeLines` / `lineData` / `createVoucher` / 挂账分录构造 / 流水凭证构造。
- `apps/api/prisma/schema.prisma` 的 `VoucherLine` — 新列与注释。
- `apps/api/test/unit/voucher-service.test.cjs` — fake Prisma 的 `voucherLine.create` 断言点。
- `apps/api/src/modules/finance/cash-flow.domain.ts` — 流水「收支类目」(`categorySubjectId`) 的取数。

**Settled**

- 契约 C；解析不到唯一科目时 `subject_id` 留空、label 照旧。
- 不改任何借贷方向、金额、科目名称。

**Edges and seam**

- 动 `voucher.service.ts` 的分录构造与 `VoucherLineDraft/Input` 类型；不改报表（R3-2）、不改业务服务。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/voucher-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- `createAccrual` 的 `contra_subject_names` 解析出的是 id 还是行对象——按现有实现取 id 落到 `subject_id`；若现有解析两次（文本+id）合并成一个查询，改动要一并说明。

### 3. 工作流

1. 复述任务。
2. 统一「科目名 → 唯一启用科目行(id,name)」解析 helper；所有分录构造写 `subject_id`。
3. 挂账输入加 `business_subject_id`，落 `business_subject_id` + `business_subject_label`；流水凭证用 `categorySubjectId` 落业务科目。
4. 手工凭证按名称解析落 `subject_id`；歧义留空 + 回报清单。
5. 单测（下表）+ targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 挂账凭证，业务科目「管理费用」 | 两行都写 `subject_id`（管理费用/应付账款） | `createAccrual` |
| 2 | 挂账凭证，传入 business_subject_id | 行上 `business_subject_id`/`business_subject_label` 有值 | `createAccrual` |
| 3 | 流水凭证，流水有 categorySubjectId | 借/贷行写 `business_subject_id` | 流水生成 |
| 4 | 科目名在科目表里不存在（历史手工名） | `subject_id=null`，`subject_label` 原样 | 手工凭证 |
| 5 | 同名跨类目（两个类别各一个「其他」） | `subject_id=null`（歧义不猜） | 分录构造 |

## R3-2 报表按科目 id 匹配（label 兜底）

### 1. 任务位置

- 属于 **R3 工程收口**，目标：三大报表/明细账按 `voucher_lines.subject_id` 归集，历史行按 label 兜底。
- 前置：R3-3 迁移（回填已完成）。后续等它：无（可独立验收）。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/finance-three-statements.service.ts` — 现在按什么字段匹配科目（`subjectKey`/`subjectLabel`）。
- `apps/api/src/modules/finance/finance-three-statements.ts` — 报表行定义与科目→行映射。
- `apps/api/src/modules/finance/finance-report-query.service.ts` — 明细账/科目余额取数。
- `apps/api/test/unit/finance-three-statements-service.test.cjs` — fake Prisma 的 voucherLine 形状。

**Settled**

- 契约 C 的读取规则；`subject_id` 优先，null 才用 label；同一行只能计一次。
- 报表数字口径、行名、期初逻辑不变。

**Edges and seam**

- 只动三个报表/查询服务与对应单测；不改 voucher.service、不改前端。
- 若 fake Prisma 行数据没有 `subjectId` 字段，测试数据要补（不能因此走不到 id 分支）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/finance-three-statements-service.test.cjs apps/api/test/unit/finance-report-query-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 现在是否用 `subject_key`（`分类/名称`）做主要匹配——若已能精确匹配且没有改名问题，仍要加 id 分支并保留兜底；若发现期初余额表只存 key，报表合并两套键时要格外小心（不许金额翻倍），停下来说明。

### 3. 工作流

1. 复述任务。
2. 报表取数改为「id 匹配优先、label 兜底」的单一归集函数（内部只用一次，避免双计）。
3. 补单测：历史行（subjectId=null）仍按 label 计入；同名跨类目按 id 不串行。
4. targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 两行：id=管理费用 / label=管理费用（历史） | 都归「管理费用」，合计不重复 | 资产负债表 |
| 2 | id=其他（资产类）与 id=其他（负债类） | 分属两行，不串 | 资产负债表 |
| 3 | label 改名后与 id 不一致 | 按 id 归集，金额不错行 | 三表 |

## R3-4 红冲后按来源重算

### 1. 任务位置

- 属于 **R3 工程收口**，目标：挂账凭证红冲后，同一来源可以重建挂账凭证（不再 422 卡死）。
- 前置：R3-1（同文件）。后续等它：R3-5、R3-6。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/voucher.service.ts` — `createAccrual` 的 `existing` 分支、`accruedSourceIds`、`postedAccrualOf`、`createOrReviveVoucher`。
- `apps/api/prisma/migrations/20261109130000_finance_governance_r3/migration.sql` — 部分唯一索引的条件。
- `apps/api/test/unit/voucher-service.test.cjs` — `VOUCHER_ACCRUAL_REVERSED` 现有断言（要改）。

**Settled**

- 契约 D；红冲历史行不得删除/改写。
- `accruedSourceIds` 仍只认 posted。

**Edges and seam**

- 动 `voucher.service.ts` 的「按来源查现有凭证」与 `createAccrual` 重算分支 + 单测；不改业务服务（R3-6）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/voucher-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 若有代码依赖「同一来源一定只有一行」做 `findFirst`（不排序）——改成按 `createdAt desc` 取有效行；发现别处散落查询要一并收口（在回报里列出）。

### 3. 工作流

1. 复述任务。
2. 抽 `activeVoucherOf(sourceType, sourceId, db?)` helper（`deletedAt:null, status.not:"reversed"`），替换散落查询。
3. `createAccrual`：已有 red 时不再 422，改为新建 posted 凭证；金额/币种与业务单据不一致时仍以本次入参为准（重算即按当前单据重记）。
4. 改单测：红冲→重算成功、历史红字行仍在、有效行仍唯一。
5. targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 挂账凭证已红冲，再次 createAccrual(post) | 新凭证 created/posted，旧行 status 仍 reversed | `createAccrual` |
| 2 | 已有 posted 有效凭证，再次 createAccrual(同金额) | `replayed=true`，不新建 | `createAccrual` |
| 3 | 已有 posted，金额不同 | 422 `VOUCHER_ACCRUAL_AMOUNT_MISMATCH`（不覆盖已过账） | `createAccrual` |
| 4 | 同一来源两张：red + new posted | `findFirst` 取到 new posted | helper |

## R3-5 冲销联动矩阵

### 1. 任务位置

- 属于 **R3 工程收口**，目标：冲销动作不再留孤儿凭证/孤儿流水。
- 前置：R3-4。后续等它：R3-7。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/cash-flow.service.ts` — `reverse`、`reverseSourceFlowInTransaction`、`autoReverseFromPayment`、`autoCreateFromPayment`（凭证生成点）。
- `apps/api/src/modules/finance/voucher.service.ts` — `reverse`（红字凭证生成）、`createOrReviveVoucher`、来源类型常量。
- `apps/api/test/unit/cash-flow-service.test.cjs`（若存在）/ `cash-flow-autocreate.test.cjs` — fake Prisma 与断言风格。

**Settled**

- 契约 E 三行矩阵；红冲只走 `voucher.reverse`，不直接改状态。
- 幂等：重复冲销不重复红冲（已有 red 就跳过，`replayed`/`activeVoucherOf`）。

**Edges and seam**

- 动 `cash-flow.service.ts` 与 `voucher.service.ts` 的 reverse 段（与 R3-7 串行，避免同行冲突）。
- 不改业务单据服务（R3-6 负责护栏）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/voucher-service.test.cjs apps/api/test/unit/cash-flow-autocreate.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 红冲凭证时若来源流水已 reversed，凭证红字摘要要能追溯（用 reason 透传）；若 `voucher.reverse` 对 `source_type='voucher'` 有守卫，按契约 E 只对业务来源红冲，不受影响。

### 3. 工作流

1. 复述任务。
2. 加 `VoucherService.reverseBySource(sourceType, sourceId, reason, user, client?)`：找有效凭证 → 已红冲/不存在则幂等返回 → 调 reverse。
3. `cash-flow.reverse`：置 reversed 后红冲该流水凭证（同事务外，按现有审计纪律）；收/付款来源的流水只由付款冲销链触发，避免重复。
4. 付款/收款冲销链：`autoReverseFromPayment` 里补「红冲流水凭证」。
5. 单测（下表）+ targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 流水有 posted 凭证，冲销流水 | 凭证变 reversed + 生成红字凭证 | `cash-flow.reverse` |
| 2 | 流水凭证已红冲后再次冲销 | 不重复红冲，返回幂等 | `reverseBySource` |
| 3 | 付款冲销 | 流水 reversed 且其凭证 reversed（红字 1 张） | `autoReverseFromPayment` |
| 4 | 无凭证的流水冲销 | 不报错，不生成红字 | `cash-flow.reverse` |

## R3-6 业务单据护栏 + 挂账状态 + 按来源重算入口

### 1. 任务位置

- 属于 **R3 工程收口**，目标：业务单据能说清「挂账状态」，红冲后可一键重算；回退/删除护栏与红冲后重算不互相卡死。
- 前置：R3-4、R2-3。后续等它：R3-11（验证）。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/supplier-payable.service.ts` — `reopen`/`reverse`/`removeOther` 现有 `*_HAS_POSTED_ACCRUAL` 护栏、`list` 映射。
- `apps/api/src/modules/finance/receivable.service.ts` — `reopen`/`cancel` 护栏。
- `apps/api/src/modules/finance/voucher.service.ts` — `postedAccrualOf`、`createAccrual`、`discardDraftAccrual`。
- `apps/api/src/modules/finance/finance.controller.ts` — 路由风格与 DTO。
- `apps/api/test/unit/supplier-payable-service.test.cjs`、`receivable-service.test.cjs`。

**Settled**

- 契约 D 的 `accrual_status` 与 `reaccrue` 接口；已 posted 时 422 `ACCRUAL_ALREADY_POSTED`。
- 既有护栏不放松：有 posted 挂账仍禁止回退/删除；红冲后（无 posted）才允许。

**Edges and seam**

- 动应付/应收服务 + controller + 单测；不动 voucher.service（R3-4 已提供能力）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/supplier-payable-service.test.cjs apps/api/test/unit/receivable-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 应收来源没有 `subjectId`（业务科目为空）时重算的业务科目取什么——按对账单科目，再退回候选链（与确认时同一条链），不要新造口径。

### 3. 工作流

1. 复述任务。
2. 列表/详情返回 `accrual_status`（posted/reversed/draft/none）。
3. 新增 `reaccrue` 服务方法 + `POST /finance/payables/:id/reaccrue`、`POST /finance/receivables/:id/reaccrue`，内部 `createAccrual(post=true)`。
4. 单测（下表）+ targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 应付已确认且挂账 posted | `accrual_status="posted"` | `supplier-payable.list` |
| 2 | 挂账凭证已红冲 | `accrual_status="reversed"` | `supplier-payable.list` |
| 3 | 对 status=reversed 的应付 reaccrue | 新建 posted 凭证，`accrual_status` 回到 posted | `reaccrue` |
| 4 | 对已 posted 的应付 reaccrue | 422 `ACCRUAL_ALREADY_POSTED` | `reaccrue` |
| 5 | 应收红冲后 reaccrue | 成功；再 cancel 仍被 posted 护栏挡住 | `receivable.reaccrue` |

## R3-7 收付款凭证自动过账 + 流水编辑护栏

### 1. 任务位置

- 属于 **R3 工程收口**，目标：D2「确认即过账」贯通到资金侧；已过账凭证的来源流水不可再改。
- 前置：R3-5。后续等它：R3-11。

### 2. 开发者须知

**Read first**

- `apps/api/src/modules/finance/cash-flow.service.ts` — `create`/`update`/`autoCreateFromPayment` 与凭证生成调用。
- `apps/api/src/modules/finance/voucher.service.ts` — `createVoucher` 的 `status` 选项、`createFromCashFlow`（约 196 行）。
- `apps/api/test/unit/cash-flow-autocreate.test.cjs` — 现有断言（很多断言 draft，需要按新口径改）。
- `apps/api/test/unit/voucher-service.test.cjs` — 流水凭证用例。

**Settled**

- 契约 F；手工凭证仍 draft。
- 流水 `update` 遇已过账凭证 422 `CASH_FLOW_HAS_POSTED_VOUCHER`；`reverse` 走 R3-5 联动。
- 存量草稿流水凭证不自动过账（R3-8 提供盘点清单，人工处理）。

**Edges and seam**

- 动 `cash-flow.service.ts` 与 `voucher.service.ts` 的「生成状态」段；不动业务单据服务。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/cash-flow-autocreate.test.cjs apps/api/test/unit/voucher-service.test.cjs apps/api/test/unit/supplier-payment-service.test.cjs apps/api/test/unit/customer-payment-service.test.cjs`
- `npx tsc --noEmit -p apps/api/tsconfig.json`

**Unknowns**

- 流水生成凭证与流水创建是否同事务——现状若分两步，保持现状但把凭证状态改 posted；若能把生成放进同一事务更好，但别为此重构支付链（在回报里说明选择）。

### 3. 工作流

1. 复述任务。
2. 自动生成凭证的状态默认改 `posted`（显式参数，别全局改 `createVoucher` 默认值）。
3. `cash-flow.update` 加护栏 422；单测覆盖。
4. 改既有断言（draft→posted），新增护栏用例。
5. targeted + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 付款过账生成流水 | 流水凭证 status=posted | `autoCreateFromPayment` |
| 2 | 手工凭证 | status=draft | `createManual` |
| 3 | 改有 posted 凭证的流水 | 422 `CASH_FLOW_HAS_POSTED_VOUCHER` | `cash-flow.update` |
| 4 | 改无凭证的流水 | 成功 | `cash-flow.update` |

## R3-8 存量数据盘点与修复脚本

### 1. 任务位置

- 属于 **R3 工程收口**，目标：把仓库里改不动的历史数据变成**可审阅的清单 + 可重复执行的 SQL**，不自动改生产。
- 前置：无。后续等它：R3-11（说明存量口径）。

### 2. 开发者须知

**Read first**

- `docs/audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md` §「生产体检」— 已有 87 条只读查询结论。
- `docs/log/2026-11-09.md` §部署注意 — 旧草稿挂账凭证、报表口径变化。
- `apps/api/prisma/migrations/20261109130000_finance_governance_r3/migration.sql` — 本轮 DDL 与回填条件。
- 生产只读通道：`ssh ubuntu@118.178.95.156` → `sudo docker exec -i app-postgres-1 psql -U dilee -d dilee_erp -P pager=off`（只读 SELECT，禁止写）。

**Settled**

- 只产出脚本 + 盘点报告，不执行任何写操作；报告放 `tmp/`（不进仓）。
- 修复项必须带「前置盘点 SELECT + 幂等 UPDATE/软删 + 回滚说明」，且 UPDATE 必须有 `WHERE` 限定到可复算的行。

**Edges and seam**

- 新文件：`apps/api/prisma/maintenance/2026-11-09-finance-repair.sql` + `tmp/finance-review/2026-11-09-repair-inventory.md`。
- 不改业务代码。

**Run**

- 只读盘点：`ssh ubuntu@118.178.95.156 "sudo docker exec -i app-postgres-1 psql -U dilee -d dilee_erp -P pager=off -c \"<SQL>\""`
- `npx prisma validate`（不涉及 schema，可跳过）

**Unknowns**

- 生产是否已应用本轮迁移（大概率未）——盘点 SQL 要能区分「迁移前/后」，用 `information_schema` 判断列是否存在，别写死。

### 3. 工作流

1. 复述任务。
2. 盘点：草稿挂账凭证（按来源类型/金额）、无 posted 挂账的已确认应付、凭证行 `subject_label` 不在科目主数据的行、3 张 posted 红字凭证、长红冲链。
3. 写 `maintenance/2026-11-09-finance-repair.sql`：每段「盘点 SELECT + 修复 UPDATE（注释说明何时取消注释）」，结构：
   A. 孤儿草稿挂账凭证软删（对应业务单据已不 confirmed）；B. 旧草稿挂账凭证人工过账清单（只列不写）；
   C. 科目名快照无法回填 subject_id 的行清单；D. 红字凭证不入报表已由 R1 保证（只核对条数）。
4. 跑只读盘点，写 `tmp/` 报告，回报关键数字。
5. 在回报里给 lead「上线前人工处理步骤」3 条。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 盘点 SQL 在迁移前库 | 不报错（列不存在时跳过对应段） | `information_schema` 探测 |
| 2 | 修复 SQL 重复执行两次 | 第二次影响 0 行（幂等） | UPDATE WHERE |
| 3 | 任一修复段 | 前面必有同口径 SELECT 盘点 | 脚本结构 |

## R3-9 凭证页显示业务科目（辅助）

### 1. 任务位置

- 属于 **R3 工程收口**，目标：凭证详情/打印把「业务科目（辅助）」显示出来，财务能看出这笔账的业务依据。
- 前置：R3-1（接口返回字段）。后续等它：无。

### 2. 开发者须知

**Read first**

- `apps/web/components/finance/` 下凭证组件（`voucher-workspace.tsx` / `voucher-detail` / `voucher-slip` 之类）— 分录表格与打印模板。
- `apps/api/src/modules/finance/finance-slip.ts` / `finance-slip.service.ts` — 打印数据怎么出。
- `apps/web/test/finance-page.test.tsx` — 现有断言。

**Settled**

- 只在有 `business_subject_label` 时显示，且与记账科目相同时不重复。
- 不改借贷方向、金额展示。

**Edges and seam**

- 只动凭证前端与打印数据映射（若需后端补字段，找 lead 协调，不自行改 voucher.service）。

**Run**

- `cd apps/web && npx vitest run test/finance-page.test.tsx`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 打印模板是 HTML 还是后端拼文本——按现有实现选最薄改法；若打印件由后端 `finance-slip.ts` 生成，只加字段不改排版。

### 3. 工作流

1. 复述任务。
2. 凭证详情/打印显示辅助科目。
3. 测试 + typecheck，回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 分录有 business_subject_label | 详情显示「业务科目（辅助）：房租费」 | 凭证详情 |
| 2 | 分录无业务科目 | 不显示该行 | 凭证详情 |
| 3 | 业务科目=记账科目 | 不重复显示 | 凭证详情 |

## R3-10 决策记录 / 设计文档 / 日志 / 收口总结

### 1. 任务位置

- 属于 **R3 工程收口** 的文档半边：先把 D4/D5 与「取代 2026-09-20 旧口径」记下来，收尾写本轮总结。
- 前置：无（可先写决策）。后续等它：全部实现完成后再写总结章。

### 2. 开发者须知

**Read first**

- `docs/design/finance-accrual-policy-2026-11-09.md` — R1 的写法（口径表 / 契约 / 明确不做 / 验收）。
- `docs/log/2026-11-09.md` — 日志格式。
- `.agent/constitution/constitution.md` — 决策要先记录、日志要当天写。
- 本文件 §0 / §1 — 口径与契约原文。

**Settled**

- 新建 `docs/design/finance-governance-r2-r3-2026-11-09.md`：D4/D5、取代旧口径的理由、A–F 契约、迁移与回填、上线须知、明确不做（应收销项税、期初、审批流）。
- 收尾在 `docs/log/2026-11-09.md` 追加本轮记录，并写 `docs/log/2026-11-09-r2-r3-summary.md`（变更表 / 意味着什么 / 还没做）。

**Edges and seam**

- 只动 `docs/**`；不改代码。

**Run**

- 无测试；产出后回报文件路径与「明确不做」清单。

**Unknowns**

- 若实现与契约不一致，以实现为准并**显式记录差异**（别把文档写成理想态）。

### 3. 工作流

1. 复述任务。
2. 先写设计文档（口径 + 契约 + 迁移 + 上线须知）。
3. 实现完成后补「验收与实现差异」章。
4. 写日志与总结。
5. 回报。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 文档口径表 | D4/D5 各一行、可追溯到用户原话 | 设计文档 |
| 2 | 「明确不做」 | 列出去向（R4 或永不做）与理由 | 设计文档 |
| 3 | 日志 | 决策/实现/门禁/部署注意/遗留 五段齐全 | 日志 |

## R3-11 独立验证与全量门禁

### 1. 任务位置

- 属于 **R3 工程收口** 的验收半边：不复用实现者测试，独立写探针；跑全量门禁。
- 前置：R2-1…R3-9 全部完成。

### 2. 开发者须知

**Read first**

- `.agent/verify/finance-accrual-policy-2026-11-09-probe.mjs` — R1 探针写法（手写 fake、断言真实行为、反证）。
- `.agent/verify/finance-accrual-policy-2026-11-09-report.md` — 报告格式。
- `apps/api/test/unit/` 下本轮改过的测试 — 确认覆盖，但探针要**另写**。

**Settled**

- 探针资产放 `.agent/verify/`；结果 JSON + Markdown 报告。
- 必须包含反证（例如：去掉部分索引条件后重算应失败；去掉进项税行后借贷不等）。

**Edges and seam**

- 只写 `.agent/verify/**` 与 `tmp/**`；不改产品代码。发现缺陷 → 报 lead，不自行修。

**Run**

- `npm run typecheck`
- `npm run test:unit:api`（全量 API 单测）
- `npm run test:unit:web`
- `npm run build --workspace=@dilee/web`

**Unknowns**

- 全量 API 单测会因第二轮行为变更出现期望漂移——这是验收的一部分，逐条判断是「实现错」还是「期望旧」，前者交回实现者，后者记录。

### 3. 工作流

1. 复述任务。
2. 写探针：D4 拒绝部分核销、D5 专票/普票分录、科目 id 落库与报表归集、红冲后重算、冲销联动、自动过账，共 ≥12 例，含 ≥2 个反证。
3. 跑探针 + 全量门禁，产出 `-results.json` / `-report.md`。
4. 回报：通过数、失败项分类、需实现者修的具体文件/行。

### 4. 测试用例

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 部分核销 | 探针断言 422 code 与 details | post 服务 |
| 2 | 专票 11300/13% | 三行且借贷相等、净额 10000 | createAccrual |
| 3 | 红冲后重算 | 第二张 posted，红字行保留 | createAccrual |
| 4 | 冲销付款 | 流水 + 凭证都 reversed | reverse 链 |
| 5 | 自动过账 | 流水凭证 posted，改流水 422 | cash-flow |
| 6 | 反证 | 去掉部分索引条件 → 重算失败 | 迁移条件 |
