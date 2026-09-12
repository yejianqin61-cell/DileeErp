# 05 — 日报到工资来源与工资台账闭环

**What to build:** 员工按生产单、工序和日期提交日报，**同一员工同日同工序允许多条**（各自独立计薪），薪资来源按有效日报求和生成；财务在工资总览按员工和期间维护、确认和支付工资台账。

**Blocked by:** #3 — 生产验收环境与发布包指纹闭环

**Status:** implemented — pending real PostgreSQL/browser acceptance

> 口径更新（2026-09-12）：第 3、10、17 行写于“同键累加为一行”的旧口径下。现行口径为：同一员工 + 同一生产单 + 同一工序 + 同一天允许重复登记多条日报（支持复选、可混合计薪方式、可不同单价），每条独立成行、独立计薪；数据库层的员工日报业务唯一索引已在迁移 `20260912120000_allow_duplicate_employee_daily_reports` 中移除；薪资来源、工资台账与工资总览仍按有效记录求和，金额不受影响。

- [x] 计件和计时四种组合均可保存，计件不强制时长，计时不强制件数，人工单价始终必填。
- [x] 同员工、生产单、工序、日期和计薪方式重复提交会新增一条独立日报（不再合并累加），薪资来源按有效记录求和，不漏计也不重复计薪。
- [x] 切换日期、生产单和工序不会串数据；计划数量和超单量计算可复现。
- [x] 日报保存后在同一事务生成或更新工资来源，工资总览可立即查询。
- [x] 工资总览支持车间/非车间分区、姓名和期间筛选、草稿 CRUD、确认和支付。
- [x] 人事负责来源记录，财务负责台账确认和支付；重复入口不产生重复工资事实。
- [ ] 真实 PostgreSQL 测试覆盖重复提交、并发冲突和工资汇总（需配置 TEST_DATABASE_URL）。

**Evidence:** `employee-daily-reports.service.ts` 在单事务内为每条日报独立落库并汇总同步生产工资来源；`daily-reports-panel.tsx` 按生产单/工序/日期隔离且支持同一员工复选；`finance/salary/page.tsx` 提供车间/非车间工资总览；`employee-daily-reports-service.test.cjs`、`employee-daily-reports-multi-entry.test.cjs`、`daily-report-merge-anomalies.test.cjs`、`payroll-ledger-service.test.cjs` 覆盖核心规则；`npm test` 当前 319 项通过。
