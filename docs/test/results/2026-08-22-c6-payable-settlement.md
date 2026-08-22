# C6 应付确认、付款与核销测试记录

## 范围

- 厂内原料入库和外加工签收两类应付来源统一生成应付确认快照。
- 应付确认支持确认、余额计算和冲销门禁。
- 供应商付款支持分批、未分配付款、多对多核销和付款冲销。
- 所有金额使用 Decimal，订单号、来源、操作人和审计事件贯穿链路。

## 快速验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck --workspace=@dilee/api` | 通过 |
| `npm run build --workspace=@dilee/api` | 通过 |
| `npm run build --workspace=@dilee/web` | 通过 |
| `npm run test:unit` | 通过，50/50 |
| C6 领域不变量 | 通过：应付余额、付款/应付双向超额核销、状态派生、来源类型 |
| `git diff --check` | 通过 |

## 后置环境验证

真实 PostgreSQL、HTTP API 和 Playwright 回归需在 `TEST_DATABASE_URL`、`API_BASE_URL`、`PLAYWRIGHT_BASE_URL` 可用后执行。至少补验迁移、两类来源幂等生成、事务并发超额核销、付款冲销恢复、权限、审计和订单号汇总。

## C6 结论

C6 代码、单元测试和构建完成；真实数据库/API/浏览器验收待环境具备后补做。原始应付来源、确认快照、付款和核销均保持独立事实，不物理删除。
