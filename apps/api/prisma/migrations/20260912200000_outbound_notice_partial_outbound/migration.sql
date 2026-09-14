-- 成品出库改为支持分批（客户确认：出库数量可 ≤ 当前可用量，剩余库存可再出库）。
-- 出库通知也从「一对一、必须整批」改为「一对多、可分批出库到发完」：
--   1) 出库单新增 outbound_notice_id 指向来源通知（nullable，多张出库单可挂同一张通知）；
--   2) 通知新增 shipped_quantity 累计已过账出库量；
--   3) 去掉通知上的 outbound_id（一对一）列，先回填再删除，保证历史数据不丢关联。

ALTER TABLE "finished_goods_outbounds" ADD COLUMN "outbound_notice_id" UUID;
CREATE INDEX "finished_goods_outbounds_outbound_notice_id_idx" ON "finished_goods_outbounds"("outbound_notice_id");
ALTER TABLE "finished_goods_outbounds" ADD CONSTRAINT "finished_goods_outbounds_outbound_notice_id_fkey" FOREIGN KEY ("outbound_notice_id") REFERENCES "finished_goods_outbound_notices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 回填历史关联：原来挂在通知上的出库单，现在反挂到出库单侧。
UPDATE "finished_goods_outbounds" AS o
SET "outbound_notice_id" = n."id"
FROM "finished_goods_outbound_notices" AS n
WHERE n."outbound_id" = o."id";

ALTER TABLE "finished_goods_outbound_notices" ADD COLUMN "shipped_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- 已过账/已发出/已签收的部分计入已出库量；草稿与已冲销不计。
UPDATE "finished_goods_outbound_notices" AS n
SET "shipped_quantity" = COALESCE((
  SELECT SUM(o."quantity")
  FROM "finished_goods_outbounds" AS o
  WHERE o."outbound_notice_id" = n."id"
    AND o."deleted_at" IS NULL
    AND o."status" IN ('posted', 'shipped', 'signed')
), 0);

DROP INDEX IF EXISTS "finished_goods_outbound_notices_outbound_id_key";
ALTER TABLE "finished_goods_outbound_notices" DROP CONSTRAINT IF EXISTS "finished_goods_outbound_notices_outbound_id_fkey";
ALTER TABLE "finished_goods_outbound_notices" DROP COLUMN "outbound_id";
