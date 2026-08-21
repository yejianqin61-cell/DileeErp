CREATE TABLE "production_orders" (
  "id" UUID NOT NULL,
  "production_order_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID NOT NULL,
  "bom_id" UUID,
  "bom_version" INTEGER,
  "bom_snapshot" JSONB,
  "production_order_type" VARCHAR(30) NOT NULL DEFAULT 'standard',
  "parent_production_order_id" UUID,
  "execution_mode" VARCHAR(20) NOT NULL,
  "execution_location_id" UUID NOT NULL,
  "planned_quantity" DECIMAL(18,4) NOT NULL,
  "unit_id" UUID NOT NULL,
  "product_specification" VARCHAR(1000),
  "production_process_note" VARCHAR(2000),
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "planned_started_on" DATE,
  "delivery_due_on" DATE,
  "started_on" DATE,
  "completed_on" DATE,
  "actual_completed_quantity" DECIMAL(18,4),
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "production_orders_production_order_no_key" ON "production_orders"("production_order_no");
CREATE INDEX "production_orders_order_no_status_idx" ON "production_orders"("order_no", "status");
CREATE INDEX "production_orders_sales_order_id_production_order_type_idx" ON "production_orders"("sales_order_id", "production_order_type");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_parent_production_order_id_fkey" FOREIGN KEY ("parent_production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_execution_location_id_fkey" FOREIGN KEY ("execution_location_id") REFERENCES "production_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
