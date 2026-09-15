# Task 05：凭证管理占位

> **2026-09-15 已被需求推翻**：用户当天要求「凭证管理，从收支流水中 fetch，每条收支条目都可以生成对应的
> 条目」，占位页已替换为真实的凭证模块（收支流水 → 生成凭证 → 凭证纸打印/另存 PDF）。
> 新设计见 `docs/design/accounting-vouchers-2026-09-15.md`，实现见 `voucher.service.ts` /
> `voucher.domain.ts` / `components/finance/voucher-workspace.tsx`。本文保留为占位期的决策记录。

## 状态
已完成（已过时，见上方说明）

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

在财务一级页给出「凭证管理」入口，二级页为占位：只显示「待生成凭证的已确认应收/应付条目数」，
不提供任何写操作。

## 关联决策

- `docs/design/finance-module-improvement-spec-2026-09-02.md` 的 Out of Scope 明确：
  「会计总账、凭证、会计科目和财务期间结账」不在 V1 范围；
- 用户 2026-09-14 指令：凭证管理「回头再说，可以先占位」。

## 范围与非范围

范围内：

- 入口 + 占位页 + 已确认应收/应付的条数与金额预览 + 一个禁用的「生成单据（建设中）」按钮。

非范围：

- 单据编号规则、会计科目、期间结账、任何写接口与数据模型。

## 验收与验证

1. `/finance/voucher` 可访问并渲染页面根 `page-finance-voucher`；
2. 只统计 `confirmed / partially_paid / paid` 的应收与应付（组件测试断言草稿与已取消不计入）；
3. 页面明确标注建设中，且没有任何会写数据的按钮。

## 决策记录

- 预览数据直接复用 `/finance/receivable-sources` 与 `/finance/payable-entries` 的既有口径，
  **不新增后端接口**：占位页提前固化凭证模型（单据号、科目）会把后面的设计锁死；
- 「待生成凭证」的口径取「已确认及之后」的全部状态，而不是只取 `confirmed`：
  部分收款/已收清的应收与部分付款/已付清的应付同样是已生效的财务事实，将来都要出凭证。

## 完成记录

- 新增 `components/finance/voucher-workspace.tsx`、`app/finance/voucher/page.tsx`；
- 组件测试 1 条（只统计已确认；草稿与已取消不计入；按钮禁用）。
- 验证结果：web typecheck 通过；`vitest run` 全绿；`next build` 中 `/finance/voucher` 为静态页。
