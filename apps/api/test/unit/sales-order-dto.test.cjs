const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ValidationPipe, BadRequestException } = require("@nestjs/common");
const { SalesOrderDto, UpdateSalesOrderDto } = require("../../dist/modules/sales/sales-orders.controller.js");

// 契约测试：用**真实 ValidationPipe 配置**（main.ts: whitelist + transform + forbidNonWhitelisted）
// 校验「新建/编辑销售单」真实发出的请求体。
//
// 背景：apps/web/app/sales/page.tsx 的对话框把每个字段初始化成 ""（ActionDialog），
// 单价/金额不填就提交 ""；而 DTO 是 @IsOptional() @IsDecimal()，@IsOptional() 只跳过
// null/undefined，"" 会被判为「不是合法小数」→ 新建销售单必然 400。
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function validateBody(metatype, value) {
  return pipe.transform(value, { type: "body", metatype });
}
async function assertRejected(metatype, value, label) {
  await assert.rejects(() => validateBody(metatype, value), (error) => error instanceof BadRequestException, label);
}

// 对话框「新建销售单」在用户只填必填项时实际发出的请求体（单价/金额/税率为空串）。
const dialogBody = {
  order_no: "SO-20260912-001",
  customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  contact_id: undefined,
  external_contract_no: "",
  product_name: "折叠伞",
  product_spec: "",
  quantity: "10",
  unit: "把",
  order_date: new Date("2026-09-12T00:00:00.000Z").toISOString(),
  delivery_date: undefined,
  currency: "USD",
  unit_price: "",
  total_amount: "",
};

test("DTO 元数据可用：导出的确实是 DTO 类（否则 ValidationPipe 会跳过全部校验）", () => {
  assert.equal(typeof SalesOrderDto, "function");
  assert.equal(typeof UpdateSalesOrderDto, "function");
});

test("新建销售单：单价/金额留空（前端默认空串）必须能通过校验", async () => {
  const result = await validateBody(SalesOrderDto, dialogBody);
  assert.equal(result.order_no, "SO-20260912-001");
  assert.equal(result.unit_price, undefined, "空串应归一成 undefined，交给 @IsOptional() 跳过");
  assert.equal(result.total_amount, undefined);
});

test("新建销售单：填写单价/金额时按原值通过", async () => {
  const result = await validateBody(SalesOrderDto, { ...dialogBody, unit_price: "12.5", total_amount: "125", tax_rate: "0.13" });
  assert.equal(result.unit_price, "12.5");
  assert.equal(result.total_amount, "125");
  assert.equal(result.tax_rate, "0.13");
});

test("编辑销售单：清空单价提交空串时同样通过（不写入该字段）", async () => {
  const result = await validateBody(UpdateSalesOrderDto, { unit_price: "", total_amount: "", tax_rate: "", reason: "调价" });
  assert.equal(result.unit_price, undefined);
  assert.equal(result.total_amount, undefined);
  assert.equal(result.reason, "调价");
});

test("空串归一没有放松校验：非法小数、未声明字段、缺必填仍然 400", async () => {
  await assertRejected(SalesOrderDto, { ...dialogBody, unit_price: "abc" }, "非法小数必须 400");
  await assertRejected(SalesOrderDto, { ...dialogBody, unit_price: "1e5" }, "科学计数法不是合法小数");
  await assertRejected(SalesOrderDto, { ...dialogBody, unexpected_field: "x" }, "未声明字段必须 400");
  const { currency, ...withoutCurrency } = dialogBody;
  await assertRejected(SalesOrderDto, withoutCurrency, "缺少币种必须 400");
  await assertRejected(SalesOrderDto, { ...dialogBody, quantity: "" }, "必填数量为空串必须 400");
});

test("必填文本字段留空必须 400（不能再把空订单号/空币种写进库）", async () => {
  for (const [field, value] of [["order_no", ""], ["product_name", "   "], ["currency", ""], ["unit", " "], ["customer_id", ""]]) {
    await assertRejected(SalesOrderDto, { ...dialogBody, [field]: value }, `${field} 为空必须 400`);
  }
});

test("编辑销售单：必填文本字段传空串视为「不修改」而不是写入空值", async () => {
  const result = await validateBody(UpdateSalesOrderDto, { unit: "", currency: "  ", product_name: "" });
  assert.equal(result.unit, undefined);
  assert.equal(result.currency, undefined);
  assert.equal(result.product_name, undefined);
});
