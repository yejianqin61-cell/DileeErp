-- 银行池（banks）+ 「其他应付」（order_no 可空）+ 对账/付款选择银行。
--
-- 本文件已由部署方对齐 Prisma 规范 DDL（schema.prisma 的 Bank 模型是本迁移的权威来源）：
--   原稿建表用了 TIMESTAMPTZ 与 "id" 的 DB 默认值，而 schema 声明的是普通 DateTime（Prisma 映射
--   为 TIMESTAMP(3)）与客户端侧 uuid() 默认——两者都会让 `prisma migrate diff` 报库/schema 漂移，
--   而且全库其余 68 个迁移用的都是 TIMESTAMP(3)，单独一张表用 timestamptz 会造成时区语义不一致。
--   核对方式：`npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script`。
--   迁移当时**尚未在任何库上执行**，因此改内容是安全的（已应用的迁移绝不能改，会使 checksum 失配）。

-- CreateTable
CREATE TABLE "banks" (
    "id" UUID NOT NULL,
    "bank_code" VARCHAR(80) NOT NULL,
    "bank_name" VARCHAR(200) NOT NULL,
    "account_name" VARCHAR(200) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "swift_code" VARCHAR(50),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "banks_bank_code_key" ON "banks"("bank_code");

-- AlterTable：「其他应付」没有订单号，因此把 order_no 放宽为可空
ALTER TABLE "supplier_payable_entries" ALTER COLUMN "order_no" DROP NOT NULL;
-- 核销明细的 order_no 是从应付条目带下来的快照，父条目可空，它也必须可空
-- （否则「其他应付」一旦付款核销就会写不进去；schema.prisma 的 SupplierPaymentAllocation.orderNo 已同步改为可空）。
ALTER TABLE "supplier_payment_allocations" ALTER COLUMN "order_no" DROP NOT NULL;

-- AlterTable：对账与付款都要指明收款/付款银行
ALTER TABLE "supplier_payable_reconciliations" ADD COLUMN "bank_id" UUID;
ALTER TABLE "supplier_payments" ADD COLUMN "bank_id" UUID;

-- AddForeignKey：bank_id 是可空关联 → Prisma 期望 SET NULL（写成 RESTRICT 会造成库与 schema 漂移）
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
