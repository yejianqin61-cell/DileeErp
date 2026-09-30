// 销售单细化字段清单与纯函数的测试（node:test，不是 vitest —— 纯函数按仓库约定走 node --test）。
//
// 最要紧的一条：这份清单必须与后端 `SPEC_SCALAR_FIELDS` **逐键一致**。
// 分叉的后果是「界面填了、库里没存」——最难查的一类错，所以两边用同一组向量：
// 这里断言的是 37 个键、顺序、以及「表头→布量→材料→工艺」的分组。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SPEC_DETAIL_LABELS, SPEC_DETAIL_COLUMNS, SPEC_DETAIL_LABEL_KEYS, SPEC_DETAIL_LABEL_MAX_LENGTH,
  SPEC_FABRIC_FIELDS, SPEC_HEADER_FIELDS, SPEC_MATERIAL_FIELDS, SPEC_PROCESS_FIELDS, SPEC_SCALAR_KEYS,
  detailLabelsWithDefaults, emptySpecDetailRow, isBlankSpecDetail, normalizeSpecUnit, snakeToCamel,
  specDetailLabelsFromOrder, specFromOrder, specPayload, specQuantityNotice, validateSpecDetailLabels, validateSpecDetails,
} from "./sales-order-spec.ts";

test("字段清单：37 个标量，顺序是「表头 → 布量 → 材料 → 工艺」", () => {
  assert.equal(SPEC_SCALAR_KEYS.length, 37);
  assert.equal(new Set(SPEC_SCALAR_KEYS).size, 37, "键不能重复");
  assert.equal(SPEC_SCALAR_KEYS[0], "factory");
  assert.equal(SPEC_SCALAR_KEYS[5], "fabric_usage_canopy");
  assert.equal(SPEC_SCALAR_KEYS[10], "rib_spec", "伞骨是材料第一行");
  assert.equal(SPEC_SCALAR_KEYS.at(-1), "qc_requirement", "质检报告是工艺最后一条");
  assert.equal(SPEC_HEADER_FIELDS.length + SPEC_FABRIC_FIELDS.length + SPEC_MATERIAL_FIELDS.length + SPEC_PROCESS_FIELDS.length, 37);
  assert.equal(SPEC_MATERIAL_FIELDS.length, 18);
  assert.equal(SPEC_PROCESS_FIELDS.length, 9);
});

test("两样本并集：样本1 独有与样本2 独有的字段都在", () => {
  const keys = SPEC_SCALAR_KEYS;
  for (const key of ["handle_strap_spec", "strap_fastener_spec", "woven_label_spec"]) assert.ok(keys.includes(key), `样本1 独有缺 ${key}`);
  for (const key of ["top_fabric_spec", "wood_ear_spec", "keychain_spec", "printing_spec"]) assert.ok(keys.includes(key), `样本2 独有缺 ${key}`);
});

test("明细列与后端 SpecDetailDto 的字段名一一对应", () => {
  assert.deepEqual(SPEC_DETAIL_COLUMNS.map(([key]) => key), ["group_name", "name", "color", "barcode", "quantity", "unit"]);
});

test("载荷：每个标量键都带上（空串 = 清除这一格），空明细行不提交", () => {
  const details = [
    { group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "100", unit: "pcs" },
    emptySpecDetailRow(),
  ];
  const payload = specPayload({ factory: "JBN", attention_note: "" }, details);

  for (const key of SPEC_SCALAR_KEYS) assert.ok(key in payload, `载荷缺 ${key}`);
  assert.equal(payload.factory, "JBN");
  assert.equal(payload.attention_note, "", "删空的格子要发空串（后端据此清空），不能省略这个键");
  assert.equal(payload.spec_details.length, 1, "整行空的行不提交");
  assert.deepEqual(payload.spec_details[0], { group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "100", unit: "pcs", sort_order: 0 });
});

