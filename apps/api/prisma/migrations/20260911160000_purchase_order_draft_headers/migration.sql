-- 采购单草稿：允许"编辑一半先保存"。
-- BOM、头部供应商、采购日期在草稿阶段可以缺省；下单（order）时由服务层强制校验完整性。
-- 明细行不受影响：一旦存在，物料/单位/供应商/数量/单价仍必须完整。
ALTER TABLE "purchase_orders"
  ALTER COLUMN "bom_id" DROP NOT NULL,
  ALTER COLUMN "bom_version" DROP NOT NULL,
  ALTER COLUMN "bom_snapshot" DROP NOT NULL,
  ALTER COLUMN "supplier_id" DROP NOT NULL,
  ALTER COLUMN "supplier_snapshot" DROP NOT NULL,
  ALTER COLUMN "purchase_date" DROP NOT NULL;
