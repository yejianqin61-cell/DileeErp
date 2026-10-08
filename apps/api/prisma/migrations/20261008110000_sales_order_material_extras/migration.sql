-- 销售单「材料明细」末尾的自定义类目行（用户 2026-10-08）。
--
-- 用户原话：「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要别的物料。
-- 允许用户增删改」。
--
-- 与既有两张附表的关系（取舍写在 schema.prisma 的模型注释上，这里只记与**迁移**有关的三条）：
--
--   1. 为什么不加列：上面 18 项是模板上印死的栏位，而这里的**类目名是用户自己起的、条数不定**。
--   2. 为什么不塞进 `sales_order_spec_details`：那张表是「细分明细」（印在工艺单下半部的明细区），
--      形状完全不同（分组名 + 品番/品名 + 颜色 + 条码 + 数量 + 单位）。混用就得靠 group_name 猜
--      这行属于哪块版面，猜错就是整块印错位。
--   3. 为什么 `material_id` 在这张表上、而不是进 `sales_order_material_refs`：那张表的唯一键
--      `(sales_order_id, spec_key)` 里 `spec_key` 的语义是「18 个栏位之一」，「其它」行没有稳定的
--      栏位键（拿序号当键的话，删掉中间一行会让后面每一行的引用整体错位 —— 表现是图配错了物料，
--      而纸上看不出来）。
--
-- 没有唯一键：替换语义是「软删旧的 + 建新的」（与 `sales_order_spec_details` 一致），
-- 所以行 id 每次保存都会变；图片导出候选按 `extra:<行 id>` 标识（见 sales-order-export.service.ts）。
--
-- ⚠️ 外键一律 `ON DELETE RESTRICT`（与整条销售链上的既有口径一致：销售单与其附表都不带
-- `CASCADE`，草稿删除是软删）。`material_id` 可空：那一行可以只填文字。
CREATE TABLE "sales_order_material_extras" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "content" VARCHAR(1000),
    "material_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_material_extras_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_order_material_extras_sales_order_id_sort_order_idx" ON "sales_order_material_extras"("sales_order_id", "sort_order");

CREATE INDEX "sales_order_material_extras_material_id_idx" ON "sales_order_material_extras"("material_id");

ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
