# D7 生产进度、生产计量与订单推进状态测试记录

## 范围

本次覆盖 D7 领域计算、来源重算审计、订单状态/时间线 API、权限元数据和 Web 工作台。D5 工序日报、员工日报及 D6 外加工成品来源被纳入 D7 集成测试旅程。

## 已通过

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| API 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/api` |
| Web 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/web` |
| API 构建 | 通过 | `npm run build --workspace=@dilee/api` |
| Web 构建 | 通过 | `npm run build --workspace=@dilee/web` |
| 单元测试 | 31/31 通过 | `npm run test:unit` |
| D7 领域测试 | 3/3 通过 | Decimal、取消事实、混合单位、状态阻塞和能力标记 |
| 测试脚本语法 | 通过 | `node --check`（D7 集成/HTTP 测试） |

## 后置验证

| 检查 | 结果 | 阻断原因 |
| --- | --- | --- |
| PostgreSQL 集成测试 | 未运行 | `TEST_DATABASE_URL` 未配置，入口返回 `TEST_BLOCKED` |
| HTTP API 测试 | 未运行 | `API_BASE_URL` 未配置，入口返回 `TEST_BLOCKED` |
| Playwright 工作台测试 | 未运行 | `PLAYWRIGHT_BASE_URL` 未配置，入口返回 `TEST_BLOCKED` |

本次收束修正另外覆盖了 D5/D6 来源事务内重算、来源冲销阻塞和进度审计时间线。真实环境具备后，至少执行：

```powershell
$env:TEST_DATABASE_URL = "postgresql://.../dilee_erp_test"
$env:API_BASE_URL = "http://localhost:3001"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
npm run verify:chain
```

不得将后置验证改写为通过；需确认 D7 集成旅程中的生产计量、阻塞恢复、重算审计和工作台展示证据。
