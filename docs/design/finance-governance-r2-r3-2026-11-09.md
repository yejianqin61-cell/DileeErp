# 财务治理 R2 / R3 决策与设计（2026-11-09）

> **定位**：R2「口径收口」与 R3「工程收口」的决策记录 + 设计 + 迁移/上线说明。本文写在实现之前（先定口径再写代码），实现完成后再补「验收与实现差异」章（见 §8）。
> **前置**：R1 的三条口径 D1/D2/D3 已落地，见 [finance-accrual-policy-2026-11-09.md](finance-accrual-policy-2026-11-09.md) 与 [docs/log/2026-11-09.md](../log/2026-11-09.md)。
> **来源**：[R2/R3 任务简报](finance-governance-r2-r3-briefs-2026-11-09.md) §0（用户 2026-11-09 第二次拍板，第 11–12 行）、§1（共享契约，第 19–94 行）；诊断背景 [11-07 财务链路诊断](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md) §0.4 与 §9（第 540–562 行）。

## 0. 文档元信息

| 项 | 值 |
|---|---|
| 决策人 | 用户（2026-11-09 第二次拍板，原话见 [brief](finance-governance-r2-r3-briefs-2026-11-09.md) §0 第 11–12 行） |
| 记录人 | cashflow-chain（R3-10） |
| 状态 | **已收口（2026-11-09）**：R2/R3 全部任务落地，最终门禁全绿（API 2972/2972、Web 1293 tests、typecheck/build exit 0、独立探针 26/26 + 反证 2/2、真实 PG 冒烟 17/17、报表复核 17/17）；集成/HTTP 为 `TEST_BLOCKED` 并记 R4-9。迁移已写好、代码未提交（仓库约定由用户 commit）。详见 §8.4–§8.7 |
| 取代 | 仅 D5 相关部分取代 2026-09-20「凭证模板金额一律留空、不按税率自动拆进项税」旧口径（见 §2；宪章《Decision Traceability》第 6 条：追加取代记录，不改写历史） |
| 适用范围 | R2-1…R2-6、R3-1…R3-11（brief 第 96–119 行）；不含应收销项税、期初、审批流、预付/预收（见 §6） |
| 验收依据 | 各任务 brief §4 测试用例 + R3-11 独立探针（brief 第 918–969 行） |

---

## 1. 决策记录（D4 / D5）

### 1.1 口径表（可追溯到用户原话）

| 代号 | 用户原话（2026-11-09 第二次拍板） | 决策 | 落地含义 | 落地任务 | 边界 |
|---|---|---|---|---|---|
| **D4** | 「强制核销额=单据额」（[brief §0 第 11 行](finance-governance-r2-r3-briefs-2026-11-09.md)） | 核销（销账）只允许**整单结清** | ① 每条核销金额必须**等于该单据的未核销余额**（新单据即单据金额）；② 一张付款/收款单的核销合计必须**等于单据金额**；③ 不做部分核销、不做多付/少付、不引「预付/预收」 | R2-1（API）、R2-4/R2-6（Web） | 历史部分核销数据不迁移；再次核销时按剩余 `available` 结清即可，但不允许再产生新的部分核销（brief 第 32 行） |
| **D5** | 「含税/未税按专票/普票拆进项税」（[brief §0 第 12 行](finance-governance-r2-r3-briefs-2026-11-09.md)） | 应付条目新增**发票类型**，按类型决定是否拆进项税 | ① 取值 `special`（专票）/ `general`（普票）/ `none`（无票）/ `null`（未录）；② **专票**挂账拆三行：借 业务科目（不含税）+ 借 应交税费-进项税（税额）/ 贷 应付账款（含税），`不含税 = 含税 ÷ (1+税率)`；③ **普票/无票/未录**不拆，全额进成本 | R2-2（凭证侧）、R2-3（业务侧）、R2-5（Web） | 应收侧本轮**不拆销项税**（brief 第 48 行）；不改历史凭证；不替财务猜税率（专票缺税率 422） |

> 原话出处：brief §0 的「用户原话」列（第 11–12 行）。这组口径回答的是 11-07 诊断 §9 的两个 B 级问题：B4「含税/未税是否自动拆进项税？普票/不可抵扣/部分抵扣怎么处理？」（[11-07 报告第 550 行](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md)）与 B5「部分核销/超额收付款的差额记预付/预收，还是强制单据金额＝核销金额？」（同文件第 551 行）。

### 1.2 与 R1（D1–D3）的关系

| R1 代号 | 口径 | 状态 | 与 R2/R3 的关系 |
|---|---|---|---|
| D1 | 采购入库挂账借方首选「原材料」（存货），「主营业务成本」退为兜底 | 已落地（[accrual policy](finance-accrual-policy-2026-11-09.md) §1 D1） | R2-2 的三行分录里「业务科目」候选链沿用 D1 口径 |
| D2 | 确认应收/应付 → 挂账凭证直接 `posted`，确认与挂账同一事务 | 已落地（同文件 D2） | R3-7 把同一口径延伸到**资金侧**（收付款/流水自动凭证生成即 posted，契约 F） |
| D3 | 业务科目只作辅助核算维度，不决定凭证借贷科目 | R1 部分落地；**R3 落数据** | R3-1 给 `voucher_lines` 落 `subject_id`/`business_subject_id`，R3-2 报表按 id 归集，R3-9 凭证页显示「业务科目（辅助）」 |

### 1.3 决策时已知的假设与未决点

| # | 假设 / 未决点 | 处理 | 依据 |
|---|---|---|---|
| A1 | `taxRate` 是**价内税率**且已由来源录入；`amount` 是含税总额 | 专票按 `taxRate` 拆；税率缺失/≤0 → 422，**不猜 13%** | brief 第 37–42、199–200 行 |
| A2 | 进项税科目必须已存在于科目表 | 候选 `INPUT_TAX_SUBJECT_NAMES`（`应交税费-进项税` → `应交税费-应交增值税（进项税额）` → `应交税费`）取第一个启用科目；全不存在 → 422，不静默换科目 | brief 第 44–46 行 |
| A3 | 历史凭证不回写 | D5 只影响此后生成的挂账凭证；旧凭证不自动重述 | brief 第 23 行（D1 同规则）、本文 §2.3 |
| A4 | 历史部分核销数据不迁移 | 再次核销按剩余 `available` 结清；不新增部分核销 | brief 第 32 行 |
| A5 | 科目 id 只在「唯一同名/唯一命中」时落库 | 歧义（同名跨类目）`subject_id` 留空，读取方回退 `subject_label` | brief 第 62、512 行 |
| A6 | 拆税金额按 4 位小数、`HALF_UP`，且 `tax = amount − net` | 保证 `debitTotal === creditTotal`，不四舍五入两次 | brief 第 41 行 |
| A7 | 其他应付的 `taxRate` 恒为 0（`supplier-payable.service.ts:612`），但其他应付也要能开专票 | **不降级**（2026-11-09 复核口径）：R2-3 扩展确认选项接受 `tax_rate`（仅 `invoice_type=special` 且条目税率为空/0 时可传，落库到条目 `taxRate`）；R2-5 在确认弹窗提供税率输入。其他应付专票必须能填税率，**填不了才允许改普票/无票** | brief 第 273 行（原「允许降级」按复核收敛）；`supplier-payable.service.ts:606-614` |

