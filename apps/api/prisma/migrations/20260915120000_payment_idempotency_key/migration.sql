-- 收款单 / 付款单建单的幂等键。
--
-- 依据：仓库、生产、采购的建单与过账接口一直都有 `idempotency_key`（nullable 列 + 唯一索引，
-- 命中即返回原记录），只有财务的收款/付款建单没有——同一个「登记收款」被重复提交
-- 会生成多张完全相同的草稿单（2026-09-15 实测：一个订单 4 张一模一样的 14310 USD 草稿）。
--
-- 与 `operation_daily_reports` / `employee_daily_reports` 加该列时的写法保持一致：
-- 允许 NULL 且只建唯一索引 —— Postgres 认为多个 NULL 互不相同，因此历史行不受影响。
ALTER TABLE "customer_payments" ADD COLUMN "idempotency_key" VARCHAR(200);
ALTER TABLE "supplier_payments" ADD COLUMN "idempotency_key" VARCHAR(200);
CREATE UNIQUE INDEX "customer_payments_idempotency_key_key" ON "customer_payments"("idempotency_key");
CREATE UNIQUE INDEX "supplier_payments_idempotency_key_key" ON "supplier_payments"("idempotency_key");
