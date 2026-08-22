# D7 集成测试、浏览器验收与链路关闭

## 状态
已完成（真实环境后置验证）

## 认领
负责人：Codex
开始日期：2026-08-22

## 目标

验证 D7 从 D5/D6 来源到生产计量、订单状态和前端工作台的完整数据流，并更新路线图和测试记录。

## 依赖

`03-d7-source-linkage-and-transactional-recalculation.md`、`04-d7-order-status-timeline-and-permissions.md`、`05-d7-progress-workbench-frontend.md`。

## 范围

- Node 单元测试：Decimal、单位分组、状态机、阻塞原因和重算。
- PostgreSQL 集成测试：多工序、多生产单、多批外加工来源、冲销和事务回滚。
- HTTP/API 测试：鉴权、RBAC、分页、错误码、幂等和并发冲突。
- Playwright：登录、订单列表、进度详情、超单/差异/外加工阻塞、来源时间线和权限。
- 更新 `docs/test/results/` 测试报告及 `docs/task/coding-roadmap-todolist.md` 的 D7 状态。

## 非范围

不把未配置的 PostgreSQL/API/浏览器环境伪报为通过；环境缺失必须记录为后置验证。

## 验收与验证

- 设计文档列出的 8 类测试场景全部有证据或明确后置验证。
- D1-D6 回归通过，D7 的重算结果与来源抽样核对一致。
- 构建、质量门禁和测试日志通过审查。
- 发现问题先修复再关闭链路；不得只依赖静态检查。

## 决策记录

- 链路关闭的判定同时依赖代码、真实数据流测试、浏览器工作流和文档更新。

## 完成记录

已补 D7 PostgreSQL 集成旅程断言、匿名 HTTP 路由测试和 Playwright 工作台断言；D5 集成测试已接入 D7 重算服务并验证订单状态/重算审计。已记录测试结果和环境阻断，不虚报真实环境通过。

已通过：API/Web 类型检查、API/Web 构建、单元测试 30/30、D7 领域测试 3/3、测试脚本语法检查。

后置验证：`TEST_DATABASE_URL`、`API_BASE_URL`、`PLAYWRIGHT_BASE_URL` 未配置，PostgreSQL、HTTP API、Playwright 尚未运行，详见 `docs/test/results/2026-08-22-d7-implementation.md`。

提交：`74be536 test: close d7 progress chain`
