# 0821-05-07 D4 浏览器验收与链路关闭

## 状态

已完成

## 目标

用真实浏览器完成从已入库原料、厂内生产单到领料、退料/报废或冲销的操作旅程，并以可复现证据关闭 D4，不把后续生产日报或成品链路误标为已交付。

## 关联决策

- `raw-material-issue-return-scrap-inventory-chain-implementation-design.md` 的测试决策、非范围与交付门槛
- `testing-system-and-tooling-plan.md`
- 编码路线图 D4、D5

## 范围

- 使用独立 PostgreSQL、真实 API 和 Playwright 完成已登录操作员的 D4 主旅程；
- 验收 UI 中的库存影响预览、风险原因、领料、退料或报废、冲销/拒绝冲销、历史审计和可见错误；
- 执行 `verify:quick`、`verify:chain`，归档报告，更新路线图 D4 状态和每日开发日志；
- 明确 D4 结束时 D5-D7、E1-E5、外加工直发和全局告警仍未实现。

## 非范围

- 以页面可打开或构建通过代替真实数据流转验收；
- 厂内正式部署、备份恢复、并发性能压测和历史迁移；
- 补做本批以外的业务功能以便测试通过。

## 验收与验证

1. Playwright 可从真实登录开始，选择生产中的厂内生产单，完成领料并验证可用库存下降与历史可追溯。
2. Playwright 完成退料或报废，并验证退料回补、报废不回补及数量/风险错误均在页面中可见。
3. 已过账单据的冲销或拒绝冲销在真实界面中符合 API 和库存事实结果。
4. 独立 PostgreSQL、HTTP/API、浏览器和质量门禁结果完整归档，D4 不以 mock、测试阻断或手工数据库修改作为验收证据。
5. 路线图、每日开发日志和测试报告准确反映 D4 的实际范围与剩余依赖。

## 阻塞关系

被 05 原料流转前端工作流和 06 D4 API 与数据库回归阻塞。

## 完成记录

完成日期：2026-08-21

验证：新增真实 Playwright 用例 `tests/e2e/raw-material-movement.spec.mjs`，从登录开始选择生产中的厂内生产单，查看影响预览，完成领料、退料、报废，并验证存在下游记录时来源领料冲销被服务端拒绝。专门 D4 用例通过；完整 `npm run test:e2e` 通过 4 项。`npm run verify:chain` 通过：迁移准备、4 项 PostgreSQL 集成、4 项 HTTP/API 和 4 项浏览器用例全部通过。结果见 `docs/test/results/latest-chain-quality-gate.md` 与 `docs/test/results/2026-08-21-d4-browser-acceptance-report.md`。

## D4 关闭边界

D4 已完成并关闭。D5-D7（工序/员工日报、超单与差异告警、生产进度、外加工直发）、E1-E5（成品 QC/库存/出库/应收）、全局告警中心、部署和历史迁移仍按路线图保持未交付状态。
