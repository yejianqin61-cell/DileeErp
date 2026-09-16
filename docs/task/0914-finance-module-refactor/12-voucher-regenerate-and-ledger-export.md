# Task 12：凭证重新生成 + 银行存款引用具体账户 + 确认页过滤与两处台账导出

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

1. 「现在要支持凭证重新生成。」
2. 「凭证中的那个会计科目的银行存款，要引用的是具体的银行账户」
3. 「确认应付，确认应收，表单里如果是已付或者已收款，那个条目就不要出现在那里了！」
4. 「冲销是什么意思？」（概念提问，回答记在设计与日志里）
5. 「确认应收，确认应付，两处表单。要支持导出excel。支持按照已付未付，已收未收。还有按照时间范围筛选。」

设计见 [凭证重新生成、银行存款引用具体账户、确认页过滤与台账导出](../../design/finance-voucher-regenerate-and-ledger-export-2026-09-16.md)。

## 范围

### 数据库

- `voucher_lines` 新增 `bank_id UUID`（可空，`ON DELETE SET NULL`，建索引）；
  红冲件同样带 `bank_id`。**科目名仍是「银行存款」**，账户是引用 + 名称快照两层。

### 后端

- `POST /finance/vouchers/:id/regenerate`：草稿 + 来源为收支流水 + 来源存在且未冲销，
  四条门禁各有错误码；事务内 `FOR UPDATE` 复查状态、**删旧分录重建**、刷新凭证头日期/期间/
  摘要/币种/合计；审计 `voucher.regenerate` 记 before/after。
- `voucher.domain.ts` 的 `fundLineFor()`：`bank_id` 优先于「结算方式含现金」的文本判断，
  科目名快照 `${bankName}${accountNumber}`，无账户名时退化为纯 `银行存款`。
- 新增 `ledger-filter.ts`（应收/应付共用筛选口径：付款情况分桶、日期闭区间、关键字）
  与 `ledger-workbook.ts`（两张台账工作簿 + 表尾口径说明）。
- `GET /finance/payable-entries.xlsx`、`GET /finance/receivable-sources.xlsx`：
  接受与界面同一组参数（`payment/from/to/q` + 各自的身份参数），走既有
  `renderReportWorkbook` → `sendWorkbook`（金额为 Excel 数值、中文文件名用 `filename*=`）。
- `supplier-payable.service.list()` / `receivable.service.list()` 新增 `filter` 参数。

### 前端

- 凭证页：列表行与收支流水行两个「重新生成」入口（都先弹确认框，写明会覆盖手工分录）；
- 确认应付 / 确认应收：新增「付款情况 / 收款情况」筛选（**默认未付 / 未收**，括号里是实时条数）、
  「确认日期 / 出库日期」范围、以及「导出 Excel」按钮（把当前筛选原样带给后端）；
- 新增 `apps/web/lib/finance-ledger-filter.ts`（与后端同口径的第二份实现，供界面即时筛选与计数）。

## 不做

- **不做「按银行账户的银行存款明细账」报表**：数据（`bank_id`）已就位，报表未做；
- **不做重新生成的差异预览**：直接覆盖，靠审计留 before/after；
- **不放开「红冲后重新生成」**：`vouchers_source_type_source_id_key` 的唯一性语义不动；
- **导出不加合计行**：台账多币种同表，跨币种相加没有意义。

## 验收与验证

1. 凭证域 5 条：`bank_id` 优先于现金文本判断 / 科目仍为「银行存款」/ 快照名格式 /
   无账户名退化 / 红冲分录带 `bank_id`；
2. 凭证服务 5 条：重新生成重算分录与凭证头 / 已过账拒绝 / 红冲件拒绝 / 来源缺失拒绝 /
   来源已冲销拒绝 + 审计留痕；
3. 迁移守卫 4 条：列类型、`ON DELETE SET NULL`、索引、以及「不新建表」这条防线；
4. `ledger-export.test.cjs` 11 条：两侧分桶与日期区间 / 无日期行在设了范围时不计命中 /
   两张台账的列名与数值单元格 / 多币种表尾不合计 / 单币种不出多余表尾；
5. 服务层各 2 条：`list()` 的付款情况与日期筛选；
6. 前端 lib 4 条：与后端同口径的分桶、日期区间、导出查询串；
7. 组件测试：应付页「已付/未付筛选 + 日期 + 导出请求串」、凭证页两个重新生成入口
   （含草稿/已过账的门禁展示）；
8. 财务全部页面原有行为断言（请求契约、计数、列头）保持通过。

## 完成记录

- schema/迁移：`apps/api/prisma/schema.prisma`、
  `apps/api/prisma/migrations/20260916180000_voucher_line_bank_account/migration.sql`；
- 后端：`voucher.domain.ts`、`voucher.service.ts`（`regenerate`、`bankAccountLabel`、`draftForEntry`）、
  `voucher.controller.ts`、`ledger-filter.ts`(新)、`ledger-workbook.ts`(新)、
  `finance-report-workbook.ts`（抽出 `sendWorkbook`）、`finance-report.controller.ts`、
  `supplier-payable.service.ts`、`receivable.service.ts`、`finance.controller.ts`；
- 前端：`voucher-workspace.tsx`、`payable-workspace.tsx`、`receivable-workspace.tsx`、
  `finance-ledger-filter.ts`(新)；
- 验证：API 单测 **1380 / 1380**；web 组件 **38 文件 / 732 用例**全绿；web lib **154 条**全绿；
  `tsc --noEmit` 通过。本机无 PostgreSQL，**迁移未在真实库上执行**，凭证重新生成与导出的
  事务行为、`.xlsx` 在 Excel/WPS 里的实际打开效果均未端到端验证。
