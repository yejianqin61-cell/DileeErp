-- 工资付款的会计科目归类 + 新增「工资支付」科目
--
-- 用户 2026-09-20：「工资的确认支付也要加上会计科目，会计科目里面多加一个工资支付。
-- 这样确认支付工资的时候就能归类到工资支付里面。好做账，好出表。」
--
-- 两件事：
--   1) 给 `salary_payments` 加 `subject_id`，与 `customer_payments` / `supplier_payments`
--      同一口径（付款单上记下财务选定的会计科目）。**可空 + ON DELETE SET NULL**：
--      历史付款单没有这个值，且科目是「只停用不删除」的配置数据，删除时不该连带删掉单据。
--   2) 种入补充科目「工资支付」（成本类，借，sort_order 715）。
--      与 `src/modules/finance/accounting-subject-catalog.ts` 的 SUPPLEMENTARY_SUBJECTS 同一份清单。
--      `accounting_subjects` 有 `@@unique([category, name])`，所以 ON CONFLICT DO NOTHING 天然幂等；
--      老库升级与新库 seed 都会执行到同一条，重复跑不会报错也不会重复插入。
--
-- sort_order 715 的取法：夹在「临时工资」610…「印刷费」710 之后、「实收资本」720 之前，
-- 保持成本类整块连续（分类交错会把列表与报表的「分类小计」拆成两行）。

-- 1) 工资付款单的会计科目
--
-- **不建索引**：与两张同类表（`customer_payments` / `supplier_payments` 的 `subject_id`）保持同一形状 ——
-- 它们建列时也没有索引，且 `schema.prisma` 里没有 `@@index([subjectId])`。
-- 多建一个 Prisma 不认识的对象会造成 schema drift（`prisma migrate dev` 会想把它 DROP 掉），
-- 而现有那两张表早就是「外键 + 无索引」的口径，工资付款没有理由不一样。
ALTER TABLE "salary_payments" ADD COLUMN "subject_id" UUID;
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) 补充科目「工资支付」（需要至少一个用户作为 created_by/updated_by 的取值来源）
DO $$
DECLARE
  actor_id UUID;
BEGIN
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "accounting_subjects" ("id", "category", "name", "balance_direction", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  VALUES (gen_random_uuid(), '成本类', '工资支付', '借', 715, true, CURRENT_TIMESTAMP, actor_id, actor_id)
  ON CONFLICT ("category", "name") DO NOTHING;
END $$;
