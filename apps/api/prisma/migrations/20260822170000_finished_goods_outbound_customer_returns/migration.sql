CREATE TABLE "finished_goods_outbounds" (
  "id" UUID NOT NULL,
  "outbound_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID NOT NULL,
  "production_order_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "product_name_snapshot" VARCHAR(200),
  "product_specification_snapshot" VARCHAR(1000),
  "quantity" DECIMAL(18,4) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "shipment_date" DATE,
  "carrier" VARCHAR(200),
  "tracking_no" VARCHAR(200),
  "packing_list_no" VARCHAR(100),
  "invoice_no" VARCHAR(100),
  "signed_at" TIMESTAMP(3),
  "signature_reference" VARCHAR(500),
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "idempotency_key" VARCHAR(200) NOT NULL,
  "risk_reason" VARCHAR(1000),
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "finished_goods_outbounds_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "customer_returns" (
  "id" UUID NOT NULL,
  "return_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID NOT NULL,
  "production_order_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "product_name_snapshot" VARCHAR(200),
  "product_specification_snapshot" VARCHAR(1000),
  "quantity" DECIMAL(18,4) NOT NULL,
  "return_date" DATE NOT NULL,
  "destination" VARCHAR(30) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "idempotency_key" VARCHAR(200) NOT NULL,
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "customer_returns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finished_goods_outbounds_outbound_no_key" ON "finished_goods_outbounds"("outbound_no");
CREATE UNIQUE INDEX "finished_goods_outbounds_idempotency_key_key" ON "finished_goods_outbounds"("idempotency_key");
CREATE INDEX "finished_goods_outbounds_order_no_status_idx" ON "finished_goods_outbounds"("order_no", "status");
CREATE INDEX "finished_goods_outbounds_sales_order_id_status_idx" ON "finished_goods_outbounds"("sales_order_id", "status");
CREATE INDEX "finished_goods_outbounds_production_order_id_status_idx" ON "finished_goods_outbounds"("production_order_id", "status");
CREATE UNIQUE INDEX "customer_returns_return_no_key" ON "customer_returns"("return_no");
CREATE UNIQUE INDEX "customer_returns_idempotency_key_key" ON "customer_returns"("idempotency_key");
CREATE INDEX "customer_returns_order_no_status_idx" ON "customer_returns"("order_no", "status");
CREATE INDEX "customer_returns_sales_order_id_status_idx" ON "customer_returns"("sales_order_id", "status");
CREATE INDEX "customer_returns_production_order_id_status_idx" ON "customer_returns"("production_order_id", "status");
ALTER TABLE "finished_goods_outbounds"
  ADD CONSTRAINT "finished_goods_outbounds_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_outbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_outbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_returns"
  ADD CONSTRAINT "customer_returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_returns_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_returns_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_facts"
  ADD CONSTRAINT "inventory_facts_finished_goods_outbound_id_fkey" FOREIGN KEY ("finished_goods_outbound_id") REFERENCES "finished_goods_outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_facts_customer_return_id_fkey" FOREIGN KEY ("customer_return_id") REFERENCES "customer_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
