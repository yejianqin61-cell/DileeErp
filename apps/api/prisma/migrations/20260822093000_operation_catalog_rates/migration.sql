CREATE TABLE "operation_catalogs" (
  "id" UUID NOT NULL,
  "operation_code" VARCHAR(80),
  "operation_name" VARCHAR(150) NOT NULL,
  "default_unit_id" UUID,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "operation_catalogs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "operation_rates" (
  "id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "wage_mode" VARCHAR(20) NOT NULL,
  "unit_price" DECIMAL(18,4) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "operation_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operation_catalogs_operation_code_key" ON "operation_catalogs"("operation_code");
CREATE INDEX "operation_rates_employee_id_operation_id_wage_mode_effective_from_idx" ON "operation_rates"("employee_id", "operation_id", "wage_mode", "effective_from");
ALTER TABLE "operation_catalogs" ADD CONSTRAINT "operation_catalogs_default_unit_id_fkey" FOREIGN KEY ("default_unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operation_rates" ADD CONSTRAINT "operation_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operation_rates" ADD CONSTRAINT "operation_rates_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
