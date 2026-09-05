# 02 — 采购单整单批次工作区

**What to build:** 用户打开采购单后，在宽屏详情工作区中按采购物料固定行、按收货批次成组展示到货数量、应付金额、质检状态和入库数量，并可维护批次。

**Blocked by:** #3 — 生产验收环境与发布包指纹闭环

**Status:** implemented — pending real PostgreSQL/browser acceptance

- [x] 采购单号可从主列表明显进入批次工作区，桌面端宽度至少覆盖原页面 80%。
- [x] 一张整单表固定物料行，批次列显示到货、应付、质检和入库信息。
- [x] 可新增、编辑、撤销收货批次，并显示第 N 批和采购单号。
- [x] 批次数量和金额使用 Decimal 展示，空值和未生成状态有明确文案。
- [x] 已产生下游事实的批次不能直接覆盖，只能进入受控回退或冲销流程。
- [ ] 前端测试覆盖多物料、多批次和无批次三种展示状态（需浏览器环境执行）。

**Evidence:** `apps/web/app/procurement/page.tsx` 的 `renderOrderBatchWorkflow` 提供整单固定物料行与批次列；`apps/api/test/unit/purchase-order-batch-sequence.test.cjs`、`apps/api/test/purchase-orders.test.cjs` 覆盖批次序号和下游事实保护；`npm run test:unit` 当前 127 项通过。
