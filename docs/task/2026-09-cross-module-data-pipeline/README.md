# 跨模块数据管线开发任务

来源规格：[跨模块数据管线开发改进规格](../../design/cross-module-data-pipeline-improvement-spec-2026-09-03.md)

本目录将已确认的规格拆成 7 个可独立验收的垂直任务。每个任务均覆盖数据模型、API、前端和测试。

## 合并说明

采购到货、来料质检、原料入库和应付/付款不是四条互相独立的功能，而是同一批次的连续业务管线。因此将它们合并为 `02-procurement-receiving-qc-inbound-payable.md`，统一设计批次标识、状态回退、下游事实约束、库存影响和应付核销规则。后续实现该管线时必须以端到端链路验收，不能只完成其中一个页面或单据。

生产日报与工资来源、成品 QC 与应收等任务同样按业务事实边界拆分；任务之间的阻塞关系表示前置数据约束已经稳定后，后续任务才能开始实现。

## 依赖顺序

1. `01-unified-invariants-and-history.md`
2. `02-procurement-receiving-qc-inbound-payable.md`（阻塞于 01）
3. `03-inventory-facts-and-material-issue.md`（阻塞于 01）
4. `04-production-daily-and-manual-pricing.md`（阻塞于 01）
5. `05-production-operation-completion.md`（阻塞于 04）
6. `06-finished-goods-qc-inventory-receivable.md`（阻塞于 03、05）
7. `07-payroll-refresh-and-edit-governance.md`（阻塞于 02、04、05、06）

## 共同交付门槛

- API 构建、前端类型检查、迁移验证和相关回归测试通过。
- 所有写操作保留审计事件；重复请求不重复产生业务事实。
- 前端使用现有组件库，不使用原生 `alert`、`confirm` 或裸业务下拉。
- 用户可见定位使用订单号、单据号、批次号、姓名和工号，UUID 仅作为隐藏关联值。
