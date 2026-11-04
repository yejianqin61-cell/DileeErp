# 对抗性复核：其他应付进采购对账明细 + 会计科目落库/导出（2026-10-12）

复核人：`verifier-api`（独立复核，只读 `src/` `test/` `prisma/`，只在 `docs/review/` 写）
复核对象：工作区**未提交**改动（`git status` 里的 `apps/api/src/modules/finance/*`、`apps/api/prisma/*`、`apps/api/test/unit/*`）
结论一句话：**明细列与科目解析基本做到位，但「科目」在一个真实写账路径上被丢掉了 —— 通过「应付管理 → 确认应付」（逐条 / 批量）挂账时，条目自己填的科目不生效，备用金会被记成「管理费用」。此外迁移与 schema 存在两处永久漂移。**

> 本文件里的每条结论都带 `文件:行` 或**本次实跑**的命令输出。没有跑过的东西我写"未验证"，不写"通过"。

---

## 0. 复核方法与可复现命令

| 项 | 命令 / 位置 |
| --- | --- |
| 单测（7 个必跑文件） | `cd apps/api && <node> test/unit/<file>.cjs`，node = `C:\Users\USER\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0） |
| 环境变量 | `NODE_OPTIONS="--max-old-space-size=1536 --max-semi-space-size=16"`（单文件跑，未跑 `node --test` 全量） |
| 对抗性脚本（我自己写的，可重跑） | `node docs/review/verify-other-payable-subject.cjs`（18 项断言，其中 3 项失败，EXIT=1） |
| 迁移 ↔ schema 漂移证据 | `node node_modules/prisma/build/index.js migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script`（离线，不需要数据库；输出留在 `docs/review/_prisma-from-empty.sql`） |
| dist 与 src 一致 | 逐文件比时间戳 + 在 `dist/**/*.js` 里 grep 新代码（见 §7） |

7 个必跑单测**全部 EXIT=0**：

```
finance-report-query-service  tests 37  pass 37  fail 0   EXIT=0
finance-report-workbook       tests 11  pass 11  fail 0   EXIT=0
finance-report-controller     tests 26  pass 26  fail 0   EXIT=0
other-payable-import          tests 28  pass 28  fail 0   EXIT=0
accounting-subject-service    tests 22  pass 22  fail 0   EXIT=0
finance-slip-service          tests 15  pass 15  fail 0   EXIT=0
ledger-export                 tests 15  pass 15  fail 0   EXIT=0
```

另外补跑 3 个与本次改动相邻的文件，也都 EXIT=0：`accounting-subject-catalog`（16）、`supplier-payable-service`（33）、`supplier-payable-reconciliation-service`（15）。

---

## 1. 结论汇总

| # | 复核项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | `purchaseReconciliationDetail()` 不再按来源过滤 / 费用说明 / 科目 / 行数口径 | **通过** | `finance-report-query.service.ts:74-76,257-262,304-305,317-322`；脚本 B1–B10 |
| 2 | 19 列、列序、合计下标 `[17,18]` | **通过** | `finance-report.tables.ts:170-190,198,241-266`；脚本 D1；workbook 测试 |
| 3 | `createOther` / `importOther` 的科目校验与名字解析 | **通过** | `supplier-payable.service.ts:461,477-482,488-500,545-561`；测试 28/28 |
| 4 | 科目优先级三处一致性 | **不通过（高）** | 见 §3：还有第四、第五处写账入口（逐条/批量确认应付）**漏了条目科目** |
| 4b | 应付台账「会计科目」列与实际挂账科目的一致 | **不通过（中）** | 见 §4：`supplier-payable.service.ts:96-98` 只读 `row.subject`，看不到对账单级科目 |
| 5 | `usageCount` 补 `supplierPayableEntry` | **通过** | `accounting-subject.service.ts:129-144`；测试断言 7 张表 |
| 6 | 迁移 ↔ `schema.prisma` 一致 | **不通过（中）** | 外键动作 RESTRICT vs SET NULL、索引多出；`migration.sql:32,34` vs `schema.prisma:1375` |
| 6b | 是否需要回填 | **通过（无需回填）** | NULL 语义 = 未指定、回落候选链，与历史行为一致 |

---

## 2. 通过项的证据（不是复述描述，是逐条证伪失败）

### 2.1 不再按 `sourceType` 过滤（清单第 1 条）

- 旧代码的 `where: { ...scope, sourceType: { not: "other" } }` 已消失：`apps/api/src/modules/finance/finance-report-query.service.ts:257-258` 现在是 `where: scope`，`scope` 里没有任何 `sourceType`（`:238-256`）。
- 不是"注释说去掉了"：脚本断言了**传给 findMany 的 where**：

```
finance-report-query-service.test.cjs:  assert.equal(calls.supplierPayableEntry[0].where.sourceType, undefined, "不能再按来源类型筛")
```

  该用例 EXIT=0。同时 `calls.supplierPayableEntryCount.length === 0`（不再单独 count 被排除的笔数）。

- 期间过滤对"没有采购单的其他应付"仍然覆盖：`scope.OR` 第三条 `{ purchaseOrderId: null, createdAt: period }`（`:252`）。

### 2.2 `otherDescription` 取值与反例（含「-」、空说明、无 remark、无快照、30 字截断）

`otherPayableDescription`（`:69-77`）逻辑 = `sourceType !== "other" → null`；否则去掉 `^其他应付[-—]` 前缀并 `trim`，空则回落 `remark.trim()`，再空则 `null`。

脚本 B 项实跑结果（`node docs/review/verify-other-payable-subject.cjs`）：

```
PASS  B1 说明里本身含「-」（其他应付-周金红-备用金） → "周金红-备用金"
PASS  B2 说明以「-」开头（其他应付--备用金）        → "-备用金"
PASS  B3 快照为空串（其他应付-）+ 备注有值          → "银行转账"
PASS  B4 快照为 null + 备注为 null                  → null
PASS  B5 快照前后有空格（其他应付-  备用金  ）      → "备用金"
PASS  B6 破折号分隔（其他应付—备用金）              → "备用金"
PASS  B8 采购行即使快照是「其他应付-」              → null
PASS  B9 说明 31 字：落库即截 30 字，报表如实转述（不还原全文）
```

- 「说明里含 `-`」不会误剥：正则只锚定**开头一次**。
- 「截断到 30 字」是**落库时**就发生的（`supplier-payable.service.ts:493` 的 `slice(0, 30)`），报表只是转述 —— 与注释一致，不是缺陷，但财务只能看到前 30 字，值得知道。
- 一条**我无法证伪成缺陷、但值得记下的边界**：若某行 `sourceNoSnapshot` 不带 `其他应付-` 前缀（当前代码不会产出这种值，`grep "其他应付-"` 只命中 `supplier-payable.service.ts:493` 与两处读取），「费用说明」会把整串原样显示（脚本 INFO B7：`"其他应付备用金"`）。**当前应用内不可复现**，只是没有兜底。

### 2.3 `subjectName` 来自 include，且拼成 `分类 / 名称`

- include：`:262` `subject: { select: { category: true, name: true } }`；拼接：`:305` `accountingSubjectLabel(category, name)`；实现 `accounting-subject-catalog.ts:206-208` 返回 `` `${category} / ${name}` ``，与前端 `apps/web/lib/accounting-subjects.ts:29` 的 `subjectOptionLabel` **逐字一致**。
- 测试确实钉住了 include（不是只喂手写行）：`finance-report-query-service.test.cjs` 里 `assert.deepEqual(calls.supplierPayableEntry[0].include.subject, { select: { category: true, name: true } })`，并且同一用例断言 `rows[1].subjectName === "资产类 / 库存现金（备用金）"`、`rows[0].subjectName === null`。**这条测试不是自证。**

### 2.4 行数口径与 `sourceType` 不泄漏

- `:317-322`：`otherRowCount = mapped.filter(sourceType === "other").length`；`purchaseRowCount = mapped.length - otherRowCount`；返回前 `mapped.map(({ sourceType: _sourceType, ...rest }) => rest)`。
- 脚本 B10 实跑：`purchaseRowCount=1 otherRowCount=1 rows.length=2`，且 `Object.keys(rows[0])` 里**没有** `sourceType`。
- 说明：`purchaseRowCount + otherRowCount === rows.length` 是**构造性恒等**（同一个长度相减），它只能证明"统计没算错"，不能证明"筛选范围与行集一致"；后者由 2.1 的 where 断言覆盖。

### 2.5 19 列与合计下标（清单第 2 条）

逐列数一遍（`finance-report.tables.ts:170-190`），0 起算：

| 下标 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 列名 | 日期 | 产品名称 | 订单号 | 采购单号 | **费用说明** | 供应商名称 | 产品代码 | 规格型号 | 单位 | 币种 | 单价 | 含税单价 | 数量 | 折扣 | 税额 | 调整金额 | **会计科目** | **金额** | **含税金额** |

脚本 D1 实跑（直接读 dist 的列定义 + `reportTotalRow`）：

```
headers=[...] length=19，headers[3]="采购单号" headers[4]="费用说明" headers[16]="会计科目" headers[17]="金额" headers[18]="含税金额"
totalColumns=[17,18]
```

`[17,18]` 确实指向 `金额/含税金额`；行单元格顺序也与列一一对齐（`:241-266`，`会计科目` 在 16、金额在 17/18）。workbook 测试还断言了 `totals[15] === null`（调整金额不是合计列）。

### 2.6 `createOther` / `importOther`（清单第 3 条）

- **建单校验**：`supplier-payable.service.ts:461` `await this.cashFlow.requireSubject(input.subject_id, ...)`；`requireSubject`（`cash-flow.service.ts:192-201`）对空值返回 `null`、对不存在/停用抛 422。
- **真写进条目**：`:465` `subjectId: subject?.id ?? null` → `:496` `subjectId: input.subjectId`（`otherEntryData` 是新建与导入的唯一口径）。测试"新建其他应付：填了科目就存下来；科目不存在/已停用当场 422"通过。
- **名字 → id**：`:477-482` `where: { name, deletedAt: null, isActive: true }`，0 条 → `undefined`（认不出）、>1 条 → `"ambiguous"`（重名）。
- **两条分支都按行报错、该行不写、好行照常**：`:545-561`，`writableRows = parsed.rows.filter((row) => subjectIds.has(row.row))`；`parsed.errors` 与 `subjectErrors` 合并回报（`:562`），进 `hints`（`:614`），`status` 用 `allErrors` 判定（`:619`）。
- 实测（`other-payable-import.test.cjs`，EXIT=0）：
  - `导入：科目名认不出按行报错、该行不入库，别的行照常导入` → `imported=1 errorCount=1`，`createdEntries=[subj-1]`；
  - `导入：同名科目落在两个分类下时拒绝` → `imported=0`，状态 `partial`（解析期这行是好的）；
  - 表头别名 `会计科目/科目/科目名称/费用科目/总账科目`（`other-payable-import.ts:55`）；超 100 字按行报错（`:261`）；重复行判据**不含科目**（`:265`，测试"同一笔支出一行填了科目、一行没填，仍是重复"通过）。
- 我额外在**种入科目表**里核了模板举例的那几个名字都存在（`库存现金（备用金）`/`其他应收款`/`房租费`/`管理费用`/`顺丰快递` 等 11 个全部命中 `ACCOUNTING_SUBJECT_SEEDS`），名字唯一（脚本 C3：122 个唯一名称，无重名）—— 也就是说模板给的示例不会一用就报"科目不存在"。

### 2.7 `usageCount`（清单第 5 条）

`accounting-subject.service.ts:129-144` 现在是 7 张表，第 7 张 `this.prisma.supplierPayableEntry.count({ where: { subjectId: id } })`；`remove()`（`:117-126`）**先**调 `usageCount`，>0 抛 `ACCOUNTING_SUBJECT_IN_USE`（422），所以应用内路径不会撞外键。测试断言了 7 张表的表名集合与 `usage=35`，EXIT=0。

> 顺带观察（**非本轮缺陷**）：这 7 个 count 都不带 `deletedAt` 过滤，所以一条**已软删除**的其他应付仍会挡住科目删除。与其它 6 张表的历史口径一致，不是本次引入。

### 2.8 迁移的回填问题（清单第 6 条后半）

不需要回填：列可空，NULL 的语义 = "没指定 → 确认时按来源候选链"，与改动前的行为逐字一致（`migration.sql:15-17`）。给历史行填 `管理费用` 反而会把"自动归类"写死成"手选"，与设计文档 `docs/design/other-payable-detail-and-subject-2026-10-12.md:123` 的口径一致。迁移注释引用的设计文档确实存在（**通过**）。

---

## 3. 缺陷 1（高）：条目科目在「确认应付」的逐条 / 批量入口被丢掉

### 结论
**不通过。** 优先级的实际实现不是"三处"，而是**五处写/显示路径**；其中两处（`SupplierPayableService.confirm`、`batchConfirm`）**完全不看条目科目**，会用来源候选链首位 `管理费用` 挂账。这正是任务里点名的那种缺陷（"备用金会被记成管理费用"）。

### 证据

1. 挂账参数只有调用方传的 `options.subject_id`：
   - `apps/api/src/modules/finance/supplier-payable.service.ts:225-242`（`accrue`）：`contra_subject_names: row.sourceType ? paymentSubjectNames(row.sourceType) : PAYABLE_CONFIRM_SUBJECT_NAMES`，`contra_subject_id: options.subject_id` —— 函数签名（`:226`）里**没有** `subjectId`，`row` 的 `subjectId` 从未被读出。
   - `voucher.service.ts:223-225`：`contra_subject_id` 优先，没有才按 `contra_subject_names` 查名 —— 所以 `options.subject_id` 为空时**必然**落到 `paymentSubjectNames("other")[0]`，即 `accounting-subject-catalog.ts:359` 的 `"管理费用"`。
2. 批量入口连数据都没查出来：`supplier-payable.service.ts:272` 的 `select` 里**没有 `subjectId`**（实跑输出见下）。
3. 对照实现（对账单入口是对的）：`supplier-payable-reconciliation.service.ts:190` `select` 带 `subjectId: true`，`:230` `contra_subject_id: entry.subjectId ?? result.subjectId`。
4. 前端根本没把条目科目带进弹窗：`apps/web/components/finance/payable-workspace.tsx:602` 调 `subjectEditField("会计科目")`（**没有**第二参 `current`），而 `:485-489` 的 `defaultValue: current ?? ""`；`:491` `subjectValue("")` → `undefined`。所以默认路径送 `subject_id: undefined`。
5. 用户可见文案已经承诺了做不到的事：`other-payable-import.ts:315` 的模板填写说明第 9 条写着"填了就以填的为准（**确认应付时会把这笔挂到这个科目上**）"。经此路径确认时，这句是假的。
6. **对照组（对账单路径是对的）**，同一份脚本实跑：

```
PASS  E1 按对账单确认应付：条目自己的科目生效   contra_subject_id="subject-allowance"
INFO  E2 条目科目与弹窗科目同时存在时          contra_subject_id="subject-allowance"（与 design 文档 :113 的「条目优先」一致）
```

   即"条目优先"这条规则在 `supplier-payable-reconciliation.service.ts:230` 是**真的实现了**；缺的只是 `supplier-payable.service.ts` 那两条入口。

### 复现（实跑，EXIT=1）

```
node docs/review/verify-other-payable-subject.cjs

