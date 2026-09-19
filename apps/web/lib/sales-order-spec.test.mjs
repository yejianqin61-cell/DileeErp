// 销售单细化字段清单与纯函数的测试（node:test，不是 vitest —— 纯函数按仓库约定走 node --test）。
//
// 最要紧的一条：这份清单必须与后端 `SPEC_SCALAR_FIELDS` **逐键一致**。
// 分叉的后果是「界面填了、库里没存」——最难查的一类错，所以两边用同一组向量：
// 这里断言的是 37 个键、顺序、以及「表头→布量→材料→工艺」的分组。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPEC_DETAIL_COLUMNS, SPEC_FABRIC_FIELDS, SPEC_HEADER_FIELDS, SPEC_MATERIAL_FIELDS, SPEC_PROCESS_FIELDS, SPEC_SCALAR_KEYS,
  emptySpecDetailRow, isBlankSpecDetail, normalizeSpecUnit, specPayload, specQuantityNotice, validateSpecDetails,
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
