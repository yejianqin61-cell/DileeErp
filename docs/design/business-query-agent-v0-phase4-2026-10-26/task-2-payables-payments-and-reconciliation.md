## 1. Where this task sits

- **Phase 4 财务档位完整查询**：完整覆盖订单的应付、付款与对账。
- **本任务推进 R-5 完整只读工具集、R-12 数据口径与来源**：落三项财务 operation。
- **开始于** T1 财务 DTO 和根分发。**后续等待它**：成本人工与完整验收。

## 2. What the developer needs to know

**Read first**

- `finance/supplier-payable.service.ts` — 应付余额与有效付款分摊。
- `finance/supplier-payment.service.ts` — 付款、状态与订单汇总。
- `finance/reconciliation.service.ts` — 客户对账的订单过滤语义。
- `finance/supplier-payable-reconciliation.service.ts` — 供应商对账的订单过滤语义。
- `prisma/schema.prisma` — 应付、付款、两类对账的关联和软删列。

**Settled**

- 三项都先过订单根；财务金额、币种、状态和对账期间可输出。
- 客户与供应商对账合并到 `get_reconciliations`，每行标明方向。
- 只读 SQL 重建窄 DTO；不复用带写依赖的服务返回。
- 银行账号不输出，付款仅可输出银行名称。

**Edges and seam**

- 触及财务工具文件、根分发、注册表与领域测试。
- 不改应付、付款、对账服务及其状态机。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-finance-payable.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若供应商对账缺订单列，必须经采购单关联下推；无法证明归属则不返回。
- 对账的金额脚注若无稳定来源，停在 DTO 前说明。

## 3. The workflow

1. 阅读第 2 部分并复述：财务档只读订单应付、付款和双向对账。
2. 为应付余额与草稿付款写红测。
3. 实现应付、付款白名单查询并接入分发。
4. 为客户和供应商对账方向与订单归属写红测。
5. 实现合并对账 DTO，更新三项 capability。
6. 运行任务命令并提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 应付含草稿付款 | 未付不扣草稿金额 | `getPayables()` |
| 2 | 付款含账号 | 名称可见，账号缺席 | `getSupplierPayments()` |
| 3 | 客户对账 | `direction=receivable` | `getReconciliations()` |
| 4 | 供应商对账 | `direction=payable` | `getReconciliations()` |
| 5 | 他订单对账 | 不在结果中 | 订单根过滤 |
