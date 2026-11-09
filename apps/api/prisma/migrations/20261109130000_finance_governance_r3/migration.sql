-- 财务治理 R2/R3（2026-11-09）：科目 id / 辅助维度 / 进项税 / 红冲后按来源重算
--
-- 四件事，一次迁移：
--   1) supplier_payable_entries.invoice_type：专票/普票/无票，决定挂账时是否拆进项税（用户拍板 D5）；
--   2) voucher_lines.subject_id / business_subject_id / business_subject_label：
--      记账科目与业务科目（辅助核算维度）落 id，文本 label 只留作快照（用户拍板 D3）；
--   3) 按科目名回填历史分录的 subject_id（只回填「唯一同名」的行，歧义行留空，读取方按 label 兜底）；
--   4) vouchers 的全局唯一键 (source_type, source_id) 改成**部分唯一索引**：
--      只约束「未删除且未红冲」的行，红冲后可以按来源重算（此前唯一键被红冲行占着，重算永远 422）。
--
-- 全部可回滚：新列可空、无数据改写；唯一键换索引是 DDL，回滚见文件末尾注释。

-- ---------- 1) 发票类型 ----------
ALTER TABLE "supplier_payable_entries" ADD COLUMN "invoice_type" VARCHAR(20);

-- ---------- 2) 凭证分录的科目 id 与辅助维度 ----------
ALTER TABLE "voucher_lines" ADD COLUMN "subject_id" UUID;
ALTER TABLE "voucher_lines" ADD COLUMN "business_subject_id" UUID;
ALTER TABLE "voucher_lines" ADD COLUMN "business_subject_label" VARCHAR(200);

-- SetNull：科目行正常只停用不物理删除；万一物理清理，分录仍靠 subject_label 快照可读。
ALTER TABLE "voucher_lines"
  ADD CONSTRAINT "voucher_lines_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voucher_lines"
  ADD CONSTRAINT "voucher_lines_business_subject_id_fkey"
  FOREIGN KEY ("business_subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "voucher_lines_subject_id_idx" ON "voucher_lines"("subject_id");
CREATE INDEX "voucher_lines_business_subject_id_idx" ON "voucher_lines"("business_subject_id");

-- ---------- 3) 历史分录回填 subject_id ----------
-- 匹配两种历史写法：纯科目名（`原材料`）与「分类 / 名称」复合名（`资产类 / 原材料`）。
-- 只在**恰好命中一个科目**时回填：同名跨类目（科目表允许 `@@unique([category, name])` 而非全局唯一）
-- 必须留空，宁可让报表回退文本，也不能把分录归到一个猜出来的科目上。
WITH matched AS (
  -- PostgreSQL 没有 min(uuid)：先转文本取最大，再转回 uuid（HAVING count(*)=1 保证结果就是唯一那个）。
  SELECT l."id" AS line_id, max(s."id"::text)::uuid AS subject_id
  FROM "voucher_lines" l
  JOIN "accounting_subjects" s
    ON s."deleted_at" IS NULL
   AND (
        l."subject_label" = s."name"
     OR l."subject_label" = s."category" || ' / ' || s."name"
     OR l."subject_key"   = s."category" || '/' || s."name"
   )
  WHERE l."subject_id" IS NULL
  GROUP BY l."id"
  HAVING count(*) = 1
)
UPDATE "voucher_lines" l
   SET "subject_id" = m.subject_id
  FROM matched m
 WHERE l."id" = m.line_id;

-- ---------- 4) 唯一键 → 部分唯一索引 ----------
-- 旧键：一条来源只能有一张凭证（红冲行也占键 → 红冲后无法重算）。
DROP INDEX IF EXISTS "vouchers_source_type_source_id_key";
CREATE UNIQUE INDEX "vouchers_source_active_key"
  ON "vouchers" ("source_type", "source_id")
  WHERE "deleted_at" IS NULL AND "status" <> 'reversed' AND "source_id" IS NOT NULL;
-- 普通索引仍保留：按来源查历史（含红冲）要这张。
CREATE INDEX "vouchers_source_type_source_id_idx" ON "vouchers" ("source_type", "source_id");

-- 回滚（手工）：
--   DROP INDEX "vouchers_source_active_key";
--   DROP INDEX "vouchers_source_type_source_id_idx";
--   CREATE UNIQUE INDEX "vouchers_source_type_source_id_key" ON "vouchers"("source_type","source_id");  -- 若已有红冲重算产生的重复来源行，先人工处理
--   ALTER TABLE "voucher_lines" DROP CONSTRAINT "voucher_lines_subject_id_fkey";
--   ALTER TABLE "voucher_lines" DROP CONSTRAINT "voucher_lines_business_subject_id_fkey";
--   DROP INDEX "voucher_lines_subject_id_idx"; DROP INDEX "voucher_lines_business_subject_id_idx";
--   ALTER TABLE "voucher_lines" DROP COLUMN "subject_id", DROP COLUMN "business_subject_id", DROP COLUMN "business_subject_label";
--   ALTER TABLE "supplier_payable_entries" DROP COLUMN "invoice_type";
