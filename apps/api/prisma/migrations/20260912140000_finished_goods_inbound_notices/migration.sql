-- 成品入库通知（分批入库）：包装工序（工序名称含“包装”）作为每个生产单的收尾工序，
-- 其累计报工量即可通知入库的数量；生产可分批手动发通知，仓库再按通知送检/QC 并办理成品入库。
-- 本迁移只新增通知单表及其索引/外键，不改动既有成品入库、QC、库存表。
CREATE TABLE "finished_goods_inbound_notices" (
    "id" UUID NOT NULL,
    "notice_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "production_order_no_snapshot" VARCHAR(100) NOT NULL,
    "operation_name_snapshot" VARCHAR(150) NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "unit_id" UUID NOT NULL,
    "unit_name_snapshot" VARCHAR(30) NOT NULL,
    "notice_quantity" DECIMAL(18,4) NOT NULL,
    "notice_date" DATE NOT NULL,
    "batch_no" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "finished_goods_inbound_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finished_goods_inbound_notices_notice_no_key" ON "finished_goods_inbound_notices"("notice_no");
CREATE UNIQUE INDEX "finished_goods_inbound_notices_idempotency_key_key" ON "finished_goods_inbound_notices"("idempotency_key");
CREATE INDEX "finished_goods_inbound_notices_order_no_status_idx" ON "finished_goods_inbound_notices"("order_no", "status");
CREATE INDEX "finished_goods_inbound_notices_production_order_id_status_idx" ON "finished_goods_inbound_notices"("production_order_id", "status");
CREATE INDEX "finished_goods_inbound_notices_production_order_operation_id_status_idx" ON "finished_goods_inbound_notices"("production_order_operation_id", "status");

ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