---

## 2. 取代 2026-09-20 旧口径（D5）

### 2.1 旧口径原文与理由

2026-09-20 用户拍板：**凭证模板只给结构、金额一律留空，不按税率自动拆进项税**。理由：系统里采购单价是**含税价**，`不含税 = 含税 ÷ (1+税率)` 在取得普票（不抵扣）、享受优惠税率或部分抵扣时会被自动填错，而这类错误在凭证上看不出来。

旧口径的落点（原文证据）：

| 位置 | 内容 |
|---|---|
| [finance-cost-accounting-and-voucher-editing-2026-09-20.md](finance-cost-accounting-and-voucher-editing-2026-09-20.md):9,142 | 拍板原文：「模板只给结构、金额留空由财务手填（不按税率自动拆…）」及同一理由的重申 |
| [docs/log/2026-09-20.md](../log/2026-09-20.md):243 | 当日日志：「一行一条应付、金额全额，**不自动拆进项税**…」 |
| [finance-slip-and-merged-reconciliation-2026-09-20.md](finance-slip-and-merged-reconciliation-2026-09-20.md):95 | 同一理由在收付款单预填方案里的引用 |
| `apps/api/src/modules/finance/voucher-template.ts:33-35` | 代码注释：「模板只给结构，金额一律留空（用户 2026-09-20 拍板）。不按税率自动拆进项税…」 |
| `apps/web/lib/voucher-lines.ts:188-189` | 前端同口径注释 |
| `apps/web/components/finance/payable-workspace.tsx:689-690` | 付款单预填注释：「一行一条应付（金额全额，**不自动拆进项税**…）」 |

### 2.2 为什么 D5 可以取代（旧顾虑已被消除）

1. **先判「该不该拆」再拆**：旧口径的顾虑是「不知道是专票还是普票，拆了可能错」。D5 要求应付条目先录 `invoice_type`——只有 `special` 才拆，`general`/`none`/`null` 一律全额（brief 第 12、43 行）。于是「普票被拆错」这个分支从根上不存在。
2. **税率由财务给，系统不猜**：专票必须有 `taxRate`（价内税率），缺失或 ≤0 直接 422 `INVOICE_TAX_RATE_REQUIRED`（brief 第 42 行）。系统不预设 13%，避免把优惠税率/差额征税填错。
3. **拆分算法闭合、可验证**：`net = round(amount/(1+taxRate), 4)`，`tax = amount − net`——税额不是再除一次，借贷严格相等，不会出现 0.0001 差（brief 第 41、200 行）。
4. **科目存在性有护栏**：进项税科目候选全不存在时 422 `INPUT_TAX_SUBJECT_MISSING`，不静默改用别的科目（brief 第 44 行）。

### 2.3 取代的精确范围（什么变、什么不变）

| 场景 | 2026-09-20 旧口径 | D5 之后 | 依据 |
|---|---|---|---|
| **自动挂账凭证**（应付确认，专票） | 两行、全额进业务科目、无进项税行 | **三行**：借 业务科目（不含税）+ 借 应交税费-进项税 / 贷 应付账款（含税） | brief 第 12、40–41 行 |
| 自动挂账凭证（普票 / 无票 / 未录） | 两行、全额 | **不变**：两行、全额进业务科目 | brief 第 43 行 |
| 手工凭证模板（工资/材料/税款等） | 金额留空、由财务填 | **不变**：模板仍只给结构、金额留空（手工凭证是人录的账，不自动拆） | `voucher-template.ts:33-40,93,107-111` |
| 付款单 / 收付款打印件 | 按含税全额（资金支付额） | **不变**（2026-11-09 复核确认）：付款金额是含税实付额，拆税只发生在挂账凭证，不改变资金单据 | `apps/web/components/finance/payable-workspace.tsx:689-690`；§1.1 D5 边界 |
| 应收挂账（销项税） | 不拆 | **不变**：本轮不拆销项税（→ §6） | brief 第 48 行 |
| 历史凭证 | 不动 | **不动**：不回写、不重述（重述属 11-07 批次 D） | brief 第 23 行 |

### 2.4 旧注释/文档处理清单（必须同步，防止新代码旁留着旧口径）

| 文件:行 | 旧说法 | 处理 | 归属任务 |
|---|---|---|---|
| `apps/api/src/modules/finance/voucher-template.ts:33-35` | 「不按税率自动拆进项税」作为**系统全局**口径 | 改写为：「**自动挂账**已按 D5 拆进项税（见本文 §3 B）；本模板仍是手工凭证的参考结构，金额留空由人填」 | task-11（voucher-chain；2026-11-09 扩作用域） |
| `apps/web/lib/voucher-lines.ts:188-189` | 同上 | 同上（前端副本） | task-14（web-ui） |
| `apps/web/components/finance/payable-workspace.tsx:689-690` | 付款单「不自动拆进项税」被表述为系统口径 | 改写为：「付款单按**含税全额**（资金支付额）；进项税拆分只发生在**挂账凭证**（专票）」 | task-14（web-ui） |
| [finance-cost-accounting-and-voucher-editing-2026-09-20.md](finance-cost-accounting-and-voucher-editing-2026-09-20.md):9,142 | 2026-09-20 拍板原文 | **正文不动**；收尾阶段（task-25 后半）在文首加一行 supersedes 注记，指向本文；现在先不加 | R3-10（收尾） |
| [docs/log/2026-09-20.md](../log/2026-09-20.md):243 | 当日日志 | **正文不动**；收尾阶段（task-25 后半）在文首加一行 supersedes 注记；日志仍作为当日事实记录 | R3-10（收尾日志） |
| [finance-slip-and-merged-reconciliation-2026-09-20.md](finance-slip-and-merged-reconciliation-2026-09-20.md):95 | 同源理由 | 保留原文；本轮不加注记（非「两份旧文件」范围） | R3-10（收尾，可选） |

> 口径：**文档/日志保留历史 + 本文作为取代记录；代码注释必须改写**（brief 第 14–17 行明确「这是决策记录，不是代码注释美化」）。
> 2026-11-09 复核确认：`voucher-template.ts` 归 task-11、`lib/voucher-lines.ts` + `payable-workspace.tsx:689` 归 task-14；voucher-chain **只改注释语义**，不改模板「金额留空」的交互（手工凭证仍留空，只有挂账自动拆）。

---

## 3. 共享契约 A–F（实现与测试按此对齐，不得各自发明）

> 原文见 [brief §1](finance-governance-r2-r3-briefs-2026-11-09.md) 第 19–94 行。以下为等义转写 + 关键边界，不改条款。

### A. 强制核销额 = 单据额（R2-1）

