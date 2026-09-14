# Task 01：财务一级页与路由重构

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

把财务从「7 个板块平铺的一张长页」改为「一级 4 个板块入口 + 二级子栏目页」，并保留旧地址可用。

## 关联决策

- `docs/design/finance-module-refactor-2026-09-14.md`
- 宪法《Decision Traceability》《Configurable Business Categories》

## 范围与非范围

范围内：

- `/finance` 只展示 4 个入口卡片（应收管理 / 应付管理 / 薪资台账 / 凭证管理）；
- 二级页 `/finance/receivable`、`/finance/payable`、`/finance/salary`、`/finance/voucher`；
- 旧 7 个平铺地址（`/finance/receivable-sources` 等）重定向到新二级页；
- `lib/finance-sections.ts` 重写为「板块 + 子栏目 + 旧地址映射」三份清单（保持无 `"use client"`）。

非范围：

- 不改财务后端状态机；
- 不引入路由库或全局状态管理。

## 验收与验证

1. `/finance` 只渲染 4 个入口，每个 `href` 指向对应二级页（组件测试）；
2. 子栏目是真实链接（带 `?tab=`），可收藏；
3. 旧地址 `redirect()` 到新地址，白名单外 `notFound()`（源码约定测试 + 用例）；
4. `next build` 通过（验证 RSC 边界：Server Component 不得从 client 模块导入大写常量）。

## 决策记录

- 子栏目用**查询参数**而不是路径段：旧地址重定向时能直接带上 tab，且不需要 `useSearchParams()`（避免静态构建的 Suspense 边界问题）；
- 一级页不加载数据，因此 `page-finance` 立即可见（重构前要等 11 个接口）；
- 旧的 `finance-workspace.tsx` 与已废弃的 `lib/finance-draft-edit-method.test.mjs` 一并删除，
  其运行时意图由新的 `test/finance-page.test.tsx` 继承（PATCH vs POST、URL 指向 `/:id`）。

## 完成记录

- 新增：`finance-board-index.tsx`、`finance-tabs.tsx`、`finance-status.ts`、`receivable/page.tsx`、`payable/page.tsx`、`voucher/page.tsx`；
- 重写：`lib/finance-sections.ts`、`app/finance/page.tsx`、`app/finance/[section]/page.tsx`；
- 删除：`components/finance/finance-workspace.tsx`、`lib/finance-draft-edit-method.test.mjs`；
- 测试：`test/finance-page.test.tsx` 重写为 21 条；`test/testid-pages.test.ts` 增加「纯重定向页面必须 redirect()」用例；
  `lib/outbound-notice-entries.test.mjs` 的财务断言改指向新组件。
- 验证结果：web typecheck 通过；`vitest run` 517 条通过；`next build` 通过（34 个页面全部生成成功）。
