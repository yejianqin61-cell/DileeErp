CREATE TABLE "supplier_payable_entries" (
  "id" UUID NOT NULL,
  "payable_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "supplier_id" UUID NOT NULL,
  "source_type" VARCHAR(40) NOT NULL,
  "payable_source_id" UUID,
  "outsource_payable_source_id" UUID,
  "source_no_snapshot" VARCHAR(100) NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "unit_price" DECIMAL(18,4) NOT NULL,
  "tax_rate" DECIMAL(8,4),
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "confirmation_date" DATE NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "supplier_payable_entries_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "supplier_payments" (
  "id" UUID NOT NULL,
  "payment_no" VARCHAR(100) NOT NULL,
  "supplier_id" UUID NOT NULL,
  "order_no" VARCHAR(100),
  "payment_date" DATE NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "payment_method" VARCHAR(50) NOT NULL,
  "bank_reference" VARCHAR(200),
  "payee_name" VARCHAR(200),
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "supplier_payment_allocations" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "payable_entry_id" UUID NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'active',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_payable_entries_payable_no_key" ON "supplier_payable_entries"("payable_no");
CREATE UNIQUE INDEX "supplier_payable_entries_payable_source_id_key" ON "supplier_payable_entries"("payable_source_id");
CREATE UNIQUE INDEX "supplier_payable_entries_outsource_payable_source_id_key" ON "supplier_payable_entries"("outsource_payable_source_id");
CREATE INDEX "supplier_payable_entries_order_no_status_idx" ON "supplier_payable_entries"("order_no", "status");
CREATE INDEX "supplier_payable_entries_supplier_id_status_idx" ON "supplier_payable_entries"("supplier_id", "status");
CREATE INDEX "supplier_payable_entries_source_type_status_idx" ON "supplier_payable_entries"("source_type", "status");
CREATE UNIQUE INDEX "supplier_payments_payment_no_key" ON "supplier_payments"("payment_no");
CREATE INDEX "supplier_payments_supplier_id_status_idx" ON "supplier_payments"("supplier_id", "status");
CREATE INDEX "supplier_payments_order_no_status_idx" ON "supplier_payments"("order_no", "status");
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_id_payable_entry_id_key" ON "supplier_payment_allocations"("payment_id", "payable_entry_id");
CREATE INDEX "supplier_payment_allocations_payable_entry_id_status_idx" ON "supplier_payment_allocations"("payable_entry_id", "status");
CREATE INDEX "supplier_payment_allocations_order_no_status_idx" ON "supplier_payment_allocations"("order_no", "status");
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_payable_source_id_fkey" FOREIGN KEY ("payable_source_id") REFERENCES "payable_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_outsource_payable_source_id_fkey" FOREIGN KEY ("outsource_payable_source_id") REFERENCES "outsource_payable_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payable_entry_id_fkey" FOREIGN KEY ("payable_entry_id") REFERENCES "supplier_payable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
