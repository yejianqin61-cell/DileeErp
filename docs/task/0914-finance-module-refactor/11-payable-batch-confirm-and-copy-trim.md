# Task 11：应付「勾选批量确认」与财务界面文案精简

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

1. 「财务部分，这种说明性的语句，全部去掉。比如说每次成品出库过账生成一条应收来源；
   一个订单分批出库就是多条，双击查看全部字段」
2. 「应付管理，原料入库条目这边，已接收的条目，就不要在这边的表单出现了。」
3. 「确认应付这边，就不要再搞那么多繁琐的步骤了。不要又是登记付款又是确认应付了。
   直接就是支持勾选，批量确认。」

设计见 [应付「勾选批量确认」与财务界面文案精简](../../design/finance-payable-batch-confirm-2026-09-16.md)。

## 范围

### 前端（财务全部页面）

- 删掉所有「解释系统怎么运作 / 该怎么用」的说明性文字：页面与子栏目 `description`、
  `panel-heading` 说明句、独立说明段、`EmptyState` / 详情弹窗的 `description` 与 `sections[].note`、
  字段 label 里的解释性括注、`type: "info"` 确认文案里的说明句；
- **保留**数据（计数、合计、状态）、校验规则括注与错误提示；
  说明句改成数据（如「待接收 3 条 · 已接收 1 条」「确认 2 条草稿应付（合计 800.0000 CNY）」）；
- 两个「待接收」子栏目只列**待接收**来源（已接收的从列表移出，计数里点名）；
- 「确认应付」改成台账 + **勾选 + 批量确认**；移除行内「登记付款」与「付款」子表；
  台账不再显示「已付 / 未付」两列（核销明细仍在详情里）。

### 后端

- 新增 `POST /finance/payable-entries/batch-confirm`（`SupplierPayableService.batchConfirm`）：
  整批一个支付银行 + 一个收支项目，**每条应付各写一条支出流水**；
  跳过非草稿与来源作废的条目并回报 `skipped_count`；
  银行/项目在事务前先校验；状态被并发改动时整批回滚（`PAYABLE_CONFIRM_CONFLICT`）；
  合计按币种分组返回（`amounts`）。

## 不做

- **不改 schema、不加迁移**：本轮没有新的持久化需求（批量确认复用 `confirm` 的记账口径）；
- **不删付款接口与数据**：`/finance/supplier-payments` 全套、`supplier_payment_allocations`、
  对账单的 `paymentAmountSnapshot` 全部保留（历史核销、采购侧通知、报表仍依赖）；
  去掉的只是「确认应付」页上的入口；
- **应收侧结构不动**：「确认应收 + 登记收款」有同样的重复记账形状，但用户本轮只点名应付，
  是否同样简化需要业务确认。

## 验收与验证

1. `batchConfirm` 单测 8 条：逐条写流水 / 跳过已确认 / 跳过作废来源 / 全不可确认时 422 /
   空 ids 422 / 银行非法先拒绝 / 跨币种分组 / 并发改动整批回滚；
2. 组件测试：勾选两条 → 一次 `batch-confirm`（请求体 `{ids, bank_id, cash_flow_item_id}`）；
   已确认行没有勾选框；未勾选时按钮禁用；`bank_missing` 给错误态警告并点名跳过条数；
3. 「已接收的来源不再出现在待接收列表」组件测试 2 条（含「状态停在 pending_finance 但已有应付单」的历史数据）；
4. 财务各页面文案删减后，原有行为断言（请求契约、计数、列头）全部保持通过。

## 完成记录

- `apps/api/src/modules/finance/supplier-payable.service.ts` 新增 `batchConfirm`；
- `apps/api/src/modules/finance/finance.controller.ts` 新增 `BatchConfirmPayablesDto` 与路由
  （放在 `payable-entries/:id/*` 之前）；
- `apps/web/components/finance/payable-workspace.tsx` 重写（勾选列 / 批量确认 / 去掉付款 / 文案）；
- `apps/web/components/finance/receivable-workspace.tsx` 与其余财务页面/组件、`lib/finance-sections.ts`
  的文案精简（含 `finance-tabs.tsx`、`finance-board-index.tsx`、`app/finance/salary/page.tsx`
  对 `description` 的渲染移除）；
- 验证：API 单测 1339/1339；web `tsc --noEmit` 通过；web 组件测试与 lib 测试通过（数字见当日日志）。
