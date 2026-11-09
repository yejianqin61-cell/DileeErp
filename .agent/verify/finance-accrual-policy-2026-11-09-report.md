# 独立验证报告：2026-11-09 财务挂账口径（D1 / D2 / A1 / A3a / A5）

> 任务：shared task-9（revision 2）。独立验证，不复用实现者/test-sync 的用例。
> 结论：**22 / 22 探针断言 PASS**；`npm run typecheck --workspace=@dilee/api` exit=0；3 个基线测试文件 42 个用例全绿（18 + 18 + 6，exit=0）。**未发现 FAIL**。
> 唯一需要 lead 裁决的不是实现缺陷，而是**设计文档与实现的一处口径不一致**（§6.1）。
>
> 探针：`.agent/verify/finance-accrual-policy-2026-11-09-probe.mjs`（可复跑）
> 机器结果：`.agent/verify/finance-accrual-policy-2026-11-09-results.json`（22 条，逐条含断言明细）
> 复跑：`node .agent/verify/finance-accrual-policy-2026-11-09-probe.mjs`

## 0 验证对象与方法

| 项 | 事实 | 证据 |
|---|---|---|
| 被测产物 | `apps/api/dist`（今日 12:22:23 build）；所有相关 src 最新 mtime 为 12:21:22（`receivable.service.ts`），**dist 晚于 src** | `Get-ChildItem apps/api/src/modules/finance/*.ts / dist/modules/finance/*.js | Sort LastWriteTime` |
| 口径来源 | `docs/design/finance-accrual-policy-2026-11-09.md`（12:14:05，D1/D2/D3 + R1 清单 + §3 契约 + §5 验收） | 设计文档全文 |
| 探针方式 | `require` dist 的真实 `VoucherService` / `SupplierPayableService` / `ReceivableService` / `FinanceThreeStatementsService`；**手写内存 Prisma 替身**（`$transaction` 带快照回滚语义）+ 手写 Audit 替身；`node:assert` 风格自断言 | 探针 `makeDb()` / `makeAudit()` |
| 不读什么 | 未 import、未读取 `apps/api/test/` 下被 test-sync 修改的 3 个文件（`accounting-subject-catalog.test.cjs`、`accounting-subject-service.test.cjs`、`cash-flow-autocreate.test.cjs`）；回归只选**未被本轮修改**的基线文件 | §2.7 |
| 不做什么 | 不连数据库、不改 src、不改 test、不 commit、不读生产库 | — |

## 1 结论摘要

| 编号 | 待验内容 | 结论 | 探针用例 |
|---|---|---|---|
| 1 | D1 原材料存货（候选链首位） | **PASS** | D1-01、D1-02 |
| 2 | D2 确认即过账（post / client / 幂等三态） | **PASS** | D2-01 ~ D2-06 |
| 3 | D2 确认与挂账同一事务（回滚 + 正例） | **PASS** | D2-07、D2-08 |
| 4 | A1 销账判定只认 posted | **PASS** | A1-01 |
| 5 | A3a 红字不可再红冲 + 挂账凭证存在时禁止回退/冲销/删除 + 仅 draft 时软删 | **PASS** | A3a-01 ~ A3a-08 |
| 6 | A5 三大报表排除红字凭证 | **PASS** | A5-01 ~ A5-03 |
| 7 | 回归（typecheck + 3 个核心测试文件） | **PASS** | 命令与结果见 §2.7 |
## 2 逐项验证

### 2.1 第 1 项 · D1：原料入库/到货的挂账借方首选「原材料」

- **结论：PASS**
- **探针**：D1-01 / D1-02
- **断言**：
  - `paymentSubjectNames("raw_material_inbound") = ["原材料","主营业务成本"]`（首位原材料、兜底仍是主营业务成本）；
  - `DEFAULT_PAYMENT_SUBJECT_NAMES[0] = "原材料"`、`PAYABLE_CONFIRM_SUBJECT_NAMES[0] = "原材料"`、`paymentSubjectNames("purchase_receipt")[0] = "原材料"`；
  - 科目表里「原材料」的 `category = "资产类"`（存货口径）；
  - 未被 D1 波及：`outsource_receipt` 首位仍 `加工费`、`other` 首位仍 `管理费用`。
