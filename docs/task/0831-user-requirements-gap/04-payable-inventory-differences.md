# 04 — 批次应付与库存差异治理

**What to build:** 将原料入库批次形成可追踪的应付来源，并在财务中按供应商、订单号和批次核对数量、单价、金额及差异，支持付款、冲销和审计。

**Blocked by:** #5 — 采购到货、质检、入库批次状态链

**Status:** implemented — pending real PostgreSQL reconciliation acceptance

- [x] 每个有效原料入库批次最多形成一个可追踪应付来源，重复接收幂等。
- [x] 应付来源保留订单号、采购单号、批次号、物料、单位、数量、单价、税率、币种和金额快照。
- [x] 财务可接收、编辑草稿金额、确认、过账或冲销，应付状态与来源状态可追溯。
- [x] 对账按供应商、订单号和批次聚合，差异必须填写原因及外部余额。
- [x] 付款分配不得超过应付余额；部分付款、未分配付款和冲销均可正确重算。
- [ ] 集成测试证明库存事实和应付来源在同一事务中一致（需真实 PostgreSQL 环境）。

**Evidence:** `raw-material-inbounds.service.ts` 在入库过账事务中创建库存事实并以收货批次唯一来源；财务应付、付款和供应商对账服务提供状态与差异核对；`payable-source-batch-trace.test.cjs`、`supplier-payable-service.test.cjs`、`supplier-payment-service.test.cjs`、`supplier-payable-reconciliation-service.test.cjs` 覆盖核心规则；`npm run test:unit` 当前 127 项通过。
