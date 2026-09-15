-- 记账凭证（vouchers + voucher_lines）：从收支流水生成。
--
-- 设计要点（为什么这样做，见 docs/design/accounting-vouchers-2026-09-15.md）：
--   1) 凭证是**结构化记录**，不是图片：可查/可核/可追溯/可重打；图片只是渲染视图（前端凭证纸 + 浏览器打印）。
--   2) 一条来源只能有一张凭证 → vouchers 上 (source_type, source_id) 唯一索引，重复生成就是返回原凭证（幂等）。
--   3) 金额恒为正数、方向由 direction 决定（与 cash_flow_entries 同一约定，避免「负数金额」这种无法校验的写法）。
--   4) 科目名做**快照**（subject_label）：字典改名/停用后，历史凭证仍显示记账当时的科目名。
--   5) 分录随凭证级联删除：凭证被物理删除时分录没有独立意义（业务上只软删除凭证）。
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "voucher_no" VARCHAR(100) NOT NULL,
    "voucher_date" DATE NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" UUID NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "debit_total" DECIMAL(18,4) NOT NULL,
    "credit_total" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_lines" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "subject_key" VARCHAR(200) NOT NULL,
    "subject_label" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "cash_flow_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_voucher_no_key" ON "vouchers"("voucher_no");
-- 一条来源只能生成一张凭证（生成接口的幂等根）
CREATE UNIQUE INDEX "vouchers_source_type_source_id_key" ON "vouchers"("source_type", "source_id");
CREATE INDEX "vouchers_period_status_idx" ON "vouchers"("period", "status");
CREATE INDEX "vouchers_voucher_date_idx" ON "vouchers"("voucher_date");
CREATE UNIQUE INDEX "voucher_lines_voucher_id_line_no_key" ON "voucher_lines"("voucher_id", "line_no");

-- AddForeignKey：分录随凭证级联删除（软删除凭证时不动分录，按 deleted_at 过滤）
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey：来源流水被删除时分录保留（凭证是独立事实，只把来源指针置空）
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_cash_flow_entry_id_fkey" FOREIGN KEY ("cash_flow_entry_id") REFERENCES "cash_flow_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
