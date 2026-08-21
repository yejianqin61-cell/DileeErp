# D4 原料流转浏览器验收报告

## 基本信息

- 测试日期：2026-08-21
- 浏览器：Playwright Chromium
- 数据库：独立 PostgreSQL `dilee_erp_test`
- 页面：`http://localhost:3000/warehouse`

## 结果

| 场景 | 结果 |
| --- | --- |
| 真实账号登录并进入仓库工作台 | 通过 |
| 选择生产中的厂内生产单与启用物料 | 通过 |
| 领料影响预览显示当前/过账后库存 | 通过 |
| 领料过账并在历史列表追溯订单号 | 通过 |
| 退料过账 | 通过 |
| 报废过账且不回补可用库存 | 通过 |
| 存在退料/报废下游记录时拒绝来源领料冲销 | 通过 |
| 完整 E2E（认证、生产单、D4） | 4 项通过 |

## 门禁命令

`npm run verify:chain` 通过，包含：

- `npm run db:test:prepare`
- `npm run test:integration`（4 项）
- `npm run test:api`（4 项）
- `npm run test:e2e`（4 项）

测试夹具在结束后清理生产单、流转单、库存事实、审计事件、物料和测试用户；未使用 mock 库存或手工数据库修改作为验收证据。
