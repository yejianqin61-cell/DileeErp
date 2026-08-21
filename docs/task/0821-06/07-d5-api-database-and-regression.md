# 0821-06-07 D5 API、数据库与回归测试

## 状态

已完成（2026-08-22）

## 目标

使用独立 PostgreSQL 和真实 HTTP/API 验证 D5 日报、计价、进度、告警、回退和薪资来源规则，并保证 D1-D4 不回归。

## 关联决策

- D5 设计第 5 节
- 测试体系与测试工具建设方案
- 编码路线图 D1-D5、F2

## 范围

- 建立 D5 业务夹具及 PostgreSQL 集成用例；
- 通过真实 HTTP/API 覆盖鉴权、RBAC、状态门禁、金额/数量、幂等、并发、审计和统一 JSON 信封；
- 将 D5 回归纳入 `verify:chain`，记录命令、环境、结果和剩余边界；
- 回归 D1-D4 的生产单、计价、库存事实和审计行为。

## 非范围

- 使用 mock 代替 PostgreSQL/HTTP/浏览器；
- 性能压测、部署演练、工资支付或成品库存测试。

## 验收与验证

1. 真实 PostgreSQL 覆盖计件/计时金额、单价快照、累计进度、超单、日报差异、告警确认/恢复和修改/删除回退。
2. HTTP/API 覆盖 401、403、422、409、幂等和稳定 JSON 契约；订单号、审计和薪资来源均可读取验证。
3. `verify:quick`、D5 相关 `verify:chain` 前置步骤稳定通过，D1-D4 回归继续通过。
4. 测试报告明确 D6-D7、F2 最终台账、E 链路和全局告警尚未实现。

## 完成记录

- 新增 PostgreSQL 集成夹具 `apps/api/test/integration/production-daily-reports.test.cjs`，覆盖计件/计时金额、Decimal 快照、累计进度、超单/差异告警、确认/恢复、幂等、版本冲突、逻辑删除和审计；
- 新增 HTTP 未登录契约测试 `apps/api/test/http/production-daily-reports-http.test.cjs`；
- 真实测试库执行迁移并通过 5/5 集成测试；API 契约测试通过 6/6；既有 D1-D4 集成测试继续通过；API build、unit 25/25 通过；
- 测试证据见 [2026-08-22-d5-api-regression.md](../../test/results/2026-08-22-d5-api-regression.md)；
- D6-D7、F2 最终台账、E 链路和全局告警仍未实现，未纳入本批通过声明。

## 阻塞关系

被 02 至 05 阻塞；完成后阻塞 08。
