# 财务挂账口径与账务护栏（2026-11-09 用户拍板）

> 来源：2026-11-07 全链路诊断（[finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md](../audit/finance-flow-and-ap-cashflow-voucher-review-2026-11-07.md) §0.4 三个 A 级待拍板问题）。
> 用户 2026-11-09 答复：
>
> 1. 「原材料作为存货吧」
> 2. 「确认即过账」
> 3. 「业务科目只作为辅助核算维度」
>
> 本文件把三条答复固化为可执行口径，并界定本轮（R1）与下一轮（R2）的落地范围。
>
> **实现状态**：R1 已落地并通过全量验证（2026-11-09）：API 2892/2892、Web 1266/1266、独立探针 22/22。
> 详见 [docs/log/2026-11-09.md](../log/2026-11-09.md)。

## 1. 三条口径

### D1 —— 采购入库的挂账借方记「原材料」（存货），不再默认记「主营业务成本」

- **决定**：原料入库 / 到货单来源的确认应付，借方科目候选链首位改为**资产类「原材料」**；「主营业务成本」退为兜底（仅当库里没有「原材料」时）。
- **范围**：`PAYMENT_SUBJECT_NAMES.raw_material_inbound` / `.purchase_receipt`、`PAYABLE_CONFIRM_SUBJECT_NAMES`、`DEFAULT_PAYMENT_SUBJECT_NAMES`（未挂账付款的借方兜底同口径）。
- **理由**：采购入库形成存货，领用/销售时才结转成本。入库即费用化会同时错列资产负债表「存货」与利润表「成本」。
- **不影响**：外加工（`加工费`）、其他应付（费用科目）的候选链。
- **历史数据**：已生成的旧凭证不自动改写；如需重述，走 R2 的历史数据修复清单。

### D2 —— 「确认即过账」：挂账凭证生成即为已过账，且与确认动作同一事务

- **决定**：确认应收/应付（逐条 / 批量 / 按对账单）时，挂账凭证的终态直接是 `posted`，不再停留在 `draft` 等待人工逐张过账；确认与挂账在**同一数据库事务**内完成，任一步失败整体回滚。
- **理由**：
  1. 报表只认 `posted`，草稿挂账让确认后的应付账款在资产负债表上看不见；
  2. 草稿凭证可被人任意改分录——本次生产数据证明错账全部来自手改；已过账凭证只能红冲，从源头收窄改单面；
  3. 确认与挂账跨事务会留下「已确认、无凭证」且无法自然补账（诊断 P0-4）。
- **副作用与约束**：
  - 确认后要改科目/金额，必须先红冲挂账凭证（R2 提供「按来源重算」入口），不再能直接编辑；
  - `accruedSourceIds`（销账时判断「这条应付/应收有没有先挂账」）改为**只认 `posted`**（诊断 P0-1）；
  - 历史遗留的草稿挂账凭证不会被自动过账（需要财务在凭证页逐张处理，或 R2 提供批量过账）。
- **不做**：收/付款凭证（由收支流水生成）仍保持草稿、由财务复核后过账——本次拍板只针对「确认」这一步。

### D3 —— 「业务科目」只作为辅助核算维度

- **决定**：凭证的**分录科目**由会计规则决定（原材料 / 应付账款 / 银行存款 / 收入科目……）；业务科目（这笔钱算什么）作为**辅助核算维度**附着在凭证与流水上，用于报表分类与管理分析，**不再直接决定凭证的借贷科目**。
- **R1 落地**：
  - 应付/应收确认弹窗选的科目，继续作为挂账凭证借方（这是「其他应付」唯一可得的费用科目来源）；
  - 付款/收款凭证的分录科目仍按准则（借 应付账款 / 贷 银行存款），业务科目继续保存在流水的 `category_subject_id`，页面与现金流量表按它显示/落行（现状已如此，R1 不改）。
- **R2 落地**：`voucher_lines` 增加 `subject_id`（分录科目外键）与 `business_subject_id`（辅助维度）；报表按 id 匹配；凭证纸显示「业务科目（辅助）」；界面词分家（业务科目 / 记账对方科目 / 分录科目）。
- **判定边界**：业务科目**永远不能**顶掉往来科目与资金科目（例如付款凭证的借方不能因为业务科目是费用就记成费用）——这条是本轮要堵的口径漏洞。

## 2. R1 落地清单（本轮）

| # | 改动 | 落点 |
|---|---|---|
| R1-1 | 原料入库候选链首选「原材料」 | `accounting-subject-catalog.ts` |
| R1-2 | `createAccrual` 支持「事务内创建」与「直接过账」 | `voucher.service.ts` |
| R1-3 | 五个确认入口改为「确认 + 挂账」同一事务、挂账直接过账 | `supplier-payable.service.ts`、`receivable.service.ts`、`reconciliation.service.ts`、`supplier-payable-reconciliation.service.ts` |
| R1-4 | 销账判定只认已过账的挂账凭证 | `voucher.service.ts` |
| R1-5 | 禁止对红字凭证再红冲（阻断 9 连红冲链） | `voucher.service.ts` |
| R1-6 | 报表不计入红字凭证（原凭证已作废，红字不得单边进表） | `finance-three-statements.service.ts` |
| R1-7 | 凭证改分录的审计记改前/改后科目（护栏前置） | `voucher.service.ts`、`audit.service.ts`（支持事务客户端） |
| R1-8 | 确认应付弹窗去掉无效的「支付银行」并更正「已记入收支流水」文案 | `apps/web/components/finance/payable-workspace.tsx` |

## 3. 关键契约（供实现与测试对齐）

```ts
// AuditService：审计可加入调用方事务
record(action, entityType, actorId?, entityId?, details?, client?: Prisma.TransactionClient)

// VoucherService：挂账
createAccrual(
  input,                 // 现有入参不变
  user,
  options?: {
    client?: Prisma.TransactionClient;  // 传入时在调用方事务内创建，不另开事务
    post?: boolean;                     // true = 生成即 posted
  },
)

// 返回：{ id, voucherNo, status, replayed }（事务内只返回必要字段，不再回读整张凭证）
```

- `post=true` 且来源已有**草稿**挂账凭证：按本次入参重建分录后过账（修复「回退改金额→重新确认仍是旧金额」）。
- `post=true` 且来源已有**已过账**挂账凭证：金额/币种与入参一致则复用（`replayed=true`），不一致显式 422，要求先红冲。
- `post=true` 且来源已有**已红冲**挂账凭证：显式 422（`VOUCHER_ACCRUAL_REVERSED`）。因为唯一键 `(source_type, source_id)` 仍占着那一行，原地重建会把红冲历史覆盖掉；要允许重建必须先把唯一索引改成部分索引（`WHERE deleted_at IS NULL AND status <> 'reversed'`），与 R2 的「按来源重算」一起做。

## 4. 明确不在本轮

- `voucher_lines.subject_id` / `business_subject_id` 迁移与报表按 id 匹配（R2）；
- 冲销/红冲全链路联动矩阵（付款冲销→红冲付款凭证、凭证红冲→回写业务状态等）（R2）；
- 改分录强制填原因、自动凭证行级锁定（R2）；
- 死代码清理（`recordConfirmation` 等）与历史数据修复（R2/D）；
- 收/付款凭证自动生成或自动过账。

## 5. 验收

- `npm run typecheck`（api / coding-worker / web）全绿；
- API 全量单测、Web lib + 组件测试全绿（含新增用例：确认即 posted、同事务回滚、只认 posted 销账、报表排除红字、红字不可再红冲、原材料候选首位）；
- 报告与日志记录本轮口径与影响面。