- **证据（src）**：`apps/api/src/modules/finance/accounting-subject-catalog.ts:395`（raw_material_inbound）、`:397`（purchase_receipt）、`:405`（DEFAULT）、`:411`（PAYABLE_CONFIRM）、`:415`（paymentSubjectNames）、`:52`（「原材料」=资产类）。

### 2.2 第 2 项 · D2：`createAccrual` 直接过账 / 事务内创建 / 幂等

- **结论：PASS**
- **探针**：D2-01 ~ D2-06
- **断言与结果**：

| 用例 | 断言 | 结果 |
|---|---|---|
| D2-01 | `{post:true}`（事务外）→ 返回值 `status="posted"`、`replayed=false`；落库凭证 `status="posted"`；`$transaction` 恰好 1 次；至少 2 条分录；审计含 `voucher.post(auto=true, reason=confirm_post)` | PASS（transactions=1、已 posted） |
| D2-02 | 传 `{client: tx}` → root `$transaction` **0 次**；`accountingSubject.findMany` / `voucher.findFirst` / `voucher.create` / `voucherLine.createMany` 全部记录在 client 上 | PASS（root tx=0，client 调用有凭证写入） |
| D2-03 | 已 `posted` 且金额/币种一致 → `replayed=true`、复用原 id、**不 create / 不 update** | PASS |
| D2-04 | 已 `posted` 但金额不一致 → **422 `VOUCHER_ACCRUAL_AMOUNT_MISMATCH`** | PASS（422 + 正确 code） |
| D2-05 | 已 `reversed` → **422 `VOUCHER_ACCRUAL_REVERSED`** | PASS（422 + 正确 code） |
| D2-06（附加） | 已 `draft` + `post:true` → 按入参重建（清旧分录、2 条新分录、借方「原材料」）后过账，`replayed=true` | PASS（debit=原材料、debitTotal=100） |

- **证据（src）**：`voucher.service.ts:269-280`（新增 `options{client,post}`）、`:278`（`db = options.client ?? prisma`）、`:286-305`（幂等三态）、`:291-305`（金额/币种/已红冲守卫）、`:346-372`（draft 重建后过账）、`:375`（`createVoucher(..., {client, status: wantPosted ? "posted" : "draft"})`）、`:490`（`createVoucher` 的 client/status 入参）、`:512-521`（client 分支不另开事务 + `voucher.create`/`voucher.post` 审计）。

### 2.3 第 3 项 · D2 事务性：确认与挂账同事务

- **结论：PASS**
- **探针**：D2-07（正例）、D2-08（回滚）
- **断言与结果**：
  - 正例：`SupplierPayableService.confirm` 成功后 `entry.status = "confirmed"`，同时挂账凭证 `status="posted"`（`sourceType=supplier_payable`、`sourceId=ap-1`）；`$transaction` 仅 1 次（挂账不再另开）；挂账借方 = 「原材料」（D1 与 D2 联动正确）。
  - 回滚：让挂账步骤在 `subjectByName` 抛 `ACCOUNTING_SUBJECT_NOT_FOUND`（科目表为空）→ 异常为 422 且 **entry 仍为 `draft`、凭证表 0 张、无 `supplier_payable.confirm` 审计**（证明两件事在同一事务里，挂账失败整体回滚）。
