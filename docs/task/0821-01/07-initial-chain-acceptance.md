# 0821-01-07 初链路集成与浏览器验收

## 状态

环境阻断（代码验收完成，真实数据库链路待恢复）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

以唯一端到端验收缝隙验证 0821-01 的安全性、数据一致性与可用性，并记录可复现的部署/恢复结果。

## 关联决策

- `docs/design/0821-01-initial-order-chain-delivery-plan.md`
- `docs/test/platform-quality-and-recovery.md`

## 范围

- API 集成测试：健康检查、登录/退出/会话、权限、客户、销售单、确认和 BOM 来源；
- 浏览器端到端测试：登录 -> 客户 -> 销售单 -> 订单号 -> 确认 -> BOM -> 来源追踪；
- 负向测试：重复订单号、无权访问、未登录、未确认销售单建 BOM、非法状态流转、已建 BOM 后销售编辑；
- 运行构建、类型检查、测试和数据库迁移重复执行验证；
- 记录本机启动、初始化、测试、失败恢复和遗留风险。

## 非范围

- 后续模块的业务验收；
- 性能压测、生产服务器正式部署、数据迁移和用户培训。

## 验收与验证

1. 已验证：API build、Web build、全仓 typecheck、5 项 API 单元/契约测试全部通过。
2. 已验证：API 可启动并正确映射认证、客户、销售单、BOM 路由；数据库不可用时 `/api/v1/health` 返回 `503 DEPENDENCY_UNAVAILABLE`。
3. 已验证：浏览器打开 `/login`；未登录访问 `/` 自动跳转 `/login`；页面不再展示演示数据工作台。
4. 待验证：真实 PostgreSQL 迁移、初始管理员 seed、登录 Cookie、客户创建、销售单创建/确认、BOM 创建和来源追踪。
5. 阻断原因：Docker Desktop 已启动，但拉取 `postgres:16-alpine` 时 Docker Hub HTTPS 连接被当前网络代理阻断；本机没有可用 PostgreSQL/psql 服务。
6. 所有发现的未确认业务规则进入 `docs/memo/`，不通过临时代码绕过。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：运行态 API/Web 已启动；Playwright 验证登录页与未登录跳转；PowerShell 请求健康检查得到 `503 DEPENDENCY_UNAVAILABLE`。完整链路需 PostgreSQL 环境恢复后重新执行。
