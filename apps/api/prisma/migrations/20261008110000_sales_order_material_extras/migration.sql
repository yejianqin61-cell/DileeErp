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
-- ⚠️ 两条外键的 `ON DELETE` **不一样**，不是笔误 —— 它是 Prisma 按「可空 / 不可空」定的默认口径，
-- 而 schema 与本文件必须一致：不一致就是 6 行**永久漂移**（`npx prisma migrate diff` 会一直要求
-- DROP 掉这条外键再按 `SET NULL` 建回来）。
--
--   `sales_order_id` 不可空 → `RESTRICT`：删销售单不许把附表悄悄带走（整条销售链都不带 `CASCADE`，
--   草稿删除是软删）。与 `sales_order_material_refs` / `sales_order_spec_details` 同一条口径。
--
--   `material_id` 可空 → `SET NULL`：**这一行可以只填文字**（`material_id` 为 NULL 是它的正常状态，
--   不是异常），所以物料被硬删时该行**留着文字、只摘掉引用**。这与服务层 `usableMaterialExtras`
--   （返单时发现引用的物料已删 → 保留文字、只摘引用，并回报一条 warning）是同一条业务口径，
--   也与既有那两条**可空的**物料外键一致（`outsource_return_transfers_material_id_fkey`、
--   `inventory_facts_material_id_fkey` 都是 `SET NULL`）。反过来用 `RESTRICT` 的话，
--   表现是「删一个物料被一张单子的『其它』行挡住」——用户看不出来是被哪个类目挡的。
--
-- 注：物料走的是软删（`materials.deleted_at`），正常情况下这两条外键都不会触发；
-- 它们防的是直连数据库硬删的那种情况。
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

ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
