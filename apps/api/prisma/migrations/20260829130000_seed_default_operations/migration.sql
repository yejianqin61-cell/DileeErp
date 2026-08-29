-- Seed the production operation pool without requiring a separate seed command.
-- A deployment always has an administrator/user and at least one default unit.
INSERT INTO "operation_catalogs" (
  "id", "operation_code", "operation_name", "default_unit_id", "is_active",
  "updated_at", "created_by", "updated_by"
)
SELECT
  gen_random_uuid(),
  'OP-' || LPAD((row_number() OVER (ORDER BY item.name))::text, 3, '0'),
  item.name,
  (SELECT "id" FROM "units" WHERE "deleted_at" IS NULL AND "is_active" = true ORDER BY "created_at" LIMIT 1),
  true,
  CURRENT_TIMESTAMP,
  actor."id",
  actor."id"
FROM (VALUES
  ('大裁'), ('拉边'), ('小裁'), ('验片'), ('合片'), ('剪线头'), ('打顶打带'),
  ('打珠尾'), ('缝伞'), ('品检'), ('折伞'), ('外发加工'), ('其他'), ('包装')
) AS item(name)
CROSS JOIN LATERAL (SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1) AS actor
WHERE NOT EXISTS (
  SELECT 1 FROM "operation_catalogs" existing
  WHERE existing."operation_name" = item.name AND existing."deleted_at" IS NULL
)
AND EXISTS (SELECT 1 FROM "units" WHERE "deleted_at" IS NULL AND "is_active" = true);
