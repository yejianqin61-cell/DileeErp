# P3-T3 采购领域 4 个 operation

## 1. 位置

- 阶段：Phase 3 非财务订单全链路。
- 本任务落采购领域：get_purchase_plans、get_purchase_orders、get_receipts、get_incoming_inspections。
- 前置：P3-T1 订单根验证器。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/procurement/purchase-plans.service.ts`（与 `purchase-plans.domain.ts`）— 计划行与状态口径；原列表计算计划金额并读 unitPrice/currency 的位置。
- `apps/api/src/modules/procurement/purchase-orders.service.ts` 的 `list()/get()` — 采购单状态、到货关系与 receipts 批次序号规则。
- `apps/api/src/modules/procurement/incoming-inspections.service.ts` — 质检数量批次口径与 extensionData 的内容。
- `apps/api/prisma/schema.prisma` 的 PurchasePlan/PurchaseOrder/PurchaseOrderItem/PurchaseReceipt/IncomingInspection 模型。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md` 映射表（procurement_query 四行）。

**定案（不得重开）**

- 全部先过 `assertOrderRoot`（订单 → 采购单/计划/到货/质检全部以订单号为根下推）。
- `get_purchase_plans` 投影：计划单号、行物料、数量、单位、状态、时间；排除 unitPrice/currency/金额。
- `get_purchase_orders` 投影：采购单号、供应商名称/编码、状态、行数量与单位、时间；排除总额、单价、结算与应付关联（payableSources）。
- `get_receipts` 投影：到货单号、批次序号、数量、单位、状态、时间；**不返回 extensionData、payableSources、结算扩展**——批次序号规则沿用现有实现。
- `get_incoming_inspections` 投影：质检单号、批次、检验/合格/让步/拒收数量、结论、状态、时间；剔除 extensionData 中未审计字段（整个 extensionData 都不给，需要哪个字段就显式挑哪个）。
- 供应商快照同 P3-T2 客户口径：只给名称/编码，联系人/电话/地址不给。
- 文件：`tools/procurement-query-tools.ts`；executor 分支；registry 翻开关。

**边界**

- 新文件 `tools/procurement-query-tools.ts`。不改业务模块。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-procurement-domain.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 到货 receipt 的数量字段与批次序号在 extensionData 还是独立列，以 schema/service 实现为准；若批次规则依赖 extensionData 里的字段，只挑该字段进投影并在注释里写明依据。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写测试（红）：四个 op 喂「带金额/结算/应付来源」的宽行。
3. 写 `procurement-query-tools.ts` 四个实现；executor 分支；registry 翻开关。
4. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 计划行带 unitPrice/currency/金额 | 投影只有物料/数量/单位/状态 | `get_purchase_plans` |
| 2 | 采购单带总额/结算/应付关联 | 投影只有单号/供应商名/状态/数量/时间 | `get_purchase_orders` |
| 3 | 到货单带 extensionData/payableSources | 投影只有单号/批次/数量/状态/时间 | `get_receipts` |
| 4 | 质检单带 extensionData | 投影只有白名单字段，extensionData 整体不出 | `get_incoming_inspections` |
| 5 | 供应商快照带联系人/电话 | 只投影名称/编码 | 快照投影 |
