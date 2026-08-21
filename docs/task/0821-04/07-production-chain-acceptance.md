# 0821-04-07 生产基础链路验收与回归证据

## 状态

已完成

## 目标

用独立 PostgreSQL 测试库、真实 API 和浏览器验证 D1-D3 的可操作性、数据一致性、权限和审计，并将证据纳入链路质量门禁。

## 关联决策

- `employee-operation-production-order-chain-implementation-design.md` 的测试决策
- `testing-system-and-tooling-plan.md`
- `docs/test/README.md`

## 范围

- 建立覆盖组织/员工、工序/计价、生产单/工序/状态机的主路径、负向、逻辑删除/恢复、权限和审计测试；
- 通过真实 API 从已确认订单和已发布 BOM 创建生产单，而不是仅靠直接数据库夹具伪造业务旅程；
- 使用 Playwright 完成物控 Web 主路径并验证可见错误；
- 执行 `verify:quick` 与 `verify:chain`，归档结果及残留风险。

## 非范围

- 将未实现的 D4-D7、E、F 链路伪装为生产完成验收；
- 厂内正式部署、备份恢复或并发压测。

## 验收与验证

1. 单元、HTTP、PostgreSQL 和浏览器测试均覆盖 D1-D3 的主路径和关键拒绝路径。
2. 真实测试库中可从订单/BOM 创建厂内生产单，添加工序并启动，审计可回查 `order_no`。
3. 外加工单可按最小追溯规则建立且不产生现场日报；厂内无工序启动、跨订单父单、非法状态转换均被拒绝。
4. `verify:quick` 和 `verify:chain` 通过，测试报告记录提交基线、环境、命令、结果与未覆盖边界。
5. 编码路线图 D1-D3 与 A7 相应状态、每日开发日志和测试证据同步更新。

## 阻塞关系

被 06 生产模块前端工作流阻塞。

## 完成记录

完成日期：2026-08-21

验收证据：

- 独立 `dilee_erp_test` 已执行 Prisma migration；`npm run test:integration` 通过 3 项真实 PostgreSQL 用例，包含已确认订单和已发布 BOM 创建厂内生产单、无工序启动拒绝、添加工序后启动，以及外加工工序作为工艺说明。
- `npm run test:api` 通过 2 项 HTTP 合同用例；`npm run test:e2e` 通过匿名访问、错误登录及物控从地点/工序维护到厂内生产单创建、加工作序、启动的 3 项浏览器用例。
- `npm run verify:quick` 与 `npm run verify:chain` 全部通过。Playwright 以已构建的 standalone Web 产物运行，并在启动时复制 Next 静态资源，避免开发服务器缓存占用影响验收。
- 本批边界仍止于 D1-D3：不包含领退料、日报、超单、外加工直发、成品 QC/出入库、应收应付结算或薪资。
