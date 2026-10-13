// 「同一供应商的后续下单**追加进同一张采购单**」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-10-13：「如果相同的供应商的不同物料没有同时下单，下单之后也要自动收束在一个采购单里」。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的
//           findMergeTarget / appendItems / openOrdersForPlan
// 入口：POST /api/v1/purchase-plans/:id/order（采购计划收束下单，见 purchase-plans.service.ts）
// 设计依据：docs/design/purchase-plan-split-order-and-flat-list-2026-10-13.md（口径 1~4）
//
// 本文件逐条钉住"什么算可并入"这条不变式 —— 它是这个功能最容易被改坏的地方：
//   1. **认据是计划行回写的采购明细 id**，不是供应商。按供应商猜会把别人手工建的同供应商单吞进来；
//   2. 供应商与**币种**都要对得上（一张单一个供应商、一个币种；币种错了财务会收到
//      "单价是美元、单头写着人民币"的单，而全链路不报错）；
//   3. 状态要是 `ordered`，且**任一未删明细都不能有到货记录** —— 到货是既成事实，
//      后面挂着质检、入库与应付来源。而且这条要看**明细的到货记录**，不能只看状态：
//      `receipt()`（V1）登记到货时不刷单头状态；
//   4. 追加**只往后加**：单号、供应商、币种、采购日期、打印字段一概不动，只有 `total_amount` 累加；
//   5. 多条候选取**最近建的那一张**（=上一波下的那单）；
//   6. 任何一条不满足 → 返回 null，调用方新建一张（**不在**这里抛错，因为"不能并"是正常业务）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const user = { id: "user-1" };

/** 一条采购明细（`deletedAt: null` = 未删；`receipts` 空数组 = 没有任何到货事实）。 */
const poItem = (id, extra = {}) => ({ id, deletedAt: null, receipts: [], ...extra });

/** 一张采购单。默认：已下单、人民币、无到货、明细里有 poi-old（被计划行回写过链接）。 */
const po = (id, overrides = {}) => ({
  id,
  purchaseOrderNo: `PO-${id}`,
  orderNo: "SO-1",
  bomId: "bom-1",
  supplierId: "sup-1",
  currency: "CNY",
  status: "ordered",
  totalAmount: new Prisma.Decimal("17.5000"),
  extensionData: {},
  deletedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  items: [poItem("poi-old")],
  ...overrides,
});

function makeService({ orders = [] } = {}) {
  const writes = { created: [], updated: [] };
  let sequence = 0;
  // 假 Prisma **按 where 真的过滤**：本文件要验证的正是那几条判据，
  // 一个恒返回全部数据的桩会把断言变成永远通过。
  const rows = orders.map((row) => ({ ...row }));
  const project = (row) => ({
    id: row.id,
    purchaseOrderNo: row.purchaseOrderNo,
    supplierId: row.supplierId,
    currency: row.currency,
    totalAmount: row.totalAmount,
    createdAt: row.createdAt,
    items: row.items.filter((item) => item.deletedAt === null).map((item) => ({ id: item.id, receipts: item.receipts ?? [] })),
  });
  const prisma = {
    purchaseOrder: {
      findMany: async ({ where }) => rows
        .filter((row) => row.deletedAt === null && row.status === where.status
          && (!where.orderNo || row.orderNo === where.orderNo)
          && (!where.bomId || row.bomId === where.bomId)
          && (!where.items?.some?.id?.in || row.items.some((item) => item.deletedAt === null && where.items.some.id.in.includes(item.id))))
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(project),
      findFirst: async ({ where }) => rows.find((row) => row.id === where.id && row.deletedAt === null) ?? null,
      update: async ({ where, data }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        writes.updated.push({ where, data });
        Object.assign(row, data);
        // 真 Prisma 的金额列读出来是 Decimal（服务里会 `.toFixed(4)`），桩要一样。
        row.totalAmount = new Prisma.Decimal(row.totalAmount);
        return row;
      },
    },
    purchaseOrderItem: {
      create: async ({ data }) => {
        sequence += 1;
        const row = { id: `poi-new-${sequence}`, ...data };
        writes.created.push(row);
        return { id: row.id, extensionData: row.extensionData, materialId: row.materialId, quantity: row.quantity, unitPrice: row.unitPrice };
      },
      findMany: async () => [],
    },
    $transaction: async (fn) => fn(prisma),
  };
  const service = new PurchaseOrdersService(prisma, {
    create: (actor) => ({ createdBy: actor.id }),
    update: (actor) => ({ updatedBy: actor.id }),
    record: async () => undefined,
  });
  return { service, prisma, rows, writes };
}