- 应付 `supplier-payment.post`：每条核销 `amount === balance.available`（该应付未核销余额；新单据即单据金额），否则 422 `ALLOCATION_MUST_SETTLE_PAYABLE`，`details: [{ payable_amount, available_amount, requested_amount }]`。
- 应收 `customer-payment.post`：同理，422 `ALLOCATION_MUST_SETTLE_RECEIVABLE`，`details: [{ receivable_amount, available_amount, requested_amount }]`。
- 两侧都要求 `Σ核销金额 === 单据金额`，否则 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`（应付/收款共用同一 code，message 区分），`details: [{ payment_amount, allocated_amount }]`。
- 允许的核销前置状态：应付 `confirmed`（历史 `partially_paid` 的 `available = amount − 已核销`，仍按 `available` 全额结清）；应收 `confirmed` / `partially_paid` 同理。
- 不新增 schema 字段、不改 `refreshStatus`；`paid_amount/outstanding_amount` 口径不变。历史部分核销不迁移；不允许再产生新的部分核销。（brief 第 23–32、145 行）
- **历史边界（2026-11-09 复核确认）**：新付款单金额 = 本次核销合计 = Σ各单据**剩余可核销余额**；历史 `partially_paid` 只结余款、不回算原单据金额；**没有**「付款单金额必须等于原应付单据金额」的额外要求。

### B. 进项税拆分（R2-2 / R2-3）

- 数据：`supplier_payable_entries.invoice_type`（迁移已加），取值 `special` / `general` / `none` / `null`；`amount` 是**含税总额**，`taxRate` 是**价内税率**（schema `1532-1547`）。
- `createAccrual` 输入新增 `invoice_type?: string | null; tax_rate?: string | Prisma.Decimal | null`。判定顺序：
  1. `special` 且税率 `r > 0` → **三行**：借 业务科目 `net`、借 应交税费-进项税 `tax`、贷 应付账款 `amount`；`net = round(amount/(1+r), 4, HALF_UP)`，`tax = amount − net`（借贷严格相等）。
  2. `special` 且税率缺失/≤0 → 422 `INVOICE_TAX_RATE_REQUIRED`。
  3. 其余（`general` / `none` / `null`）→ 两行，全额进业务科目。
  4. 找不到进项税科目 → 422 `INPUT_TAX_SUBJECT_MISSING`，`details` 列出候选名。
- 进项税科目候选（新增导出常量 `INPUT_TAX_SUBJECT_NAMES`，按序取第一个启用科目）：`["应交税费-进项税", "应交税费-应交增值税（进项税额）", "应交税费"]`；全不存在时 422，不静默换科目。
- 贷方仍是 `ACCRUAL_SUBJECT_NAMES[SOURCE_PAYABLE]`（应付账款），金额为**含税总额**。
- 台账/接口字段（R2-3）：`invoice_type`、`tax_rate`、`amount`（含税）、`amount_net`（不含税，非专票 null）、`tax_amount`（税额，非专票 null）。不含税/税额只在专票下给出。
- `invoice_type` 只允许在**草稿**改/传；已确认条目再改一律 422 `INVOICE_TYPE_LOCKED`（实际做法：确认时落库，`updateDraft` 类入口若存在则允许改）。确认入口（单条/批量/对账）都接受可选 `invoice_type`，批量/对账下发给每条**尚未录**的条目，已有值不覆盖。（brief 第 36–50、255–258 行）
- **确认时补税率（2026-11-09 复核，替代 §1.3 A7 的「降级」写法）**：`confirm`/批量/对账确认的选项接受可选 `tax_rate`——仅当 `invoice_type=special` 且条目 `taxRate` 为空/0 时允许传，并落库到条目 `taxRate`；R2-5 在确认弹窗提供税率输入。其他应付专票**必须能填税率**，填不了才允许改普票/无票（`general`/`none`）。

### C. 凭证行科目 id 与辅助维度（R3-1 / R3-2 / R3-9）

- 迁移已加列：`voucher_lines.subject_id`（记账科目）、`business_subject_id`（业务科目/辅助核算）、`business_subject_label`（业务科目名快照）；历史行按「唯一同名」回填 `subject_id`（schema `2532-2539`；迁移见 §4）。
- 写入（R3-1）：所有生成分录的路径都要落 `subject_id`；能拿到业务科目的路径要落 `business_subject_id` + `business_subject_label`：
  - 挂账凭证：`subject_id` = 该行记账科目（业务科目候选链/人工科目/进项税科目解出来的那条），`business_subject_id` = `createAccrual` 输入新增的 `business_subject_id`（应付条目/对账单科目；应收为空）。
  - 流水凭证：`business_subject_id` = 流水的 `categorySubjectId`（label 取科目名）。
  - 手工凭证：`subject_id` 按名称解析；`business_subject_id` 为空。
  - 解析不到唯一科目时 **`subject_id` 留空**，`subject_label` 照旧写文本（报表靠 label 兜底）。
- 读取（R3-2）：三大报表/明细按 `subject_id` 归集，`subject_id IS NULL` 的行回退按 `subject_label` 文本匹配（历史行）；**同一行不能既按 id 又按 label 被计两次**。
- 展示（R3-9）：凭证详情/打印在「业务科目（辅助）」一栏显示 `business_subject_label`（与记账科目相同时可不重复显示）。（brief 第 54–65 行）

### D. 红冲后按来源重算（R3-4）

- 迁移已把 `(source_type, source_id)` 全局唯一键换成**部分唯一索引** `WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`（§4.4）。
- 代码里所有「按来源找凭证」必须带 `deletedAt: null, status: { not: "reversed" }`（新增私有 helper `activeVoucherOf` 统一，禁止散落）。
- `createAccrual(post=true)`：来源已有**已红冲**挂账凭证时**允许新建**（不再 422 `VOUCHER_ACCRUAL_REVERSED`），新凭证 `posted`；红冲历史行原样保留（红字凭证另存 `source_type='voucher'`）。
- 业务单据挂账状态（R3-6）：`accrual_status: "posted" | "reversed" | "draft" | "none"` 由 `postedAccrualOf` + 是否红冲推导；台账/详情返回；`POST /finance/payables/:id/reaccrue` 与 `POST /finance/receivables/:id/reaccrue` 用于按来源重算（内部只调 `createAccrual(post=true)`；已 posted 时 422 `ACCRUAL_ALREADY_POSTED`）。
- `accruedSourceIds` 仍只认 `posted`。（brief 第 69–76 行）

### E. 冲销联动矩阵（R3-5）

| 动作 | 必须联动 |
|---|---|
| 付款/收款冲销（`*.reverse`） | ① 回冲核销分配、业务单据状态回退（已有）；② 冲销其收支流水（已有）；③ **红冲该流水生成的凭证**（新增） |
| 收支流水冲销（`cash-flow.reverse`） | 若该流水有已过账凭证 → 同一事务外红冲该凭证（新增）；流水来自收/付款单时，业务单据状态由付款冲销那条链路负责，**不得重复红冲** |
| 凭证红冲（`voucher.reverse`，来源 = 应付/应收/流水） | 不再改业务单据状态；业务单据侧通过 `accrual_status` 暴露「挂账已红冲」，用「按来源重算」补（新增） |

- 红冲一律走既有 `voucher.reverse`（生成红字凭证，`source_type='voucher'`），不得直接改 `status` 了事。
- 幂等：重复冲销不重复红冲（已有红字就跳过，`replayed` / `activeVoucherOf`）。（brief 第 80–86、629–632 行）

### F. 收付款凭证自动过账（R3-7）

- 由收/付款单/流水自动生成的凭证：生成即 `posted`（与 D2 同一口径，用户已拍）。手工凭证仍 `draft`（人录的账由人过）。
- 已过账凭证的来源流水**不可再改**：`cash-flow.update` 遇已过账凭证 → 422 `CASH_FLOW_HAS_POSTED_VOUCHER`；要改先冲销（冲销会红冲凭证），再重开流水。
- 存量草稿流水凭证不自动过账（由 R3-8 盘点清单，人工处理）。
- 行为变更需在验收文档写明：「收付款凭证不再需要人工过账；改流水需先冲销」。（brief 第 90–94、735–737 行）

---

## 4. 迁移与回填：`20261109130000_finance_governance_r3`

> 迁移文件：`apps/api/prisma/migrations/20261109130000_finance_governance_r3/migration.sql`（4308 字节）；schema 对照见 `apps/api/prisma/schema.prisma`。R3-3 由 lead 完成并已 `prisma format/validate/generate` + `tsc --noEmit`（brief 第 453–459 行）。

### 4.1 变更清单

| # | 对象 | DDL | 可空/默认 | 用途 | 回滚 |
|---|---|---|---|---|---|
| 1 | `supplier_payable_entries` | `ADD COLUMN invoice_type VARCHAR(20)` | 可空（历史 = null = 未录） | D5 发票类型：`special`/`general`/`none`/`null` | `DROP COLUMN invoice_type` |
| 2 | `voucher_lines` | `ADD COLUMN subject_id UUID` + FK → `accounting_subjects(id)` `ON DELETE SET NULL`，索引 `voucher_lines_subject_id_idx` | 可空 | 记账科目 id（R3-1）；报表按 id 归集 | 删 FK/索引/列 |
| 3 | `voucher_lines` | `ADD COLUMN business_subject_id UUID` + FK `ON DELETE SET NULL`，索引 | 可空 | 业务科目（辅助核算维度，R3-1/R3-9） | 同上 |
| 4 | `voucher_lines` | `ADD COLUMN business_subject_label VARCHAR(200)` | 可空 | 业务科目名快照 | 同上 |
| 5 | `vouchers` | `DROP INDEX vouchers_source_type_source_id_key`；`CREATE UNIQUE INDEX vouchers_source_active_key ... WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`；另建普通索引 `vouchers_source_type_source_id_idx` | — | 红冲后可按来源重算（R3-4） | 见迁移文件末尾回滚注释 |

> Prisma schema 表达不了部分索引：`Voucher` 上只留 `@@index([sourceType, sourceId])`，部分唯一约束由迁移保证（`schema.prisma:2433-2441` 的注释已写明）。

### 4.2 历史 `subject_id` 回填规则

一次性 `UPDATE`（迁移第 3 段）：

1. 匹配三种历史写法：`subject_label = 科目名`；`subject_label = 分类 || ' / ' || 科目名`；`subject_key = 分类 || '/' || 科目名`。
2. 只对 `deleted_at IS NULL` 的科目匹配，且**按分录行 `GROUP BY ... HAVING count(*) = 1`**——只有**恰好命中一个科目**才回填。
3. 同名跨类目（科目表允许 `@@unique([category, name])`，不是全局唯一）**必须留空**，宁可让报表回退文本，也不猜一个科目。
4. 只回填 `subject_id IS NULL` 的行；不覆盖任何已有值。

### 4.3 部分唯一索引（为什么必须是迁移而不是 Prisma 模型）

- 旧键语义：「一条来源只能有一张凭证」——但红冲行也占着 `(source_type, source_id)`，于是挂账凭证红冲后永远建不出第二张，只能 422 卡死（brief 第 69–73 行）。
- 新索引条件：`deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`——红冲行不再占键，重算可建新凭证；「同一来源同时只有一张有效凭证」仍成立。
- 普通索引 `vouchers_source_type_source_id_idx` 保留：按来源查历史（含红冲行）仍要它。
- 已知约束：`source_id IS NULL` 的行（手工凭证）不受唯一约束（原 `@@unique` 对 NULL 也不约束，语义保持）。

### 4.4 执行、验证与回滚

- 执行：`pnpm prisma migrate deploy`（部署顺序见 §5）。
- 验证：`prisma validate` + `prisma generate`（R3-3 已完成）；上线后核对 `voucher_lines.subject_id` 回填率与「歧义留空」清单（R3-8 盘点报告）。
- 回滚：新列可空、无数据改写；唯一键换索引的回滚 SQL 已写在迁移文件末尾。**注意**：若已产生「红冲行 + 重算新行」的重复来源，回滚全局唯一键前必须先人工处理重复行（迁移注释已写明）。

---

## 5. 上线须知

1. **先迁移、后发版**：本轮代码依赖新列/新索引（R3-1/R3-4/R3-7）。迁移可先于代码上线（新列可空、旧代码不写它们），但新索引必须在「红冲后重算」代码上线前就位。
2. **D4 是行为收紧（422 属预期）**：部分核销、核销合计 ≠ 单据金额都会被拒；财务需改为「整单结清 / 一次付清」。历史部分核销数据不迁移，再次核销时按剩余未核销额结清。
3. **D5 会改变成本/费用数字**：专票挂账从现在起拆出进项税（业务科目按不含税入账），普票/无票/未录不变。上线前备份，并对上月「成本/费用 + 应交税费」做一次口径差异核对；历史凭证不重述。
4. **F 会改变凭证状态**：收付款/流水自动凭证生成即 `posted`，不再需要人工过账；手工凭证仍 `draft`。已有草稿流水凭证不自动过账——按 R3-8 清单人工处理（过账或作废）。（对流水编辑的影响见第 5 条待验证项）
5. **改流水护栏（已实现，R3-7 契约 F）**：由流水自动生成的凭证生成即 `posted` 后，来源流水不可直接改：`PATCH /finance/cash-flow-entries/:id` 遇有效已过账凭证 → 422 `CASH_FLOW_HAS_POSTED_VOUCHER`（details `[{voucher_id, voucher_no}]`）；要改先冲销（冲销会红冲凭证），再重开流水。草稿凭证不阻改：更正成功后自动软删作废（审计 `voucher.delete`，`auto:true`），之后再点「生成凭证」会原地复活并直接过账。实现与用例见 §8.3/§8.4。
   - 已实测（R3-7 单测 95/95，见 §8.3「测试侧」）：自动凭证 `posted`、改有 posted 凭证流水 422、改无凭证流水成功、草稿凭证作废；最终门禁见 §8.4（API 2972/2972、探针 26/26、真实 PG 17/17）。
6. **冲销联动（E）后报表会变**：付款/收款冲销、流水冲销会自动红冲对应凭证；红字凭证不进报表（R1 已修），净额回到 0。上线后第一次冲销请核对报表与银行余额。
7. **部分唯一索引的查询纪律**：所有「按来源找有效凭证」必须带 `deletedAt: null, status: { not: "reversed" }`（R3-4 的 `activeVoucherOf`）。旧代码若用 `findFirst({ sourceType, sourceId })` 不筛状态，可能取到红冲历史行——上线检查点，发现散落查询要一并收口。
8. **`invoice_type = null` 不拆税**：历史/未取票条目保持全额；台账提示待补，系统不替财务猜。专票缺税率 = 422 `INVOICE_TAX_RATE_REQUIRED`；进项税科目缺失 = 422 `INPUT_TAX_SUBJECT_MISSING`（需先在科目表补「应交税费-进项税」）。
9. **回滚顺序**：先回滚代码，再回滚迁移；若已有「红冲后重算」产生的重复来源行，先人工处理再恢复全局唯一键（§4.4）。
10. **生产现状**：截至本文写作时生产大概率未应用本轮迁移；R3-8 的盘点 SQL 用 `information_schema` 判断列是否存在，不写死「迁移前/后」（brief 第 802 行）。
11. **历史数据不自动修**：11-07 批次 D（26 行孤儿分录、3 张 posted 红字、手改凭证重开、悬空流水等）必须财务逐笔确认后执行，不属 R2/R3（[11-07 报告第 534–536 行](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md)）。

---

## 6. 明确不做（含去向与理由）

| 项 | 去向 | 理由 | 本轮边界（证据） |
|---|---|---|---|
| **应收销项税拆分** | R4 / 待用户拍板 | 用户本次只拍「进项税」（D5 原话）；销项税的税率来源、收入科目与价税分离口径都未定，不能顺手复制进项逻辑 | 本轮 `createAccrual` 只处理应付侧；应收挂账保持两行（brief 第 12、48 行） |
| **期初余额改「开账凭证」** | R4 | 11-07 诊断 C11「期初是否必须走开账凭证」未拍板；改动会改写历史报表与建账口径，需财务确认 | 本轮不动 `accounting_opening_balances` / `banks.opening_balance` 与报表期初逻辑（[11-07 报告第 560 行](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md)；R3-2 brief 第 533 行「期初逻辑不变」） |
| **审批流**（制单/审核分离、金额阈值、财务角色细分） | 永不做 / 另立项 | 用户未要求（11-07 C13 停留在提问）；本轮用「生成即过账 + 已过账只能红冲」收口改单面，不引入审批状态机 | 不新增角色/状态/审批表（[11-07 报告第 562 行](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md)） |
| **预付 / 预收**（含部分核销、多付/少付） | 永不做 | D4 强制「核销额 = 单据额」且「Σ核销 = 单据金额」，部分核销与多付/少付被 422 从入口封死，没有差额需要「预付/预收」科目承接 | 不引入预付/预收科目、不新增 schema 字段、不改 `refreshStatus`（brief 第 11、28、145 行） |

**范围外但非永久不做**（不在 R2/R3 brief，避免被当成承诺）：

- 银行互转凭证与汇兑损益（11-07 §9 C10，第 559 行）；
- 期间关账 / 红冲期间规则（11-07 §9 C6，第 552 行）；
- 工资「计提应付职工薪酬 → 实发」两步（11-07 §9 C7，第 553 行）；
- 历史错账修复（11-07 批次 D，第 534–536 行，须财务逐笔确认）。

---

## 7. 验收口径（供实现与测试对齐，非总结）

- 以 brief 各任务 §4 的测试用例为准（R2-1 第 170–178 行、R2-2 第 225–234 行、R2-3 第 283–291 行、R3-1 第 504–512 行、R3-4 第 605–612 行、R3-5 第 656–663 行、R3-6 第 707–715 行、R3-7 第 760–767 行、R3-9 第 861–867 行）。
- R3-11 独立验证（brief 第 918–969 行）：≥12 例，覆盖「D4 拒绝部分核销、D5 专票三行/普票两行、科目 id 落库与报表归集、红冲后重算、冲销联动、自动过账」，且**含 ≥2 个反证**：
  1. 去掉部分唯一索引条件（恢复全局唯一）→ 红冲后重算必须失败；
  2. 去掉进项税行 → 借贷不相等。
- 全量门禁：`npm run typecheck`、`npm run test:unit:api`、`npm run test:unit:web`、`next build`（brief 第 956 行）。
- 实现与本文契约不一致时：**以实现为准并在 §8 显式记录差异**（brief 第 898–900 行）。

---

## 8. 实现状态与差异

> 本章按**实际代码**补写（brief R3-10 工作流第 3 步：实现与契约不一致时以实现为准，并显式记录差异）。
> 终态（2026-11-09）：R2/R3 全部任务已落地且最终门禁全绿（§8.4/§8.7）；R3-3 迁移已写好、代码未提交（仓库约定由用户 commit）；集成/HTTP 为 `TEST_BLOCKED` 并记 R4-9。

### 8.1 契约 × 任务 × 状态总览

| 契约 | 任务 | 状态 | 落点（当前代码） |
|---|---|---|---|
| A 强制核销额=单据额 | R2-1 | **已实现** | `supplier-payment.service.ts`（`ALLOCATION_MUST_SETTLE_PAYABLE` / `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`）、`customer-payment.service.ts`（`ALLOCATION_MUST_SETTLE_RECEIVABLE`） |
| B 进项税拆分 | R2-2 / R2-3 | **已实现** | `voucher.service.ts` 的 `resolveAccrualTaxSplit` / `resolveInputTaxSubject`；`supplier-payable.service.ts` 的 `parsePayableTaxRate` / `resolvePayableInvoice` / `createOther` / `updateDraft` / 三个确认入口 |
| C 凭证行科目 id 与辅助维度 | R3-1 / R3-2 / R3-9 | **已实现** | `voucher.service.ts` 的 `withLineSubjects` / `lineData` / `accrualDraft`；`finance-three-statements.service.ts` + `finance-three-statements.ts` 的 `subjectIdKeyOf` / `subjectKeyOfLine`；凭证详情与打印（web） |
| D 红冲后按来源重算 | R3-4 / R3-6 | **已实现** | `voucher.service.ts` 的 `activeVoucherOf` / `createAccrual`；`supplier-payable.service.ts` / `receivable.service.ts` 的 `reaccrue` + `accrual_status` |
| E 冲销联动矩阵 | R3-5 | **已实现** | `voucher.service.ts` 的 `reverseBySource`；`cash-flow.service.ts` 的 `reverse` / `autoReverseFromPayment` |
| F 自动凭证过账 + 流水护栏 | R3-7 | **已实现** | `voucher.service.ts` 的 `createFromCashFlowEntry`（`status:"posted"`）；`cash-flow.service.ts` 的 `update`（`CASH_FLOW_HAS_POSTED_VOUCHER`） |
| 迁移与回填 | R3-3 | 已写好、未提交 | `20261109130000_finance_governance_r3/migration.sql`（§4） |
| 存量盘点与修复脚本 | R3-8 | 已产出、未执行写 | `apps/api/prisma/maintenance/2026-11-09-finance-repair.sql` + `tmp/finance-review/2026-11-09-repair-inventory.md`（不自动改生产） |
| 决策/设计/日志/总结 | R3-10 | 本文档 | 本文 + `docs/log/2026-11-09.md` + `docs/log/2026-11-09-r2-r3-summary.md` |
| 独立验证 + 全量门禁 | R3-11 | **已完成** | 探针 26/26 + 反证 2/2；全量门禁见 §8.4 / §8.7 |

### 8.2 契约逐条落地

**A（D4 强制核销额=单据额）**：应付/应收两侧都把「≤ 可用余额」收紧为「= 该单据未核销余额」，并强制「Σ核销 = 单据金额」；错误码与 `details` 按契约落地。历史 `partially_paid` 单据只按剩余 `available` 结清、不回算原单据金额；**不引入预付/预收**。后果：**同一张应付/应收不能被分次付款/收款**（要分次只能拆成多张业务单据）；一张付款/收款单仍可一次结清多张单据（每张必须全额）。

**B（D5 进项税拆分）**：只有 `special` 拆三行；`amount` 是含税、`taxRate` 是价内税率；`net = round(amount/(1+r),4,HALF_UP)`、`tax = amount − net`，贷方应付账款为含税总额。契约之外**实现更具体**的边界见 §8.3-B。

**C（科目 id / 辅助维度 / 报表）**：`voucher_lines.subject_id` 只在按科目名解析到**唯一启用科目**时落库（同名跨类目、历史手工名 → `null`，读取方按 `subject_label` 兜底）；`business_subject_id/label` **只落业务分录行**；红字行沿用原行的 `subject_id`/`business_subject_*`（借贷对调、科目不变）；报表 `subject_id` 优先（`@id:` 键）、`IS NULL` 才回退 label，单行只归集一次。

**D（红冲后按来源重算）**：部分唯一索引生效后，同一来源可「红冲历史行 + 新 posted 有效行」并存；`createAccrual(post=true)` 不再因红冲 422，历史红字原样保留；`accruedSourceIds` 只认 posted。业务侧 `accrual_status` = `posted > draft > reversed > none`；`reaccrue` 只对 `confirmed`/`partially_paid`，已有 posted 挂账 → 422 `ACCRUAL_ALREADY_POSTED`；删除/草稿/回退/取消 → 422 `PAYABLE_NOT_RECALCULABLE` / `RECEIVABLE_NOT_RECALCULABLE`；0 元/资金搬运（本来不挂账）→ 同 `*_NOT_RECALCULABLE`。

**E（冲销联动）**：付款/收款冲销与流水冲销都会按来源红冲其凭证（`reverseBySource`：无有效凭证→幂等 null；posted→既有 `reverse`；**draft→软删作废**）。凭证红冲**不写**业务单据状态，业务侧靠 `accrual_status` + `reaccrue` 补。

**F（自动过账 + 流水护栏）**：由流水生成的凭证生成即 `posted`（显式传参，未改 `createVoucher` 默认值；手工凭证仍 `draft`）；改有有效 posted 凭证的流水 → 422 `CASH_FLOW_HAS_POSTED_VOUCHER`；草稿凭证存在时允许改、改后作废它；存量草稿不自动过账（R3-8 清单人工处理）。

### 8.3 实现比契约更具体 / 有偏差的点（重点记录）

**A/D4**

| 项 | 实现 |
|---|---|
| 两侧整单结清 | 应付 `amount === balance.available` → 否则 422 `ALLOCATION_MUST_SETTLE_PAYABLE`；应收同构 `ALLOCATION_MUST_SETTLE_RECEIVABLE`；两侧再校验 `Σ核销 === 单据金额` → 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`（`details` 带金额） |
| 历史数据 | `partially_paid` 只按剩余 `available` 结清，**不回算**原单据金额；不迁移历史部分核销 |
| 明确后果 | **分次付款/分次收款不再支持**（同一张单据不能拆成两次结清）；没有「预付/预收」科目，也没有「多付留存」 |