FAIL  A1 逐条确认（弹窗未重选科目）：挂账对方科目应取条目自己的科目 subject-allowance
      实际 contra_subject_id=undefined，contra_subject_names=["管理费用","其他管理费用"]
FAIL  A3 勾选批量确认：挂账对方科目应取条目自己的科目 subject-allowance
      实际 contra_subject_id=undefined，contra_subject_names=["管理费用","其他管理费用"]
FAIL  A4 勾选批量确认 findMany 的 select 里有没有 subjectId
      select = {"id":true,"payableNo":true,"orderNo":true,"amount":true,"currency":true,"sourceType":true,
                "supplierId":true,"supplier":{"select":{"name":true}},
                "payableSource":{"select":{"status":true}},"outsourcePayableSource":{"select":{"status":true}}}
```

脚本用的条目：`sourceType: "other"`、`subjectId: "subject-allowance"`（模拟导入/新建时选了「库存现金（备用金）」），`confirm(id, user, {})` / `batchConfirm([id], user, {})`。

**同一笔其他应付的两条确认路径会写出不同的账**：走对账单（`supplier-payable-reconciliation`）→ 挂到条目科目；走应付管理 → 确认应付 → 挂到 `管理费用`。

### 最小修复建议（不在此改动 src，交回 Lead）

1. `supplier-payable.service.ts`
   - `accrue` 增加入参 `entrySubjectId`，`:240` 改成 `contra_subject_id: entrySubjectId ?? options.subject_id`（顺序与 `supplier-payable-reconciliation.service.ts:230` 的"条目优先"一致）。
   - `confirm`（`:205-212`）里 `current`/`updated` 已有标量 `subjectId`，把它传给 `accrue`。
   - `batchConfirm` 的 `select`（`:272`）加 `subjectId: true`，循环里（`:289`）传 `draft.subjectId ?? options.subject_id`。
2. `payable-workspace.tsx`：`confirmEntry`（`:602`）改成 `subjectEditField("会计科目", item.subjectId)`，让弹窗默认带出条目科目（否则用户每次都得重选一遍）。
3. 补两条测试（当前**两条路径都没有覆盖**"条目自己有科目"这一分支）：
   - `test/unit/supplier-payable-service.test.cjs` 只在弹窗传了科目的情况下断言（`:220` `contra_subject_id === "subject-1"`），没有任何用例覆盖条目自带科目 —— 这正是本缺陷能溜过去的原因；
   - `test/unit/supplier-payable-reconciliation-service.test.cjs` 的 `draftEntry`（`:62`）**不带 `subjectId`**，所以 `:230` 的 `entry.subjectId ?? result.subjectId` 里"条目优先"那一半同样没有测试（只能靠脚本 E1/E2 现场验证，而它是好的）。

---

## 4. 缺陷 2（中）：应付台账的「会计科目」列可能显示一个并不会被挂账的科目

### 结论
**不通过（与注释/文档的口径不符）。** 台账列只读条目自己的科目，`row.subject`（`supplier-payable.service.ts:96-98`），否则显示**候选链首位**；而实际挂账时，科目也可能是**对账单上的**科目（`supplier-payable-reconciliation.service.ts:205` `subjectId = override.subject_id ?? current.subjectId`，`:230` `entry.subjectId ?? result.subjectId`）。

### 证据与可达路径
- 台账计算：`supplier-payable.service.ts:89-98`，注释自己写着"显示的是**确认时会写入的那个科目**"。
- 对账确认：`supplier-payable-reconciliation.service.ts:204-208,230`。
- 可达场景：创建对账单时填了「会计科目 = 成本类 / 房租费」（`payable-workspace.tsx:731` 会送 `subject_id`），条目自己没选科目，走"按对账单确认应付" → 实际挂 `房租费`；但应付台账对这几行显示 `损益类 / 管理费用`（候选链首位）。**同一个字段，一处是"预测"，一处是"事实"，两者可以不一致。**
- 旁证：`supplier-payable.service.ts:94` 的注释还引用 `recordConfirmation`，而 2026-09-24 起确认应付已不再写收支流水（`supplier-payable.service.ts:181-188`），这句引用是旧的。
- 脚本实测台账映射本身是对的（C1：手选 → `资产类 / 库存现金（备用金）`；未手选 → `损益类 / 主营业务成本`；`other` → `损益类 / 管理费用`），所以问题不在映射，在**取值链少了一段**。

### 最小修复建议
二选一，别继续用一句可能为假的注释兜：
- 要么把台账列改名/改注释为"条目科目 / 按来源的默认归类"（承认它是**归类预测**，不是已挂账科目）；或
- 要么在 `list()` 里按 `coveringPayableReconciliation(row, scopes)` 已经查出来的对账单补一段：`row.subject ?? covering?.subject / 候选链`（`covering` 目前只 select 了 id/编号/状态/期间，需要加 `subject`）。

### 补充：测试没有覆盖这一段
`ledger-export.test.cjs` 是**手写** `subject_name: "成本类 / 主营业务成本"` 喂给 `buildPayableLedgerTable`，并没有调用 `SupplierPayableService.list()`；而真实映射里 `主营业务成本` 属于**损益类**（脚本 C2 输出 `主营业务成本 → 损益类 / 主营业务成本`）。也就是说那条测试只验证了列位置与留空，**没有验证服务层算出来的文案**。我用脚本 C1 补了这个空白（通过）。

---

## 5. 缺陷 3（中）：迁移与 `schema.prisma` 漂移两处

### 结论
**不通过。** 迁移里的列名/表名/索引名与 schema 的字段名是对得上的，但**外键动作**与**索引**两边不一致，会让 `prisma migrate dev` 永久生成一条"修正"迁移。

### 证据

1. 迁移写的是 RESTRICT + 索引：
   - `apps/api/prisma/migrations/20261013090000_other_payable_subject/migration.sql:32` `ON DELETE RESTRICT ON UPDATE CASCADE`
   - `migration.sql:34` `CREATE INDEX "supplier_payable_entries_subject_id_idx" ...`
2. schema 只声明了字段与关系，**没有** `onDelete`、**没有** `@@index([subjectId])`：
   - `schema.prisma:1365` `subjectId String? @map("subject_id") @db.Uuid`
   - `schema.prisma:1375` `subject AccountingSubject? @relation(fields: [subjectId], references: [id])`
3. Prisma 自己判定的 DDL（离线 `prisma migrate diff --from-empty --to-schema-datamodel`，EXIT=0）：

```
docs/review/_prisma-from-empty.sql:3360:
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

   即：**可空关系的 `onDelete` 默认值是 `SET NULL`**，与迁移的 `RESTRICT` 冲突。同一次输出里 `supplier_payable_entries` 的索引只有 `order_no_status / supplier_id_status / source_type_status` 三个，**没有 `subject_id`** —— 迁移建的那个索引在 schema 里无对应声明。
