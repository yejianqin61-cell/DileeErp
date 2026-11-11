-- 建账期初余额落科目主键（2026-11-11，R-1 / T3）
--
-- 一件事：给 `accounting_opening_balances` 加 `subject_id`，并回填历史行。
--
-- 为什么必须做：期初余额是**唯一一张连科目外键都没有**的业务表 —— 它只有文本键
-- `subject_key`（`分类/名称` 或裸名）。科目一改名，这一行的键就与主数据脱节，
-- 报表按名字匹配不上，而资产负债表又没有「未归位科目」出口，于是这笔期初金额静默消失
-- （诊断 docs/audit/accounting-subject-diagnosis-2026-11-11.md 的 P0-2）。
--
-- 回填判据沿用上一轮（20261109130000_finance_governance_r3）的同一条纪律：
-- **只有唯一同名才算归上**，歧义（同名跨分类）与查不到一律留空，绝不猜一个科目塞进去 ——
-- 猜错等于把期初余额记到别的账上，而报表上看不出来。
--
-- 可回滚：只加列、索引与外键，不改任何原有列、不删数据。回滚见文件末尾注释。

-- ---------- 1) 加可空列 ----------
ALTER TABLE "accounting_opening_balances" ADD COLUMN "subject_id" UUID;

-- ---------- 2) 回填 ----------
-- `subject_key` 有两种历史写法（与凭证分录同一套）：
--   - `分类/名称`（正常写法，如 `资产类/银行存款`）；
--   - 裸名（资金科目的老写法，如 `银行存款` / `库存现金`）。
-- 用第一个 `/` 切开：分类在前、名称在后；没有 `/` 的整段都当名称。
WITH parsed AS (
  SELECT
    o."id" AS opening_id,
    CASE
      WHEN position('/' in o."subject_key") > 0 THEN split_part(o."subject_key", '/', 1)
      ELSE ''
    END AS category,
    CASE
      WHEN position('/' in o."subject_key") > 0
        THEN substring(o."subject_key" from position('/' in o."subject_key") + 1)
      ELSE o."subject_key"
    END AS name
  FROM "accounting_opening_balances" o
  WHERE o."subject_id" IS NULL
),
candidates AS (
  -- 带分类的行只在同分类里找；不含 `/` 的裸名行在全表按名称找。
  -- 两种情况都用 cardinality = 1 过滤，语义就是「唯一同名」。
  SELECT p.opening_id, array_agg(s."id") AS subject_ids
  FROM parsed p
  JOIN "accounting_subjects" s
    ON s."deleted_at" IS NULL
   AND (
        (p.category <> '' AND s."category" = p.category AND s."name" = p.name)
     OR (p.category =  '' AND s."name" = p.name)
   )
  GROUP BY p.opening_id
)
UPDATE "accounting_opening_balances" o
SET "subject_id" = c.subject_ids[1]
FROM candidates c
WHERE o."id" = c.opening_id
  AND cardinality(c.subject_ids) = 1;

-- 归不上的行（同名跨分类、科目被改过名、或书写有误）保持 NULL。
-- 它们仍能被报表按 `subject_key` 文本兜底读到，只是改名之后会失配 ——
-- 具体有多少条、分别是谁，由 T4 的回填清单统一报出来，这里不重复统计。

-- ---------- 3) 外键与索引 ----------
-- SetNull：与 `voucher_lines.subject_id` 同一约定 —— 科目行正常只停用不物理删除；
-- 万一物理清理，期初仍靠 `subject_key` 快照可读，不会把整行期初删掉。
ALTER TABLE "accounting_opening_balances"
  ADD CONSTRAINT "accounting_opening_balances_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "accounting_opening_balances_subject_id_idx" ON "accounting_opening_balances"("subject_id");

-- ⚠️ 唯一键**不动**：仍是 (as_of_date, subject_key, currency)。
-- 换成 (as_of_date, subject_id, currency) 会让「删掉一行 → 再用同名科目加回来」因为
-- 可空的 subject_id 产生两条占位行，服务层「整批替换」的软删占位就会失效。

-- ---------- 回滚 ----------
-- DROP INDEX "accounting_opening_balances_subject_id_idx";
-- ALTER TABLE "accounting_opening_balances" DROP CONSTRAINT "accounting_opening_balances_subject_id_fkey";
-- ALTER TABLE "accounting_opening_balances" DROP COLUMN "subject_id";