**B/D5**

| 项 | 实现 |
|---|---|
| 税率归一在 R2-3 边界 | `parsePayableTaxRate`：空/0/负数 = 未录；`>1` 视为百分数（13 → 0.13）；归一后必须 `0 < r < 1`，否则 422 `INVALID_TAX_RATE`（details 带 `tax_rate_raw` / `tax_rate_normalized`） |
| 凭证侧最后守卫 | `resolveAccrualTaxSplit`：`r >= 1` → 422 `INVALID_TAX_RATE`（不在这里归一，报原值定位）；专票缺/非法税率 → 422 `INVOICE_TAX_RATE_REQUIRED`；缺进项税科目 → 422 `INPUT_TAX_SUBJECT_MISSING`（details 带候选名） |
| 实现补充（契约未写） | 税率极小导致 `net<=0`/`tax<=0` 时**不拆**（两行全额），避免 0 元分录被 `normalizeLines` 判非法；与普票在账上等价 |
| 不拆的范围 | 付款单、收付款打印件、收支流水仍按**含税全额**（资金口径）；**应收侧不拆销项税**（本轮只拍进项） |
| 其他应付专票 | `createOther`/草稿编辑/确认入口都接受 `invoice_type` + `tax_rate`；其他应付 `taxRate` 历史恒 0，**选专票必须同时给税率**（建单或确认时补），否则 422 `INVALID_TAX_RATE`；非专票传了税率会被忽略并审计 `ignored_tax_rate` |
| 审计 | 确认/重算审计记 `tax_rate_raw` / `tax_rate_normalized` / `ignored_tax_rate`，事后能解释「当时按什么税率拆的」 |