test("载荷：一格都不填时 37 个键全是空串 —— 这是新建销售单的默认形态，后端必须收得下", () => {
  // 2026-09-20 的现场问题：这个形态**每次**都被后端判 400（5 个布量是数值列，
  // `@IsOptional()` 不跳过空串，"" 撞上 @Matches/@IsDecimal）。
  // 前端这边不能「聪明地」把空键删掉来绕过 —— 删了就等于永远清不掉一格（见 specPayload 的注释）。
  // 所以契约是：前端照发空串，后端负责把数值列的空串归一成「清空」。
  const payload = specPayload({}, [emptySpecDetailRow()]);
  for (const key of SPEC_SCALAR_KEYS) assert.equal(payload[key], "", `${key} 应是空串（而不是被省略）`);
  assert.deepEqual(payload.spec_details, [], "只有一行空行时不提交任何明细");
});

test("回填：接口给的是 camelCase 列名（真实形状），37 格都必须读出来", () => {
  // 2026-09-20 现场问题：「材料明细，我是写了，然后还保存了，但是再打开就又没有了」。
  // 根因就在这里：接口 `GET /sales-orders/:id` 返回的是 Prisma 整行 —— 键是**列名 camelCase**
  // （`ribSpec` / `fabricUsageCanopy`），而表单按**请求键 snake_case** 取值。
  // 拿请求键去索引 camelCase 行，除了 `factory`（两种名字恰好一样）之外全是 undefined。
  const fromApi = {
    factory: "JBN", completionRemark: "进仓", attentionNote: "都需使用防水线",
    fabricUsageCanopy: "1.2", fabricUsageStrap: null,
    ribSpec: "50cm*5K三折手开双碳纤骨", qcRequirement: "所有材料和成品都要质检报告",
    shippingMarkFront: "（正唛图稿）",
  };
  const spec = specFromOrder(fromApi);

  assert.equal(spec.rib_spec, "50cm*5K三折手开双碳纤骨");
  assert.equal(spec.fabric_usage_canopy, "1.2");
  assert.equal(spec.qc_requirement, "所有材料和成品都要质检报告");
  assert.equal(spec.attention_note, "都需使用防水线");
  assert.equal(spec.shipping_mark_front, "（正唛图稿）");
  assert.equal(spec.factory, "JBN");
  // 没填的字段是空串（表单初值），不能是 "undefined"/"null" 这种字符串
  assert.equal(spec.fabric_usage_strap, "");
  assert.equal(spec.canopy_spec, "");
  for (const key of SPEC_SCALAR_KEYS) assert.equal(typeof spec[key], "string", `${key} 必须是字符串`);
  // 37 格全在（少一格就是「界面填了、库里没存」的镜像问题：库里存了、界面不显示）
  assert.equal(Object.keys(spec).length, 37);
});

test("回填：Decimal / null / 缺键 都要变成能放进输入框的文本", () => {
  // 布量在库里是 Decimal(18,4)，序列化进 JSON 是字符串（decimal.js 的 toJSON 走 toString，
  // 所以 1.2000 出来是 "1.2"）；这里约束的是**透传**：前端不做四舍五入、也不截断。
  const spec = specFromOrder({ fabricUsageCanopy: "1.2", fabricUsageBag: null, ribSpec: undefined });
  assert.equal(spec.fabric_usage_canopy, "1.2", "数值列照原样进输入框，不在前端做四舍五入");
  assert.equal(spec.fabric_usage_bag, "", "null = 没填 = 空串");
  assert.equal(spec.rib_spec, "", "缺键 = 没填 = 空串（不能变成 \"undefined\"）");
});

test("回填：版本快照形状（请求键 snake_case）也认 —— 两种键名都要认", () => {
  // `sales_order_versions.snapshot` 存的是请求键；只认列名的话，从快照渲染的路径又会断一次。
  const spec = specFromOrder({ rib_spec: "快照里的伞骨", attention_note: "快照里的注意事项" });
  assert.equal(spec.rib_spec, "快照里的伞骨");
  assert.equal(spec.attention_note, "快照里的注意事项");
  // 两种同时出现时以请求键为准（快照优先），并保持一致
  assert.equal(specFromOrder({ rib_spec: "请求键", ribSpec: "列名" }).rib_spec, "请求键");
});

