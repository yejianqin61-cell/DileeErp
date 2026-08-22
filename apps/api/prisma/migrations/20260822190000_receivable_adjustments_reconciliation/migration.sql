CREATE TABLE "receivable_adjustments" (
  "id" UUID NOT NULL,
  "adjustment_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID,
  "customer_id" UUID NOT NULL,
  "receivable_source_id" UUID,
  "adjustment_type" VARCHAR(30) NOT NULL,
  "effect" VARCHAR(20) NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "adjustment_date" DATE NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "receivable_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "receivable_reconciliations" (
  "id" UUID NOT NULL,
  "reconciliation_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "sales_order_id" UUID,
  "customer_id" UUID NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "receivable_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "payment_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "adjustment_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "system_balance" DECIMAL(18,4) NOT NULL,
  "external_balance" DECIMAL(18,4) NOT NULL,
  "difference" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "resolution_remark" VARCHAR(1000),
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "receivable_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receivable_adjustments_adjustment_no_key" ON "receivable_adjustments"("adjustment_no");
CREATE INDEX "receivable_adjustments_order_no_status_idx" ON "receivable_adjustments"("order_no", "status");
CREATE INDEX "receivable_adjustments_customer_id_status_idx" ON "receivable_adjustments"("customer_id", "status");
CREATE INDEX "receivable_adjustments_receivable_source_id_status_idx" ON "receivable_adjustments"("receivable_source_id", "status");
CREATE UNIQUE INDEX "receivable_reconciliations_reconciliation_no_key" ON "receivable_reconciliations"("reconciliation_no");
CREATE INDEX "receivable_reconciliations_order_no_status_idx" ON "receivable_reconciliations"("order_no", "status");
CREATE INDEX "receivable_reconciliations_customer_id_status_idx" ON "receivable_reconciliations"("customer_id", "status");
CREATE INDEX "receivable_reconciliations_period_start_period_end_idx" ON "receivable_reconciliations"("period_start", "period_end");
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_receivable_source_id_fkey" FOREIGN KEY ("receivable_source_id") REFERENCES "receivable_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
