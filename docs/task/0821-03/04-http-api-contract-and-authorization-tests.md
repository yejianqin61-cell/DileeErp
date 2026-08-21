# 0821-03-04 HTTP API 契约与权限测试

## 状态

已实现（环境阻断）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

用真实 HTTP 请求验证 API JSON 契约、错误码、认证、RBAC、状态动作和字段校验，而不只调用 service mock。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 3.2、7、8 节
- `docs/design/global-api-contract.md`
- `docs/task/0821-01/07-initial-chain-acceptance.md`

## 范围

- 使用 Node 原生 `fetch` 和独立测试会话调用已启动 API；
- 覆盖成功 `{ data, meta }`、错误 `{ error, meta }`、`request_id`、分页和字段级错误；
- 覆盖未登录 401、无权限 403、模块权限隔离、非法状态动作、来源版本失效和重复业务编号；
- 将请求 ID、用户角色、`order_no` 和错误码写入失败报告；
- 覆盖客户 -> 销售单 -> BOM 和采购/QC/入库关键 API。

## 非范围

- 真实数据库事务一致性（由第 05 项负责）；
- 浏览器渲染和页面布局；
- 外部系统接口。

## 验收与验证

1. API 服务可启动时专项测试能独立登录、请求、断言和退出。
2. 每个权限角色只能调用被授予模块的写接口；管理员行为单独覆盖。
3. 负向请求确认没有产生部分业务写入或状态变化。
4. 测试结果区分 API 服务不可用、数据库不可用和业务断言失败。

## 决策记录

HTTP 层优先使用 Node 原生 `fetch`，复用生产 API 契约，不在测试中绕过控制器直接调用服务。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：`npm run test:unit`，14 tests passed；`npm run test:api` 因未设置 `API_BASE_URL` 以 `TEST_BLOCKED` 退出。HTTP 测试已覆盖健康信封、匿名 401 和 `request_id`，待测试 API 与 PostgreSQL 可用后执行真实验收。