**C/R3-1 / R3-2**

| 项 | 实现 |
|---|---|
| `subject_id` 回填与落库 | 只在「唯一同名/唯一命中」时写；同名跨类目、历史手工名 → `null`，`subject_label` 原样保留；报表按 `subject_label` 兜底，**不猜科目** |
| 业务科目（辅助）落点 | 只落**业务分录行**：挂账的业务科目行、专票的不含税业务行、流水凭证的业务行；应付账款行、进项税行、资金行**不落** `business_subject_*` |
| 红冲 | 红字分录沿用原行的 `subject_id` / `business_subject_id` / `business_subject_label`（不按名称重新解析，避免科目改名/停用后红字挂错） |
| 报表归集 | `subject_id` 优先（内部 `@id:<uuid>` 键），`subject_id IS NULL` 回退 `subject_label`；一行只按一种键归集，不会 id+label 双计 |
| 已知残留 | **期初余额表只有 `subject_key`（分类/名称），没有 id**：科目改名后旧期初会落 `unmapped`（表尾点名），金额不会翻倍，但需要后续 R4 处理（把期初迁到 id 或保留旧键映射） |

**D/E：R3-4 / R3-5**

| 项 | 实现 |
|---|---|
| 部分唯一索引 | `vouchers_source_active_key (source_type, source_id) WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`；普通索引保留供历史查询 |
| 红冲后重算 | 只认「有效凭证」的查询统一走 `activeVoucherOf`；`createAccrual(post=true)` 在只剩红冲行时新建 posted，历史行不动 |
| 冲销联动 | 付款/收款冲销 → 回冲流水 → 红冲流水凭证；流水冲销 → 红冲其凭证；重复冲销幂等不重复红字 |
| **契约 E 之外的额外处理** | 有效凭证是 **draft** 时，冲销/更正会**软删作废**（`voucher.delete` 审计 `auto:true`），不生成红字。理由：R3-7 前自动凭证都是草稿，流水一旦冲销/更正，草稿永远过不了账（`regenerate`/`createFromCashFlowEntry` 都拒绝已冲销流水），留着只会变成可误过账的孤儿。lead 已确认保留 |
| 凭证红冲 | 不写业务单据状态；业务侧靠 `accrual_status`（reversed）+ `reaccrue` 补 |