- **证据（src）**：`supplier-payable.service.ts:242-252`（`$transaction` 内 update 状态 + `this.accrue(..., tx)`）、`:250`、`:291`（`{client, post:true}`）；其余四个确认入口静态核对亦已改为同事务 + 直接过账：`supplier-payable.service.ts:316/339`（批量）、`receivable.service.ts:182/221`（逐条）、`:258/:311`（批量/按订单）、`reconciliation.service.ts:184-195`、`supplier-payable-reconciliation.service.ts:217-230`。

### 2.4 第 4 项 · A1：销账判定只认 posted

- **结论：PASS**
- **探针**：A1-01
- **断言**：`accruedSourceIds` 的 `where` 为 `{ sourceType, sourceId:{in}, deletedAt:null, status:"posted" }`；对「只有 draft 凭证」返回空集，对「posted 凭证」命中 `p-posted`。
- **证据（src）**：`voucher.service.ts:419-424`（`status: "posted"`，旧口径是 `{not:"reversed"}`）；消费点 `supplier-payment.service.ts:136`、`customer-payment.service.ts:129`。

### 2.5 第 5 项 · A3a：红字不红冲 + 挂账凭证存在时禁止回退/冲销/删除 + draft 软删

- **结论：PASS**
- **探针**：A3a-01 ~ A3a-08

| 用例 | 断言 | 结果 |
|---|---|---|
| A3a-01 | `voucher.reverse` 对 `sourceType="voucher"` → 422 `VOUCHER_RED_NOT_REVERSIBLE`；不生成红字凭证；守卫在 `$transaction` 之前生效 | PASS（事务 0 次） |
| A3a-02 | 应付 `reopen` + 存在 posted 挂账凭证 → 422 `SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL`，entry 不变 | PASS |
| A3a-03 | 应付 `reverse`（同上）→ 422 同上，entry 不变 | PASS |
| A3a-04 | 应付 `removeOther`（任务描述里的 deleteOther）→ 422 同上，不软删 | PASS |
| A3a-05 | 应收 `reopen` → 422 `RECEIVABLE_SOURCE_HAS_POSTED_ACCRUAL`，状态不变 | PASS |
| A3a-06 | 应收 `cancel` → 422 同上，状态不变 | PASS |
| A3a-07 | 只有 draft 挂账凭证时应付 `reopen`：entry→draft，且 `voucher.update` 收到 `deletedAt`（软删草稿，审计操作人正确） | PASS |
| A3a-08 | 只有 draft 挂账凭证时应收 `cancel`：source→cancelled，草稿凭证被软删 | PASS |

- **证据（src）**：`voucher.service.ts:804`（红字不可再红冲）、`:436-439`（`postedAccrualOf` 只查 posted）、`:447-455`（`discardDraftAccrual` 只软删 draft）；`supplier-payable.service.ts:393-396`（reopen）、`:412-414`（reverse）、`:469-472`（removeOther）；`receivable.service.ts:356-358`（reopen）、`:373-375`（cancel）。

### 2.6 第 6 项 · A5：三大报表取数排除红字凭证

- **结论：PASS**（where 断言 + 端到端行为 + 灵敏度反证）
- **探针**：A5-01 ~ A5-03
- **断言与结果**：
  - A5-01：报表 `voucher.findMany` 的 `where = {status:"posted", deletedAt:null, sourceType:{not:"voucher"}, voucherDate:{lte:...}}` → `sourceType.not === "voucher"` PASS。
  - A5-02：数据 = 1 张正常 posted（借 银行存款 100 / 贷 主营业务收入 100，`sourceType=cash_flow_entry`）+ 1 张 posted 红字（反向分录，`sourceType=voucher`）→ 资产负债表 `货币资金=100、资产总计=100`；利润表 `营业收入=100、unmapped=0`；现金流量表 `销售商品收到的现金=100、净增加=100、期末现金=100、unmapped=0` → PASS（红字未进表）。
  - A5-03（灵敏度反证）：同一份数据**故意剥掉** `sourceType` 过滤（模拟未实现 A5 的旧代码）→ 资产总计 0、营业收入 0、现金流量表 `unmapped` 多出 1 条 → PASS。这证明 A5-02 的「100」不是假通过（若实现漏了过滤，A5-02 必然失败）。
