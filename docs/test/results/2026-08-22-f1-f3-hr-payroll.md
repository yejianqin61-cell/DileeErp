# F1-F3 人事、考勤、绩效与薪资支付链路测试记录

日期：2026-08-22

## 范围

员工目录 -> 考勤/绩效 -> D5 生产薪资来源 -> 月度薪资台账 -> 分批/一次性工资支付。

## 已执行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| API TypeScript 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/api` |
| API 构建 | 通过 | `npm run build --workspace=@dilee/api` |
| F1-F3 领域单元测试 | 通过，5/5 | `node --test apps/api/test/unit/hr-payroll-domain.test.cjs` |
| 完整单元测试 | 通过，55/55 | `npm run test:unit` |
| Web 构建 | 通过 | `npm run build --workspace=@dilee/web` |
| 链路质量门禁 | 环境阻断 | `npm run verify:chain`；缺少 `TEST_DATABASE_URL`、`API_BASE_URL`、`PLAYWRIGHT_BASE_URL` |
| 真实 PostgreSQL/API/浏览器链路 | 环境待具备 | 需要 `TEST_DATABASE_URL`、API 和 Web 服务 |

## 覆盖的不变量

- 考勤和绩效不会自动覆盖薪资金额。
- D5 来源按金额汇总；计时日报的件数不作为薪资金额。
- 独立薪资调整按 `increase/decrease` 使用 Decimal 计算。
- 薪资台账和工资付款均禁止超额核销。
- 薪资状态按已支付金额派生为 `confirmed/partially_paid/paid`。

## 限制

本记录不能替代真实环境验收。`verify:chain` 已明确阻断于测试库、API 和 Playwright 地址未配置；Docker/PostgreSQL 不可用或环境变量未配置时，必须将 API、迁移和浏览器回归标记为阻断，不得把静态构建和领域测试宣称为完整链路验收。
