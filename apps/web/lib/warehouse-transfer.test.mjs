// 跨仓调拨（T-0028）前端口径单测：目标仓选项、数量边界、明细摘要。
import test from "node:test";
import assert from "node:assert/strict";
import {
  WAREHOUSE_TRANSFER_PURPOSE_LABEL,
  WAREHOUSE_TRANSFER_SOURCE_LABEL,
  WAREHOUSE_TRANSFER_TARGET_OPTIONS,
  isPositiveTransferQuantity,
  transferLineSummary,
  warehouseTransferTargetLabel,
} from "./warehouse-transfer.ts";

test("目标仓只给大田仓、晋江仓，源仓固定同安仓", () => {
  assert.deepEqual(WAREHOUSE_TRANSFER_TARGET_OPTIONS, [
    { value: "daitan", label: "大田仓" },
    { value: "jinjiang", label: "晋江仓" },
  ]);
  assert.equal(WAREHOUSE_TRANSFER_SOURCE_LABEL, "同安仓");
  assert.equal(WAREHOUSE_TRANSFER_PURPOSE_LABEL, "供目标仓库生产使用");
  assert.equal(warehouseTransferTargetLabel("jinjiang"), "晋江仓");
  assert.equal(warehouseTransferTargetLabel(""), "");
});

test("数量边界与后端 parseQuantity 一致：大于零、最多 4 位小数，拒绝指数/负数/零", () => {
  for (const value of ["1", "2.5", "0.0001", " 12 "]) assert.equal(isPositiveTransferQuantity(value), true, value);
  for (const value of ["0", "0.0000", "-1", "1e3", "1.23456", "", "abc", "1,000"]) assert.equal(isPositiveTransferQuantity(value), false, value);
});

test("明细摘要把物料名、数量与单位拼成一行，空明细显示 -", () => {
  assert.equal(transferLineSummary([
    { material_name: "涤纶布", quantity: "2.5", unit_name: "米" },
    { material_name: "松紧带", quantity: "10", unit_name: "个" },
  ]), "涤纶布 × 2.5米、松紧带 × 10个");
  assert.equal(transferLineSummary([]), "-");
});
