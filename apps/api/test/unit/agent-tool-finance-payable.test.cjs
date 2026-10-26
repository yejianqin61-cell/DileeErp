const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getPayables, getReconciliations, getSupplierPayments } = require("../../dist/modules/business-query-agent/tools/finance-query-tools.js");

const ROOT = { id: "order-id", orderNo: "SO-FIN-002", quantity: { toString: () => "10" }, unit: "把", status: "confirmed", updatedAt: new Date() };
const decimal = (value) => ({ toString: () => String(value) });

function fakeClient() {
  const queries = {};
  return {
    __queries: queries,
    supplierPayableEntry: { findMany: async () => [{
      payableNo: "AP-1", sourceNoSnapshot: "RMI-1", quantity: decimal("10"), unitPrice: decimal("8"), taxRate: decimal("0.13"), amount: decimal("80"), currency: "CNY", confirmationDate: new Date("2026-10-20"), status: "confirmed", remark: "内部备注",
      supplier: { supplierCode: "SUP-1", name: "供应商甲", contactPhone: "13900000000" }, purchaseOrder: { purchaseOrderNo: "PO-1" },
      allocations: [
        { amount: decimal("30"), status: "active", payment: { status: "posted" } },
        { amount: decimal("20"), status: "active", payment: { status: "draft" } },
        { amount: decimal("5"), status: "reversed", payment: { status: "posted" } },
      ],
    }] },
    supplierPayment: { findMany: async () => [{
      paymentNo: "SP-1", paymentDate: new Date("2026-10-21"), amount: decimal("30"), currency: "CNY", paymentMethod: "银行转账", status: "posted", bankReference: "6222 9999", payeeName: "收款人", remark: "内部备注",
      supplier: { supplierCode: "SUP-1", name: "供应商甲", contactPhone: "13900000000" }, bank: { bankName: "建设银行", accountNumber: "6222 9999" },
      allocations: [{ amount: decimal("30"), currency: "CNY", status: "active", payableEntry: { payableNo: "AP-1" } }],
    }] },
    receivableReconciliation: { findMany: async (query) => {
      queries.receivableReconciliation = query;
      return [{
      reconciliationNo: "REC-1", periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-31"), receivableAmountSnapshot: decimal("125"), paymentAmountSnapshot: decimal("40"), adjustmentAmountSnapshot: decimal("0"), systemBalance: decimal("85"), externalBalance: decimal("85"), difference: decimal("0"), currency: "CNY", status: "matched", createdAt: new Date("2026-10-22"), remark: "不应泄露",
      customer: { customerCode: "CUS-1", name: "客户甲", phone: "13800000000" }, bank: { bankName: "中国银行", accountNumber: "6222 8888" },
      }];
    } },
    supplierPayableReconciliation: { findMany: async (query) => {
      queries.supplierPayableReconciliation = query;
      return [{
      reconciliationNo: "SREC-1", periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-31"), payableAmountSnapshot: decimal("80"), paymentAmountSnapshot: decimal("30"), adjustmentAmountSnapshot: decimal("0"), systemBalance: decimal("50"), externalBalance: decimal("50"), difference: decimal("0"), currency: "CNY", status: "matched", createdAt: new Date("2026-10-23"), resolutionRemark: "不应泄露",
      supplier: { supplierCode: "SUP-1", name: "供应商甲", contactPhone: "13900000000" }, bank: { bankName: "建设银行", accountNumber: "6222 9999" }, purchaseOrder: { purchaseOrderNo: "PO-1" },
      }];
    } },
  };
}

test("get_payables：只扣已过账的有效付款分摊，投影订单应付财务事实", async () => {
  const result = await getPayables(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data[0], {
    payable_no: "AP-1", source_no: "RMI-1", purchase_order_no: "PO-1", supplier_code: "SUP-1", supplier_name: "供应商甲",
    quantity: "10", unit_price: "8", tax_rate: "0.13", amount: "80", currency: "CNY", status: "confirmed", confirmation_date: new Date("2026-10-20"),
    paid_amount: "30", outstanding_amount: "50",
  });
  assert.doesNotMatch(JSON.stringify(result), /13900000000|内部备注/);
});

test("get_supplier_payments：付款含有效分摊与银行名称，排除账号和收款人", async () => {
  const result = await getSupplierPayments(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data[0], {
    payment_no: "SP-1", payment_date: new Date("2026-10-21"), amount: "30", currency: "CNY", payment_method: "银行转账", status: "posted",
    supplier_code: "SUP-1", supplier_name: "供应商甲", bank_name: "建设银行", allocations: [{ payable_no: "AP-1", amount: "30", currency: "CNY" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /6222|收款人|内部备注|13900000000/);
});

test("get_reconciliations：客户与供应商对账各标方向，且 DTO 不含敏感字段", async () => {
  const client = fakeClient();
  const result = await getReconciliations(client, ROOT, 1);
  assert.deepEqual(result.data.map((row) => [row.direction, row.reconciliation_no]), [["payable", "SREC-1"], ["receivable", "REC-1"]]);
  assert.equal(result.data[0].purchase_order_no, "PO-1");
  assert.equal(result.data[1].customer_code, "CUS-1");
  assert.doesNotMatch(JSON.stringify(result), /6222|13800000000|13900000000|不应泄露/);
  assert.deepEqual(client.__queries.receivableReconciliation.where, { orderNo: ROOT.orderNo, deletedAt: null });
  assert.deepEqual(client.__queries.supplierPayableReconciliation.where, {
    deletedAt: null,
    OR: [{ orderNo: ROOT.orderNo }, { purchaseOrder: { is: { orderNo: ROOT.orderNo, deletedAt: null } } }],
  });
});
