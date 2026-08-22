# D7 生产计量读模型与重算 API

## 状态
已完成

## 认领
负责人：Codex
开始日期：2026-08-22

## 目标

实现生产单/订单级进度查询、计量来源查询和按范围重算能力，确保来源事实变化后摘要可重建。

## 依赖

`01-d7-progress-domain-and-rebuild-contract.md`。

## 范围

- 数据库迁移或可重建汇总表（若采用读时计算，说明性能边界）。
- `GET /production/orders/:id/progress`、`GET /production/orders/:id/measurements`。
- `GET /production-progress/measurements`、`GET /production-progress/order-statuses`。
- 管理员受保护的 `POST /production-progress/rebuild`，支持订单和日期范围。
- 服务端分页、筛选、排序、Decimal 序列化和请求 ID。
- 所有查询返回 `order_no`、来源、单位分组、状态和阻塞原因。

## 非范围

不提供直接写入计量或状态的 API，不改变日报/外加工交接接口。

## 验收与验证

- API 返回与领域计算样例一致。
- 重算失败事务回滚，不留下部分摘要。
- 非管理员重算返回 403；不存在资源返回 404；非法范围返回 422。
- 重复重算幂等，构建、类型检查和 API 单元测试通过。

## 决策记录

- 前端不跨模块自行汇总。
- 汇总表如存在，必须提供全量重建路径。

## 完成记录

已实现生产计量查询、订单状态查询、订单时间线和管理员重算 API，复用 D5/D6 来源事实实时汇总；未新增重复产量事实表。已接入生产模块、鉴权、生产权限、分页、Decimal 字符串和重算范围返回。

验证：`npm run typecheck --workspace=@dilee/api`、`npm run build --workspace=@dilee/api`、`npm run test:unit`（30/30）通过。

提交：`6b3cf3e feat: expose d7 progress read models`