- **证据（src）**：`finance-three-statements.service.ts:213`（`sourceType: { not: "voucher" }`，注释 `202-212`）。

### 2.7 第 7 项 · 回归

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck --workspace=@dilee/api` | **exit=0** | `tsc --noEmit` 无输出（无类型错误） |
| `node --test apps/api/test/unit/finance-three-statements.test.cjs` | **exit=0，18 tests** | 验证前后 `git status` 均为未修改（基线） |
| `node --test apps/api/test/unit/voucher-domain.test.cjs` | **exit=0，18 tests** | 同上 |
| `node --test apps/api/test/unit/cash-flow-business-subject.test.cjs` | **exit=0，6 tests** | 同上 |

合计 42 个用例全绿；选的是**在验证开始与结束两次 `git status` 中均未被 test-sync 修改**的 3 个核心文件（财务报表内核、凭证分录 domain、收支业务科目口径），符合 task-9「不要求全量、确认基线未被破坏」的要求。

> 说明：验证过程中观察到 test-sync 正在**并发修改**其它 API 单测（如 `finance-three-statements-service.test.cjs`、`voucher-service.test.cjs` 等在 12:31 后出现在 `git status`）；为不与被改用例混在一起，本项只选上述 3 个稳定基线文件；先前一次跑过 `finance-three-statements-service.test.cjs`（当时 exit=0）不计入本报告证据。

## 3 探针结果总表（22/22 PASS）

| # | 用例 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | D1-01 | PASS | 首位「原材料」，资产类 |
| 2 | D1-02 | PASS | DEFAULT/PAYABLE_CONFIRM/purchase_receipt 首原材料；外加工/其他应付不受影响 |
| 3 | D2-01 | PASS | post:true → posted；事务 1 次；voucher.post 审计 |
| 4 | D2-02 | PASS | client 路径 root tx=0，读写全走 client |
| 5 | D2-03 | PASS | 幂等同额 → replayed，不重建 |
| 6 | D2-04 | PASS | 同额不同 → 422 AMOUNT_MISMATCH |
| 7 | D2-05 | PASS | reversed → 422 REVERSED |
| 8 | D2-06 | PASS | draft → 重建过账（附加项） |
| 9 | D2-07 | PASS | confirm 同事务正例：confirmed + posted |
| 10 | D2-08 | PASS | 挂账抛错整体回滚，entry 仍 draft |
| 11 | A1-01 | PASS | where.status=posted；draft 不算已挂账 |
| 12 | A3a-01 | PASS | 红字不可再红冲（事务前拦截） |
| 13 | A3a-02 | PASS | 应付 reopen 拦截 |
| 14 | A3a-03 | PASS | 应付 reverse 拦截 |
| 15 | A3a-04 | PASS | 应付 removeOther 拦截 |
| 16 | A3a-05 | PASS | 应收 reopen 拦截 |
| 17 | A3a-06 | PASS | 应收 cancel 拦截 |
| 18 | A3a-07 | PASS | 仅 draft → 软删草稿（含 deletedBy） |
| 19 | A3a-08 | PASS | 仅 draft → 应收侧软删草稿 |
| 20 | A5-01 | PASS | where.sourceType.not='voucher' |
| 21 | A5-02 | PASS | 端到端三表排除红字 |
| 22 | A5-03 | PASS | 灵敏度反证（去过滤即算错） |

## 4 证据行汇总（src → 变更点）

| 变更 | src 证据行 |
|---|---|
| D1 候选链 | `accounting-subject-catalog.ts:395,397,405,411,415`；「原材料」资产类 `:52` |
| D2 `createAccrual` 事务/过账 | `voucher.service.ts:269-280,278,286-305,346-372,375,490,512-521` |
| D2 五个确认入口同事务 | `supplier-payable.service.ts:242-252,291,316,339`；`receivable.service.ts:182,221,258,311`；`reconciliation.service.ts:184-195`；`supplier-payable-reconciliation.service.ts:217-230` |
| A1 只认 posted | `voucher.service.ts:419-424`；`supplier-payment.service.ts:136`；`customer-payment.service.ts:129` |
| A3a 红字守卫 | `voucher.service.ts:804` |
| A3a 挂账凭证护栏 | `voucher.service.ts:436-455`；`supplier-payable.service.ts:393-396,412-414,469-472`；`receivable.service.ts:356-358,373-375` |
| A5 报表排除红字 | `finance-three-statements.service.ts:202-213` |

## 5 覆盖边界与未覆盖说明（诚实声明）

1. **替身不是数据库**：内存 Prisma 替身不含唯一索引、外键、CHECK、并发锁；因此「`vouchers_source_type_source_id_key` 撞键后原地复活」「并发确认」等语义**未验证**（本轮清单也未要求）。
2. **五个确认入口只对 `SupplierPayableService.confirm` 做了行为验证**；其余 4 个入口（应付批量、应收逐条/批量/按订单、两张对账单）只做**静态核对**（都调用 `createAccrual(..., {client: tx, post:true})`）——接口形状一致但未逐条跑行为。
3. **未验证**：R1-7（改分录审计 before/after）、R1-8（web 文案）不在 task-9 的 7 项清单内；收/付款凭证自动过账明确不在本轮（设计文档 §4）。
4. **A5 端到端**用合成凭证（1 正常 + 1 红字，CNY、无期初、无汇率），未覆盖多币种折算、科目期初、跨期间红冲链；红冲链场景由 `sourceType.not` 全量排除，逻辑上覆盖，但未做长链用例。
5. **未读生产库**：本验证不替代生产数据取证；本轮无数据迁移。

## 6 非 FAIL 的发现（需 lead 裁决 / 记录）

### 6.1 设计文档 §3 与实现不一致：已红冲的挂账凭证「重建」还是「422」

- 设计文档 `docs/design/finance-accrual-policy-2026-11-09.md:78` 写的是：「`post=true` 且来源已有**已红冲**挂账凭证：视为不存在，允许重建（配合 R1-5 的红冲守卫与幂等修复）」。
- 实现是 **422 拒绝**：`voucher.service.ts:303-305` 抛 `VOUCHER_ACCRUAL_REVERSED`（消息：请先在凭证页处理，再重新确认）。
- task-9 的验证清单第 2 项 (c) 明确要求「已 reversed → 抛 422 VOUCHER_ACCRUAL_REVERSED」——**按任务书判 PASS**。
- 但文档与实现二者只能对一个：要么改文档（推荐，因为唯一键 `(source_type, source_id)` 仍被已红冲行占着，真重建必须处理唯一键，而设计文档 §3 也只说「允许重建」没给路径），要么这是实现遗漏（若口径确实是重建，则 R2 需要补「按来源重算」入口）。**建议 lead 让实现者/文档 owner 对齐，别留到 R2 踩。**

### 6.2 命名

task-9 描述写「应付 … deleteOther」，实现方法是 `SupplierPayableService.removeOther`（`supplier-payable.service.ts:442`）。本探针按实际方法 `removeOther` 验证；仅是任务书用词差异，不是缺陷。

## 7 复跑命令

```powershell
# 探针（22 条断言，生成 results.json；有 FAIL 时 exit code = 1）
node .agent/verify/finance-accrual-policy-2026-11-09-probe.mjs

# 回归（typecheck + 3 个基线测试文件）
npm run typecheck --workspace=@dilee/api
node --test apps/api/test/unit/finance-three-statements.test.cjs
node --test apps/api/test/unit/voucher-domain.test.cjs
node --test apps/api/test/unit/cash-flow-business-subject.test.cjs
```