**F：R3-7**

| 项 | 实现 |
|---|---|
| 自动凭证 | `createFromCashFlowEntry` 生成即 `posted`（显式传 `status:"posted"`），并补一条 `voucher.post` 审计（`auto:true`, `reason:"cash_flow_auto_post"`）；`createVoucher` 默认值、手工凭证、`createAccrual` 均未改 |
| 流水护栏 | 有效 posted 凭证 → 改流水 422 `CASH_FLOW_HAS_POSTED_VOUCHER`（details `voucher_id`/`voucher_no`），被挡下时**不写流水**；要改先冲销（冲销会红冲凭证） |
| 草稿处理 | 草稿凭证不阻改；流水更正成功后软删作废（审计 `because:"source_updated"`），之后「生成凭证」原地复活并直接 posted |
| 存量 | 存量草稿不自动过账；`regenerate` 对存量草稿仍保持 draft（lead 已确认：走 R3-8 清单人工处理） |
| 事务现状 | **流水创建与凭证生成不同事务、也不同请求**：付款/收款过账事务外写流水；凭证是用户点「生成凭证」的独立 `POST /finance/vouchers/from-cash-flow/:entryId`。按 brief 未重构支付链 |

**R3-6 业务侧**

| 项 | 实现 |
|---|---|
| `accrual_status` | `posted > draft > reversed > none`（同一来源可能同时有红冲行 + 新 posted 行，按优先级取） |
| `reaccrue` | 仅 `confirmed`/`partially_paid`；已 posted → 422 `ACCRUAL_ALREADY_POSTED`；软删/草稿（回退）/取消 → 422 `PAYABLE_NOT_RECALCULABLE` / `RECEIVABLE_NOT_RECALCULABLE`；0 元/资金搬运 → 同 `*_NOT_RECALCULABLE`；同事务内读单据 + 建凭证，失败一起回滚；原因可选、只进审计 |
| 路由 | `POST /finance/payables/:id/reaccrue`、`POST /finance/receivables/:id/reaccrue`（`finance.controller.ts`） |

