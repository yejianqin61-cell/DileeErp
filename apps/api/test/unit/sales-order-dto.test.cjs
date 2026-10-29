const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ValidationPipe, BadRequestException } = require("@nestjs/common");
const { SalesOrderDto, UpdateSalesOrderDto } = require("../../dist/modules/sales/sales-orders.controller.js");
const { SPEC_SCALAR_FIELDS } = require("../../dist/modules/sales/sales-orders.service.js");

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

test("结算口径字段：留空通过、合法值原样保留、结算方式只接受固定枚举", async () => {
  const filled = await validateBody(SalesOrderDto, { ...dialogBody, settlement_unit_price: "1.7", receivable_amount: "17", settlement_method: "tt", local_currency_amount: "122.4" });
  assert.equal(filled.settlement_unit_price, "1.7");
  assert.equal(filled.receivable_amount, "17");
  assert.equal(filled.settlement_method, "tt");
  assert.equal(filled.local_currency_amount, "122.4");

  const blank = await validateBody(SalesOrderDto, dialogBody);
  assert.equal(blank.settlement_unit_price, undefined);
  assert.equal(blank.receivable_amount, undefined);
  assert.equal(blank.settlement_method, undefined);
  assert.equal(blank.local_currency_amount, undefined);

  await assertRejected(SalesOrderDto, { ...dialogBody, settlement_method: "barter" }, "非法结算方式必须 400");
  await assertRejected(SalesOrderDto, { ...dialogBody, receivable_amount: "abc" }, "应收金额必须是合法小数");
  await assertRejected(UpdateSalesOrderDto, { local_currency_amount: "1e3" }, "科学计数法不是合法小数");
  // 负数金额会被原样带进财务应收来源，必须拒绝（@Min 对字符串不生效，这里用正则）。
  await assertRejected(SalesOrderDto, { ...dialogBody, receivable_amount: "-100" }, "应收金额不能为负");
  await assertRejected(SalesOrderDto, { ...dialogBody, settlement_unit_price: "-1" }, "结算币价不能为负");
  await assertRejected(UpdateSalesOrderDto, { local_currency_amount: "-0.01" }, "本币金额不能为负");
  await assertRejected(SalesOrderDto, { ...dialogBody, quantity: "-1" }, "数量不能为负");
  await assertRejected(UpdateSalesOrderDto, { quantity: "-0.5" }, "编辑数量也不能为负");
});

// ---------------------------------------------------------------------------
// 整页编辑器（/sales/orders/new）的请求体：这一组是 2026-09-20 补的回归护栏。
//
// 现场症状：新建销售单**永远**弹「请求参数校验失败」，而且不说哪个字段。
// 成因：`specPayload()` 把 37 个细化键**全部**带上（设计如此：不带就永远清不掉一格），
// 其中 5 个布量是数值列 —— `@IsOptional()` 不跳过空串，"" 撞上 `@Matches`/`@IsDecimal`
// 被判「不是合法小数」。于是「布量一个字都不填」这种最常见的填法每次必 400。
// 修法是 DTO 上给这 5 个键加 `EmptyStringToNull`（空串 → null = 清空这一格，不是「不动」）。
// 下面用**真实前端清单**跑一遍真实 payload，防止清单或装饰器再被改坏。
// ---------------------------------------------------------------------------

