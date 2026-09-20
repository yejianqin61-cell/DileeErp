-- 「这张 BOM 明细行是不是已经买过了」需要一个按明细行的索引（2026-09-17）。
--
-- 新建采购单时会按 `purchase_order_items.bom_item_id` 归集每一行的累计下单量
-- （见 PurchaseOrdersService.bomItemOrderStatus）。这一列以前没有索引：
-- 每次导入 BOM 都要全表扫 purchase_order_items，表一大就慢。
-- 纯新增索引，不改任何数据，也不加约束 —— 缺值（BOM 外的补料行）本来就是允许的。
CREATE INDEX "purchase_order_items_bom_item_id_idx" ON "purchase_order_items"("bom_item_id");
