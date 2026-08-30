# 采购收货链路改进任务

本组任务依据 `docs/design/procurement-receiving-qc-reconciliation-improvement-design.md`，按依赖顺序执行。每个任务完成后单独验证并提交一次 Conventional Commit。

## 顺序

1. `01-production-master-data-pools.md`：工序池、加工地点池二级页面。
2. `02-daily-report-conflict-errors.md`：日报冲突错误细化。
3. `03-purchase-order-receiving-batches.md`：采购单分批到货与应付来源。
4. `04-incoming-qc-batches.md`：到货触发来料质检、多批质检。
5. `05-reversible-raw-material-inbound.md`：质检后可逆原料入库。

未完成前不得开始后续任务；不修改无关模块。
