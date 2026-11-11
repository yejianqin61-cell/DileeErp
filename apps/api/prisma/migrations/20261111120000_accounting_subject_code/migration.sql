-- 会计科目不可变编码（2026-11-11，R-1）
--
-- 一件事件：给 `accounting_subjects` 加一列**终身不变**的编码，作为科目的身份。
--
-- 为什么现在做：科目表的唯一标识一直是 `分类/名称` 这段人可读文本，而财务随时能改名 ——
-- 改名即换身份。于是凭证分录、期初余额、报表行匹配只能按名字与名字前缀认科目，
-- 财务改一个科目名就让某张报表的某一笔金额静默少计，报表仍然平、勾稽仍然通过。
-- 编码把「身份」与「显示名」拆开（诊断：docs/audit/accounting-subject-diagnosis-2026-11-11.md P0-1 / P0-3）。
--
-- 编码格式：`S` + `sort_order` 左补零到 4 位，例 `S0010`、`S0715`、`S1210`。
-- `sort_order` 在科目表里本就全局唯一，因此编码唯一性直接继承它；而且 TS 侧
-- （`accountingSubjectCodeFor`，accounting-subject-catalog.ts）与本文件算出**同一个字符串**，
-- 不依赖数据库排序规则 —— collation 与 JS `localeCompare` 的排序不同，用 ROW_NUMBER() 两边永远对不齐。
--
-- 为什么 `S` 前缀：老表的「科目代码」（1001 / 100201 / 222101001）已被用户明确弃用，
-- 编码不能长得像它，否则财务会以为这就是那套三层科目代码。
--
-- 可回滚：只加列与唯一索引，不改任何原有列、不删数据。回滚见文件末尾注释。

-- ---------- 1) 加可空列 ----------
-- 必须先可空再加：已有 122 行没值，直接 NOT NULL 会失败。
ALTER TABLE "accounting_subjects" ADD COLUMN "code" VARCHAR(20);

-- ---------- 2) 回填 ----------
-- 与 `accountingSubjectCodeFor(sortOrder)` 逐字对应：`S` + lpad(sort_order, 4, '0')。
UPDATE "accounting_subjects"
SET "code" = 'S' || lpad("sort_order"::text, 4, '0')
WHERE "code" IS NULL;

-- 重复的 sort_order 会让两行算出同一个编码，紧跟其后的唯一索引会在这里当场失败。
-- 这是刻意的失败方式：它暴露的是「排序号不唯一」这个真实缺陷，而不是悄悄覆盖某一行。
-- 修复方式：先给重复的行分配不同的 sort_order，再重跑本迁移。

-- ---------- 3) 设非空 + 唯一 ----------
ALTER TABLE "accounting_subjects" ALTER COLUMN "code" SET NOT NULL;

-- 唯一索引即身份的保证：两行不可能有同一个编码。
CREATE UNIQUE INDEX "accounting_subjects_code_key" ON "accounting_subjects"("code");

-- ---------- 回滚 ----------
-- DROP INDEX "accounting_subjects_code_key";
-- ALTER TABLE "accounting_subjects" DROP COLUMN "code";
