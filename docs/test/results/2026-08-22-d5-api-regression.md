# D5 API、数据库与回归测试证据

## 环境

- 日期：2026-08-22
- 测试数据库：独立 PostgreSQL `dilee_erp_test`（`TEST_DATABASE_URL`）
- API：NestJS 本地进程，`API_BASE_URL=http://localhost:3001`
- 提交基线：task 07 执行时工作区提交前版本

## 结果

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 数据库迁移 | `npm run db:test:prepare` | 通过，包含 D5 两个迁移 |
| 单元与既有领域回归 | `npm run test:unit` | 通过，25/25 |
| PostgreSQL 集成 | `npm run test:integration:raw` | 通过，5/5（D1-D4 + D5） |
| HTTP/API 契约 | `API_BASE_URL=http://localhost:3001 npm run test:api:raw` | 通过，6/6 |
| API 编译 | `npm run build --workspace=@dilee/api` | 通过 |

## D5 覆盖

- 计件金额 = 件数 × 单价；计时金额 = 分钟 × 单价，计时件数参与差异核对；
- 单价快照不受未来计价修改影响；
- 累计量、差额、超单状态及持续告警；
- 员工日报差异告警自动恢复，告警确认备注与审计；
- 幂等键、乐观版本冲突、逻辑删除和影响联动；
- 订单号、生产单、工序、员工及审计可追溯。

## 未覆盖边界

D6-D7 外加工/订单工作台、F2 最终薪资台账、E 成品 QC/库存、全局告警中心和性能压测不属于 D5。
