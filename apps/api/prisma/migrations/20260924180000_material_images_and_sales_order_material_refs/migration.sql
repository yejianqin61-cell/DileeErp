-- 物料图片 + 销售单材料明细的物料引用（用户 2026-09-24 的第 ③④ 件事）。
--
-- ③：「物料清单，要给物料配上图片。图片上传之后要压缩成 webp 再存进数据库里」；
-- ④：「在编辑销售单的时候，每个部件，既支持填空，也支持从现有的物料清单中引用。
--     同时要体现对应的物料的图片」。
--
-- 三处取舍都写在 schema.prisma 的模型注释上，这里只记与**迁移**有关的两条：
--
--   1. `material_images` 是**独立表**而不是 `materials` 上的字节列：`materials` 被采购/BOM/
--      库存/生产到处 `findMany`，字节列挂在主表上会让每次列表查询都把图片读回来。
--      1:1 从表只在显式 include 时才取。`material_id` 唯一，所以一个物料最多一张图。
--   2. `sales_order_material_refs` 是「一行一个引用」（spec_key + material_id），不是往
--      `sales_orders` 上加 18 个可空外键列 —— 能让引用的栏位清单（`SPEC_MATERIAL_FIELDS`）
--      以后增删而不动 schema。唯一键 (sales_order_id, spec_key) 与软删除并存：换引用是
--      **改这一行**（清 deleted_at、换 material_id），删了再建会撞唯一索引。
--
-- ⚠️ 唯一索引**不看 deleted_at**（与全站既有口径一致）：同一张销售单的同一个栏位只有一行，
-- 软删之后仍然占位，所以服务层用的是 upsert 式恢复，不是「软删 + 新建」。
CREATE TABLE "material_images" (
    "id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "mime_type" VARCHAR(50) NOT NULL DEFAULT 'image/webp',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "material_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_images_material_id_key" ON "material_images"("material_id");

ALTER TABLE "material_images" ADD CONSTRAINT "material_images_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sales_order_material_refs" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "spec_key" VARCHAR(50) NOT NULL,
    "material_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_material_refs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_order_material_refs_sales_order_id_spec_key_key" ON "sales_order_material_refs"("sales_order_id", "spec_key");

CREATE INDEX "sales_order_material_refs_material_id_idx" ON "sales_order_material_refs"("material_id");

ALTER TABLE "sales_order_material_refs" ADD CONSTRAINT "sales_order_material_refs_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_order_material_refs" ADD CONSTRAINT "sales_order_material_refs_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
