CREATE TABLE "production_order_operations" (
  "id" UUID NOT NULL,
  "production_order_id" UUID NOT NULL,
  "operation_catalog_id" UUID NOT NULL,
  "operation_name_snapshot" VARCHAR(150) NOT NULL,
  "unit_id" UUID NOT NULL,
  "sequence_no" INTEGER NOT NULL,
  "target_quantity" DECIMAL(18,4) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "cancellation_reason" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "production_order_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "production_order_operations_production_order_id_sequence_no_key" ON "production_order_operations"("production_order_id", "sequence_no");
CREATE INDEX "production_order_operations_production_order_id_status_idx" ON "production_order_operations"("production_order_id", "status");
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_operation_catalog_id_fkey" FOREIGN KEY ("operation_catalog_id") REFERENCES "operation_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