test("snakeToCamel：37 个请求键都能机械转成后端列名（这把「再抄一份映射表」省掉了）", () => {
  // 后端 `SPEC_SCALAR_FIELDS` 是「请求键 → 列」的权威表；这里只允许依赖「列名 = 请求键的驼峰」
  // 这一条假设，而它由 apps/api/test/unit/sales-order-dto.test.cjs 逐键钉住。
  assert.equal(snakeToCamel("rib_spec"), "ribSpec");
  assert.equal(snakeToCamel("fabric_usage_wood_ear"), "fabricUsageWoodEar");
  assert.equal(snakeToCamel("top_stitch_requirement"), "topStitchRequirement");
  assert.equal(snakeToCamel("factory"), "factory", "没有下划线的键原样返回");
  assert.equal(snakeToCamel("hang_tag_note"), "hangTagNote");
});

test("明细校验：分组名与品番品名必填、数量必须是数字，逐行报错且整行空的不报", () => {
  const errors = validateSpecDetails([
    { group_name: "", name: "只有名字", color: "", barcode: "", quantity: "", unit: "" },
    { group_name: "伞头配色", name: "", color: "", barcode: "", quantity: "abc", unit: "打" },
    emptySpecDetailRow(),
  ]);
  assert.deepEqual(errors, [
    { row: 1, reason: "分组名不能为空（例如：伞布明细 / 伞头配色）" },
    { row: 2, reason: "品番/品名不能为空" },
    { row: 2, reason: "数量必须是不小于 0 的数字" },
  ]);
});

test("单位归一：支 / pcs 是同一个单位（模板样本1 就是表头写支、明细写 pcs）", () => {
  for (const unit of ["支", "pcs", "PCS", "piece", "个"]) assert.equal(normalizeSpecUnit(unit), "piece", unit);
  for (const unit of ["打", "dz", "dozen"]) assert.equal(normalizeSpecUnit(unit), "dozen", unit);
  assert.equal(normalizeSpecUnit("米"), "米");
  assert.equal(normalizeSpecUnit(""), null);
});

test("数量核对：模板样本1 的 12 款花色合计 1960支 不提示", () => {
  const quantities = ["100", "200", "200", "100", "120", "120", "200", "200", "120", "200", "200", "200"];
  const details = quantities.map((quantity) => ({ ...emptySpecDetailRow(), group_name: "伞布明细", name: "x", quantity, unit: "pcs" }));
  assert.equal(specQuantityNotice("1960", "支", details), null);
});

test("数量核对：模板样本2 的 15×167打 不提示；不一致时给提示；跨单位不硬算", () => {
  const rows = (quantity, unit, count) => Array.from({ length: count }, () => ({ ...emptySpecDetailRow(), group_name: "伞头配色", name: "x", quantity, unit }));
  assert.equal(specQuantityNotice("2505", "打", rows("167", "打", 15)), null);

  assert.match(specQuantityNotice("1960", "支", rows("100", "pcs", 12)), /明细数量合计 1200 与单头数量 1960支 不一致/);
  assert.match(specQuantityNotice("5", "打", rows("60", "支", 1)), /跨单位不做合计/);
});

test("数量核对：没有数字的行、或单头数量没填时不提示（免得一进页面就报警）", () => {
  assert.equal(specQuantityNotice("", "支", []), null);
  assert.equal(specQuantityNotice("1960", "支", [emptySpecDetailRow()]), null);
  assert.equal(specQuantityNotice("1960", "支", [{ ...emptySpecDetailRow(), name: "只填了名字" }]), null);
});

