-- 原料库存按供应商分桶 + 领料行单位/供应商（2026-11-13）
--
-- 用户反馈三条，根因都在「库存不按供应商分档，且领料行单位默认取物料默认单位」：
--
-- 1. 贴纸库存 36000 张，全部领出却提示库存不足。
--    伞头贴纸（MAT-20261010-0008）的 material.defaultUnit = 个，但库存事实落在 36000 张。
--    RawMaterialMovementsService.previewLines 永远传 material.defaultUnitId 取余额，
--    所以可用量恒为 0 → 库存不足拦截触发。后端必须让领料行用 BOM 行单位（unitId），
--    并按该单位求余额。
-- 2. 同一订单同一型号物料（伞头）不同供应商，到货入库没问题，领料时没法分开领用。
--    金色大弯伞头在 BOM 里两行：富达 320 打、远强（远诚）塑料 2680 打；库存也分别记在两家名下。
--    previewLines 用 seen.has(line.material_id) 拦重复，且出库事实没有供应商列 → 两行合并为一行。
-- 3. 仓库「原料仓储情况」页需要一个「现存原料数量」列（前端完成，与本迁移无关）。
--
-- 本迁移做两件事：
--   A. 在 inventory_facts 和 raw_material_movement_lines 上加 supplier_id 列 + Supplier 关系 + 索引。
--   B. 把 inventory_facts.supplier_id 从关联的 raw_material_inbounds 回填（历史入库事实已带供应商）。
--      出库历史事实（material_issue 等）保持 NULL（当时确实没记供应商，编造任何值都是错的）；
--      NULL 档位在代码里表示「未指定供应商」，独立于具体供应商档位。
--
-- 范围边界：不动 raw_material_inbounds（已有 supplierId）、不动 BOM 行 supplierId（已有）。
-- 历史 43 条 material_issue 事实全部保持 NULL，不会回填任何值。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_facts' AND column_name='supplier_id') THEN
    ALTER TABLE "inventory_facts" ADD COLUMN "supplier_id" UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='raw_material_movement_lines' AND column_name='supplier_id') THEN
    ALTER TABLE "raw_material_movement_lines" ADD COLUMN "supplier_id" UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_facts_supplier_id_fkey') THEN
    ALTER TABLE "inventory_facts"
      ADD CONSTRAINT "inventory_facts_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='raw_material_movement_lines_supplier_id_fkey') THEN
    ALTER TABLE "raw_material_movement_lines"
      ADD CONSTRAINT "raw_material_movement_lines_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "inventory_facts_material_id_inventory_category_unit_id_supplier_id_idx"
  ON "inventory_facts"("material_id", "inventory_category", "unit_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "raw_material_movement_lines_movement_id_material_id_supplier_id_idx"
  ON "raw_material_movement_lines"("movement_id", "material_id", "supplier_id");

-- ---------- 回填 ----------
-- 把过账的入库事实的供应商从对应的入库单上继承下来。
-- 生产库实测命中 54 行（全部是 raw_material_inbound 事实，逐一关联到 raw_material_inbounds）。
WITH to_fill AS (
  SELECT f."id" AS fact_id, i."supplier_id" AS supplier_id
  FROM "inventory_facts" f
  JOIN "raw_material_inbounds" i ON i."id" = f."raw_material_inbound_id"
  WHERE f."supplier_id" IS NULL
    AND f."inventory_category" = 'raw_material'
    AND f."source_type" = 'raw_material_inbound'
)
UPDATE "inventory_facts" f
SET "supplier_id" = t.supplier_id
FROM to_fill t
WHERE f."id" = t.fact_id;

-- 校验：回填后不应还有带 inbound 关联但 supplier 为空的 raw_material 事实。
-- 若这里返回非 0，说明有脏数据（入库单的 supplier 为空），需要人工介入。
-- 计数仅作诊断，不阻塞迁移。
-- SELECT count(*) FROM "inventory_facts" f
--   LEFT JOIN "raw_material_inbounds" i ON i."id" = f."raw_material_inbound_id"
--   WHERE f."supplier_id" IS NULL
--     AND f."inventory_category" = 'raw_material'
--     AND f."source_type" = 'raw_material_inbound'
--     AND i."supplier_id" IS NOT NULL;

-- ---------- 回滚 ----------
-- ALTER TABLE "inventory_facts" DROP COLUMN IF EXISTS "supplier_id";
-- ALTER TABLE "raw_material_movement_lines" DROP COLUMN IF EXISTS "supplier_id";
-- DROP INDEX IF EXISTS "inventory_facts_material_id_inventory_category_unit_id_supplier_id_idx";
-- DROP INDEX IF EXISTS "raw_material_movement_lines_movement_id_material_id_supplier_id_idx";
