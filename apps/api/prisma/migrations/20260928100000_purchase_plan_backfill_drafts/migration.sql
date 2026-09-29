-- 把既有的采购单**草稿**搬成采购计划（2026-09-27）。
--
-- 背景：新流程不再产生草稿（采购计划接管了它），如果不搬，库里既有的草稿会变成
-- 「采购单列表里看不到、计划里也没有」的僵尸行。而草稿里是采购员逐行填过的供应商/单价/交期，
-- 丢掉是真实劳动损失 —— 用户已拍板「迁移时归并成计划」（设计文档 §2 口径 8）。
--
-- 归并规则：
--   · 按 `bom_id` 归并：同一张 BOM 的多张草稿（历史上保存草稿会**按供应商拆成 N 行**）
--     合并进**同一份**计划。行**不去重** —— 同一 BOM 行出现两行是允许的，正好表达"两家比价"。
--   · **一张明细都没有的草稿不搬**（用户只是选了个销售单存了一下，里面没有任何信息）。
--     它们原样留着，什么也不丢。
--   · **没有 `bom_id` 的草稿不搬**（历史遗留，画不出计划）。
--   · 搬完之后草稿软删（不是硬删：留痕，也避免与"未删除的草稿"这种状态再次混淆）。
--
-- 幂等：靠"软删"这个动作本身。第二遍跑时 `status='draft'` 已经查不到，什么都不做。
-- 而每一步都在 Prisma 的迁移事务里，失败即整体回滚，不存在搬一半的状态。
--
-- ⚠️ 本机没有 PostgreSQL，这段 SQL **没有在真实库上执行过**。部署前请：
--   ① `pg_dump` 备份；② 在影子库干跑；③ 核对 `purchase_plans` 行数 = 有明细的草稿 BOM 数、
--   `purchase_plan_items` 行数 = 被搬草稿的未删明细数；④ 确认 `status='draft'` 且未删的采购单为 0。

-- 本次真正要迁移的 BOM（一张 BOM 一行），并把生成好的计划 id/编号先固定在临时表里：
-- 后面建计划、搬明细、软删草稿三步共用同一份映射，不会各算一遍而对不上。
-- 临时表 `ON COMMIT DROP` 随迁移事务结束消失。
CREATE TEMP TABLE "_purchase_plan_draft_migration" (
  "bom_id"  UUID PRIMARY KEY,
  "plan_id" UUID NOT NULL,
  "plan_no" VARCHAR(100) NOT NULL
) ON COMMIT DROP;

INSERT INTO "_purchase_plan_draft_migration" ("bom_id", "plan_id", "plan_no")
SELECT
  po."bom_id",
  gen_random_uuid(),
  -- 与采购单号同格式，前缀 PP（`purchase-orders.service.ts` 是 PO-{YYYYMMDD}-{UUID前8位}）。
  'PP-' || to_char(NOW(), 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
FROM "purchase_orders" po
WHERE po."deleted_at" IS NULL
  AND po."status" = 'draft'
  AND po."bom_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "purchase_order_items" poi
    WHERE poi."purchase_order_id" = po."id" AND poi."deleted_at" IS NULL
  )
  -- 该 BOM 已经有未删计划（理论上不会发生：本次上线前系统里还没有计划表）就跳过，
  -- 不去动它，也不搬它的草稿 —— 宁可少做，也不能把行灌进一份已经在用的计划。
  AND NOT EXISTS (
    SELECT 1 FROM "purchase_plans" pp
    WHERE pp."bom_id" = po."bom_id" AND pp."deleted_at" IS NULL
  )
GROUP BY po."bom_id";

