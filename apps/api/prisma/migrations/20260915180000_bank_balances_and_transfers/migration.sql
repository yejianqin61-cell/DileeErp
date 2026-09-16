-- 银行余额管理：期初余额 + 账户互转 + 流水落到具体银行账户 + 各单据记收支项目。
--
-- 设计要点（为什么这样做，见 docs/design/bank-balance-and-transfer-2026-09-16.md）：
--   1) banks.opening_balance —— 财务接手的账户本来就有余额；没有期初，系统余额永远对不上银行对账单。
--   2) bank_transfers —— 同一个银行池内两个账户互转，**不写进 cash_flow_entries**：
--      互转既不是收入也不是支出，写成「A 支出 + B 收入」会让收支汇总表凭空多一笔收入与一笔支出。
--      它只在计算银行余额时参与（转出方 −from_amount、转入方 +to_amount）。
--   3) cash_flow_entries.bank_id —— 资金实际所在的银行账户（banks），是算余额的依据。
--      与 settlement_account_id（老表「结算方式」字典）是两回事：字典是给人看的文本，这里才是账。
--   4) *_reconciliations / customer_payments / supplier_payments 的 cash_flow_item_id —— 收支项目。
--      确认应收/应付、收付款过账时按它写入收支流水，收支明细表才能按项目分类统计。
--
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- AlterTable：期初余额。已有账户补 0（不是 NULL）：0 是「期初为零」这一事实，NULL 会让余额算不出来。
ALTER TABLE "banks" ADD COLUMN "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable：流水落到具体银行账户（可空：历史流水与「不确定走哪张卡」的流水）。
ALTER TABLE "cash_flow_entries" ADD COLUMN "bank_id" UUID;

-- AlterTable：各单据记收支项目（可空：不填则由服务端按业务来源自动归类）。
ALTER TABLE "customer_payments" ADD COLUMN "cash_flow_item_id" UUID;
ALTER TABLE "supplier_payments" ADD COLUMN "cash_flow_item_id" UUID;
ALTER TABLE "receivable_reconciliations" ADD COLUMN "cash_flow_item_id" UUID;
ALTER TABLE "supplier_payable_reconciliations" ADD COLUMN "cash_flow_item_id" UUID;

-- CreateTable：银行余额互转
CREATE TABLE "bank_transfers" (
    "id" UUID NOT NULL,
    "transfer_no" VARCHAR(100) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "from_bank_id" UUID NOT NULL,
    "from_currency" VARCHAR(10) NOT NULL,
    "to_bank_id" UUID NOT NULL,
    "to_currency" VARCHAR(10) NOT NULL,
    "from_amount" DECIMAL(18,4) NOT NULL,
    "to_amount" DECIMAL(18,4) NOT NULL,
    "exchange_rate" DECIMAL(18,6),
    "status" VARCHAR(30) NOT NULL DEFAULT 'posted',
    "reversal_reason" VARCHAR(500),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "bank_transfers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_transfers_transfer_no_key" ON "bank_transfers"("transfer_no");
CREATE INDEX "bank_transfers_transfer_date_status_idx" ON "bank_transfers"("transfer_date", "status");
CREATE INDEX "bank_transfers_from_bank_id_status_idx" ON "bank_transfers"("from_bank_id", "status");
CREATE INDEX "bank_transfers_to_bank_id_status_idx" ON "bank_transfers"("to_bank_id", "status");

-- AddForeignKey：可空关联（流水/单据可以不选银行、不选项目）→ Prisma 期望 ON DELETE SET NULL。
-- 写成 RESTRICT 会让 `migrate status` 认为库与 schema 有漂移，所以这里逐列区分：
--   * bank_id / cash_flow_item_id 可空 → SET NULL；
--   * bank_transfers 的 from/to_bank_id 必填 → RESTRICT（账户只软删除，不会真删）。
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_cash_flow_item_id_fkey" FOREIGN KEY ("cash_flow_item_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cash_flow_item_id_fkey" FOREIGN KEY ("cash_flow_item_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_cash_flow_item_id_fkey" FOREIGN KEY ("cash_flow_item_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_cash_flow_item_id_fkey" FOREIGN KEY ("cash_flow_item_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_from_bank_id_fkey" FOREIGN KEY ("from_bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_to_bank_id_fkey" FOREIGN KEY ("to_bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex：余额聚合按 (bank_id, status) 扫，缺这条索引会让每次余额计算都全表扫流水。
CREATE INDEX "cash_flow_entries_bank_id_status_idx" ON "cash_flow_entries"("bank_id", "status");

-- 库层边界检查（与 cash_flow_entries_direction_check 等既有约束同一做法）：
-- 即使有写入绕过 HTTP 服务，也不允许出现金额为零/为负、自己转给自己、状态不明的互转。
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_amount_positive_check" CHECK ("from_amount" > 0 AND "to_amount" > 0);
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_distinct_banks_check" CHECK ("from_bank_id" <> "to_bank_id");
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_status_check" CHECK ("status" IN ('posted', 'reversed'));
