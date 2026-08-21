# 0821-03-05 PostgreSQL 集成与事务测试

## 状态

已实现（环境阻断）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

在专用 PostgreSQL 测试库中验证 Prisma 迁移、seed、真实外键、事务、库存事实和应付来源数据流。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 3.2、5.3、8 节
- `docs/test/platform-quality-and-recovery.md`
- `apps/api/prisma/schema.prisma`

## 范围

- 提供测试数据库准备、迁移、seed、健康检查和清理命令；
- 验证空库迁移可重复执行、外键/唯一约束、逻辑删除和测试角色初始化；
- 验证采购单快照、QC 分流、原料入库、库存事实、应付来源在同一事务中提交或整体回滚；
- 覆盖重复过账、并发冲突、来源失效、库存负数和数据库异常后的无部分写入；
- 记录真实 PostgreSQL 未可用时的环境阻断证据。

## 非范围

- 浏览器测试；
- 生产库恢复演练（属于部署验收）；
- 大规模性能压测。

## 验收与验证

1. 测试库连接串与生产库隔离，迁移和清理不会触碰生产数据。
2. 入库过账成功时库存事实和应付来源同时存在；失败时两者均不存在。
3. 重试不会重复库存或应付来源，冲销保留原事实并写入反向事实。
4. 报告明确区分真实数据库通过、数据库环境阻断和 mock 测试通过。

## 决策记录

真实 PostgreSQL 集成是链路关闭的必要证据；数据库不可用时不自动降级为“集成通过”。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：`npm run test:unit`，14 tests passed；`npm run db:test:prepare` 和 `npm run test:integration` 均因未设置专用 `TEST_DATABASE_URL` 以 `TEST_BLOCKED` 退出。测试库脚本拒绝非 test 命名数据库并将 Prisma 连接限定为该环境变量。
