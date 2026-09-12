-- 成品出库通知：成品入库后由销售通知仓库发货（寄给客户），仓库据此生成整批出库单。
CREATE TABLE "finished_goods_outbound_notices" (
    "id" UUID NOT NULL,
    "notice_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "unit_id" UUID NOT NULL,
    "unit_name_snapshot" VARCHAR(30),
    "inbound_quantity" DECIMAL(18,4) NOT NULL,
    "outbound_quantity" DECIMAL(18,4) NOT NULL,
    "notice_quantity" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "outbound_id" UUID,
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_by" UUID NOT NULL,
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_outbound_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finished_goods_outbound_notices_notice_no_key" ON "finished_goods_outbound_notices"("notice_no");
CREATE UNIQUE INDEX "finished_goods_outbound_notices_outbound_id_key" ON "finished_goods_outbound_notices"("outbound_id");
CREATE UNIQUE INDEX "finished_goods_outbound_notices_idempotency_key_key" ON "finished_goods_outbound_notices"("idempotency_key");
CREATE INDEX "finished_goods_outbound_notices_order_no_status_idx" ON "finished_goods_outbound_notices"("order_no", "status");
CREATE INDEX "finished_goods_outbound_notices_sales_order_id_status_idx" ON "finished_goods_outbound_notices"("sales_order_id", "status");
CREATE INDEX "finished_goods_outbound_notices_production_order_id_status_idx" ON "finished_goods_outbound_notices"("production_order_id", "status");

ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "finished_goods_outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
