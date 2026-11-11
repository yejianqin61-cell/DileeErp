# T1 给科目加不可变编码

## 1. 这份任务在哪

- **Phase 1 科目有了身份证**，目标是改一个科目名之后所有报表数字一个都不变。
- **本任务把 R-1 科目有不可变编码 的第一半落到库里**：科目有了一个终身不变的编码值，并能被回填。
- **开始于**：无。**后续等它**：编码对外只读、期初余额落主键。

## 2. 开发前需要知道什么

**先读**

- `apps/api/src/modules/finance/accounting-subject-catalog.ts` — 122 条科目怎么组织，`sortOrder` 是什么口径。
- `apps/api/prisma/schema.prisma` 的 `AccountingSubject` — 现在有哪些列，唯一键是什么。
- `apps/api/test/unit/accounting-subject-catalog.test.cjs` — 既有守卫测试怎么写，为什么它断言 `length === 121`。
- `apps/api/prisma/migrations/20260917120000_accounting_subjects/migration.sql` — 迁移里科目清单是怎么手抄第二份的。

**已定**

- 编码格式 `S` + `sortOrder` 左侧补零到 4 位，例：`S0010`、`S0715`、`S1210`。理由：`sortOrder` 已是全局唯一整数，不需要排序规则参与，TS 与 SQL 能算出同一个值。
- 编码一旦写入不可更改。改 `sortOrder` 不重算编码。
- 科目清单的第三份副本（迁移 SQL）继续手抄，沿用「三处一致 + 守卫测试」的既有纪律。

**边界与缝**

- 触及科目主数据、迁移、种子、守卫测试。不碰凭证、流水、报表。
- 缝：既有科目常量守卫测试入口。不新增缝。

**运行**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/accounting-subject-catalog.test.cjs apps/api/test/unit/accounting-subject-migration.test.cjs`
- `npx tsc -p apps/api/tsconfig.json --noEmit`

**未知**

- 迁移里 `sortOrder` 若有重复，唯一索引会当场失败。这是好事（暴露排序缺陷），但要在迁移里写清报错含义。

## 3. 流程

1. 读上面四个文件，用一句话复述本任务。
2. 在科目常量里加编码生成函数，并给 122 条各算出编码。
3. 在 schema 加 `code` 列，写进唯一约束。
4. 写迁移：加可空列、回填、设非空、建唯一索引。
5. 改种子：创建时写编码，更新时不写编码。
6. 加守卫测试：编码唯一、格式正确、与 `sortOrder` 对得上。
7. 跑构建、类型检查与测试。
8. 提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
| --- | --- | --- | --- |
| 1 | 科目 `sortOrder` 为 10 | 编码是 `S0010` | 常量守卫测试 |
| 2 | 122 条科目 | 编码两两不同 | 常量守卫测试 |
| 3 | 122 条科目 | 每条编码等于其 `sortOrder` 算出值 | 常量守卫测试 |
| 4 | 迁移 SQL 里的编码清单 | 与常量里的编码逐条相同 | 迁移守卫测试 |
| 5 | 任意编码 | 长度不超过 20，且只含大写字母与数字 | 常量守卫测试 |
