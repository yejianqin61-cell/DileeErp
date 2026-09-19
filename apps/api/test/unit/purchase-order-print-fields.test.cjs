// 采购单「打印信息」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-16：「采购单里面要有…付款方式、交期条款、交货地址、厂家回签意见、厂家回签、主管签字」
// 「对应的，系统中采购单，也要支持对这些字段进行填写和设置」。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 updatePrintFields
// 入口：PATCH /api/v1/purchase-orders/:id/print-fields（purchase-orders.controller.ts）
//
// 本文件钉住的核心约定：
//   1. **下单之后仍然能填**：`PATCH :id` 只允许草稿（有下游事实就整体锁死），而厂家回签是下单之后
//      才发生的事，所以打印信息走单独的入口，草稿 / 已下单 / 部分到货 / 到货完成都可以填；
//   2. 只碰这些字：**不动 items / totalAmount / status / supplierId**；
//   3. 空串（或纯空白）按「清除这一格」处理（表单里删空一格 = 这一格不印字）；
//   4. 没传的字段不动（不能因为界面只改了付款方式就把交货地址清掉）；
//   5. 已取消的采购单拒绝（它不再对外），不存在 → 404，且都写审计。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const audit = { create: () => ({}), update: (user) => ({ updatedBy: user.id }), record: async () => {} };

/**
 * 组装服务。
 *
 * `status` 用参数控制：这是本文件最要紧的一维（下单之后还能不能填）。
 * `get()` 在 update 之前不会被调用（updatePrintFields 自己只查一次），所以这里给一个直接的桩。
 */
function makeService(overrides = {}) {
  const updates = [];
  const audits = [];
  const po = { id: "po-1", purchaseOrderNo: "PO-1", status: overrides.status ?? "ordered" };
  const prisma = {
    purchaseOrder: {
      findFirst: async () => (overrides.missing ? null : po),
      update: async ({ where, data }) => { updates.push({ where, data }); return { id: where.id, ...data }; },
    },
  };
  const service = new PurchaseOrdersService(prisma, { ...audit, record: async (...args) => { audits.push(args); } });
  return { service, updates, audits, po };
}

const user = { id: "user-1" };

test("打印信息：八格全部落到对应列，且只碰这些列（不动明细/金额/状态/供应商）", async () => {
  const { service, updates } = makeService();

  await service.updatePrintFields("po-1", {
    payment_terms: "月结60天",
    delivery_terms: "合同签订后 15 天内分批交货",
    delivery_address: "浙江省绍兴市柯桥区迪礼厂区 1 号仓",
    expected_date: "2026-09-25",
    remark: "含税价，逾期按合同处理",
    supplier_reply: "同意按此价格与交期执行",
    supplier_signed: "李经理 2026-09-12",
    supervisor_signature: "钱主管 2026-09-13",
  }, user);

  assert.equal(updates.length, 1);
  const data = updates[0].data;
  assert.equal(data.paymentTerms, "月结60天");
  assert.equal(data.deliveryTerms, "合同签订后 15 天内分批交货");
  assert.equal(data.deliveryAddress, "浙江省绍兴市柯桥区迪礼厂区 1 号仓");
  assert.equal(data.expectedDate.toISOString().slice(0, 10), "2026-09-25");
  assert.equal(data.remark, "含税价，逾期按合同处理");
  assert.equal(data.supplierReply, "同意按此价格与交期执行");
  assert.equal(data.supplierSigned, "李经理 2026-09-12");
  assert.equal(data.supervisorSignature, "钱主管 2026-09-13");
  assert.equal(data.updatedBy, user.id);
  // 这四样绝不能出现在这条更新里（打印信息与业务事实互不干涉）
  for (const forbidden of ["items", "totalAmount", "status", "supplierId", "supplierSnapshot", "orderNo", "bomId"]) {
    assert.equal(forbidden in data, false, `打印信息不得改动 ${forbidden}`);
  }
});

test("打印信息：没传的格子不动（只改付款方式不会把交货地址清掉）", async () => {
  const { service, updates } = makeService();

  await service.updatePrintFields("po-1", { payment_terms: "当月付款" }, user);

  assert.deepEqual(Object.keys(updates[0].data).sort(), ["paymentTerms", "updatedBy"]);
});

test("打印信息：空串与纯空白按「清除这一格」处理（表单里删空 = 不印字）", async () => {
  const { service, updates } = makeService();

  await service.updatePrintFields("po-1", {
    payment_terms: "",
    delivery_terms: "   ",
    delivery_address: "",
    supplier_reply: "",
    supplier_signed: "  ",
    supervisor_signature: "",
  }, user);

  const data = updates[0].data;
  for (const key of ["paymentTerms", "deliveryTerms", "deliveryAddress", "supplierReply", "supplierSigned", "supervisorSignature"]) {
    assert.equal(data[key], null, `${key} 空串应清成 null`);
  }
});

test("打印信息：交货日期传 null 才清空，不传不动", async () => {
  const cleared = makeService();
  await cleared.service.updatePrintFields("po-1", { expected_date: null }, user);
  assert.equal(cleared.updates[0].data.expectedDate, null);
  assert.equal("expectedDate" in cleared.updates[0].data, true);

  const untouched = makeService();
  await untouched.service.updatePrintFields("po-1", { payment_terms: "月结30天" }, user);
  assert.equal("expectedDate" in untouched.updates[0].data, false, "没传交货日期不许改它");
});

test("打印信息：草稿 / 已下单 / 部分到货 / 到货完成都能填（厂家回签本来就是下单之后的事）", async () => {
  for (const status of ["draft", "ordered", "partially_arrived", "arrived_complete"]) {
    const { service, updates, audits } = makeService({ status });
    await service.updatePrintFields("po-1", { supplier_signed: "李经理 2026-09-12" }, user);
    assert.equal(updates.length, 1, `status=${status} 应允许填写打印信息`);
    assert.ok(audits.some(([action]) => action === "purchase_order.print_fields"), `status=${status} 应写审计`);
  }
});

test("打印信息：已取消的采购单拒绝（422），且一个字都不写", async () => {
  const { service, updates } = makeService({ status: "cancelled" });

  await assert.rejects(
    () => service.updatePrintFields("po-1", { payment_terms: "月结30天" }, user),
    (error) => error.getResponse().code === "PURCHASE_ORDER_NOT_EDITABLE",
  );
  assert.equal(updates.length, 0);
});

test("打印信息：采购单不存在 → 404；审计带上单号与被改的字段名", async () => {
  const missing = makeService({ missing: true });
  await assert.rejects(
    () => missing.service.updatePrintFields("po-1", { payment_terms: "月结30天" }, user),
    (error) => error.getResponse().code === "PURCHASE_ORDER_NOT_FOUND",
  );

  const { service, audits } = makeService();
  await service.updatePrintFields("po-1", { payment_terms: "月结30天", delivery_address: "厂区" }, user);
  // 审计签名：record(action, entityType, actorId, entityId, details)
  const [action, entityType, actorId, entityId, details] = audits.find(([name]) => name === "purchase_order.print_fields");
  assert.equal(action, "purchase_order.print_fields");
  assert.equal(entityType, "purchase_order");
  assert.equal(actorId, "user-1");
  assert.equal(entityId, "po-1");
  assert.equal(details.purchase_order_no, "PO-1");
  assert.equal(details.status, "ordered");
  assert.deepEqual(details.fields.sort(), ["deliveryAddress", "paymentTerms"]);
});