/** 一组的落库形状（真实的 `collectGroups()` 产出；这里手搓，把校验与查询分开测）。 */
function mergedGroup({ currency = "CNY", supplierId = "sup-1", items, plan = { plan_id: "plan-1", plan_no: "PP-1" } } = {}) {
  const lines = items ?? [{ material_id: "mat-1", unit_id: "unit-1", supplier_id: supplierId, quantity: "3.0000", unit_price: "4.0000", extension_data: { purchase_plan_item_id: "i-2" } }];
  return {
    input: { order_no: "SO-1", bom_id: "bom-1", supplier_id: supplierId, currency, extension_data: plan ? { purchase_plan: plan } : {}, items: lines },
    prepared: {
      refs: {
        order: { id: "so-1", orderNo: "SO-1" },
        bom: { id: "bom-1", version: 1 },
        supplier: undefined,
        supplierMap: new Map(),
        materials: new Map([["mat-1", { id: "mat-1", materialCode: "M-1", name: "面料" }]]),
        units: new Map([["unit-1", { id: "unit-1", name: "米" }]]),
        items: lines,
      },
      items: lines,
      total: "12.0000",
    },
  };
}

const codeOf = (error) => error.getResponse().code;
const query = { orderNo: "SO-1", bomId: "bom-1", supplierId: "sup-1", currency: "CNY", linkedOrderItemIds: ["poi-old"] };

// ---------------------------------------------------------------------------------------------
// findMergeTarget：什么算「可以并入」

test("并入判据：同计划认领 + 同供应商 + 同币种 + 已下单 + 无到货 → 就是这一张", async () => {
  const { service, prisma } = makeService({ orders: [po("po-1")] });

  const target = await service.findMergeTarget(prisma, query);

  assert.deepEqual(target, { id: "po-1", purchaseOrderNo: "PO-po-1" });
});

test("并入判据：认据是**计划行回写的采购明细 id** —— 认不到就不并（不按供应商猜）", async () => {
  // 这张单是别人手工给同一家供应商建的：明细里没有本计划行认领的那条。
  const { service, prisma } = makeService({ orders: [po("po-1", { items: [poItem("poi-someone-else")] })] });

  assert.equal(await service.findMergeTarget(prisma, query), null, "吞掉别人的单不会当场报错，只会让两张单悄悄长在一起");
  assert.equal(await service.findMergeTarget(prisma, { ...query, linkedOrderItemIds: [] }), null, "计划一行都没下过时更不该问");
});

test("并入判据：币种不同不并（一张单只能有一个币种）", async () => {
  const { service, prisma } = makeService({ orders: [po("po-1")] });

  assert.equal(await service.findMergeTarget(prisma, { ...query, currency: "USD" }), null, "库里只有人民币那张，美元的钱不能并进去");
  assert.deepEqual(await service.findMergeTarget(prisma, query), { id: "po-1", purchaseOrderNo: "PO-po-1" }, "币种一致才并");
});

test("并入判据：供应商不同不并", async () => {
  const { service, prisma } = makeService({ orders: [po("po-1", { supplierId: "sup-2" })] });

  assert.equal(await service.findMergeTarget(prisma, query), null);
});

test("并入判据：状态不是已下单不并（草稿/部分到货/到货完成/已取消）", async () => {
  for (const status of ["draft", "partially_arrived", "arrived_complete", "cancelled"]) {
    const { service, prisma } = makeService({ orders: [po("po-1", { status })] });
    assert.equal(await service.findMergeTarget(prisma, query), null, `${status} 不该被并`);
  }
});

test("并入判据：**已下单但已经有到货记录**的不并 —— 按明细的到货判，不能只看状态", async () => {
  // `receipt()`（V1）登记到货时**不刷单头状态**，所以库里真的存在「status 还是 ordered、
  // 明细却有到货」的单。只看状态会把货已经收过的单当成可并的。
  const receipted = po("po-1", { items: [poItem("poi-old", { receipts: [{ id: "gr-1" }] })] });
  const { service, prisma } = makeService({ orders: [receipted] });

  assert.equal(await service.findMergeTarget(prisma, query), null);
});

