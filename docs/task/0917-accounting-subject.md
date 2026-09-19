# 任务：收支项目并入会计科目（2026-09-17）

需求原文与口径依据见 `docs/design/accounting-subject-chart-2026-09-17.md`；
37 条对照表（**请财务过目**）见 `docs/memo/0917-收支项目并入会计科目对照表.md`。

一句话：财务的「收支项目」不再独立存在，全站财务口径改为一张**会计科目表**
（分类 = 科目类别，项目 = 科目名称，来源 `example/财务/科目表(2).xls`，121 条），
旧 37 条并入、历史数据改指、收支项目维护与会计科目维护合并成一个栏目。

## 1. 交付清单

| # | 交付物 | 位置 |
| --- | --- | --- |
| 1 | 科目表常量（121 条 + 37 条并入映射 + 自动归类候选链） | `apps/api/src/modules/finance/accounting-subject-catalog.ts` |
| 2 | 结算账户字典常量（剥离收支项目） | `apps/api/src/modules/finance/cash-flow-catalog.ts` |
| 3 | 表模型 | `apps/api/prisma/schema.prisma`（`AccountingSubject` + 5 张表改 `subjectId`） |
| 4 | 迁移（建表 + 种入 + 沿用旧 id + 改指 + 外键切换 + 审计） | `apps/api/prisma/migrations/20260917120000_accounting_subjects/migration.sql` |
| 5 | 科目服务与控制器 | `apps/api/src/modules/finance/accounting-subject.{service,controller}.ts` |
| 6 | 收支流水改口径（含 `requireSubject` / `firstCandidateSubject`） | `apps/api/src/modules/finance/cash-flow.{service,controller}.ts` |
| 7 | 收付款/对账/确认/工资付款改字段 | `customer-payment` `supplier-payment` `reconciliation` `supplier-payable(-reconciliation)` `receivable` `finance.controller` `hr/salary-payment` |
| 8 | 报表改口径（分类列 + 分类小计） | `finance-report-{query.service,tables,types,controller}.ts` |
| 9 | 凭证业务科目接入科目表 | `voucher.{domain,service}.ts` |
| 10 | 新库初始化种科目 | `apps/api/prisma/seed.ts` |
| 11 | 前端共用件 | `apps/web/lib/accounting-subjects.ts` |
| 12 | 子栏目与页面 | `apps/web/lib/finance-sections.ts`、`app/finance/cash-flow/page.tsx` |
| 13 | 科目维护页 | `apps/web/components/finance/accounting-subject-workspace.tsx` |
| 14 | 流水页/应收/应付/报表/凭证页改口径 | `apps/web/components/finance/*.tsx` |

## 2. 迁移（**部署前必做**）

```bash
npm run db:generate --workspace=@dilee/api   # schema 改了必须先重生成 client
npx prisma migrate deploy                    # 生产：先跑迁移再上新代码
```

**不跑迁移直接上新代码 = 全站收支相关功能立刻不可用**（`cash_flow_entries.subject_id` 不存在）。

迁移是幂等意义上的「一次性」，但有几处刻意的行为要记住：

1. **空库（无 users）时科目种入整段跳过**，交给 `prisma/seed.ts`（与币种/结算账户字典同一约定）；
2. **一对一映射的 32 条沿用旧字典项 id**，因此历史外键不需要逐行 UPDATE；合并组那 5 条由临时映射表驱动的
   5 条 UPDATE 改指（不漏表）；
3. **未写进对照表的自定义旧项目并入分类「未分类」**，不丢；插不进去时迁移 `RAISE EXCEPTION` 中止；
4. 旧 `cash_flow_item` 字典**软删**，审计事件留下完整 37 条前后值。

## 3. 关键实现决定（为什么这么做）

