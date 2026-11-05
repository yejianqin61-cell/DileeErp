-- 销售单「一条物料最多 3 张图」（用户 2026-11-05：「销售单那边，一条物料支持导入3张图片，现在只有1张。改一下」）。
--
-- 上一轮（2026-11-04）的口径是「每行/每格一张图」：`sales_order_spec_details.image_id`、
-- `sales_order_material_extras.image_id`、`sales_order_slot_images` 唯一键 `(sales_order_id, spec_key)`。
-- 本轮把三个位置都扩到最多 3 张，且**旧数据原样可用**：
--   · 第 1 张继续用 `image_id`（历史行 = 第 1 张，不需要回填）；
--   · 第 2/3 张各加一个可空外键列（`image_id_2` / `image_id_3`，ON DELETE SET NULL：
--     图片被硬删时那几行只是「少了这张」，不是数据异常）；
--   · 18 个材料格的那张映射表加 `slot_index`（0/1/2），唯一键从
--     `(sales_order_id, spec_key)` 换成 `(sales_order_id, spec_key, slot_index)`。
--     历史行的 `slot_index` 默认 0 —— 正好就是「这一格的第 1 张」。
--
-- 为什么不做成「图片数组列（uuid[]）」：三张图都要能按 id 回读字节、也要能算「这一单还有没有行引用它」
-- （保存末尾清理孤儿图），可空外键 + 索引让这两件事继续走同一条路径；数组列没有外键约束，
-- 清理逻辑要扫数组，属于换一种更难维护的写法。
--
-- 为什么 18 格用 `slot_index` 而不是加三列：那张表本来就是「一行 = 一格的一张图」，
-- 多一行就是多一张，不需要动表头形状；外键非空 + 唯一键保证同一格同一位置只有一条活行。

-- ---------------------------------------------------------------------------
-- 1. 细分明细行：第 2/3 张图
-- ---------------------------------------------------------------------------
ALTER TABLE "sales_order_spec_details"
  ADD COLUMN "image_id_2" UUID,
  ADD COLUMN "image_id_3" UUID;

CREATE INDEX "sales_order_spec_details_image_id_2_idx" ON "sales_order_spec_details"("image_id_2");

CREATE INDEX "sales_order_spec_details_image_id_3_idx" ON "sales_order_spec_details"("image_id_3");

ALTER TABLE "sales_order_spec_details"
  ADD CONSTRAINT "sales_order_spec_details_image_id_2_fkey" FOREIGN KEY ("image_id_2") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_order_spec_details"
  ADD CONSTRAINT "sales_order_spec_details_image_id_3_fkey" FOREIGN KEY ("image_id_3") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. 「再加一款 / 其它」行：第 2/3 张图
-- ---------------------------------------------------------------------------
ALTER TABLE "sales_order_material_extras"
  ADD COLUMN "image_id_2" UUID,
  ADD COLUMN "image_id_3" UUID;

CREATE INDEX "sales_order_material_extras_image_id_2_idx" ON "sales_order_material_extras"("image_id_2");

CREATE INDEX "sales_order_material_extras_image_id_3_idx" ON "sales_order_material_extras"("image_id_3");

ALTER TABLE "sales_order_material_extras"
  ADD CONSTRAINT "sales_order_material_extras_image_id_2_fkey" FOREIGN KEY ("image_id_2") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_order_material_extras"
  ADD CONSTRAINT "sales_order_material_extras_image_id_3_fkey" FOREIGN KEY ("image_id_3") REFERENCES "sales_order_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. 18 个材料格：一格最多 3 张（`slot_index` 0/1/2）
-- ---------------------------------------------------------------------------
-- 历史行自动落在 0 = 「这一格的第 1 张」，不需要 UPDATE 回填。
ALTER TABLE "sales_order_slot_images" ADD COLUMN "slot_index" INTEGER NOT NULL DEFAULT 0;

-- 旧唯一键「一格只有一张」必须换掉，否则第 2/3 张会被它挡住。
DROP INDEX "sales_order_slot_images_sales_order_id_spec_key_key";

CREATE UNIQUE INDEX "sales_order_slot_images_sales_order_id_spec_key_slot_index_key" ON "sales_order_slot_images"("sales_order_id", "spec_key", "slot_index");
