# E5 应收调整、对账与订单关闭提示测试记录

## 范围

- 应收退款、红冲、折让、坏账和更正以独立调整事实记录。
- 调整过账/冲销不改写 E4 应收、收款和核销事实。
- 对账保存应收、收款、调整、系统余额、外部余额和差异快照。
- 订单关闭预览只读返回生产、成品出库、应收余额、对账和未冲销调整阻塞条件。

## 快速验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck --workspace=@dilee/api` | 通过 |
| `npm run build --workspace=@dilee/api` | 通过 |
| `npm run build --workspace=@dilee/web` | 通过 |
| `npm run test:unit` | 通过，47/47 |
| E5 领域不变量 | 通过：调整方向、超额调整、冲销后的净额、对账差异、关闭阻塞 |
| `git diff --check` | 通过 |

## 后置环境验证

`npm run verify:chain` 已执行，但当前环境未提供专用 `TEST_DATABASE_URL`、运行中的 `API_BASE_URL` 和 `PLAYWRIGHT_BASE_URL`，因此 PostgreSQL、HTTP API 和浏览器回归均按测试工具约定记录为“环境阻断”，不是业务失败。见 [latest-chain-quality-gate.md](latest-chain-quality-gate.md)。

环境具备后至少补验：迁移部署、调整过账/冲销事务、并发超额退款、对账快照、权限、审计、订单关闭预览和 E1-E4 回归。

## E5 结论

E5 代码、单元测试和构建完成；真实数据库/API/浏览器验收待环境具备后补做。订单关闭仍为只读提示，不自动改变销售单状态。