4. 本仓库自己就吃过这个亏，且留了注释当教训：`schema.prisma:525-530`（`sales_order_material_extras.material`）明确写"`onDelete: SetNull` **必须写出来**……两边不一致就是 6 行**永久漂移**（`prisma migrate diff` 会一直要求把这条外键 DROP 掉再按 `SET NULL` 建回来）"。
5. 迁移注释第 18 行说"与 `supplier_payments.subject_id` / `supplier_payable_reconciliations.subject_id` 同形"——**这句话不成立**：那两条外键在 `20260917120000_accounting_subjects/migration.sql:356,362` 里是 `ON DELETE SET NULL`（`grep subject_id apps/api/prisma/migrations` 可复核），而且 schema 里也没有 `@@index([subjectId])`。
6. 仓库脚本走的是 `prisma migrate dev`（`apps/api/package.json:11` `"db:migrate": "prisma migrate dev"`），所以漂移不是理论问题。

### 最小修复建议
先定"到底要哪个动作"，再把两边写齐（**不要只改一边**）：
- 若要 DB 级 RESTRICT（与 `usageCount` + `remove()` 的应用层守卫重复，但更硬）：`schema.prisma:1375` 改成 `@relation(fields: [subjectId], references: [id], onDelete: Restrict)`，并在 `schema.prisma` 加 `@@index([subjectId])`。
- 若要跟 5 张同类可空外键同形：把 `migration.sql:32` 改成 `ON DELETE SET NULL`，删掉 `:34` 的索引，并改掉注释里"同形/RESTRICT"的表述。
- 无论选哪条，都建议保留一句"为什么"，否则下一轮又会"顺手统一"掉。

