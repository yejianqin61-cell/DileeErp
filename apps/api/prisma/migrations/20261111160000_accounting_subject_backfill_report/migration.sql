-- 历史科目快照回填与未归位清单（2026-11-11，R-1 / T4）
--
-- 一件事：把还只靠文本认科目的历史行补上科目主键，并把「补不上的」统计成一条审计事件。
--
-- 为什么放在这一轮：T1 加了科目编码、T3 给期初加了主键，但历史数据里仍有三处只有文本：
--   · `voucher_lines.business_subject_id`（辅助核算维度）—— 上一轮 20261109130000 只回填了
--     `subject_id`，这一列完全没回填，于是「业务科目」维度对历史行永远是空的；
--   · `accounting_opening_balances.subject_id` —— 由 T3 的 20261111140000 回填，这里只统计剩余；
--   · `cash_flow_entries.category_subject_id`（收支类目）—— 无文本可回填（本来就存 id），
--     这里只统计它有多少行为空，作为报表「按业务科目统计」的覆盖率基线。
--
-- 判据与全站一致：**只有唯一同名才算归上**。同名跨分类、科目被改过名一律留空，
-- 宁可让报表回退文本匹配，也不能把分录归到一个猜出来的科目上（猜错在报表上看不出来）。
--
-- 幂等：三个 UPDATE 都带 `WHERE ... IS NULL`，审计事件按 action 去重（已存在就不再写），
-- 因此重复执行不改变任何业务行，也不会刷出第二条清单。

-- ---------- 1) 凭证分录：回填辅助核算科目（业务科目） ----------
-- 判据照抄 20261109130000 对 `subject_id` 的那一段，避免同一个名字在两条迁移里被认成不同科目。
-- 业务科目的文本来源是 `business_subject_label`（上一轮新加的列），它存的是裸科目名。
WITH matched AS (
  SELECT l."id" AS line_id, max(s."id"::text)::uuid AS subject_id
  FROM "voucher_lines" l
  JOIN "accounting_subjects" s
    ON s."deleted_at" IS NULL
   AND (
        l."business_subject_label" = s."name"
     OR l."business_subject_label" = s."category" || ' / ' || s."name"
   )
  WHERE l."business_subject_id" IS NULL
    AND l."business_subject_label" IS NOT NULL
  GROUP BY l."id"
  HAVING count(*) = 1
)
UPDATE "voucher_lines" l
   SET "business_subject_id" = m.subject_id
  FROM matched m
 WHERE l."id" = m.line_id;

-- ---------- 2) 期初余额：补回 T3 之后仍为空的行 ----------
-- T3 的迁移已经按「唯一同名」回填过一次。这里单独再跑一遍是为了覆盖一种时序：
-- 先有期初、后来才把科目建出来的环境（旧库恢复、分批建账）。判据必须与 T3 逐字一致，
-- 否则同一条期初在两条迁移里可能落到不同科目上。
WITH parsed AS (
  SELECT
    o."id" AS opening_id,
    CASE WHEN position('/' in o."subject_key") > 0 THEN split_part(o."subject_key", '/', 1) ELSE '' END AS category,
    CASE WHEN position('/' in o."subject_key") > 0
         THEN substring(o."subject_key" from position('/' in o."subject_key") + 1)
         ELSE o."subject_key" END AS name
  FROM "accounting_opening_balances" o
  WHERE o."subject_id" IS NULL
),
candidates AS (
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

-- ---------- 3) 未归位清单（审计事件，幂等） ----------
-- 为什么必须留这条：诊断里「金额静默消失」的根因就是**没有人知道有多少行没归上**。
-- 四个计数放在一条事件里，财务/实施跑完迁移就能看到基线，也方便下一轮对比是否在收敛。
-- 只在第一次执行时写入；重复执行不再追加，避免审计表被刷屏。
INSERT INTO "audit_events" ("id", "action", "entity_type", "actor_id", "details")
SELECT
  gen_random_uuid(),
  'accounting_subject.backfill_report',
  'accounting_subject',
  NULL,
  jsonb_build_object(
    'reason', '会计科目不可变编码 R-1/T4：历史快照回填后仍归不上的行数',
    'voucher_line_subject_missing',      (SELECT count(*) FROM "voucher_lines" WHERE "subject_id" IS NULL),
    'voucher_line_business_missing',     (SELECT count(*) FROM "voucher_lines" WHERE "business_subject_id" IS NULL AND "business_subject_label" IS NOT NULL),
    'cash_flow_category_missing',        (SELECT count(*) FROM "cash_flow_entries" WHERE "category_subject_id" IS NULL AND "deleted_at" IS NULL),
    'opening_balance_subject_missing',   (SELECT count(*) FROM "accounting_opening_balances" WHERE "subject_id" IS NULL AND "deleted_at" IS NULL)
  )
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_events" WHERE "action" = 'accounting_subject.backfill_report'
);

-- ---------- 回滚 ----------
-- 回填本身不改任何文本、不删数据，回滚只需把两列清空（会退回到「按文本认科目」）：
--   UPDATE "voucher_lines" SET "business_subject_id" = NULL;
--   UPDATE "accounting_opening_balances" SET "subject_id" = NULL;
--   DELETE FROM "audit_events" WHERE "action" = 'accounting_subject.backfill_report';