/** 从前端源码里取细化字段清单：两份清单分居两个 workspace，只能靠测试钉住不许分叉。 */
function webSpecScalarKeys() {
  const source = readFileSync(join(__dirname, "../../../web/lib/sales-order-spec.ts"), "utf8");
  // 只取 `SPEC_SCALAR_KEYS` 之前的四个字段清单声明（它自己是用 spread 拼出来的，没有字面量）。
  const declarations = source.slice(0, source.indexOf("export const SPEC_SCALAR_KEYS"));
  return [...declarations.matchAll(/^\s*\["([a-z_]+)",\s*"/gm)].map((match) => match[1]);
}

test("字段清单不许分叉：apps/web 的 37 个键必须与后端 SPEC_SCALAR_FIELDS 逐键按序一致", () => {
  const backend = SPEC_SCALAR_FIELDS.map(([key]) => key);
  assert.equal(backend.length, 37);
  assert.deepEqual(webSpecScalarKeys(), backend, "前端表单会提交的键必须与后端能接收的键完全一致（顺序也要一致）");
});

test("列名必须是请求键的机械驼峰：前端靠这条假设回填 37 格", () => {
  // 前端回填（`apps/web/lib/sales-order-spec.ts` 的 `specFromOrder`）是拿 `snakeToCamel(请求键)`
  // 去索引接口返回的 Prisma 行。这条假设一旦不成立（有人把请求键改名而没改列名，或反过来），
  // 前端会**静默**读成空 —— 正是 2026-09-20「材料明细写了、保存了，再打开就又没了」的形态：
  // 没有报错、没有 400，只是格子里没字，然后再点保存就把库里的值清成 NULL。
  // `.test.mjs` 那边单独验 `snakeToCamel` 的实现，这里验它算出来的名字与后端表逐个相符。
  const camel = (key) => key.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
  for (const [key, column] of SPEC_SCALAR_FIELDS) {
    assert.equal(camel(key), column, `${key} 的列名应是机械驼峰 ${camel(key)}，实际是 ${column}`);
  }
});

test("新建销售单（整页编辑器）：只填必填项、37 个细化格全空，必须通过校验", async () => {
  const spec = Object.fromEntries(SPEC_SCALAR_FIELDS.map(([key]) => [key, ""]));
  const editorBody = {
    order_no: "SO-20260920-001",
    customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    product_name: "折叠伞",
    quantity: "10",
    unit: "把",
    currency: "USD",
    order_date: "2026-09-20",
    ...spec,
    spec_details: [],
  };

  const result = await validateBody(SalesOrderDto, editorBody);
  assert.equal(result.order_no, "SO-20260920-001");

  // 文本格：空串原样传下去，服务层 `specScalars` 把 "" 落成 NULL（清空语义）。
  assert.equal(result.attention_note, "", "文本格保持空串（服务层据此清空这一格）");
  // 数值格：空串必须先变成 null 才能过 @Matches/@IsDecimal，同时仍是「清空」而不是「不动」。
  assert.equal(result.fabric_usage_canopy, null, "布量留空应归一成 null（清空），而不是被判成非法小数");
  assert.equal(result.fabric_usage_bag, null);
});

test("新建销售单（整页编辑器）：明细里只填分组名+品名、数量单位留空，也必须通过校验", async () => {
  const spec = Object.fromEntries(SPEC_SCALAR_FIELDS.map(([key]) => [key, ""]));
  const editorBody = {
    order_no: "SO-20260920-002",
    customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    product_name: "折叠伞",
    quantity: "10",
    unit: "把",
    currency: "USD",
    order_date: "2026-09-20",
    ...spec,
    // 前端 `specPayload` 就是这么发的：整行空的行被丢掉，留下的一行每个键都在（空的给空串）。
    spec_details: [{ group_name: "伞布明细", name: "DL260134", color: "", barcode: "", quantity: "", unit: "", sort_order: 0 }],
  };

  const result = await validateBody(SalesOrderDto, editorBody);
  assert.equal(result.spec_details.length, 1);
  assert.equal(result.spec_details[0].quantity, undefined, "明细数量空串归一成 undefined（不填）");
  assert.equal(result.spec_details[0].color, "");
});

test("新建销售单（整页编辑器）：布量填了非法值仍然 400（空串归一没有放松校验）", async () => {
  const spec = Object.fromEntries(SPEC_SCALAR_FIELDS.map(([key]) => [key, ""]));
  const editorBody = {
    order_no: "SO-20260920-003", customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    product_name: "折叠伞", quantity: "10", unit: "把", currency: "USD", order_date: "2026-09-20",
    ...spec, spec_details: [],
  };
  await assertRejected(SalesOrderDto, { ...editorBody, fabric_usage_canopy: "abc" }, "布量非法必须 400");
  await assertRejected(SalesOrderDto, { ...editorBody, fabric_usage_top: "-1" }, "布量不能为负");
  await assertRejected(SalesOrderDto, { ...editorBody, fabric_usage_bag: "1e3" }, "科学计数法不是合法小数");
});

test("编辑销售单（整页编辑器）：清空布量提交空串 = 清空这一格（不是「不动」）", async () => {
  const result = await validateBody(UpdateSalesOrderDto, { fabric_usage_canopy: "", fabric_usage_strap: "  ", attention_note: "" });
  assert.equal(result.fabric_usage_canopy, null, "空串 → null：服务层照此写成 NULL");
  assert.equal(result.fabric_usage_strap, null, "纯空白同样算清空");
  assert.equal(result.attention_note, "");
});

/** 只填必填项的新建请求体（引用那两条用例的基准：其余字段都不是它们要测的东西）。 */
const minimalBody = () => ({
  order_no: "SO-20260924-001",
  customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  product_name: "折叠伞",
  quantity: "10",
  unit: "把",
  currency: "USD",
  order_date: "2026-09-24",
});

test("材料明细引用物料：形状对就通过（空数组 = 全部取消引用）", async () => {
  const refs = [{ spec_key: "rib_spec", material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }];
  const created = await validateBody(SalesOrderDto, { ...minimalBody(), material_refs: refs });
  // class-transformer 给出的是 DTO 实例（原型不是 Object），所以按字段比而不是按引用比。
  assert.deepEqual(created.material_refs.map((ref) => ({ ...ref })), refs, "整组透传给服务层（幂等替换在服务层做）");
  const cleared = await validateBody(UpdateSalesOrderDto, { material_refs: [] });
  assert.deepEqual(cleared.material_refs, [], "空数组是合法值（= 取消全部引用），不能被当成「没传」");
  const untouched = await validateBody(UpdateSalesOrderDto, {});
  assert.equal(untouched.material_refs, undefined, "没传 = 整块不动");
});

test("材料明细引用物料：material_id 必须是 UUID、spec_key 不能空（坏形状在 DTO 就挡下）", async () => {
  const base = minimalBody();
  await assertRejected(SalesOrderDto, { ...base, material_refs: [{ spec_key: "rib_spec", material_id: "not-a-uuid" }] }, "material_id 必须是 UUID");
  await assertRejected(SalesOrderDto, { ...base, material_refs: [{ spec_key: "", material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }] }, "spec_key 不能为空");
  await assertRejected(SalesOrderDto, { ...base, material_refs: [{ material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }] }, "spec_key 必填");
  // 「这个栏位能不能引用」是业务清单说了算的（服务层 SPEC_MATERIAL_KEYS）——DTO 只做形状校验，
  // 所以 qc_requirement 在这里能过，到服务层才以 MATERIAL_REF_KEY_UNSUPPORTED 被拒。
  const shapeOnly = await validateBody(SalesOrderDto, { ...base, material_refs: [{ spec_key: "qc_requirement", material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }] });
  assert.equal(shapeOnly.material_refs.length, 1, "DTO 不替业务清单做判断（那条判定有单测钉在服务层）");
});

// 细分明细的自定义列名（2026-09-30 用户要求：「细分明细那边，可以改成自定义字段名称」）。
test("细分明细列名：对象透传，空对象 = 全部恢复默认列名（不能被当成「没传」）", async () => {
  const labels = { name: "伞头英文名", quantity: "数量/打" };
  const created = await validateBody(SalesOrderDto, { ...minimalBody(), spec_detail_labels: labels });
  assert.deepEqual(created.spec_detail_labels, labels, "整块透传给服务层（键与长度的判定在服务层）");
  const cleared = await validateBody(UpdateSalesOrderDto, { spec_detail_labels: {} });
  assert.deepEqual(cleared.spec_detail_labels, {}, "空对象是合法值（= 全部恢复默认），不等于「没传」");
  const untouched = await validateBody(UpdateSalesOrderDto, {});
  assert.equal(untouched.spec_detail_labels, undefined, "没传 = 这一块不动");
});

test("细分明细列名：不是对象就在 DTO 挡下（数组/字符串/数字都不行）", async () => {
  const base = minimalBody();
  await assertRejected(SalesOrderDto, { ...base, spec_detail_labels: ["name"] }, "数组不是「列键 → 列名」");
  await assertRejected(SalesOrderDto, { ...base, spec_detail_labels: "name=品名" }, "字符串不是对象");
  await assertRejected(SalesOrderDto, { ...base, spec_detail_labels: 3 }, "数字不是对象");
  // 认不出的列键同样在 DTO 过、到服务层才拒（SPEC_DETAIL_LABEL_KEY_UNSUPPORTED）：
  // 「哪 6 个列可以改名」是业务清单说了算的，抄进 DTO 就是一份会过期的副本。
  const shapeOnly = await validateBody(SalesOrderDto, { ...base, spec_detail_labels: { price: "单价" } });
  assert.deepEqual(shapeOnly.spec_detail_labels, { price: "单价" });
});

// 材料明细末尾的「其它」自定义类目行（2026-10-08 用户要求：「可以自行添加类目…允许用户增删改」）。
test("「其它」行：形状对就通过（类目 + 内容 / 类目 + 引用物料），空数组 = 全部删掉", async () => {
  const extras = [
    { label: "弹簧", content: "5cm 不锈钢" },
    { label: "胶袋", material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", sort_order: 1 },
  ];
  const created = await validateBody(SalesOrderDto, { ...minimalBody(), material_extras: extras });
  // class-transformer 给出的是 DTO 实例（每个声明过的键都在，没传的是 undefined），所以按"有值的那几个"比。
  const pick = (row) => ({ label: row.label, content: row.content ?? null, material_id: row.material_id ?? null, sort_order: row.sort_order ?? null });
  assert.deepEqual(created.material_extras.map(pick), [
    { label: "弹簧", content: "5cm 不锈钢", material_id: null, sort_order: null },
    { label: "胶袋", content: null, material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", sort_order: 1 },
  ], "整组透传给服务层（归一与替换在服务层做）");
  const cleared = await validateBody(UpdateSalesOrderDto, { material_extras: [] });
  assert.deepEqual(cleared.material_extras, [], "空数组是合法值（= 全部删掉），不能被当成「没传」");
  const untouched = await validateBody(UpdateSalesOrderDto, {});
  assert.equal(untouched.material_extras, undefined, "没传 = 这一块不动");
  // 内容空串是常见的形态（那一行只引用了物料）：@IsOptional() 不跳过空串，所以这里要能过。
  const refOnly = await validateBody(SalesOrderDto, { ...minimalBody(), material_extras: [{ label: "弹簧", content: "", material_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }] });
  assert.equal(refOnly.material_extras[0].content, "");
});

test("「其它」行：坏形状在 DTO 就挡下（非 UUID 物料 / 未知类目键 / 未声明字段 / 类目超长）", async () => {
  const base = minimalBody();
  await assertRejected(SalesOrderDto, { ...base, material_extras: [{ label: "弹簧", content: "x", material_id: "not-a-uuid" }] }, "material_id 必须是 UUID");
  // 2026-10-29「同类目再加一款」：`spec_key` 的**键域**在 DTO 挡（类目名由服务端按清单填）。
  await assertRejected(SalesOrderDto, { ...base, material_extras: [{ spec_key: "not_a_category", content: "x" }] }, "未知的 spec_key 要 400");
  await assertRejected(SalesOrderDto, { ...base, material_extras: [{ label: "弹".repeat(51), content: "x" }] }, `类目最长 50 字（第 51 个字就要 400）`);
  await assertRejected(SalesOrderDto, { ...base, material_extras: [{ label: "弹簧", content: "x", sort_order: 1.5 }] }, "sort_order 必须是整数");
  await assertRejected(SalesOrderDto, { ...base, material_extras: [{ label: "弹簧", content: "x", price: "1" }] }, "未声明的字段必须 400（写错了键名不能静默丢掉）");
  // 类目名不再必填：带 `spec_key` 的行由服务端按类目键填（用户不该重复打「伞头」）；
  // 自由行没有类目名时由服务层 `normalizeMaterialExtras` 以 MATERIAL_EXTRA_LABEL_REQUIRED 拒
  // —— 那条单测在 sales-order-material-extras.test.cjs（与「内容与引用至少有一个」同处）。
  for (const row of [{ label: "", content: "有内容" }, { label: "   ", content: "有内容" }, { content: "有内容" }, { spec_key: "handle_spec", content: "直柄银色" }]) {
    const shapeOnly = await validateBody(SalesOrderDto, { ...base, material_extras: [row] });
    assert.equal(shapeOnly.material_extras.length, 1, "类目名的判定在服务层，DTO 不再要求 label 必填");
  }
  const shapeOnly = await validateBody(SalesOrderDto, { ...base, material_extras: [{ label: "弹簧" }] });
  assert.equal(shapeOnly.material_extras.length, 1);
});