test("并入判据：多条候选取**最近建的那一张**（上一波下的那单）", async () => {
  const older = po("po-old", { createdAt: new Date("2026-09-01T00:00:00Z"), items: [poItem("poi-old")] });
  const newer = po("po-new", { createdAt: new Date("2026-10-10T00:00:00Z"), items: [poItem("poi-last")] });
  const { service, prisma } = makeService({ orders: [older, newer] });

  assert.deepEqual(await service.findMergeTarget(prisma, { ...query, linkedOrderItemIds: ["poi-old", "poi-last"] }), { id: "po-new", purchaseOrderNo: "PO-po-new" });
});

test("并入判据：最近那张已经有到货 → 落到**仍然未到货的更早那张**（到货的那张不再收新料）", async () => {
  // 口径 1 的候选是"已下单 + 无任何到货"的那些，取其中最近建的一张。
  // 所以"上一波那张已经收货了"不等于"这家不能收了" —— 更早那张如果还没到货，它仍然是
  // 一张**对外有效、未收货**的单，往里追新料是它本来就该承担的事；而已收货的那张不再动。
  const older = po("po-old", { createdAt: new Date("2026-09-01T00:00:00Z"), items: [poItem("poi-old")] });
  const newer = po("po-new", { createdAt: new Date("2026-10-10T00:00:00Z"), items: [poItem("poi-last", { receipts: [{ id: "gr-1" }] })] });
  const { service, prisma } = makeService({ orders: [older, newer] });

  assert.deepEqual(
    await service.findMergeTarget(prisma, { ...query, linkedOrderItemIds: ["poi-old", "poi-last"] }),
    { id: "po-old", purchaseOrderNo: "PO-po-old" },
  );
});

test("并入判据：**所有**候选都已经到货 → 不并，交给调用方新建一张", async () => {
  const first = po("po-1", { items: [poItem("poi-old", { receipts: [{ id: "gr-1" }] })] });
  const second = po("po-2", { createdAt: new Date("2026-10-10T00:00:00Z"), items: [poItem("poi-last", { receipts: [{ id: "gr-2" }] })] });
  const { service, prisma } = makeService({ orders: [first, second] });

  assert.equal(await service.findMergeTarget(prisma, { ...query, linkedOrderItemIds: ["poi-old", "poi-last"] }), null);
});

// ---------------------------------------------------------------------------------------------
// appendItems：只往后加

test("追加：只建这一波的明细，单头金额累加，别的字段一根不动", async () => {
  const { service, prisma, rows, writes } = makeService({ orders: [po("po-1")] });

  const result = await service.appendItems(prisma, "po-1", mergedGroup(), user);

  assert.equal(writes.created.length, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items.map((item) => item.id), ["poi-new-1"]);
  assert.equal(writes.created[0].purchaseOrderId, "po-1", "追加到那张单上，不是新建一张");
  assert.equal(writes.created[0].quantity, "3.0000");
  assert.equal(writes.created[0].unitPrice, "4.0000");
  assert.equal(writes.created[0].amount, "12.0000");
  assert.equal(rows[0].items.length, 1, "假 Prisma 的 items 只是被读，真正的行由 purchaseOrderItem.create 写");

  // 头部：只有金额与留痕动了
  const header = writes.updated[0].data;
  assert.equal(header.totalAmount, "29.5000", "17.5（原来）+ 12（这一波）");
  assert.equal(header.updatedBy, "user-1");
  assert.deepEqual(Object.keys(header).sort(), ["extensionData", "totalAmount", "updatedBy"], "采购日期/交货日期/备注/打印字段一概不碰");
  assert.equal(result.order.totalAmount.toFixed(4), "29.5000", "返回的是累加后的单头（前端提示要用）");
  assert.equal(result.order.purchaseOrderNo, "PO-po-1", "单号不变 —— 这是「收束」而不是「重开一张」");
});

