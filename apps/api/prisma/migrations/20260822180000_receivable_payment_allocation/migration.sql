CREATE TABLE "receivable_sources" (
  "id" UUID NOT NULL, "source_no" VARCHAR(100) NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID NOT NULL, "outbound_id" UUID NOT NULL, "customer_id" UUID NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL, "unit" VARCHAR(30) NOT NULL, "unit_price" DECIMAL(18,4),
  "tax_rate" DECIMAL(8,4), "amount" DECIMAL(18,4) NOT NULL, "currency" VARCHAR(10) NOT NULL,
  "amount_reason" VARCHAR(1000), "status" VARCHAR(30) NOT NULL DEFAULT 'draft', "due_date" DATE,
  "invoice_no" VARCHAR(100), "invoice_date" DATE, "signed_at_snapshot" TIMESTAMP(3),
  "attachment" JSONB NOT NULL DEFAULT '[]', "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "receivable_sources_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "customer_payments" (
  "id" UUID NOT NULL, "payment_no" VARCHAR(100) NOT NULL, "customer_id" UUID NOT NULL,
  "order_no" VARCHAR(100), "payment_date" DATE NOT NULL, "amount" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL, "payment_method" VARCHAR(50) NOT NULL, "bank_reference" VARCHAR(200),
  "payer_name" VARCHAR(200), "status" VARCHAR(30) NOT NULL DEFAULT 'draft', "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3), "deleted_by" UUID, CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "receivable_allocations" (
  "id" UUID NOT NULL, "payment_id" UUID NOT NULL, "receivable_source_id" UUID NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL, "currency" VARCHAR(10) NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'active',
  "remark" VARCHAR(1000), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3), "deleted_by" UUID, CONSTRAINT "receivable_allocations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receivable_sources_source_no_key" ON "receivable_sources"("source_no");
CREATE UNIQUE INDEX "receivable_sources_outbound_id_key" ON "receivable_sources"("outbound_id");
CREATE INDEX "receivable_sources_order_no_status_idx" ON "receivable_sources"("order_no", "status");
CREATE INDEX "receivable_sources_customer_id_status_idx" ON "receivable_sources"("customer_id", "status");
CREATE UNIQUE INDEX "customer_payments_payment_no_key" ON "customer_payments"("payment_no");
CREATE INDEX "customer_payments_customer_id_status_idx" ON "customer_payments"("customer_id", "status");
CREATE INDEX "customer_payments_order_no_status_idx" ON "customer_payments"("order_no", "status");
CREATE UNIQUE INDEX "receivable_allocations_payment_id_receivable_source_id_key" ON "receivable_allocations"("payment_id", "receivable_source_id");
CREATE INDEX "receivable_allocations_receivable_source_id_status_idx" ON "receivable_allocations"("receivable_source_id", "status");
ALTER TABLE "receivable_sources" ADD CONSTRAINT "receivable_sources_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE, ADD CONSTRAINT "receivable_sources_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "finished_goods_outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE, ADD CONSTRAINT "receivable_sources_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE, ADD CONSTRAINT "receivable_allocations_receivable_source_id_fkey" FOREIGN KEY ("receivable_source_id") REFERENCES "receivable_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
