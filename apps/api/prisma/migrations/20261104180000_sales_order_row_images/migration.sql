-- 销售单「每种一张图」（用户 2026-11-04）：
-- 「销售订单要支持每个物料插入图片。我记得以前是有过这个设计的，在物料清单里支持上传图片。
--   然后导出的销售单，物料图片统一归在表单底部。」
--   用户补充：「一个生产单里有 5 种伞布、11 种伞头，能在每种里插入图片」。
--
-- 拍板三件事（见 docs/design/sales-order-row-images-2026-11-04.md）：
--   ① 两处都要：材料明细的类目行（含「再加一款」）与细分明细行都能挂图；
--   ② 图片来源两种都支持：引用物料清单里那张 / 行上直接上传；物料没有图时问一句是否回填物料图；
--   ③ 导出：明细行印在该行「图片」列，材料行排表单底部图片区。
--
-- 迁移里的三条取舍（原理由写在 schema.prisma 的模型注释上）：
--
--   1. 图片是**独立的库行** `sales_order_images`，材料行/明细行只存 `image_id` 指针 ——
--      那两张附表的替换语义是「软删旧的 + 建新的」，行 id 每次保存都变，字节挂在行上
--      要么丢图、要么每次保存都把整块图重拷一遍。
--   2. 18 个材料格**没有行**可挂外键（它们是 sales_orders 上的 18 个标量列），
--      所以另建 `sales_order_slot_images`（一行 = 一格的一张图，唯一键 sales_order_id + spec_key）。
--      它和 `sales_order_material_refs` 同一条「唯一索引不看 deleted_at」的口径：
--      替换是逐格对齐（复活/换 image_id），不是软删 + 新建。
--   3. 图片按单隔离（sales_order_id 不可空）：返单/复制时由服务端**复制字节**成新单自己的行，
--      删一张单不会让另一张单的图变成破图，也没有跨单引用。
--
-- 外键的 ON DELETE：不可空的按 Prisma 默认 RESTRICT（销售链一律不 CASCADE，草稿删除是软删）；
-- 可空的 `image_id` 按默认 SET NULL —— 图片被硬删时那几行只是「没有图」，不是数据异常。
CREATE TABLE "sales_order_images" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
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
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_order_images_sales_order_id_idx" ON "sales_order_images"("sales_order_id");

ALTER TABLE "sales_order_images" ADD CONSTRAINT "sales_order_images_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sales_order_slot_images" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "spec_key" VARCHAR(50) NOT NULL,
    "image_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_slot_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_order_slot_images_sales_order_id_spec_key_key" ON "sales_order_slot_images"("sales_order_id", "spec_key");

CREATE INDEX "sales_order_slot_images_sales_order_id_idx" ON "sales_order_slot_images"("sales_order_id");

CREATE INDEX "sales_order_slot_images_image_id_idx" ON "sales_order_slot_images"("image_id");

ALTER TABLE "sales_order_slot_images" ADD CONSTRAINT "sales_order_slot_images_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_order_slot_images" ADD CONSTRAINT "sales_order_slot_images_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "sales_order_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_order_spec_details" ADD COLUMN "image_id" UUID;

CREATE INDEX "sales_order_spec_details_image_id_idx" ON "sales_order_spec_details"("image_id");

ALTER TABLE "sales_order_spec_details" ADD CONSTRAINT "sales_order_spec_details_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_order_material_extras" ADD COLUMN "image_id" UUID;

CREATE INDEX "sales_order_material_extras_image_id_idx" ON "sales_order_material_extras"("image_id");

ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