test("追加：单头留下「哪份计划、哪一波、几行」的痕迹（口径 4）", async () => {
  const { service, prisma, writes } = makeService({ orders: [po("po-1", { extensionData: { payment_terms: "月结 30 天" } })] });

  await service.appendItems(prisma, "po-1", mergedGroup(), user);

  const trace = writes.updated[0].data.extensionData;
  assert.equal(trace.payment_terms, "月结 30 天", "已有的扩展数据不能被覆盖掉");
  assert.deepEqual(trace.purchase_plan_merges.map((row) => [row.plan_no, row.plan_id, row.line_count, row.amount]), [["PP-1", "plan-1", 1, "12.0000"]]);
});

test("追加：留痕只保留最近 20 条（采购单是长期存在的，单头 JSON 不能无限长）", async () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ at: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, plan_no: `PP-${index}` }));
  const { service, prisma, writes } = makeService({ orders: [po("po-1", { extensionData: { purchase_plan_merges: history } })] });

  await service.appendItems(prisma, "po-1", mergedGroup(), user);

  const merges = writes.updated[0].data.extensionData.purchase_plan_merges;
  assert.equal(merges.length, 20);
  assert.equal(merges[0].plan_no, "PP-1", "最老的那条被挤掉");
  assert.equal(merges[19].plan_no, "PP-1");
});

test("追加：状态不是已下单 / 有到货 → 422 `PURCHASE_ORDER_NOT_APPENDABLE`，一行都不写", async () => {
  for (const [label, order] of [
    ["部分到货", po("po-1", { status: "partially_arrived" })],
    ["到货完成", po("po-1", { status: "arrived_complete" })],
    ["已取消", po("po-1", { status: "cancelled" })],
    ["状态没刷新的已到货", po("po-1", { items: [poItem("poi-old", { receipts: [{ id: "gr-1" }] })] })],
  ]) {
    const { service, prisma, writes } = makeService({ orders: [order] });
    await assert.rejects(() => service.appendItems(prisma, "po-1", mergedGroup(), user), (error) => codeOf(error) === "PURCHASE_ORDER_NOT_APPENDABLE", label);
    assert.equal(writes.created.length, 0, `${label}：校验在任何写入之前`);
    assert.equal(writes.updated.length, 0);
  }
});

test("追加：币种不一致 → 422 `PURCHASE_ORDER_CURRENCY_MISMATCH`（不静默改成单头那个币种）", async () => {
  const { service, prisma, writes } = makeService({ orders: [po("po-1", { currency: "CNY" })] });

  await assert.rejects(
    () => service.appendItems(prisma, "po-1", mergedGroup({ currency: "USD" }), user),
    (error) => codeOf(error) === "PURCHASE_ORDER_CURRENCY_MISMATCH" && /币种/.test(error.getResponse().message),
  );
  assert.equal(writes.created.length, 0);
});

test("追加：单不存在 → 404（不悄悄新建一张）", async () => {
  const { service, prisma } = makeService({ orders: [] });

  await assert.rejects(() => service.appendItems(prisma, "po-missing", mergedGroup(), user), (error) => codeOf(error) === "PURCHASE_ORDER_NOT_FOUND");
});

// ---------------------------------------------------------------------------------------------
// openOrdersForPlan：详情接口按它把「这一组会并到哪张单」写给用户看

test("可并入一览：带上供应商/币种/行数/金额，前端才写得清「并入 PO-xxx（已有 N 行）」", async () => {
  const { service } = makeService({ orders: [po("po-1", { totalAmount: new Prisma.Decimal("29.5000") })] });

  const open = await service.openOrdersForPlan(query);

  assert.deepEqual(open, [{ id: "po-1", purchaseOrderNo: "PO-po-1", supplierId: "sup-1", currency: "CNY", itemCount: 1, totalAmount: "29.5000" }]);
});

test("可并入一览：有到货的、没被本计划认领的、别的单号的都不列（与下单时同一段查询）", async () => {
  const receipted = po("po-receipted", { items: [poItem("poi-old", { receipts: [{ id: "gr-1" }] })] });
  const foreign = po("po-foreign", { items: [poItem("poi-someone-else")] });
  const otherOrder = po("po-other-order", { orderNo: "SO-2" });
  const { service } = makeService({ orders: [receipted, foreign, otherOrder] });

  assert.deepEqual(await service.openOrdersForPlan(query), []);
  assert.deepEqual(await service.openOrdersForPlan({ ...query, linkedOrderItemIds: [] }), [], "没有已下单行就不用查");
});
