-- Backfill: inbounds that were posted BEFORE the receive-only payable model
-- never got an inbound-level payable source (post() only fires at posting
-- time). Recreate them as pending_finance obligations using the same pricing
-- rule as post(): settlement fields first, then the purchase item price.
INSERT INTO "payable_sources" (
  "id", "raw_material_inbound_id", "purchase_receipt_id", "order_no",
  "purchase_order_id", "purchase_order_item_id", "supplier_id",
  "quantity", "unit_price", "currency", "tax_rate", "amount",
  "status", "idempotency_key", "created_at", "updated_at", "created_by", "updated_by"
)
SELECT
  gen_random_uuid(),
  rmi."id",
  rmi."purchase_receipt_id",
  rmi."order_no",
  rmi."purchase_order_id",
  rmi."purchase_order_item_id",
  rmi."supplier_id",
  rmi."quantity",
  COALESCE(rmi."settlement_unit_price", poi."unit_price"),
  po."currency",
  poi."tax_rate",
  COALESCE(
    rmi."settlement_total_amount",
    ROUND(rmi."quantity" * COALESCE(rmi."settlement_unit_price", poi."unit_price"), 4)
  ),
  'pending_finance',
  'inbound:' || rmi."id",
  NOW(),
  NOW(),
  rmi."created_by",
  rmi."created_by"
FROM "raw_material_inbounds" rmi
JOIN "purchase_order_items" poi ON poi."id" = rmi."purchase_order_item_id"
JOIN "purchase_orders" po ON po."id" = rmi."purchase_order_id"
WHERE rmi."deleted_at" IS NULL
  AND rmi."status" = 'posted'
  AND NOT EXISTS (
    SELECT 1 FROM "payable_sources" ps WHERE ps."raw_material_inbound_id" = rmi."id"
  );
