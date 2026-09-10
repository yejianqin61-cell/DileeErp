// 原料仓储余额行合并的回归测试。
// 覆盖缺陷：没有库存记录的物料行单位名为空（单位名取自尚未计算的渲染期 memo，而不是本次请求的单位数据）。
import test from "node:test";
import assert from "node:assert/strict";
import { mergeMaterialBalances } from "./wms-balances.ts";

const materials = [
  { id: "mat-1", defaultUnitId: "u-da" },
  { id: "mat-2", defaultUnitId: "u-ma" }
];
const units = [
  { id: "u-da", name: "打" },
  { id: "u-ma", name: "码" },
  { id: "u-ge", name: "个" }
];
const balances = [{ material_id: "mat-1", unit_id: "u-da", unit_name: "打", order_no: "SO-1", quantity: "12" }];
const attach = (row, material) => ({ ...row, material });

test("没有库存记录的物料也要带出单位名称（打 / 个 / 码），不能留空", () => {
  const rows = mergeMaterialBalances(materials, units, balances, attach);
  const synthesized = rows.find((row) => row.material_id === "mat-2");
  assert.ok(synthesized, "缺少库存记录的物料应补一行 0 库存");
  assert.equal(synthesized.unit_name, "码");
  assert.equal(synthesized.quantity, "0");
  assert.equal(synthesized.order_no, null);
});

test("已有余额记录保留接口单位名，缺失时用单位表补齐", () => {
  const rows = mergeMaterialBalances(materials, units, [{ material_id: "mat-1", unit_id: "u-ge", unit_name: "", order_no: null, quantity: "5" }], attach);
  assert.equal(rows.find((row) => row.unit_id === "u-ge").unit_name, "个");
  const kept = mergeMaterialBalances(materials, units, balances, attach).find((row) => row.unit_id === "u-da");
  assert.equal(kept.unit_name, "打");
  assert.equal(kept.material.id, "mat-1", "必须挂上物料主数据");
});

test("余额里出现未知物料时丢弃，不产生无主行", () => {
  const rows = mergeMaterialBalances(materials, units, [...balances, { material_id: "mat-x", unit_id: "u-da", unit_name: "打", order_no: null, quantity: "1" }], attach);
  assert.deepEqual(rows.filter((row) => row.material_id === "mat-x"), []);
});

test("单位表里查不到的单位名保持空串而不是 undefined", () => {
  const rows = mergeMaterialBalances([{ id: "mat-3", defaultUnitId: "u-none" }], units, [], attach);
  assert.equal(rows[0].unit_name, "");
});
