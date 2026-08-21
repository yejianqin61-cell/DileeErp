# 0821-05-06 D4 API 与数据库回归

## 状态

已完成

## 目标

以独立 PostgreSQL 和真实 HTTP/API 验证 D4 的库存、数量、幂等、权限与回退规则，确保新增生产物料流转不会破坏采购入库库存链路。

## 关联决策

- `raw-material-issue-return-scrap-inventory-chain-implementation-design.md` 的测试决策与交付门槛
- `testing-system-and-tooling-plan.md`
- 编码路线图 C4、D4

## 范围

- 建立/扩展 D4 的业务夹具和独立 PostgreSQL 测试用例，覆盖采购入库形成可用库存后进入厂内生产领退料报废的连续事实；
- 通过真实 HTTP/API 覆盖鉴权、权限、草稿、预览、过账、幂等、冲销、错误码和审计；
- 将稳定的 D4 回归纳入现有 `verify:chain` 和测试报告证据格式；
- 明确记录尚未实现的 D5-D7、E、外加工直发与全局告警边界。

## 非范围

- 用 mock 结果代替 PostgreSQL、HTTP 或浏览器验收；
- 大规模性能压测、厂内部署演练或历史数据迁移；
- 为测试虚构未实现的日报、成品或财务事实。

## 验收与验证

1. 真实 PostgreSQL 用例覆盖原料入库回归、领料扣减、退料回补、报废不回补、超量拒绝与冲销安全门禁。
2. HTTP/API 用例覆盖未登录 401、无权限 403、库存不足/数量超限 422、并发或重复操作 409/幂等结果及统一 JSON 信封。
3. 每次过账或冲销后，库存余额、来源关系、`order_no` 和审计均可由 API 读取验证。
4. `verify:quick` 与 D4 相关的 `verify:chain` 前置验证可在独立环境稳定执行，测试报告记录命令、环境、结果和残余风险。
5. 既有采购入库至应付来源测试继续通过。

## 阻塞关系

被 04 原料流转冲销、审计与附件阻塞。完成后阻塞 07。

## 完成记录

完成日期：2026-08-21

验证：真实 PostgreSQL `npm run test:integration` 通过 4 项，覆盖采购入库回归、领料扣减、退料回补、报废不回补、超量拒绝、幂等和冲销安全门禁；D4 集成测试改用真实 `AuditService`，并断言库存事实的 `order_no`/来源明细和过账审计。启动真实 API 后，`API_BASE_URL=http://localhost:3011 npm run test:api` 通过 4 项，覆盖所有 D4 受保护入口的 401、统一错误信封和请求 ID。API build 通过，证据见 `docs/test/results/2026-08-21-d4-material-movement-test-report.md`。
