-- Per-item supplier and expected arrival date on purchase order items.
-- Existing rows inherit the parent purchase order's supplier (id + snapshot) and expected date.
ALTER TABLE "purchase_order_items" ADD COLUMN "supplier_id" UUID;
ALTER TABLE "purchase_order_items" ADD COLUMN "supplier_snapshot" JSONB;
ALTER TABLE "purchase_order_items" ADD COLUMN "expected_date" TIMESTAMP(3);

UPDATE "purchase_order_items"
SET "supplier_id" = po."supplier_id",
    "supplier_snapshot" = po."supplier_snapshot",
    "expected_date" = po."expected_date"
FROM "purchase_orders" po
WHERE "purchase_order_items"."purchase_order_id" = po."id";

ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_id" SET NOT NULL;
ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_snapshot" SET NOT NULL;

CREATE INDEX "purchase_order_items_supplier_id_idx" ON "purchase_order_items"("supplier_id");
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