test("isBlankSpecDetail：全空才算空行，只填一格就不算", () => {
  assert.equal(isBlankSpecDetail(emptySpecDetailRow()), true);
  assert.equal(isBlankSpecDetail({ ...emptySpecDetailRow(), name: "x" }), false);
  assert.equal(isBlankSpecDetail({ ...emptySpecDetailRow(), group_name: "  " }), true, "纯空白也算空");
});

// ------------------------------------------------------------------ 细分明细的自定义列名（2026-09-30）

test("列名清单：6 个列键与后端 SPEC_DETAIL_LABELS 同序同键，默认名非空", () => {
  assert.deepEqual(SPEC_DETAIL_LABEL_KEYS, ["group_name", "name", "color", "barcode", "quantity", "unit"]);
  assert.deepEqual(DEFAULT_SPEC_DETAIL_LABELS, { group_name: "分组名", name: "品番/品名", color: "颜色/配色", barcode: "条码", quantity: "数量", unit: "单位" });
  assert.equal(SPEC_DETAIL_LABEL_MAX_LENGTH, 20, "与后端 SPEC_DETAIL_LABEL_MAX_LENGTH 同一口径");
});

test("列名回填：接口的列名形状与快照的请求键形状都认（只认一种就是又一轮「再打开就没了」）", () => {
  assert.deepEqual(specDetailLabelsFromOrder({ specDetailLabels: { name: "品名", color: "配色" } }), { name: "品名", color: "配色" });
  assert.deepEqual(specDetailLabelsFromOrder({ spec_detail_labels: { name: "品名" } }), { name: "品名" });
  // 认不出的键、空白值、超长的值都不进覆盖（超长的会被后端拒，读侧不该把它当成生效中的列名）
  assert.deepEqual(specDetailLabelsFromOrder({ specDetailLabels: { price: "单价", color: "   ", unit: "单".repeat(30) } }), {});
  assert.deepEqual(specDetailLabelsFromOrder({}), {});
  assert.deepEqual(specDetailLabelsFromOrder({ specDetailLabels: null }), {});
});

test("列名合并：默认名打底、覆盖优先、空覆盖回落默认名", () => {
  const merged = detailLabelsWithDefaults({ name: "伞头英文名", quantity: " " });
  assert.equal(merged.name, "伞头英文名");
  assert.equal(merged.quantity, "数量", "空值 = 用默认名");
  assert.equal(merged.barcode, "条码");
  assert.equal(Object.keys(merged).length, 6);
  assert.deepEqual(detailLabelsWithDefaults(null), DEFAULT_SPEC_DETAIL_LABELS);
});

test("列名载荷：只发非空的项（清空一格 = 不发这个键 = 后端删掉覆盖 = 回到默认名）", () => {
  const payload = specPayload({}, [emptySpecDetailRow()], undefined, { name: "品名", color: "  ", price: "单价" });
  assert.deepEqual(payload.spec_detail_labels, { name: "品名" }, "空值与不认识的值都不该发出去");
  // 整块替换语义：传了 `{}` 就是"全部恢复默认"，所以这个键必须发出去（不能因为空就省略）
  assert.deepEqual(specPayload({}, [emptySpecDetailRow()], undefined, {}).spec_detail_labels, {});
  // 不传 = 不动这一块（undefined 是后端约定好的第三种语义，返单/其它调用方依赖它）
  assert.equal("spec_detail_labels" in specPayload({}, [emptySpecDetailRow()]), false);
});

test("列名校验：超过 20 字给出人话（保存前拦下，别等一个来回）", () => {
  assert.equal(validateSpecDetailLabels({ name: "品".repeat(SPEC_DETAIL_LABEL_MAX_LENGTH) }), null);
  assert.match(validateSpecDetailLabels({ name: "品".repeat(SPEC_DETAIL_LABEL_MAX_LENGTH + 1) }), /超过 20 字/);
  assert.equal(validateSpecDetailLabels({}), null);
});
