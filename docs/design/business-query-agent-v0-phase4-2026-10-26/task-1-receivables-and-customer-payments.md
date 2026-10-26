## 1. Where this task sits

- **Phase 4 财务档位完整查询**：老板和财务可读取订单财务事实。
- **本任务推进 R-2 两档数据权限、R-5 完整只读工具集**：落 `get_receivables`、`get_customer_payments`。
- **开始于** Phase 3 的订单根验证器。**后续等待它**：付款、对账与财务验收。

## 2. What the developer needs to know

**Read first**

- `tools/tool-executor.ts` — 财务 operation 应在哪个统一分发缝执行。
- `finance/receivable.service.ts` — 应收来源、已过账分摊与余额口径。
- `finance/customer-payment.service.ts` — 收款及其有效分摊口径。
- `prisma/schema.prisma` — 应收、收款、分摊的只读列与软删条件。
- `business-query-agent-v0-module-design-2026-10-25.md` — 财务 DTO 的订单范围。

**Settled**

- 两项 operation 都先过 `assertOrderRoot`，只接受 `{order_no,page?}`。
- 只有 `full` 可见和执行；`operational` 在读库前得到 403。
- 金额、币种、状态、有效分摊与余额可进入财务 DTO。
- 银行账号不输出；付款只保留必要的银行名称，等待业务范围确认。

**Edges and seam**

- 触及 `tools/finance-query-tools.ts`、注册表与根分发；不调用可写领域服务。
- 缝是 `ToolExecutor.execute()`；所有查询走 Agent 只读 client。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-finance-receivable.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若同一订单收款可跨来源，必须以已过账 allocation 为准。
- 若产品要求展示完整银行账号，停止并等待可见范围决定。

## 3. The workflow

1. 阅读第 2 部分并复述：财务档只读同订单应收与收款。
2. 为双角色拒绝与应收宽行投影写红测。
3. 增加财务只读 DTO 和根分发，查询只选白名单列。
4. 为收款、有效分摊和无数据路径逐项红绿。
5. 更新注册表开关并回归执行器。
6. 运行任务命令并提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | `operational` 调应收 | 403，零读库 | `ToolExecutor.execute()` |
| 2 | `full` 调应收 | 来源、余额、币种出现 | `getReceivables()` |
| 3 | 已过账与草稿分摊 | 余额只扣已过账分摊 | `getReceivables()` |
| 4 | 收款含银行账号 | 仅名称，不含账号 | `getCustomerPayments()` |
| 5 | 不存在订单 | 404，不查财务表 | `assertOrderRoot()` |
