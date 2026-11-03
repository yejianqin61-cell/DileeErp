// 孤立单据（销售单删除后留下的下游单据）—— 清单/计数/汇总的单元测试。
//
// 用户 2026-11-03：「销售单能删除，相对应的采购单及其后续绑定的单据不删除而是显示孤立单据」。
// 这里的断言钉住三件事：
//   1. **同一张 11 类清单**：删除预览与汇总页看到的类型与顺序一致（两处各写一份必然漂移）；
//   2. **孤立 = 父单被软删**：下游单据一行都不改，所以判定只看 `salesOrder.deletedAt`；
//   3. **计数不被展示上限截断**：`documents` 有上限，`totals.documents` 必须是真实总数。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { ORPHAN_DOCUMENT_TYPES, countOrphanDocuments, summarizeOrphanDocuments } = require("../../dist/modules/sales/orphan-documents.js");

/** 汇总键 → Prisma 委托名（就是 schema 里模型名的首字母小写，逐条写出来比推导好读）。 */
const DELEGATE = {
  bom: "bom",
  purchase_plan: "purchasePlan",
  purchase_order: "purchaseOrder",
  production_order: "productionOrder",
  finished_goods_outbound: "finishedGoodsOutbound",
  finished_goods_outbound_notice: "finishedGoodsOutboundNotice",
  customer_return: "customerReturn",
  receivable_source: "receivableSource",
  customer_payment: "customerPayment",
  receivable_adjustment: "receivableAdjustment",
  receivable_reconciliation: "receivableReconciliation",
};

/** 假只读 client：每个委托只实现本文件真正用到的三个方法。 */
function fakeClient({ counts = {}, groups = {}, rows = {}, deletedOrders = [], users = [] } = {}) {
  const client = {
    salesOrder: { findMany: async () => deletedOrders },
    user: { findMany: async () => users },
  };
  for (const { key } of ORPHAN_DOCUMENT_TYPES) {
    client[DELEGATE[key]] = {
      count: async () => counts[key] ?? 0,
      groupBy: async () => groups[key] ?? [],
      findMany: async ({ take } = {}) => (rows[key] ?? []).slice(0, typeof take === "number" ? take : undefined),
    };
  }
  return client;
}

test("countOrphanDocuments：只列有单的类型，顺序与清单一致，总数是各类之和", async () => {
  const { items, total } = await countOrphanDocuments(fakeClient({ counts: { purchase_order: 2, receivable_source: 1 } }), "order-1");
  assert.deepEqual(items, [
    { key: "purchase_order", label: "采购单", count: 2 },
    { key: "receivable_source", label: "应收来源", count: 1 },
  ]);
  assert.equal(total, 3);
});

test("countOrphanDocuments：11 类全为 0 时返回空清单（弹窗里不铺 11 行 0）", async () => {
  const { items, total } = await countOrphanDocuments(fakeClient(), "order-1");
  assert.deepEqual(items, []);
  assert.equal(total, 0);
});

test("summarizeOrphanDocuments：没有已删销售单时返回空结果，不查下游表", async () => {
  let queried = false;
  const client = fakeClient();
  client.purchaseOrder.findMany = async () => { queried = true; return []; };
  const summary = await summarizeOrphanDocuments(client);
  assert.deepEqual(summary, { orders: [], documents: [], by_type: [], totals: { orders: 0, documents: 0 }, truncated: false });
  assert.equal(queried, false, "没有已删销售单就不该去数 11 张表");
});

test("summarizeOrphanDocuments：按被删销售单分组，附删除人与各类张数", async () => {
  const deletedAt = new Date("2026-11-03T02:00:00.000Z");
  const client = fakeClient({
    deletedOrders: [{ id: "order-1", orderNo: "DL260170", status: "confirmed", deletedAt, deletedBy: "user-1" }],
    users: [{ id: "user-1", displayName: "张三" }],
    groups: { purchase_order: [{ salesOrderId: "order-1", _count: { _all: 2 } }] },
    rows: {
      purchase_order: [
        { id: "po-1", purchaseOrderNo: "CG-1", orderNo: "DL260170", status: "ordered", totalAmount: new Prisma.Decimal("1200"), currency: "CNY", createdAt: new Date("2026-10-02T00:00:00.000Z"), salesOrderId: "order-1" },
        { id: "po-2", purchaseOrderNo: "CG-2", orderNo: "DL260170", status: "partially_arrived", totalAmount: new Prisma.Decimal("300.5"), currency: "CNY", createdAt: new Date("2026-10-03T00:00:00.000Z"), salesOrderId: "order-1" },
      ],
    },
  });
  const summary = await summarizeOrphanDocuments(client);
  assert.equal(summary.orders.length, 1);
  assert.equal(summary.orders[0].order_no, "DL260170");
  assert.equal(summary.orders[0].deleted_by_name, "张三", "界面不能显示 UUID");
  assert.deepEqual(summary.orders[0].documents, [{ key: "purchase_order", label: "采购单", count: 2 }]);
  assert.equal(summary.orders[0].document_total, 2);
  assert.deepEqual(summary.by_type, [{ key: "purchase_order", label: "采购单", count: 2 }]);
  assert.deepEqual(summary.totals, { orders: 1, documents: 2 });
  // 明细行带着原单号（用户要能看见它原来属于哪张已删的单），金额按四位小数归一。
  assert.deepEqual(summary.documents.map((row) => row.document_no), ["CG-2", "CG-1"], "按发生时间倒序");
  assert.equal(summary.documents[0].amount, "300.5000");
  assert.equal(summary.documents[0].order_no, "DL260170");
  assert.equal(summary.truncated, false);
});

test("summarizeOrphanDocuments：展示上限截断明细，但 totals.documents 仍是真实总数", async () => {
  const client = fakeClient({
    deletedOrders: [{ id: "order-1", orderNo: "DL-1", status: "closed", deletedAt: new Date(), deletedBy: null }],
    groups: { receivable_source: [{ salesOrderId: "order-1", _count: { _all: 5 } }] },
    rows: {
      receivable_source: Array.from({ length: 5 }, (_, index) => ({
        id: `ar-${index}`, sourceNo: `AR-${index}`, orderNo: "DL-1", status: "confirmed",
        amount: new Prisma.Decimal("10"), currency: "CNY", createdAt: new Date(2026, 0, index + 1), salesOrderId: "order-1",
      })),
    },
  });
  const summary = await summarizeOrphanDocuments(client, 3);
  assert.equal(summary.documents.length, 3, "明细按上限截断");
  assert.equal(summary.totals.documents, 5, "总数必须是真实总数，不是截断后的条数");
  assert.equal(summary.orders[0].deleted_by_name, null, "查不到姓名补 null，绝不回落到 UUID");
  assert.equal(summary.truncated, true);
});