| 决定 | 理由 |
| --- | --- |
| 独立表 `accounting_subjects`，不做成字典类型 | 科目表多一个「分类」维度，字典项是平表；用户也明说合并后叫「会计科目」 |
| 唯一键 `(category, name)` | 同分类内不重名（迁移幂等靠它）；跨分类允许同名，将来要时不用再迁移 |
| 列名 `item_id` → `subject_id` 一起改 | 留着旧名会让旧口径在代码里阴魂不散；这列是全站报表口径依据，名字要说真话 |
| 只停用不删除；被引用时删除直接拒 | 宪法《Configurable Business Categories》：已被引用的分类要留成历史快照 |
| `requireSubject` 放在 `CashFlowService` | 全站「科目 id 是否可用」的唯一实现；建单/过账两条路径不能各写一份校验 |
| 自动归类候选链按**科目名称**取值 | 科目可改名，名称是种入时唯一的（单测钉住）；重名时按 `sortOrder` 取第一条，结果确定 |
| 收支汇总表加「分类小计」 | 用户「很多报表都要根据这个来统计」的直接落地：这张表本身能回答「销售费用一共花了多少」 |
| 科目常量单独成文件，迁移 SQL 与 seed 都从它生成 | 避免「老库升级」与「新库初始化」种出两张不同的表（收支项目字典当年踩过） |

## 4. 可复现的生成器（`scripts/`）

科目表 121 条、迁移 SQL 的 VALUES、memo 对照表都是**脚本从 xls 直接生成**的，没有手抄
（科目名里有 `销售- 办产地证`、`管理 -财产保险` 这类原表手误空格，手抄一定漂移）：

| 脚本 | 作用 |
| --- | --- |
| `scripts/import-accounting-subject-chart.cjs` | `example/财务/科目表(2).xls` → `accounting-subject-catalog.ts` 的 121 条常量 |
| `scripts/generate-accounting-subject-migration.cjs` | 常量 → 迁移 SQL（121 条 VALUES + 37 条映射 + 全部 DDL） |
| `scripts/generate-accounting-subject-memo.cjs` | 常量 → `docs/memo/0917-收支项目并入会计科目对照表.md` |
| `scripts/dump-legacy-xls.cjs` | 通用 .xls → 文本 dump（口径核对用，`node scripts/dump-legacy-xls.cjs <文件>`） |

财务更新了科目表时，把新文件放进 `example/财务/` 并依次重跑前三个（都从仓库根目录跑）。

`import-accounting-subject-chart.cjs` 只重写 `accounting-subject-catalog.ts` 的**生成段**
（头部说明 + 分类常量 + 121 条科目 + `accountingSubjectKey`），从
`/* ---- 旧「收支项目」并入 */` 标记处往下的手写段（旧项目并入映射、自动归类候选链）**整段保留**，
已用「重跑后文件哈希不变」的方式验证过（round-trip identical）。

## 5. 验收清单

- [x] 会计科目表 121 条，分类 = 科目类别，项目 = 科目名称，无科目代码
- [x] 5 张表外键切到 `accounting_subjects`，列名 `subject_id`
- [x] 37 条旧项目全部有归属（含 5 个合并组），迁移守卫测试逐条校验
- [x] 未映射的自定义旧项目不丢（「未分类」兜底 + 迁移自检）
- [x] 审计事件留下 37 条前后值与原因、来源
- [x] 收支流水：分类/项目两列 + 分类筛选；录入必选科目
- [x] 收支项目维护与会计科目合并成一个子栏目（`/finance/cash-flow?tab=subjects`）
- [x] 收支明细表 9 列（含分类）、收支汇总表含分类列与分类小计
- [x] 凭证业务分录科目取会计科目（`分类/项目` 作为科目编码）
- [x] `seed.ts` 新库种科目，不再种收支项目字典
- [x] API typecheck / Web typecheck / API 单测 / Web 单测 / `next build` 全绿
- [ ] **迁移在真实 PostgreSQL 上执行过**（本机无库，未验证 —— 见设计文档 §9）
