## 1. Where this task sits

- **Phase 4 财务档位完整查询**：给财务档订单成本、利润与关联人工事实。
- **本任务推进 R-5 完整只读工具集、R-12 数据口径与来源**：落成本利润和订单人工两项。
- **开始于** T2 财务操作目录。**后续等待它**：降权与最终验收。

## 2. What the developer needs to know

**Read first**

- `finance/finance-report-query.service.ts` — 毛利与成本会计的既有报表口径。
- `finance/finance-report-cost.service.ts` — 出货、采购成本和人工分摊规则。
- `hr/employee-daily-reports.service.ts` — 订单关联日报的筛选字段。
- `finance/finance-report-cost-accounting.test.cjs` — 可独立核验的金额与脚注样例。
- `prisma/schema.prisma` — 人工、报工、成本来源与软删关系。

**Settled**

- 两项均只限 `full`，并以精确 `order_no` 过滤。
- 成本利润复用既有报表口径；无可核算事实必须明确为空，不自行补算。
- 人工输出订单关联员工、工序、数量、单价和金额；不扩展为全员薪资台账。
- 结果带财务事实来源，不包含员工无关的宽对象。

**Edges and seam**

- 触及财务查询工具和领域测试；不改报表、工资或日报写路径。
- 缝是 `FinanceReportQueryService` 的只读计算与订单筛选。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-finance-cost.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若报表方法无法按精确订单过滤，停止，不得从宽报表在内存猜测归属。
- 若人工分摊脚注不稳定，以既有测试口径为准并记录来源。

## 3. The workflow

1. 阅读第 2 部分并复述：复用报表口径读取单订单成本利润和人工。
2. 为出货范围、成本脚注和无数据写红测。
3. 实现成本利润窄 DTO 与来源投影。
4. 为订单日报分页和员工字段白名单写红测。
5. 实现人工 DTO，开启两项 capability。
6. 运行任务命令并提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 未出货订单 | 明确无可核算数据 | `getOrderCostProfit()` |
| 2 | 已出货订单 | 销售、采购、人工和利润一致 | 报表口径 |
| 3 | 成本脚注 | 来源与既有报表一致 | `getOrderCostProfit()` |
| 4 | 两订单日报 | 只返回目标订单 | `getOrderPayroll()` |
| 5 | 员工宽对象 | 只给员工、工序、数量、单价、金额 | `getOrderPayroll()` |
