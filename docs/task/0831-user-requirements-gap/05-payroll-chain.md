# 05 — 日报到工资来源与工资台账闭环

**What to build:** 员工按生产单、工序和日期提交日报，重复自然键自动累加并生成工资来源；财务在工资总览按员工和期间维护、确认和支付工资台账。

**Blocked by:** #3 — 生产验收环境与发布包指纹闭环

**Status:** implemented — pending real PostgreSQL/browser acceptance

- [x] 计件和计时四种组合均可保存，计件不强制时长，计时不强制件数，人工单价始终必填。
- [x] 同员工、生产单、工序、日期和计薪方式重复提交只更新累加行，不产生重复事实。
- [x] 切换日期、生产单和工序不会串数据；计划数量和超单量计算可复现。
- [x] 日报保存后在同一事务生成或更新工资来源，工资总览可立即查询。
- [x] 工资总览支持车间/非车间分区、姓名和期间筛选、草稿 CRUD、确认和支付。
- [x] 人事负责来源记录，财务负责台账确认和支付；重复入口不产生重复工资事实。
- [ ] 真实 PostgreSQL 测试覆盖重复提交、并发冲突和工资汇总（需配置 TEST_DATABASE_URL）。

**Evidence:** `employee-daily-reports.service.ts` 在单事务内累加日报并同步生产工资来源；`daily-reports-panel.tsx` 按生产单/工序/日期隔离；`finance/salary/page.tsx` 提供车间/非车间工资总览；`employee-daily-reports-service.test.cjs`、`daily-report-merge-anomalies.test.cjs`、`payroll-ledger-service.test.cjs` 覆盖核心规则；`npm run test:unit` 当前 127 项通过。
