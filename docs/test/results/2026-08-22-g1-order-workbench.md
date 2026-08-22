# G1 订单全链路工作台测试记录

日期：2026-08-22

## 范围

以 `order_no` 为根，读取销售/BOM、采购/应付、原料库存、生产、成品 QC/库存、发货和应收摘要，以及订单审计时间线。

## 已执行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| G1 聚合领域测试 | 通过，3/3 | `node --test apps/api/test/unit/order-workbench-domain.test.cjs` |
| 完整单元测试 | 通过，58/58 | `npm run test:unit` |
| API 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/api` |
| API 构建 | 通过 | `npm run build --workspace=@dilee/api` |
| Web 构建 | 通过 | `npm run build --workspace=@dilee/web` |
| 链路质量门禁 | 环境阻断 | `npm run verify:chain` |

## 覆盖的不变量

- 所有工作台摘要以 `order_no` 关联，不创建或修改业务事实。
- 缺失模块返回 `not_started`/`missing`，不以零值冒充完成。
- 阻塞状态优先于完成状态。
- 金额、数量以服务端 Decimal 字符串返回。
- 时间线只读已有 `AuditEvent`，最多返回最近 200 条。
- 工作台接口要求认证，并允许任一业务模块权限读取。

## 环境限制

`verify:chain` 因缺少 `TEST_DATABASE_URL`、`API_BASE_URL` 和 `PLAYWRIGHT_BASE_URL` 被明确标记为环境阻断。因此本记录证明代码、单元测试和构建范围，不替代真实 PostgreSQL/API/浏览器验收。
