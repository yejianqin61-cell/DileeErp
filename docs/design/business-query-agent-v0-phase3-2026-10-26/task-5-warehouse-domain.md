# P3-T5 仓库领域 6 个 operation

## 1. 位置

- 阶段：Phase 3 非财务订单全链路。
- 本任务落仓库领域：get_raw_material_balance、get_inventory_facts、get_material_movements、get_finished_goods_qc、get_finished_goods_inbounds、get_finished_goods_outbounds。
- 前置：P3-T1 订单根验证器；P3-T2/T-3/T-4 的领域文件模式。

## 2. 开发者须知

**先读**

- `apps/api/src/platform/inventory/inventory.service.ts` 的 `rawMaterialBalance(s)` — 余额口径（按物料+单位聚合库存事实）。
- `apps/api/src/modules/reports/reports.service.ts` 的 `inventory()` — InventoryFact 流水口径。
- `apps/api/src/modules/production/raw-material-movements.service.ts` — 领/退/补/报废单与状态口径。
- `apps/api/src/modules/production/finished-goods-qc.service.ts`、`finished-goods-inbound-notices.service.ts`、`apps/api/src/modules/warehouse/finished-goods-inventory.service.ts` 与 `finished-goods-outbound.service.ts` 的 `listOutbounds()/listReturns()`。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md` 映射表（warehouse_query 六行；注意出库行的「必须重写 select/DTO」警告）。

**定案（不得重开）**

- **余额与流水不能混用**：`get_raw_material_balance` 从当前订单 BOM 确定物料集合，查这些物料的**全局实存量**（沿用 `rawMaterialBalances` 口径），结果里明确标注「全局实存量，非订单专属」；`get_inventory_facts` 是订单范围的事实流水（沿用 `ReportsService.inventory()` 口径），给增减量与来源。两者不得互相借用措辞。
- `get_raw_material_balance` 投影：物料编码/名称、单位、余额数量、口径标注；输入就是 `{order_no}`。
- `get_inventory_facts` 投影：类别、增减量、来源类型、来源 ID、时间；按订单 + 分页。
- `get_material_movements` 投影：单号、单据类型（领/退/补/报废）、状态、行数量、时间；排除自由附件/扩展字段。
- `get_finished_goods_qc` 投影：质检单号、结论、状态、检验/合格/让步/拒收数量、质检日期。
- `get_finished_goods_inbounds` 投影：区分**入库通知**与**实际入库**两条链（来源类型标注），状态保留草稿/已过账；不透传整块 qcRecord/inventoryFacts。
- `get_finished_goods_outbounds` **必须重写 select/DTO**：现有服务返回的 `salesOrder` 含 `unitPrice/settlementUnitPrice/receivableAmount`——投影固定单号/状态/数量/时间/退货关联（只给关联单号）。
- 文件：`tools/warehouse-query-tools.ts`；executor 分支；registry 翻开关。

**边界**

- 新文件 `tools/warehouse-query-tools.ts`；可复用 P3-T1 的 BOM 物料集合查询（order-query-tools 内的私有函数若复用就提为导出）。不改业务模块。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-warehouse-domain.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 成品入库通知与实际入库是两张表（notice + inbound）；两链合并输出的来源标注字段名要统一为 `chain: "notice" | "inbound"`，避免模型把草稿通知当成已入库。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写测试（红）：六个 op 喂「带单价/结算/应收金额/整块关联对象」的宽行；余额/流水措辞断言。
3. 写 `warehouse-query-tools.ts` 六个实现；executor 分支；registry 翻开关。
4. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 订单 BOM 三种物料 | 余额按物料+单位给出全局实存量，标注口径 | `get_raw_material_balance` |
| 2 | 库存事实流水 | 增减量+来源，措辞非「余额」 | `get_inventory_facts` |
| 3 | 领退报废单带附件/扩展字段 | 投影只有单号/类型/状态/数量/时间 | `get_material_movements` |
| 4 | 成品 QC 行 | 只有单号/结论/状态/四类数量/日期 | `get_finished_goods_qc` |
| 5 | 入库通知+实际入库混排 | chain 标注区分，状态保留草稿/过账 | `get_finished_goods_inbounds` |
| 6 | 出库行带 unitPrice/settlementUnitPrice/receivableAmount | 三个键都不出现在结果里 | `get_finished_goods_outbounds` |
