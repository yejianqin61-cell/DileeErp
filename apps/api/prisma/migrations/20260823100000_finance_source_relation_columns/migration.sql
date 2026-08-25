ALTER TABLE "supplier_payable_entries"
  ADD COLUMN "purchase_order_id" UUID,
  ADD COLUMN "purchase_order_item_id" UUID,
  ADD COLUMN "outsource_logistics_batch_id" UUID;

ALTER TABLE "customer_payments"
  ADD COLUMN "sales_order_id" UUID;

CREATE INDEX "supplier_payable_entries_purchase_order_id_idx" ON "supplier_payable_entries"("purchase_order_id");
CREATE INDEX "supplier_payable_entries_purchase_order_item_id_idx" ON "supplier_payable_entries"("purchase_order_item_id");
CREATE INDEX "supplier_payable_entries_outsource_logistics_batch_id_idx" ON "supplier_payable_entries"("outsource_logistics_batch_id");
CREATE INDEX "customer_payments_sales_order_id_idx" ON "customer_payments"("sales_order_id");

ALTER TABLE "supplier_payable_entries"
  ADD CONSTRAINT "supplier_payable_entries_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_payable_entries_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_payable_entries_outsource_logistics_batch_id_fkey" FOREIGN KEY ("outsource_logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
