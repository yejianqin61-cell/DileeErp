ALTER TABLE "operation_daily_reports" ADD COLUMN "idempotency_key" VARCHAR(200), ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "employee_daily_reports" ADD COLUMN "idempotency_key" VARCHAR(200), ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "operation_daily_reports_idempotency_key_key" ON "operation_daily_reports"("idempotency_key");
CREATE UNIQUE INDEX "employee_daily_reports_idempotency_key_key" ON "employee_daily_reports"("idempotency_key");
