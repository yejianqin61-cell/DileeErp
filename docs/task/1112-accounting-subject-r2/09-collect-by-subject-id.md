# T9 报表取数改按科目身份归集

## 1. 这份任务在哪

- **Phase 2 报表不再靠名字认科目**，目标是财务新增一个科目时三张报表都点名它没归位。
- **本任务让报表取数只认真身份**：今天报表在 `subject_id` 为空时会退回文本键，于是同一科目被拆成「旧名桶」和「新名桶」；这条回退要收窄成「只服务回填前的历史行」。
- **开始于**：T8 把行映射落成数据。**后续等它**：Phase 3 的科目性质结构化。

## 2. 开发前需要知道什么

**先读**

- `apps/api/src/modules/finance/finance-three-statements.ts` — `subjectKeyOfLine` / `subjectRefOfKey` / `normalizeSubjectKey` 三个键函数，以及 `directValues` 的归集循环。
- `apps/api/src/modules/finance/finance-three-statements.service.ts` — `SubjectRefs` 索引怎么建，为什么只装 `deletedAt: null` 的科目。
- `docs/audit/accounting-subject-diagnosis-2026-11-11.md` P1-11、P2「双键」 — 双轨键为什么会让金额落错行而勾稽照样平。

**已定**

- 归集键的唯一来源是 `subject_id`。文本键只在主键为空时使用，且必须在表尾计数报出来。
- 不再新增第二种键格式。`@id:<uuid>` 就是唯一形态。
- 主键指向一个索引里查不到的科目时，**不猜**：进未归位，不退回文本。

**边界与缝**

- 触及报表内核的键解析与取数服务。不碰凭证写入。
- 缝：既有报表内核测试入口与取数服务测试入口。不新增缝。

**运行**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/finance-three-statements.test.cjs apps/api/test/unit/finance-three-statements-service.test.cjs`
- `npx tsc -p apps/api/tsconfig.json --noEmit`

**未知**

- 收窄回退会让一部分历史行的金额从「落行」变成「未归位」。这是**可见性提升**还是**报表变动**，取决于本机是否有历史数据；若报表数字变了，停下来说明变了多少、为什么。

## 3. 流程

1. 读上面三个文件，用一句话复述本任务。
2. 写一条会失败的测试：主键指向已删科目时金额进未归位，而不是退回文本。
3. 收窄键解析：主键优先且不回落文本。
4. 在结果里加一个计数：有多少行是靠文本键归集的。
5. 跑构建、类型检查与测试。
6. 提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
| --- | --- | --- | --- |
| 1 | 主键指向已删科目 | 金额进未归位，且报告该科目 | 报表内核 |
| 2 | 主键为空、文本是旧名 | 仍按文本归位，并计入「文本归集行数」 | 报表内核 |
| 3 | 同一科目、两条文本不同但主键相同 | 归成一个桶，金额相加 | 报表内核 |
| 4 | 全部行都有主键 | 「文本归集行数」为 0 | 报表内核 |
