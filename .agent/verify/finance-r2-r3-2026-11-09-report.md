# R2 / R3 独立验证探针报告（2026-11-09）

> 任务：task-26（R3-11 最终门禁）第 C 项 —— 独立探针 ≥12 例、含 ≥2 反证。
> 脚本：`.agent/verify/finance-r2-r3-2026-11-09-probe.mjs`（可重复运行）
> 结果：`.agent/verify/finance-r2-r3-2026-11-09-results.json`
> 口径依据：[`docs/design/finance-governance-r2-r3-2026-11-09.md`](../../docs/design/finance-governance-r2-r3-2026-11-09.md) §3 共享契约 A–F。

## 0. 结论

| 项 | 值 |
|---|---|
| 用例数 | **26**（要求 ≥12） |
| 通过 | **26** |
| 失败 | **0** |
| 反证用例 | **2 / 2 通过**（要求 ≥2） |
| 运行方式 | `node .agent/verify/finance-r2-r3-2026-11-09-probe.mjs` |
| 被测对象 | `apps/api/dist`（真实 service；不 import src / test） |
| 数据库 | 不连库：手写内存 Prisma 替身（含事务回滚语义与唯一约束模拟） |
| 结论 | D4 / D5 / R3-1 / R3-4 / R3-5 / R3-6 / R3-7 的外部行为与契约一致；**未发现实现 bug** |

## 1. 环境与可复现性

- Node：本机 `node`；`dist` 构建时间 13:36:11–13:36:13，晚于全部 `apps/api/src` 最新 mtime（13:35:28）→ 探针加载的是当前源码的产物。
- 探针自带断言与替身，不依赖 `apps/api/test/**` 中的任何用例（避免「拿被测方的测试证明被测方」）。
- 替身的关键保真点：
  1. `$transaction` 快照回滚（用于 D4 被拒后「付款仍草稿、无核销行」）；
  2. **部分唯一索引模拟**：同一来源仅「未删 + 未红冲 + source_id 非空」的行互斥（默认），并可切到 `global`（旧全局唯一键）做反证；
  3. 关系过滤按**当前**状态解析（如核销行的 `payment.status` 是 join 现值，不是创建快照）；
  4. `Decimal` 累加、`OR` / 嵌套条件、可空软删默认值。
- 已知不保真点（不影响本报告结论）：`orderBy`、`select`/`include` 的字段裁剪被忽略；`@default` 只补了本次用到的（`deletedAt=null`、核销行 `status='active'`）。

## 2. 逐项结果

### 2.1 D4 —— 强制核销额 = 单据额（5 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| D4-01 | 应付核销 60 / 未核销余额 100 → 422 `ALLOCATION_MUST_SETTLE_PAYABLE` | `details[0] = { available_amount: "100", requested_amount: "60" }`；付款仍 `draft`、核销行 0 条（事务回滚） |
| D4-02 | 付款金额 110 / 核销合计 100 → 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION` | 付款仍 `draft`、核销行 0 条 |
| D4-03 | 应收核销 60 / 未收余额 100 → 422 `ALLOCATION_MUST_SETTLE_RECEIVABLE` | 收款仍 `draft`、核销行 0 条 |
| D4-04 | 收款金额 110 / 核销合计 100 → 422 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION` | 收款仍 `draft`、核销行 0 条 |
| D4-05 | 历史 `partially_paid`（原单 100、已核 40）→ 只结余款 60 | 付款 60 过账成功；单据转 `paid`；累计核销 100；自动写 1 条收支流水；**不要求**回算原单据金额 |

> D4 是行为收紧：两次 422 都是预期结果（上线须知 §5.2），不是缺陷。

### 2.2 D5 —— 进项税拆分（5 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| D5-01 | 专票 11300 / 13% → 三行 | 借 原材料 **10000.0000** + 借 应交税费-进项税 **1300.0000** / 贷 应付账款 **11300.0000**；借合计 = 贷合计 = 11300.0000（严格相等）；三行均落 `subject_id`；不含税行带 `business_subject_id/label` |
| D5-02 | 普票（general）不拆 | 2 行、全额 11300 进「原材料」，无进项税行；给了 `tax_rate` 也不拆 |
| D5-03 | 专票缺税率 | 422 `INVOICE_TAX_RATE_REQUIRED`，未落库 |
| D5-04 | 税率 `13`（百分数写法，r≥1） | 422 `INVALID_TAX_RATE`，未落库 |
| D5-05 | 专票但科目表无进项税科目 | 422 `INPUT_TAX_SUBJECT_MISSING`，未落库（不静默换科目） |

### 2.3 R3-1 —— 凭证行科目 id 与辅助维度（3 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| SID-01 | 挂账凭证全部行落 `subject_id` | 借 原材料=`sub-raw`、贷 应付账款=`sub-ap`；借方 `business_subject_id=sub-cost`、`business_subject_label=主营业务成本`；贷方业务维度为空 |
| SID-02 | 同名跨类目 → `subject_id` 留空 | 科目表同时有「资产类/其他应收款」「损益类/其他应收款」→ 该行 `subject_id=null`、`subject_label` 快照保留；唯一命中的「银行存款」正常落 id |
| SID-03 | 红冲沿用原行 id | 红冲前把「原材料」改名；红字行仍 `subjectId=sub-raw`、`businessSubjectId=sub-cost`（不按名称重新解析）；原凭证置 `reversed` |

