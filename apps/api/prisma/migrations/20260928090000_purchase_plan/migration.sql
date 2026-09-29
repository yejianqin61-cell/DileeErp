-- 采购计划（2026-09-27）：`purchase_plans` + `purchase_plan_items`。
--
-- 设计依据 `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md`。
-- 建表语句与 `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma` 的输出
-- **逐列、逐索引、逐外键核对过**（该命令不需要数据库）。有两处是手写补充、Prisma 生成不出来的：
--
--   1. 部分唯一索引 `purchase_plans_bom_id_active_key`（见文末）。「一个 BOM 一份计划」必须
--      只对**未删**的计划成立，否则软删一份计划之后就再也建不出第二份。
--      照抄 `20260826100000_unique_editable_bom` 对 `boms` 的同一手法。
--   2. `purchase_plan_items.purchase_order_item_id` 的**唯一索引**是 Prisma 的 `@unique` 生成的
--      （可空列上的全量唯一索引，Postgres 允许多个 NULL），所以它在 schema 里声明、不算漂移。
--
-- 外键动作按仓库既定口径：**可选关系一律 ON DELETE SET NULL**（supplier / bom_item /
-- purchase_order_item），**必填关系一律 RESTRICT**（sales_order / bom / plan / material / unit）。
-- 写错（例如照抄上一行的 RESTRICT）会让 `prisma migrate diff` 长期报漂移 ——
-- 漂移不报错、只是悄悄攒着，本仓库有过 6 行漂移的教训。

-- CreateTable
CREATE TABLE "purchase_plans" (
    "id" UUID NOT NULL,
    "plan_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "bom_version" INTEGER,
    "bom_snapshot" JSONB,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_plan_items" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "material_snapshot" JSONB NOT NULL,
    "unit_id" UUID NOT NULL,
    "unit_snapshot" JSONB NOT NULL,
    "bom_item_id" UUID,
    "supplier_id" UUID,
    "supplier_snapshot" JSONB,
    "model" VARCHAR(200),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "expected_date" TIMESTAMP(3),
    "purchase_order_item_id" UUID,
    "sequence" INTEGER,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_plans_plan_no_key" ON "purchase_plans"("plan_no");

-- CreateIndex
CREATE INDEX "purchase_plans_order_no_idx" ON "purchase_plans"("order_no");

-- CreateIndex
CREATE INDEX "purchase_plans_bom_id_idx" ON "purchase_plans"("bom_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_plan_items_purchase_order_item_id_key" ON "purchase_plan_items"("purchase_order_item_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_plan_id_idx" ON "purchase_plan_items"("plan_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_supplier_id_idx" ON "purchase_plan_items"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_bom_item_id_idx" ON "purchase_plan_items"("bom_item_id");

-- AddForeignKey
ALTER TABLE "purchase_plans" ADD CONSTRAINT "purchase_plans_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plans" ADD CONSTRAINT "purchase_plans_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "purchase_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 「一个 BOM 一份计划」：只对**未删**的计划唯一。
-- 全量唯一索引会让「软删一份计划之后再也建不出第二份」，而口径允许删掉没下过单的计划再重来。
-- 代价：Prisma 不认识部分索引，`migrate diff` 会把它算作漂移（与 boms / raw_material_inbound_notices
-- 的三条同源）。基线漂移因此小幅增加，这是**预期内**的，见设计文档 §7.3。
CREATE UNIQUE INDEX "purchase_plans_bom_id_active_key" ON "purchase_plans"("bom_id") WHERE "deleted_at" IS NULL;
