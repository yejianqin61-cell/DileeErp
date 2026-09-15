-- 应收侧也要选银行：收款单（customer_payments）与应收对账（receivable_reconciliations）各加一个可空的 bank_id。
--
-- 为什么现在才加：银行账户池（banks）在 20260915120000 迁移里先接的是**应付**侧（付款登记 + 应付对账）。
-- 应收侧当时没有写路径，本次把「所有应收管理都要选择银行」补齐，字段与 FK 语义跟应付侧完全一致：
--   bank_id 可空（历史数据、以及还没确定回款账户的草稿）→ Prisma 期望 ON DELETE SET NULL。
-- 银行账户是主数据（bank_name / account_number 会变），这里只存外键，不做冗余快照。
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- AlterTable
ALTER TABLE "customer_payments" ADD COLUMN "bank_id" UUID;
ALTER TABLE "receivable_reconciliations" ADD COLUMN "bank_id" UUID;

-- AddForeignKey：可空关联 → SET NULL（写成 RESTRICT 会造成库/schema 漂移）
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
