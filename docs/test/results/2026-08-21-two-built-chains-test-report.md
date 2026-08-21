# 已建成两条链路全量测试报告

## 1. 基本信息

- 测试日期：2026-08-21
- 测试对象：
  1. 客户 -> 销售单 -> `order_no` -> 销售确认 -> BOM
  2. BOM -> 采购单 -> 分批到货 -> 来料 QC -> 原料入库 -> 应付来源
- 提交基线：`a6cd954`（测试报告编制前的最新提交）
- 执行者：Codex
- 测试策略：Node `node:test` 领域规则、TypeScript/API/Web 构建门禁、HTTP、PostgreSQL 集成、Playwright 浏览器端到端。

## 2. 总结

快速质量门禁通过：类型检查、API 构建、Web 构建和 18 项领域/契约测试均通过。

真实 HTTP、PostgreSQL 集成和浏览器端到端测试未执行，不可据此声明两条链路已完成真实全量验收。阻断原因是本机未配置 `API_BASE_URL`、`TEST_DATABASE_URL`、`PLAYWRIGHT_BASE_URL`，且 Docker Desktop 未运行，无法启动 PostgreSQL 测试环境。

## 3. 执行结果

| 测试层 | 命令 | 结果 | 证据与说明 |
| --- | --- | --- | --- |
| 快速质量门禁 | `npm run verify:quick` | 通过 | Typecheck、18 项测试、API build、Web build 通过。 |
| HTTP/API | `npm run test:api` | 环境阻断 | 未设置 `API_BASE_URL`，退出码 3。 |
| PostgreSQL 集成 | `npm run test:integration` | 环境阻断 | 未设置专用 `TEST_DATABASE_URL`，退出码 3。 |
| 浏览器 E2E | `npm run test:e2e` | 环境阻断 | 未设置 `PLAYWRIGHT_BASE_URL`，退出码 3。 |
| Docker 测试库 | `docker ps -a` | 环境阻断 | Docker Desktop Linux Engine 管道不存在，Docker daemon 未运行。 |

## 4. 销售链路覆盖

已通过的快速规则测试：

- 草稿销售单可确认，确认写入服务端操作人审计字段。
- 非草稿销售单不可重复确认，返回稳定的 `INVALID_STATE_TRANSITION`。
- 已确认销售单创建 BOM 时，BOM 保留销售单 `order_no` 与销售单版本来源。
- 未确认销售单不可创建 BOM，返回 `SALES_ORDER_NOT_CONFIRMED`。
- 空 BOM 不可发布；已发布 BOM 不可原地编辑。

未获得的真实链路证据：客户、销售单、销售确认、BOM 明细/发布的 HTTP 响应、真实数据库事务、审计事件，以及浏览器表单端到端行为。

## 5. 采购入库链路覆盖

已通过的快速规则测试：

- 采购基础资料被引用后不可物理删除。
- 来料 QC 累计检验量不可超过到货量，且 QC 分流数量受校验。
- 原料入库量不可超过 QC 允许量。
- 入库过账设计了同一订单号、库存事实、应付来源唯一性和重复过账拒绝的真实 PostgreSQL 用例。
- 通用断言覆盖订单号贯穿、审计字段、QC 分流、库存事实汇总与应付来源唯一性。

未获得的真实链路证据：BOM 发布到采购单、分批到货、QC、入库与应付来源的同一事务提交/回滚，真实幂等冲突，前端操作与可见错误提示。

## 6. 缺陷与风险

本次快速门禁未发现失败用例。

关键未验证风险：

- 真实 PostgreSQL schema、迁移、外键和事务行为尚未验收。
- API 鉴权、RBAC、统一错误信封及字段校验尚未经 HTTP 运行环境验证。
- 浏览器登录和页面操作尚未经 Chromium 运行环境验证。
- 当前采购集成用例在真实测试库可用后必须运行；它才是库存事实与应付来源原子性的直接证据。

## 7. 验收前置与复测命令

1. 启动 Docker Desktop，或提供一个独立且名称含 `test` 的 PostgreSQL 数据库。
2. 设置以下环境变量：

```powershell
$env:TEST_DATABASE_URL='postgresql://.../dilee_erp_test?schema=public'
$env:API_BASE_URL='http://localhost:3001'
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
```

3. 依次执行：

```powershell
npm run db:test:prepare
npm run test:integration
npm run test:api
npm run test:e2e
npm run verify:chain
```

只有以上命令全部通过后，才可将两条链路标记为真实全量验收通过。