> 注：这一条我只能证明**schema 与迁移不一致**（Prisma 引擎输出为证）；我没有可用的 PostgreSQL 实例，**没有**在真库上执行过这两条 DDL，也没验证 RESTRICT 在真库的报错文案。

---

## 6. 观察项（不判为本次缺陷，但请 Lead 决策）

1. **跨币种合计**（脚本 INFO D2）：采购对账明细只有一组 `totalColumns: [17,18]`（`finance-report.tables.ts:267`），没有按币种分段；实测 CNY 1000 + USD 500 的合计行 = `1500`。同文件其它表明确遵守 R7"跨币种相加没有意义"（`:638` 不设 `totalColumns`、`:723,732` 分段 + 表尾说明）。**本次改动之前就是这样**，不是本轮引入，但本次换了表尾文案、也没顺手补一句"含多币种时不做合计"。
2. **付款单「总账科目」一列的两种写法**：`finance-slip.service.ts:159-161`，条目有科目时写 `分类 / 名称`，回落"确认流水"时 `subjectOf`（`:315-317`）只给**科目名**（无分类）。同一列混两种格式。中间那条分支只在 2026-09-24 之前的存量确认流水里命中，属历史兼容路径。
3. **陈旧注释**：`finance-report.controller.ts:102` 的 doc 仍写"导出 XLSX（16 列…）"，实际已 19 列（改动前也已是 17）。
4. **`otherDescription` 前缀兜底**：见 §2.2 末尾，当前不可从应用内触发，列在这里只是备忘。