**R2-5 / R3-13 Web**

| 项 | 实现 |
|---|---|
| 台账列 | 只新增「发票类型」一列（专票/普票/无票/—）；税率、不含税金额、税额放在**详情**里（非专票显示「—」）——`payable-workspace.tsx:1246,1374-1379` |
| 挂账状态 | 放在「状态」列第二行展示（`accrual_status` → 中文；reversed 用错误色）——`payable-workspace.tsx:1252` |
| 重算按钮 | 只有 `accrual_status === "reversed"` 才给「按来源重算」——`payable-workspace.tsx:1263` |
| 弹窗 | 确认/批量确认/对账确认/其他应付新建/草稿编辑都提供发票类型 + 税率；专票缺税率前端先拦（后端同 422） |

**测试侧（终态）**

- 4 条既有迁移守卫（`accounting-subject-migration` / `bank-balance-migration` / `voucher-manual-source-migration` / `voucher-migration`）已由 test-sync 按新 schema **更新期望**（非放松：全局唯一键→部分索引、新增列、`prisma format` 后的正则），并新增 1 条本轮迁移守卫；一起并入 §8.4 的全量 API 单测。
- 集成/HTTP：`npm run test:integration` → `TEST_BLOCKED`（`TEST_DATABASE_URL` 未设置，exit 3，**未伪造通过**）。test-sync 另发现这两个集成文件本身跑不过：构造服务未注入 `VoucherService`、引用已删除的 `flow.itemId` / `dictionaryItem` 旧字段 → 记为 **R4-9「集成测试 R1–R3 全量翻修」**，不在本轮修。
- 我经手任务的测试：R3-5 两文件 91/91；R3-7 目标两文件 95/95 + `supplier-payment-service`/`customer-payment-service` 44/44；`cash-flow-service`/`cash-flow-payment-nature` 47/47（已被全量 API 2972/2972 覆盖）。
- 真实 PostgreSQL 冒烟（task-31，`tmp/finance-review/08-e2e-smoke.md`）：**17/17 PASS**——专票三行（10000/1300/11300）、`subject_id`/`business_subject_id` 真实落库、付款全额核销→paid、流水凭证 posted、改流水 422 `CASH_FLOW_HAS_POSTED_VOUCHER`、付款冲销→流水+凭证红冲+红字、红冲挂账→reaccrue→posted 且有效行唯一、D4 部分核销 422 真实事务回滚、D5 普票两行、真实 DB 部分唯一索引 P2002。
- 报表口径独立复核（task-30，`tmp/finance-review/07-r2r3-review.md`）：**17/17 PASS**——进项税在资产负债表以 −13 冲减「应交税费」、勾稽平；利润表只吃净额。
- 已知 flake（非本轮）：`apps/web/test/procurement-bom-page.test.tsx:271` 在与 `next build` 并发时偶发可见性断言失败，单跑/复跑全绿；与本轮改动无关。

### 8.4 门禁（终态，2026-11-09）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（api / coding-worker / web 三个 workspace） | **exit 0** |
| `npm run build --workspace=@dilee/api` | **exit 0** |
| API 全量单测 | **2972 / 2972 pass / 0 fail**（含本轮新增迁移守卫 1 条；原 4 条旧守卫已按新 schema 更新期望） |
| Web 单测 | **lib 430 / 430；组件 75 files / 1293 tests 全 pass** |
| `npm run build --workspace=@dilee/web`（next build） | **exit 0** |
| 独立探针 `.agent/verify/finance-r2-r3-2026-11-09-probe.mjs` | **26 / 26 PASS；反证 2 / 2 PASS**（去掉部分索引条件 → 红冲重算 P2002 失败；去掉进项税行 → `VOUCHER_NOT_BALANCED`） |
| 真实 PostgreSQL 端到端冒烟（task-31） | **17 / 17 PASS**（见 §8.3「测试侧」） |
| 报表口径独立复核（task-30） | **17 / 17 PASS** |
| 集成 / HTTP 全套 | `TEST_BLOCKED`（`TEST_DATABASE_URL` 未设置，exit 3）；且集成文件本身需 R4-9 翻修 |
| 已知 flake | `procurement-bom-page.test.tsx:271` 与 next build 并发偶发；单跑/复跑全绿，非本轮 |

### 8.5 存量数据与上线人工步骤（R3-8）

