-- 领料单归属到工序：订单号 - 生产单 - 工序 - 领料表。
-- 列可空以兼容历史领料单（它们创建时还没有工序概念）；新建领料单由服务层强制要求工序。
ALTER TABLE "raw_material_movements" ADD COLUMN "production_order_operation_id" UUID;

CREATE INDEX "raw_material_movements_production_order_operation_id_idx" ON "raw_material_movements"("production_order_operation_id");

ALTER TABLE "raw_material_movements"
  ADD CONSTRAINT "raw_material_movements_production_order_operation_id_fkey"
  FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
