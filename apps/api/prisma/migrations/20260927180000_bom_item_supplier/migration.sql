-- BOM 明细行加「默认供应商」（2026-09-26）
--
-- 依据：老板要求「针对 BOM 表，要新增一个 column，供应商。同时允许在下拉列表中快速新建」。
-- 两处已确认的口径（问过用户，写在这里免得后来的人猜）：
--   1. 供应商挂在 **BOM 明细行**（每个部件一个），不是整张 BOM 一个；
--   2. **不预填到采购单** —— BOM 上的供应商是备查信息（这个部件通常找哪家），
--      采购仍逐行自己选供应商，既有采购流程一行都不动。
--
-- 三条设计取舍：
--   · **可空**：历史 BOM 行没有供应商，加 NOT NULL 会让这条迁移在真实库上直接失败。
--   · **存 supplier_snapshot**：供应商被改名/停用之后，BOM 上仍要看得见当时记的是哪一家
--     （与 material_snapshot 同一条理由）。
--   · **引用而不是抄名字**：供应商主数据是唯一真源，抄十份之后改一次要改十处。
--
-- ⚠️ 外键动作必须是 `ON DELETE SET NULL ON UPDATE CASCADE`：Prisma 对**可选**关系一律生成
-- SET NULL，只写 `ON DELETE RESTRICT`（或干脆不写，默认 NO ACTION）会让 `prisma migrate diff`
-- **长期**报漂移 —— 漂移不是报错而是"悄悄攒着"，本仓库已经因此有过 6 行漂移的教训
-- （见 20260920120000_purchase_order_item_supplier_nullable 的守卫注释）。

ALTER TABLE "bom_items"
  ADD COLUMN "supplier_id" UUID,
  ADD COLUMN "supplier_snapshot" JSONB;

CREATE INDEX "bom_items_supplier_id_idx" ON "bom_items"("supplier_id");

ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