-- 1. 建计划。头部字段取该 BOM **最早那张草稿**的值（同一 BOM 的草稿本来就属于同一张销售单）。
-- `extension_data` 留一条迁移痕迹：以后有人问"这份计划哪来的"，答案在数据里而不只在文档里。
INSERT INTO "purchase_plans" (
  "id", "plan_no", "order_no", "sales_order_id", "bom_id", "bom_version", "bom_snapshot",
  "extension_data", "created_at", "updated_at", "created_by", "updated_by"
)
SELECT
  m."plan_id",
  m."plan_no",
  d."order_no",
  d."sales_order_id",
  m."bom_id",
  d."bom_version",
  d."bom_snapshot",
  jsonb_build_object(
    'migrated_from_draft_purchase_orders', true,
    'draft_purchase_order_nos', d."draft_nos"
  ),
  NOW(),
  NOW(),
  d."created_by",
  d."created_by"
FROM "_purchase_plan_draft_migration" m
JOIN LATERAL (
  SELECT
    po."order_no",
    po."sales_order_id",
    po."bom_version",
    po."bom_snapshot",
    po."created_by",
    (
      SELECT jsonb_agg(po2."purchase_order_no" ORDER BY po2."created_at", po2."purchase_order_no")
      FROM "purchase_orders" po2
      WHERE po2."bom_id" = m."bom_id" AND po2."deleted_at" IS NULL AND po2."status" = 'draft'
    ) AS "draft_nos"
  FROM "purchase_orders" po
  WHERE po."bom_id" = m."bom_id" AND po."deleted_at" IS NULL AND po."status" = 'draft'
  ORDER BY po."created_at", po."id"
  LIMIT 1
) d ON TRUE;

-- 2. 搬明细。`purchase_order_item_id` 一律留空 —— 草稿从来没有下过单，这是事实，不是遗漏。
-- `sequence` 用窗口函数重排（原来每张草稿各有一份序号，合并之后会重复）。
INSERT INTO "purchase_plan_items" (
  "id", "plan_id", "material_id", "material_snapshot", "unit_id", "unit_snapshot",
  "bom_item_id", "supplier_id", "supplier_snapshot", "model",
  "quantity", "unit_price", "expected_date", "purchase_order_item_id", "sequence",
  "extension_data", "created_at", "updated_at", "created_by", "updated_by"
)
SELECT
  gen_random_uuid(),
  m."plan_id",
  poi."material_id",
  poi."material_snapshot",
  poi."unit_id",
  poi."unit_snapshot",
  poi."bom_item_id",
  poi."supplier_id",
  poi."supplier_snapshot",
  poi."model",
  poi."quantity",
  poi."unit_price",
  poi."expected_date",
  NULL,
  ROW_NUMBER() OVER (PARTITION BY m."plan_id" ORDER BY po."created_at", po."id", poi."created_at", poi."id"),
  poi."extension_data",
  NOW(),
  NOW(),
  poi."created_by",
  poi."created_by"
FROM "_purchase_plan_draft_migration" m
JOIN "purchase_orders" po
  ON po."bom_id" = m."bom_id" AND po."deleted_at" IS NULL AND po."status" = 'draft'
JOIN "purchase_order_items" poi
  ON poi."purchase_order_id" = po."id" AND poi."deleted_at" IS NULL;

-- 3. 软删已搬走的草稿明细与草稿本身。只碰本次真正迁移过的 BOM。
UPDATE "purchase_order_items" poi
SET "deleted_at" = NOW(), "deleted_by" = poi."created_by", "updated_by" = poi."created_by"
FROM "purchase_orders" po, "_purchase_plan_draft_migration" m
WHERE poi."purchase_order_id" = po."id"
  AND po."bom_id" = m."bom_id"
  AND po."deleted_at" IS NULL
  AND po."status" = 'draft'
  AND poi."deleted_at" IS NULL;

UPDATE "purchase_orders" po
SET "deleted_at" = NOW(), "deleted_by" = po."created_by", "updated_by" = po."created_by"
FROM "_purchase_plan_draft_migration" m
WHERE po."bom_id" = m."bom_id"
  AND po."deleted_at" IS NULL
  AND po."status" = 'draft';
