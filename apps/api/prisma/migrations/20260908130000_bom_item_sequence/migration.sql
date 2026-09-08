-- BOM 行序号：按 BOM 分组、按创建时间回填 1..n；新行由应用层在 replaceItems 写入时按提交顺序赋 sequence。
ALTER TABLE "bom_items" ADD COLUMN "sequence" INTEGER;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "bom_id" ORDER BY "created_at" ASC, "id" ASC) AS rn
  FROM "bom_items"
  WHERE "deleted_at" IS NULL
)
UPDATE "bom_items" SET "sequence" = ranked.rn
FROM ranked WHERE "bom_items"."id" = ranked."id" AND "bom_items"."deleted_at" IS NULL;
