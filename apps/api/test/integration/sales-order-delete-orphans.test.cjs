// 销售单删除 → 下游单据保留为「孤立单据」的集成测试（需要 TEST_DATABASE_URL）。
//
// 用户 2026-11-03：「销售单能删除，相对应的采购单及其后续绑定的单据不删除而是显示孤立单据」。
//
// 这个文件钉住的是**删除动作本身不碰下游行**这一条（单元测试只能钉住"没有写删除代码"，
// 钉不住"真实 Postgres 上外键与触发器会怎么反应"）：
//   1. 删完销售单后，采购单行还在、`sales_order_id` 没被解绑、`order_no` 没变；
//   2. 采购单列表把它标成 `orphaned: true`，汇总接口能列出它；
//   3. 单号联动守护（文本 join ≡ id join）仍然成立 —— 孤立不是外键丢失。
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { SalesOrdersService } = require("../../dist/modules/sales/sales-orders.service.js");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
const audit = new AuditService(prisma);
const orders = new SalesOrdersService(prisma, audit);
const purchasing = new PurchaseOrdersService(prisma, audit);

let fixtures = [];
after(async () => {
  // 删单后的清理：工厂按 id 删登记项，软删的销售单也在登记表里，不会被漏掉。
  for (const fx of fixtures) await fx.cleanup();
  await prisma.$disconnect();
});

test("删销售单：预览→原因守卫→软删→采购单保留并标记孤立→汇总可查→联动守护仍成立", async () => {
  const fx = createFactories({ prisma, prefix: "orphan" });
  fixtures.push(fx);
  const chain = await fx.procurementChain();
  const user = fx.actor();
  // 采购单列表只收「已过供应商收束下单」的状态（草稿不进列表），夹具默认是 draft，这里提到 ordered。
  await prisma.purchaseOrder.update({ where: { id: chain.purchaseOrder.id }, data: { status: "ordered" } });

  // 1. 预览：已确认单必须填原因，且列出会留下的采购单（procurementChain 建了 BOM + 采购单）。
  const preview = await orders.deletePreview(chain.salesOrder.id);
  assert.equal(preview.status, "confirmed");
  assert.equal(preview.reason_required, true);
  assert.ok(preview.downstream.some((item) => item.key === "purchase_order" && item.count >= 1), "预览必须列出采购单");

  // 2. 非草稿不填原因 → 422，且什么都没写。
  await assert.rejects(
    () => orders.delete(chain.salesOrder.id, user),
    (error) => error.getResponse().code === "SALES_ORDER_DELETE_REASON_REQUIRED",
  );
  assert.equal((await prisma.salesOrder.findUnique({ where: { id: chain.salesOrder.id } })).deletedAt, null);

  // 3. 填原因 → 软删。
  const deleted = await orders.delete(chain.salesOrder.id, user, "客户取消整单");
  assert.ok(deleted.deletedAt instanceof Date);

  // 4. 下游采购单一行未动：在、没软删、外键没解绑、单号没变。
  const po = await prisma.purchaseOrder.findUnique({ where: { id: chain.purchaseOrder.id } });
  assert.ok(po, "采购单必须还在（不级联删除）");
  assert.equal(po.deletedAt, null);
  assert.equal(po.salesOrderId, chain.salesOrder.id, "外键不能被解绑（孤立是读出来的，不是写进去的）");
  assert.equal(po.orderNo, chain.salesOrder.orderNo);

  // 5. 销售单从列表消失。
  const active = await orders.list(1, 200);
  assert.ok(!active.data.some((order) => order.id === chain.salesOrder.id), "软删的销售单不再出现在销售单列表");

  // 6. 采购单列表标出孤立。
  const listed = await purchasing.list();
  const row = listed.find((item) => item.id === chain.purchaseOrder.id);
  assert.ok(row, "采购单仍在采购单列表里");
  assert.equal(row.orphaned, true);

  // 7. 汇总接口：按被删销售单分组，明细里能看见采购单号。
  const summary = await orders.orphans();
  const group = summary.orders.find((item) => item.sales_order_id === chain.salesOrder.id);
  assert.ok(group, "汇总接口必须列出这张被删的销售单");
  assert.ok(group.documents.some((item) => item.key === "purchase_order" && item.count >= 1));
  assert.ok(
    summary.documents.some((item) => item.type === "purchase_order" && item.document_no === chain.purchaseOrder.purchaseOrderNo),
    "明细里必须有这张采购单的单号",
  );

  // 8. 单号联动守护仍然成立：孤立单据的外键仍指向同一张销售单、单号文本仍一致。
  const [linkage] = await prisma.$queryRawUnsafe(
    `SELECT count(*) FILTER (
              WHERE x.sales_order_id IS NOT NULL
                AND x.order_no IS DISTINCT FROM (SELECT s.order_no FROM sales_orders s WHERE s.id = x.sales_order_id)
            )::int AS mismatched,
            count(*) FILTER (
              WHERE x.order_no IS NOT NULL AND x.order_no <> '' AND x.sales_order_id IS NULL
            )::int AS orphan
       FROM purchase_orders x`,
  );
  assert.equal(linkage.mismatched, 0, "文本单号与外键指向的销售单必须一致");
  assert.equal(linkage.orphan, 0, "孤立不是「外键为空」：软删的销售单仍在库里");

  // 9. 再删一次 → 404（已删的销售单不能再删）。
  await assert.rejects(() => orders.delete(chain.salesOrder.id, user, "重复删除"), (error) => error.getResponse().code === "SALES_ORDER_NOT_FOUND");
});

test("删草稿：仍然一键删、不需要原因", async () => {
  const fx = createFactories({ prisma, prefix: "orphan-draft" });
  fixtures.push(fx);
  const chain = await fx.procurementChain();
  await prisma.salesOrder.update({ where: { id: chain.salesOrder.id }, data: { status: "draft" } });
  const preview = await orders.deletePreview(chain.salesOrder.id);
  assert.equal(preview.reason_required, false);
  const deleted = await orders.delete(chain.salesOrder.id, fx.actor());
  assert.ok(deleted.deletedAt instanceof Date);
});
