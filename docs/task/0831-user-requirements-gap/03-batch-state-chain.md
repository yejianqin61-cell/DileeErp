# 03 — 采购到货、质检、入库批次状态链

**What to build:** 以收货批次为唯一链路身份，自动创建来料质检任务，质检通过后才允许原料入库，并支持可审计的草稿、过账和冲销。

**Blocked by:** #4 — 采购单整单批次工作区

**Status:** implemented — pending real PostgreSQL/concurrency acceptance

- [x] 每次有效到货只生成一条 pending 质检任务，重复请求不重复生成。
- [x] 同一采购单可维护多个收货、质检和入库批次，列表均显示采购单号及批次序号。
- [x] 质检数量分配满足送检、合格、条件接收和不合格的平衡约束。
- [x] 只有允许入库的质检数量可创建原料入库；超量请求返回稳定业务错误。
- [x] 入库状态支持 draft、posted、reversed 或等价状态，过账后只能冲销回退。
- [ ] API 集成测试覆盖重复请求、部分合格、非法回退和并发更新（需真实 PostgreSQL 环境）。

**Evidence:** 到货事务在 `purchase-orders.service.ts` 中创建质检批次并用幂等键保护；`incoming-inspections.service.ts` 和 `raw-material-inbounds.service.ts` 实现数量平衡、批次追踪及状态回退；`incoming-inspection-batch-sequence.test.cjs`、`raw-material-inbound-post-state.test.cjs`、`procurement-inbound.test.cjs` 覆盖核心链路；`npm run test:unit` 当前 127 项通过。
