const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
const { getCustomerPayments, getReceivables } = require("../../dist/modules/business-query-agent/tools/finance-query-tools.js");

const ROOT = { id: "order-id", orderNo: "SO-FIN-001", quantity: { toString: () => "10" }, unit: "把", status: "confirmed", updatedAt: new Date() };
const decimal = (value) => ({ toString: () => String(value) });

function fakeClient() {
  return {
    receivableSource: {
      findMany: async () => [{
        sourceNo: "AR-1", quantity: decimal("10"), unit: "把", unitPrice: decimal("12.5"), taxRate: decimal("0.13"), amount: decimal("125"), currency: "CNY", status: "confirmed", dueDate: new Date("2026-11-01"), invoiceNo: "INV-1", invoiceDate: new Date("2026-10-20"), remark: "客户私密备注", amountReason: "自由原因",
        customer: { customerCode: "CUS-1", name: "客户甲", phone: "13800000000" }, outbound: { outboundNo: "FGO-1" },
        allocations: [
          { amount: decimal("40"), status: "active", payment: { status: "posted" } },
          { amount: decimal("20"), status: "active", payment: { status: "draft" } },
          { amount: decimal("5"), status: "reversed", payment: { status: "posted" } },
        ],
      }],
    },
    customerPayment: {
      findMany: async () => [{
        paymentNo: "CP-1", paymentDate: new Date("2026-10-21"), amount: decimal("40"), currency: "CNY", paymentMethod: "银行转账", status: "posted", bankReference: "6222 8888 9999", payerName: "付款人", remark: "自由备注",
        customer: { customerCode: "CUS-1", name: "客户甲", phone: "13800000000" }, bank: { bankName: "中国银行", accountNumber: "6222 8888 9999" },
        allocations: [{ amount: decimal("40"), currency: "CNY", status: "active", receivableSource: { sourceNo: "AR-1" } }],
      }],
    },
  };
}

test("get_receivables：只扣已过账的有效收款分摊，投影订单应收财务事实", async () => {
  const result = await getReceivables(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data[0], {
    source_no: "AR-1", outbound_no: "FGO-1", customer_code: "CUS-1", customer_name: "客户甲",
    quantity: "10", unit: "把", unit_price: "12.5", tax_rate: "0.13", amount: "125", currency: "CNY", status: "confirmed",
    allocated_amount: "40", outstanding_amount: "85", due_date: new Date("2026-11-01"), invoice_no: "INV-1", invoice_date: new Date("2026-10-20"),
  });
  assert.doesNotMatch(JSON.stringify(result), /13800000000|客户私密备注|自由原因/);
});

test("get_customer_payments：收款保留金额与有效分摊，银行账号、付款人和备注不出", async () => {
  const result = await getCustomerPayments(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data[0], {
    payment_no: "CP-1", payment_date: new Date("2026-10-21"), amount: "40", currency: "CNY", payment_method: "银行转账", status: "posted",
    customer_code: "CUS-1", customer_name: "客户甲", bank_name: "中国银行", allocations: [{ source_no: "AR-1", amount: "40", currency: "CNY" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /6222|付款人|自由备注|13800000000/);
});

test("finance_query：operational 在读取前被拒，full 能经订单根执行应收查询", async () => {
  const client = { ...fakeClient(), salesOrder: { findFirst: async () => ROOT } };
  const calls = { roles: 0 };
  const operational = new ToolExecutor(client, { async readActiveRoleKeys() { calls.roles += 1; return ["qita"]; } });
  const opsPrincipal = { user: { id: "ops", username: "ops", display_name: "员工" }, accessLevel: "operational" };
  await assert.rejects(
    operational.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: ROOT.orderNo } }, opsPrincipal),
    (error) => error.getStatus() === 403,
  );
  assert.equal(calls.roles, 0);

  const full = new ToolExecutor(client, { async readActiveRoleKeys() { return ["laoban"]; } });
  const fullPrincipal = { user: { id: "boss", username: "boss", display_name: "老板" }, accessLevel: "full" };
  const fact = await full.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: ROOT.orderNo } }, fullPrincipal);
  assert.equal(fact.access_level, "full");
  assert.equal(fact.data[0].outstanding_amount, "85");
});
