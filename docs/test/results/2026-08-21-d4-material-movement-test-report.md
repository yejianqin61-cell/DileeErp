# D4 原料流转 API 与数据库回归报告

## 基本信息

- 测试日期：2026-08-21
- 测试对象：厂内生产单 -> 原料领料 -> 退料/报废 -> 冲销 -> 库存事实与审计
- PostgreSQL：`dilee_erp_test`
- API：`http://localhost:3011`

## 结果

| 测试层 | 命令 | 结果 | 覆盖内容 |
| --- | --- | --- | --- |
| API 构建 | `npm run build --workspace=@dilee/api` | 通过 | D4 controller/service 编译与 Prisma 类型一致 |
| PostgreSQL 集成 | `TEST_DATABASE_URL=... npm run test:integration` | 通过（4 项） | 采购入库回归、领料扣减、退料回补、报废不回补、超量拒绝、幂等、冲销门禁 |
| HTTP/API | `API_BASE_URL=http://localhost:3011 npm run test:api` | 通过（4 项） | 健康信封、匿名保护、D4 全部受保护入口 401、统一错误信封与请求 ID |

## 关键断言

- 领料事实为负向 `raw_material` 事实，并保留 `order_no`、生产单和来源领料明细；重复使用同一幂等键不会重复扣减。
- 退料回补可用原料库存；报废只写 `scrap` 事实，不增加可用原料余额。
- 退料/报废超过来源领料可处分数量被拒绝；存在下游记录时来源领料不可直接冲销。
- 冲销通过独立反向事实恢复余额，并记录真实 `AuditService` 事件；已过账单据不直接编辑或删除。
- 未登录访问列表、预览、退料等 D4 API 返回 401，响应包含统一 `error` 信封和请求 ID。

## 边界与残余风险

- 本任务未替代 task 07 的真实浏览器操作验收。
- HTTP 本轮重点验证认证边界和错误契约；已登录的完整业务旅程由 PostgreSQL 集成测试与 task 07 浏览器验收共同覆盖。
- 性能压测、厂内部署和外加工直发不属于 D4 回归范围。
