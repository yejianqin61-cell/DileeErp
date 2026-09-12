const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ValidationPipe, BadRequestException } = require("@nestjs/common");
const { CustomerDto } = require("../../dist/modules/sales/customers.controller.js");
const { MaterialDto, SupplierDto } = require("../../dist/modules/procurement/procurement-master-data.controller.js");

// 契约测试：用**真实 ValidationPipe 配置**（main.ts: whitelist + transform + forbidNonWhitelisted）
// 校验前端「新建类目」真实发出的请求体。
// 背景：客户编码支持「自动生成」后，前端会发 code_mode 且 customer_code 为空；
// 而 CustomerDto 当时仍把 customer_code 写成必填、也没有声明 code_mode，
// 于是新建客户必然 400（"property code_mode should not exist" + "customer_code must be a string"）。
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function validateBody(metatype, value) {
  return pipe.transform(value, { type: "body", metatype });
}
async function assertRejected(metatype, value, label) {
  await assert.rejects(() => validateBody(metatype, value), (error) => error instanceof BadRequestException, label);
}

test("新建客户：自动生成编码（前端默认）必须能通过校验", async () => {
  // apps/web 的 openCustomer() 在「编码方式 = auto」时实际发出的请求体。
  const payload = { code_mode: "auto", name: "新客户A", country_region: "CN", address: "", payment_terms: "", currency: "USD", remark: "" };
  const result = await validateBody(CustomerDto, payload);
  assert.equal(result.code_mode, "auto", "code_mode 必须保留在 DTO 里，否则会被 forbidNonWhitelisted 拒绝");
  assert.equal(result.customer_code, undefined, "自动编码时客户编码留空");
  assert.equal(result.name, "新客户A");
});

test("新建客户：手动填写编码必须能通过校验", async () => {
  const result = await validateBody(CustomerDto, { code_mode: "manual", customer_code: "CUS-20260912-0001", name: "新客户B" });
  assert.equal(result.customer_code, "CUS-20260912-0001");
  assert.equal(result.code_mode, "manual");
});

test("新建客户：不带 code_mode 的传统调用仍然可用（只传 customer_code）", async () => {
  const result = await validateBody(CustomerDto, { customer_code: "CUS-9", name: "老客户" });
  assert.equal(result.customer_code, "CUS-9");
});

test("新建客户的编码方式只接受 auto/manual，多余字段仍被拒绝（白名单没有被放松）", async () => {
  await assertRejected(CustomerDto, { code_mode: "guess", name: "客户C" }, "非法编码方式必须 400");
  await assertRejected(CustomerDto, { code_mode: "auto", name: "客户C", unexpected_field: "x" }, "未声明字段必须仍然 400");
  await assertRejected(CustomerDto, { code_mode: "auto" }, "缺少客户名称必须 400");
});

test("供应商与物料的自动编码模式同样通过校验（回归保护）", async () => {
  const supplier = await validateBody(SupplierDto, { code_mode: "auto", name: "新供应商", contact_name: "李经理", phone: "13800000000" });
  assert.equal(supplier.code_mode, "auto");
  assert.equal(supplier.supplier_code, undefined);
  // default_unit_id 走 @IsUUID()，必须是合法的 RFC4122 变体（第四段首位为 8/9/a/b），占位 UUID 会被拒。
  const material = await validateBody(MaterialDto, { code_mode: "auto", name: "新物料", default_unit_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", material_type: "raw_material" });
  assert.equal(material.code_mode, "auto");
  assert.equal(material.material_code, undefined);
});