---

## 7. 我做了什么 / 没做什么（可信边界）

**做了**：只读 `src/` `test/` `prisma/`；逐文件比对 `src` 与 `dist` 时间戳并在 dist 里 grep 新代码（`dist/modules/finance/finance-report-query.service.js:28,163,179`、`supplier-payable.service.js:201-202` 都能对上源码），所以"跑的是 dist"这件事我确认过；跑了 7 个必跑单测 + 3 个相邻单测；写了一个可重跑的对抗性脚本（`docs/review/verify-other-payable-subject.cjs`）覆盖含 `-`/空说明/无备注/无快照/31 字截断/重名科目/行数口径/列序与合计/跨币种；用 Prisma 引擎离线 diff 证据判定 schema↔迁移漂移。

**没做（别当成已通过）**：
- 没有连真 PostgreSQL 跑迁移或 FK 行为；§5 的 RESTRICT 后果是 schema/迁移层面的推断 + Prisma 引擎输出。
- 没有跑 `node --test` 全量（按纪律禁止，会 OOM）；没有跑 HTTP/E2E，§3 的缺陷是**服务层**实跑复现，不是浏览器点出来的。
- 没有改任何 `src/` `test/` `prisma/` 文件，没有 git commit/checkout/stash。
- 除 `docs/review/` 下的两个文件（本文件 + `verify-other-payable-subject.cjs` + 离线 DDL 证据 `_prisma-from-empty.sql`）外没有写其它文件。

**给 Lead 的建议动作顺序**：先修 §3（真金白银记错科目）→ 补 §3 的测试 → 定 §5 的迁移取舍（会生成新迁移）→ §4 文案或取值链（可选）。
