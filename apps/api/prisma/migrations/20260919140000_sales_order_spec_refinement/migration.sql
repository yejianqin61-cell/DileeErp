-- 销售单下单口径细化 + 通用明细子表（2026-09-16）
--
-- 依据：example/销售单 里的工艺单模板（两张样本：DL260134 JBN 生产单 A–J 表、
-- DL260001-1 FLOWER1 花色生产单 A–K 表），设计见
-- docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md。
--
-- 用户拍板：① 材料/工艺做成**固定字段**（两样本并集）② 明细表做成「一张通用表 + 分组名」
-- ③ 导出两张合一、空盘位自动省略 ④ 新建销售单改整页编辑器 ⑤ 材料到货状态不做。
--
-- 三条设计上的取舍（都写在注释里，避免后来的人以为是漏了）：
--   1. **落列而不是塞 extension_data(JSON)**：这些字要在页面上逐格编辑、按模板逐格打印、
--      还要能被审计，JSON 三样都做不到（上一轮采购单打印字段同一个理由）。
--   2. **全部可空、无默认值**：历史销售单没有这些字，加列不能变成「必须补填」，否则升级后旧单写不进去。
--   3. **不加索引**：这些字段只有填写、打印与人工查看，没有按它们筛选或去重的场景。
--
-- 图片格（花色图片列、【相关图片】大格、伞头图片列）按用户要求**不落库、不导出**，只留空格。
ALTER TABLE "sales_orders"
  ADD COLUMN "factory" VARCHAR(100),
  ADD COLUMN "completion_remark" VARCHAR(100),
  ADD COLUMN "attention_note" VARCHAR(2000),
  ADD COLUMN "shipping_mark_front" VARCHAR(2000),
  ADD COLUMN "shipping_mark_side" VARCHAR(2000),
  ADD COLUMN "fabric_usage_canopy" DECIMAL(18,4),
  ADD COLUMN "fabric_usage_strap" DECIMAL(18,4),
  ADD COLUMN "fabric_usage_wood_ear" DECIMAL(18,4),
  ADD COLUMN "fabric_usage_top" DECIMAL(18,4),
  ADD COLUMN "fabric_usage_bag" DECIMAL(18,4),
  ADD COLUMN "rib_spec" VARCHAR(1000),
  ADD COLUMN "canopy_spec" VARCHAR(1000),
  ADD COLUMN "handle_spec" VARCHAR(1000),
  ADD COLUMN "handle_strap_spec" VARCHAR(1000),
  ADD COLUMN "tail_spec" VARCHAR(1000),
  ADD COLUMN "runner_spec" VARCHAR(1000),
  ADD COLUMN "strap_spec" VARCHAR(1000),
  ADD COLUMN "strap_fastener_spec" VARCHAR(1000),
  ADD COLUMN "inner_label_spec" VARCHAR(1000),
  ADD COLUMN "woven_label_spec" VARCHAR(1000),
  ADD COLUMN "hang_tag_spec" VARCHAR(1000),
  ADD COLUMN "opp_spec" VARCHAR(1000),
  ADD COLUMN "bag_spec" VARCHAR(1000),
  ADD COLUMN "packaging_spec" VARCHAR(1000),
  ADD COLUMN "top_fabric_spec" VARCHAR(1000),
  ADD COLUMN "wood_ear_spec" VARCHAR(1000),
  ADD COLUMN "keychain_spec" VARCHAR(1000),
  ADD COLUMN "printing_spec" VARCHAR(1000),
  ADD COLUMN "sample_requirement" VARCHAR(1000),
  ADD COLUMN "cutting_requirement" VARCHAR(1000),
  ADD COLUMN "edge_requirement" VARCHAR(1000),
  ADD COLUMN "joining_requirement" VARCHAR(1000),
  ADD COLUMN "top_stitch_requirement" VARCHAR(1000),
  ADD COLUMN "sewing_requirement" VARCHAR(1000),
  ADD COLUMN "strap_requirement" VARCHAR(1000),
  ADD COLUMN "hang_tag_note" VARCHAR(1000),
  ADD COLUMN "qc_requirement" VARCHAR(1000);

-- 细分明细：样本1 的「伞布明细」、样本2 的「伞头配色」/「外层花色搭配」是同一种形状
-- （名称 + 颜色 + 条码 + 数量），所以用一张表 + group_name 分组，而不是每种明细表各建一张。
CREATE TABLE "sales_order_spec_details" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "group_name" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "color" VARCHAR(100),
    "barcode" VARCHAR(100),
    "quantity" DECIMAL(18,4),
    "unit" VARCHAR(30),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "sales_order_spec_details_pkey" PRIMARY KEY ("id")
);

-- 按 (销售单, 排序) 取一组行：导出要按 sort_order 落格，详情页也按它显示。
CREATE INDEX "sales_order_spec_details_sales_order_id_sort_order_idx" ON "sales_order_spec_details"("sales_order_id", "sort_order");

ALTER TABLE "sales_order_spec_details" ADD CONSTRAINT "sales_order_spec_details_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
