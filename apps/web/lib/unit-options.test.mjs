// 单位下拉选项的回归测试（全站单位引用统一取单位池）。
import test from "node:test";
import assert from "node:assert/strict";
import { activeUnitOptions, unitOptionsWithCurrent, unitMutationPayload } from "./unit-options.ts";

const units = [
  { id: "u1", name: "打", isActive: true },
  { id: "u2", name: "个", isActive: true },
  { id: "u3", name: "码", isActive: true },
  { id: "u4", name: "件", isActive: false },
  { id: "u5", name: "  ", isActive: true }
];

test("只提供启用单位，停用与空白名称不进入下拉", () => {
  assert.deepEqual(activeUnitOptions(units).map((option) => option.value), ["打", "个", "码"]);
});

test("选项值为单位名称（销售单存字符串），不是 UUID", () => {
  assert.deepEqual(activeUnitOptions(units)[0], { value: "打", label: "打" });
});

test("重复名称去重，避免下拉出现两个相同选项", () => {
  const duplicated = [...units, { id: "u6", name: "打", isActive: true }];
  assert.deepEqual(activeUnitOptions(duplicated).map((option) => option.value), ["打", "个", "码"]);
});

test("当前值是池内启用单位时原样选中，不额外插入选项", () => {
  const options = unitOptionsWithCurrent(units, "个");
  assert.deepEqual(options.map((option) => option.value), ["打", "个", "码"]);
});

test("当前值单位池里没有时补为历史值，保证编辑旧单据不丢值", () => {
  const options = unitOptionsWithCurrent(units, "箱");
  assert.equal(options[0].value, "箱");
  assert.match(options[0].label, /历史值/);
});

test("当前值对应已停用单位时标注已停用，但仍可选（旧单据回显）", () => {
  const options = unitOptionsWithCurrent(units, "件");
  assert.equal(options[0].value, "件");
  assert.match(options[0].label, /已停用/);
  assert.equal(options.filter((option) => option.value === "件").length, 1);
});

test("没有当前值时就是纯单位池选项", () => {
  assert.deepEqual(unitOptionsWithCurrent(units, undefined), activeUnitOptions(units));
  assert.deepEqual(unitOptionsWithCurrent(units, "   "), activeUnitOptions(units));
});

test("提交体：名称去空格，备注留空时发送 null（否则后端视为“不修改”，清空无效）", () => {
  assert.deepEqual(unitMutationPayload({ name: " 打 ", remark: "" }), { name: "打", remark: null });
  assert.deepEqual(unitMutationPayload({ name: "个" }), { name: "个", remark: null });
  assert.deepEqual(unitMutationPayload({ name: " 码 ", remark: "  长度单位  " }), { name: "码", remark: "长度单位" });
});