### 2.4 R3-4 —— 部分唯一索引（3 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| IDX-01 | 迁移 DDL 守卫 | 删除 `vouchers_source_type_source_id_key`；`vouchers_source_active_key` 的 `WHERE` 含 `deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`；schema 只有 `@@index([sourceType, sourceId])`，无 `@@unique` |
| IDX-02 | 红冲后可再建 | 来源只有 `reversed` 行时 `createAccrual(post:true)` 新建 `posted`；红冲历史行原样保留；同一来源有效凭证恰 1 张 |
| IDX-03 | 双 active 被拦 | 已有 `posted` 时再确认 → `replayed=true`、不调用 `voucher.create`；绕过服务层直插第二条同来源有效行会被唯一约束拦（P2002 / `vouchers_source_active_key`） |

### 2.5 R3-5 —— 冲销联动（3 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| LINK-01 | 付款冲销 | 付款单 `reversed`、核销行 `reversed`、收支流水 `reversed`、流水凭证原行 `reversed`；新增红字凭证 `posted`、`sourceType=voucher`、`sourceId=被红冲凭证`、借贷对调 |
| LINK-02 | 流水冲销 + 幂等 | 流水冲销后凭证被红冲、恰 1 张红字；再调 `reverseBySource` 返回 `null`，红字仍 1 张 |
| LINK-03 | 流水冲销 + 草稿凭证 | 返回 `action="draft_discarded"`、`redVoucherNo=null`；草稿被软删（`deletedAt` 有值、`deletedBy` 记录），不产生红字 |

### 2.6 R3-7 —— 自动过账 + 流水护栏（2 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| AUTO-01 | 流水自动凭证生成即 `posted` | 结果 `status=posted`、落库 `posted`；留 `voucher.post`（`auto:true, reason=cash_flow_auto_post`）；业务行 `business_subject_id` = 流水 `categorySubjectId` |
| AUTO-02 | 已过账凭证的流水不可改 | `cash-flow.update` → 422 `CASH_FLOW_HAS_POSTED_VOUCHER`（details 带凭证号），流水一字未改；无凭证的流水仍可更正成功 |

### 2.7 R3-6 —— reaccrue 与 accrual_status（3 例，全 PASS）

| id | 用例 | 证据 |
|---|---|---|
| RE-01 | 红冲后重算 | `reaccrue` 返回 `status=posted`、`replayed=false`；来源现有 2 张（1 `reversed` + 1 `posted`）；`payable.get().accrual_status="posted"` |
| RE-02 | 已 posted 时重算 | 422 `ACCRUAL_ALREADY_POSTED`，未新建凭证，提示先红冲 |
| RE-03 | `accrual_status` 四态 + 优先级 | `posted/draft/reversed/none` 四态正确；同一来源同时有 `reversed` + `posted` 时显示 `posted`（posted > draft > reversed） |

### 2.8 反证（2 / 2，全 PASS）

| id | 反证设计 | 结果 |
|---|---|---|
| CX-01 | 把部分唯一索引条件去掉、恢复**旧全局唯一键**语义，其余代码不变，重跑同一「红冲后重算」 | 部分索引语义下重算成功（新建第 2 张）；全局唯一键语义下**必须失败**（P2002，仍只有 1 张）→ 证明 IDX-02 不是假通过 |
| CX-02 | 用与 D5-01 完全相同的金额，但故意漏掉「借 应交税费-进项税 1300」这一行 | 凭证借贷不平 → 422 `VOUCHER_NOT_BALANCED`，未落库 → 证明拆税行是平衡的必要条件 |

## 3. 未覆盖 / 边界（明确声明）

1. **真实 PostgreSQL 行为不覆盖**：本机无 `TEST_DATABASE_URL`，集成测试 `TEST_BLOCKED`（见 §4）。部分唯一索引、事务回滚在真库上的行为由迁移 DDL + 集成测试保证；探针只按迁移条件模拟。
2. **报表按科目 id 归集（R3-2）不属本探针**：由 task-30（R3-14 独立复核）与本轮 `finance-three-statements-*` 单测覆盖。
3. **Web 展示（R3-9 / R2-5 / R2-6）不属本探针**：由 web 单测门禁覆盖。
4. **`reaccrue` 只验了应付侧**：应收侧 `ReceivableService.reaccrue` 与应付侧同构，本轮由 `receivable-service.test.cjs` 单测覆盖；探针已覆盖应收侧的 D4 两个错误码。
5. **流水凭证自动生成与流水创建是否同事务**：按 brief 允许保持现状；本轮实现为「过账后自动生成（独立调用）」，外部行为一致，未在探针内断言时序。

## 4. 关联门禁

- 集成测试（真库）：`npm run test:integration` → **TEST_BLOCKED**（`TEST_DATABASE_URL` 未设置，退出码 3）；两个财务链路文件直接运行 4/4 报 `TEST_BLOCKED`，**不伪造通过**。
- 其余门禁（typecheck / api 单测 / web 单测 / next build）数字见 Lead 汇总消息与 `tmp/gate-*.log`。

## 5. 复跑

```powershell
node .agent/verify/finance-r2-r3-2026-11-09-probe.mjs   # 26/26 PASS
```