- 资产：`apps/api/prisma/maintenance/2026-11-09-finance-repair.sql`（只读盘点 + 幂等修复段，脚本已对生产只读跑通）；盘点报告 `tmp/finance-review/2026-11-09-repair-inventory.md`（不 进仓）。
- 生产快照关键数字（2026-11-09）：迁移**未应用**（最新 `20261105103000`）；草稿挂账凭证 9 张（存活 1 / 69.90，已软删 8 / 722.44）；草稿流水凭证 7 张（存活 2 / 97.10，已软删 5 / 2,005.74）；无 posted 挂账的已确认应付 4 条 / 2,099.50；凭证行科目名无法回填 `subject_id` 16 行 / 32,552.04（可唯一回填 52 行 / 71,257.12，0 行歧义）；posted 红字凭证 3 张 / 12,061.20；长红冲链 2 条（8 连 / 4 连）。
- **上线顺序（2026-11-09 最终确认）**：
  1. **先迁移**：生产当前最新 `20261105103000`；执行 `npm run db:migrate:deploy`（包含 `20261107200000_accounting_subject_categories` 与 `20261109130000_finance_governance_r3`）。
  2. **再盘点**：跑 R3-8 盘点脚本 §1 / §3（迁移前后探测、草稿凭证/科目文本清单），核对与 `tmp/finance-review/2026-11-09-repair-inventory.md` 是否一致。
  3. **财务处理**：3 张存活草稿凭证（1 张挂账 + 2 张流水）人工过账或作废；4 条已确认但无 posted 挂账的应付用「按来源重算」（`reaccrue`）补挂账。
  4. **最后修复 SQL**：财务确认 R3-8 报告 C3 / D 段后，按 `2026-11-09-finance-repair.sql` 注释段执行（脚本不自动执行写操作）；3 张 posted 红字与 2 条长红冲链先逐笔确认。

### 8.6 已知残留风险与去向

**8.6.1 R4 清单（来自本轮验证，如实记录）**

| 编号 | 项 | 去向 | 说明 |
|---|---|---|---|
| R4-1 | 期初余额表无 `subject_id` | R4 | 科目改名后旧期初落 `unmapped`（金额不翻倍，表尾点名）；需期初迁 id 或保留旧键映射（subject-reports R4-1） |
| R4-2 | 历史付款「有核销无 posted 凭证」 | R4 | 报表余额与台账 `outstanding` 会分叉；需数据修复/补挂账或报表口径调整（R4-2） |
| R4-3 | 利润表 `unmapped` 把非损益发生额当「未归位」 | R4 | 非损益科目发生额被列进利润表表尾；需按报表类型过滤（R4-3） |
| R4-4 | 进项税留抵是否重分类到资产侧 | R4（财务口径待拍板） | 当前资产负债表以 −13 冲减「应交税费」；留抵是否列「其他流动资产」需财务确认（R4-4） |
| R4-5 | `withLineSubjects` 每凭证多 2 次科目查询 | R4（优化） | 与 `subjectByName` 重复；合并会改 R2-2/R3-1 已验收契约（R4-5） |
| R4-6 | `voucher_lines.subject_id` 回填覆盖率巡检 | R4 | 生产历史行回填后仍有 16 行无法唯一回填；需定期巡检 + 科目文本映射（R4-6） |
| R4-7 | Excel / PNG 导出未加「业务科目（辅助）」列 | R4 | 凭证页/打印有辅助科目，导出件还没有（R4-7） |
| R4-8 | 对账列表未返回逐条 `invoice_type` | R4 | 对账明细需逐条显示发票类型/税额（R4-8） |
| R4-9 | 集成测试 R1–R3 全量翻修 | R4 | 构造服务未注入 `VoucherService`、引用已删除 `flow.itemId`/`dictionaryItem` 旧字段；**不得伪造通过**，本轮记为 TEST_BLOCKED + R4 |

**8.6.2 明确不做 / 范围外**

| 项 | 去向 | 说明 |
|---|---|---|
| 分次付款 / 分次收款 | **明确不做（D4 后果）** | 一张单据必须一次结清；要分次只能拆成多张业务单据 |
| 应收销项税不拆 | **明确不做（R4 候选）** | 用户本轮只拍进项；销项税率/收入科目口径未定 |
| 期间关账 / 红冲期间规则 | R4 | 11-07 §9 C6 |
| 银行互转凭证与汇兑损益 | R4 | 11-07 §9 C10；互转仍只在银行余额层面 |
| 工资「应付职工薪酬」两步 | R4 | 11-07 §9 C7；工资付款仍付款即费用 |
| 流水与凭证同事务 | R4 或维持 | 按 brief 不重构支付链；失败补偿靠 R3-8 盘点/人工 |
| 历史错账（批次 D）与 16 行科目文本 | 财务逐笔确认 | R3-8 只给清单/脚本，不自动改生产 |
| 存量草稿凭证 | R3-8 清单人工处理 | 不自动过账；`regenerate` 保持 draft |

### 8.7 最终门禁回填（2026-11-09 已回填）

| 项 | 最终结果 |
|---|---|
| API 全量单测 | **2972 / 2972 pass / 0 fail** |
| Web 单测 | **lib 430 / 430；组件 75 files / 1293 tests 全 pass** |
| `npm run typecheck`（全工作区） | **exit 0**（api / coding-worker / web） |
| `next build` | **exit 0** |
| 独立探针（R3-11，≥12 例含 ≥2 反证） | **26 / 26 PASS；反证 2 / 2 PASS** |
| 集成 / HTTP 全套 | **TEST_BLOCKED**（`TEST_DATABASE_URL` 未设置，exit 3，未伪造通过）；集成文件本身待 R4-9 |
| 真实 PostgreSQL 冒烟（task-31） | **17 / 17 PASS** |
| 报表口径复核（task-30） | **17 / 17 PASS** |

> 回填完成：以上为 test-sync / task-30 / task-31 的最终结果；与 §8.3「写稿时快照」的差异（4 条旧守卫更新、全量 2972、探针 26/26、真实 PG 17/17）已以本节为准。

---

## 9. 参考

- 任务简报与契约原文：[finance-governance-r2-r3-briefs-2026-11-09.md](finance-governance-r2-r3-briefs-2026-11-09.md)
- R1 口径：[finance-accrual-policy-2026-11-09.md](finance-accrual-policy-2026-11-09.md)、[docs/log/2026-11-09.md](../log/2026-11-09.md)
- 诊断（问题来源）：[finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md)
- 被取代的旧口径：[finance-cost-accounting-and-voucher-editing-2026-09-20.md](finance-cost-accounting-and-voucher-editing-2026-09-20.md)、[docs/log/2026-09-20.md](../log/2026-09-20.md)
- 迁移：`apps/api/prisma/migrations/20261109130000_finance_governance_r3/migration.sql`；schema：`apps/api/prisma/schema.prisma`
- 独立验证资产：`.agent/verify/finance-r2-r3-2026-11-09-probe.mjs` + `-results.json` + `-report.md`（R3-11，可复跑）；报表口径复核 `.agent/verify/finance-r3-14-review-probe.mjs` + `-results.json`（task-30）
- 真实 PG 冒烟：`tmp/finance-review/08-e2e-smoke.cjs` / `.md` / `.raw.json`（task-31，本地库全量迁移后 17/17）
- 存量盘点与修复：`apps/api/prisma/maintenance/2026-11-09-finance-repair.sql` + `tmp/finance-review/2026-11-09-repair-inventory.md`（R3-8）
- 收口总结：[docs/log/2026-11-09-r2-r3-summary.md](../log/2026-11-09-r2-r3-summary.md)；开发日志：[docs/log/2026-11-09.md](../log/2026-11-09.md)
