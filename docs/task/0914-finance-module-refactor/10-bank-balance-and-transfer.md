# 07 · 银行余额管理与「确认即记账」

> 需求来源：用户 2026-09-16 的五条原文（见 `docs/design/bank-balance-and-transfer-2026-09-16.md` 开头）。
> 本文件是**落地清单**；为什么这样做（决策 D1–D11）与已知缺口在 design 文档里，不在这里重复。

## 目标

1. 财务新增「银行余额互转」栏目：银行池内账户之间互转（本方账户 / 本方币种 / 对方账户 / 对方币种），
   并支持设置银行**期初金额**。
2. 应收/应付**一经确认即记账**：金额进入（应收）或转出（应付）对账单指定的银行账户。
3. 应收/应付的**所有表单**都能填银行账户。
4. 应收/应付的**所有表单**都能填「收支管理 → 收支项目」。
5. 收支明细表因此能按收支项目正确统计每一笔流水。

## 数据模型

- `banks.opening_balance DECIMAL(18,4) NOT NULL DEFAULT 0`
- `cash_flow_entries.bank_id UUID`（可空，SET NULL）+ `(bank_id, status)` 索引
- `customer_payments.cash_flow_item_id` / `supplier_payments.cash_flow_item_id`
- `receivable_reconciliations.cash_flow_item_id` / `supplier_payable_reconciliations.cash_flow_item_id`
- 新表 `bank_transfers`：`transfer_no`（唯一）、`transfer_date`、`from_bank_id/from_currency/from_amount`、
  `to_bank_id/to_currency/to_amount`、`exchange_rate`、`status`、`reversal_reason`、`remark` + 审计列

迁移：`apps/api/prisma/migrations/20260915180000_bank_balances_and_transfers/migration.sql`
（守卫测试 `apps/api/test/unit/bank-balance-migration.test.cjs`）

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/finance/banks/balances?as_of=` | 全部账户余额明细（期初/收/付/转入/转出/余额/流水条数） |
| GET | `/finance/banks/:id/balance?as_of=` | 单账户余额明细 |
| GET | `/finance/bank-transfers?from=&to=&bank_id=` | 互转列表 |
| POST | `/finance/bank-transfers` | 新建互转；响应带 `source_balance_before/after`、`insufficient_balance` |
| POST | `/finance/bank-transfers/:id/reverse` | 冲销（保留整行） |
| POST | `/finance/reconciliations/:id/confirm-receivables` | body `{ bank_id?, cash_flow_item_id? }`；同时记账 |
| POST | `/finance/supplier-payable-reconciliations/:id/confirm-payables` | 同上（支出方向） |
| POST | `/finance/receivable-sources/:id/confirm` | 逐条确认应收 + 记账（body `{ bank_id?, cash_flow_item_id? }`） |
| POST | `/finance/receivable-sources/batch-confirm-by-order` | 按订单批量确认 + 记账（每条应收一条流水）；**界面入口已于 2026-09-16 下线，接口保留** |
| POST | `/finance/payable-entries/:id/confirm` | 逐条确认应付 + 记账 |
| POST | `/finance/receivable-sources/batch-confirm` | 勾选批量确认应收 + 记账（body `{ ids[], bank_id?, cash_flow_item_id? }`，每条一条流水） |
| POST | `/finance/payable-entries/batch-confirm` | 勾选批量确认应付 + 记账（同一契约，支出方向） |

既有接口新增可选字段：`POST /finance/banks`（`opening_balance`）、`PATCH /finance/banks/:id`、
`POST/PATCH /finance/customer-payments`、`POST/PATCH /finance/supplier-payments`、
`POST /finance/reconciliations`、`POST /finance/supplier-payable-reconciliations`（均加 `cash_flow_item_id`）、
`POST/PATCH /finance/cash-flow-entries`（`bank_id`）。

## 余额公式（唯一口径）

```
余额 = 期初余额 + 生效收入流水 − 生效支出流水 + 转入 − 转出
```

- 只算 `status = posted`；已冲销不算。
- 只算 `cash_flow_entries.bank_id = 本账户` 的流水；没指定账户的流水不进任何账户余额。
- 互转（`bank_transfers`）只进余额，**不进收支明细/汇总表**。
- 实现：`apps/api/src/modules/finance/bank-balance.domain.ts` 的 `bankBalance()`。

## 前端

- `apps/web/lib/finance-sections.ts`：`FINANCE_BOARDS` 新增 `bank-transfers`（标题「银行余额互转」）。
- `apps/web/app/finance/bank-transfers/page.tsx` + `components/finance/bank-transfer-workspace.tsx`（新）。
- `components/finance/bank-workspace.tsx`：期初余额字段 + 期初/当前余额列。
- `components/finance/cash-flow-workspace.tsx`：银行账户字段与列。
- `components/finance/receivable-workspace.tsx` / `payable-workspace.tsx`：收支项目字段 +
  「确认应收/应付」弹窗（可补银行与项目，`bank_missing` 时警告）。

## 验收（人工）

1. 财务 → 银行账户：建两个账户（各填期初余额），列表能看到余额。
2. 财务 → 银行余额互转：CNY 账户转 1000 到另一个 CNY 账户 → 双方余额各变 1000；
   跨币种互转要填对方金额；转出超过余额时给警告但仍落库；冲销后余额复原。
3. 应收：成品出库过账 → 创建对账（选回款银行 + 收支项目）→ 一键确认应收 →
   **银行余额增加**该笔金额，收支明细表出现一条带项目与银行账户的收入流水。
4. 应付：原料入库过账 → 接收应付 → 创建对账（选支付银行 + 收支项目）→ 确认应付 →
   **银行余额减少**，收支明细表出现带项目与银行账户的支出流水。
5. 财务报表 → 收支明细表：8 列，项目与银行账户逐行显示；收支汇总表按项目分类的合计与明细对得上。
