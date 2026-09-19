-- 库存盘点（stocktakes + stocktake_lines）：仓库每月导入一次盘点表，确认后调整原料库存。
--
-- 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，调整库存物料数量。
-- 物料的产品代码作为唯一性，在新建物料时自动生成一个物料代码。」
--
-- 设计要点（见 docs/design/stocktake-management-2026-09-16.md）：
--   1) **不直接改余额**：确认时按行写 inventory_facts 调整事实（已确认口径 28），
--      库存余额始终是事实的聚合，历史单据不被改写；确认后只能冲销，不能改单。
--   2) 三个数量快照分开存（导入时账面 / 确认时账面 / 已应用调整）：导入与确认之间仓库可能
--      又发生了领料或入库，按确认时账面重算才不会把那些真实收发悄悄冲掉（用户已确认该口径）。
--   3) 仓位/货位只是文本记录，不是库位维度：V1 已确认不建库位主数据，收下来是为了能和纸质表对照。
--   4) inventory_facts 增加 stocktake_line_id：与原料流转行（raw_material_movement_line_id）同一
--      做法，让「这笔库存变动是哪一行盘点造成的」可直接查，而不是靠 source_id 约定去猜。
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" UUID NOT NULL,
    "stocktake_no" VARCHAR(100) NOT NULL,
    "period_month" VARCHAR(7) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "source_file_name" VARCHAR(300),
    "imported_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" UUID,
    "reversal_reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "product_code_snapshot" VARCHAR(80) NOT NULL,
    "product_name_snapshot" VARCHAR(200) NOT NULL,
    "specification_snapshot" VARCHAR(200),
    "warehouse_zone" VARCHAR(100),
    "bin_location" VARCHAR(100),
    "unit_id" UUID NOT NULL,
    "actual_quantity" DECIMAL(18,4) NOT NULL,
    "book_quantity_snapshot" DECIMAL(18,4) NOT NULL,
    "difference_snapshot" DECIMAL(18,4) NOT NULL,
    "book_quantity_at_confirm" DECIMAL(18,4),
    "applied_quantity" DECIMAL(18,4),
    "difference_reason" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- AlterTable：库存事实回指盘点行
ALTER TABLE "inventory_facts" ADD COLUMN "stocktake_line_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_stocktake_no_key" ON "stocktakes"("stocktake_no");
CREATE INDEX "stocktakes_period_month_status_idx" ON "stocktakes"("period_month", "status");
-- 一张盘点单内行号唯一：重传同一行会撞在这里，而不是变成两条互相矛盾的盘点行
CREATE UNIQUE INDEX "stocktake_lines_stocktake_id_line_no_key" ON "stocktake_lines"("stocktake_id", "line_no");
CREATE INDEX "stocktake_lines_material_id_idx" ON "stocktake_lines"("material_id");
CREATE INDEX "stocktake_lines_stocktake_id_idx" ON "stocktake_lines"("stocktake_id");
CREATE INDEX "inventory_facts_stocktake_line_id_idx" ON "inventory_facts"("stocktake_line_id");

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- 库存事实保留盘点行指针：盘点行本身不会被物理删除（已确认的单子只能冲销），置空仅为兜底
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_stocktake_line_id_fkey" FOREIGN KEY ("stocktake_line_id") REFERENCES "stocktake_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
