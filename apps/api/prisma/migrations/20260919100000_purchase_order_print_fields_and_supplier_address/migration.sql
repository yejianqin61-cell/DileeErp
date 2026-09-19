-- 采购订单打印表要用的字段 + 供应商地址（用户 2026-09-16）。
--
-- 用户三条：
--   1)「供应商，需要多一个字段，地址」→ suppliers.address；
--   2)「需要允许导出 excel 采购单出来…采购单里面要有 订单号、供应商名称、供应商联系人、采购人、
--      操作人、下单录入的时间、操作时间、备注、序号、产品名称、规格型号、数量、含税单价、总价、
--      交货日期、付款方式、交期条款、交货地址、厂家回签意见、厂家回签、主管签字」；
--   3)「对应的，系统中采购单，也要支持对这些字段进行填写和设置」。
--
-- 其中原本没有落点的六项：付款方式 / 交期条款 / 交货地址 / 厂家回签意见 / 厂家回签 / 主管签字。
-- 全部可空（历史采购单没有这些字，不能因为加列变成「必须补填」），也都不加索引：
-- 它们只被打印与人工查看，没有按它们筛选的场景。
--
-- 为什么不塞进已有的 extension_data（JSON）：这六项要在采购单页面上直接编辑、要被打印表逐格读取、
-- 还要能被审计与查询（「哪些单还没填付款方式」）。JSON 三样都做不到，字段一多就变成一坨看不见的数据。
--
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- AlterTable：供应商地址
ALTER TABLE "suppliers" ADD COLUMN "address" VARCHAR(300);

-- AlterTable：采购订单打印字段（与明细/金额无关，下单之后仍可填写，见 schema.prisma 的注释）
ALTER TABLE "purchase_orders" ADD COLUMN "payment_terms" VARCHAR(50);
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_terms" VARCHAR(1000);
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_address" VARCHAR(300);
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_reply" VARCHAR(1000);
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_signed" VARCHAR(200);
ALTER TABLE "purchase_orders" ADD COLUMN "supervisor_signature" VARCHAR(200);
