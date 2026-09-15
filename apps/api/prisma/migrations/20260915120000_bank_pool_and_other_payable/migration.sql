-- Create banks table
CREATE TABLE "banks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bank_code" VARCHAR(80) NOT NULL,
    "bank_name" VARCHAR(200) NOT NULL,
    "account_name" VARCHAR(200) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "swift_code" VARCHAR(50),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,
    CONSTRAINT "banks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "banks_bank_code_key" UNIQUE ("bank_code")
);

-- Alter supplier_payable_entries: make order_no nullable for "other" payables
ALTER TABLE "supplier_payable_entries" ALTER COLUMN "order_no" DROP NOT NULL;

-- Add bank_id to supplier_payable_reconciliations
ALTER TABLE "supplier_payable_reconciliations" ADD COLUMN "bank_id" UUID;
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add bank_id to supplier_payments
ALTER TABLE "supplier_payments" ADD COLUMN "bank_id" UUID;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;