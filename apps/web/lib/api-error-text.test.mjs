// 「把校验失败的原因说清楚」的单元测试。
//
// 由来：后端一直有字段级 details，但页面只显示 `cause.message`，于是四种完全不同的错误
// （明细数量不是数字 / 明细缺品名 / 未知字段 / 必填为空）在界面上长得一模一样。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientError } from "./api-client.ts";
import { apiErrorText, fieldLabel, validationDetailLines } from "./api-error-text.ts";

const validationError = (details) => new ApiClientError("VALIDATION_ERROR", "请求参数校验失败", details);

test("字段路径人话化：完整路径优先，其次去下标取叶子，取不到就原样显示", () => {
  const labels = { quantity: "数量", spec_details: "细分明细", "spec_details[0].color": "首行颜色" };
  assert.equal(fieldLabel("spec_details[0].color", labels), "首行颜色", "登记了完整路径就优先用它");
  assert.equal(fieldLabel("spec_details[0].quantity", labels), "数量", "去掉 [0] 后用叶子字段名");
  assert.equal(fieldLabel("spec_details[1]", labels), "细分明细", "指向整行时用数组本身的标签");
  assert.equal(fieldLabel("fabric_usage_canopy", labels), "fabric_usage_canopy", "表里没有的键原样显示，不许吞");
  assert.equal(fieldLabel("", labels), "");
});

test("逐条原因：带 field 的拼成「字段：原因」，不带的直接用原因", () => {
  const lines = validationDetailLines(
    [{ field: "spec_details[0].quantity", message: "明细数量必须是不小于 0 的十进制数" }, { message: "page_size must not be greater than 200" }],
    { quantity: "数量" },
  );
  assert.deepEqual(lines, ["数量：明细数量必须是不小于 0 的十进制数", "page_size must not be greater than 200"]);
});

test("业务异常里的结构化 details（不是给人读的句子）不会被当成错误提示", () => {
  // 例如 INSUFFICIENT_INVENTORY 的 details 是 { available: "3" }，没有 message。
  assert.deepEqual(validationDetailLines([{ available: "3" }]), []);
  assert.deepEqual(validationDetailLines(undefined), []);
  assert.deepEqual(validationDetailLines("not-an-array"), []);
  assert.deepEqual(validationDetailLines([{ field: "x", message: "   " }]), [], "空白 message 不算原因");
});

test("apiErrorText：带上 details 时把原因接在 message 后面；没有 details 时只说 message", () => {
  assert.equal(
    apiErrorText(validationError([{ field: "fabric_usage_canopy", message: "布量必须是不小于 0 的十进制数" }]), "保存失败", { fabric_usage_canopy: "伞面布量" }),
    "请求参数校验失败：伞面布量：布量必须是不小于 0 的十进制数",
  );
  assert.equal(apiErrorText(validationError([]), "保存失败"), "请求参数校验失败", "没有可读 details 时不该多出一个空冒号");
  assert.equal(apiErrorText(validationError([{ available: 3 }]), "保存失败"), "请求参数校验失败");
});

test("apiErrorText：不是信封错误（网络中断等）时退回 fallback", () => {
  assert.equal(apiErrorText(new Error("Failed to fetch"), "保存失败"), "保存失败");
  assert.equal(apiErrorText(new TypeError("boom"), "保存失败"), "保存失败");
  assert.equal(apiErrorText("字符串异常", "保存失败"), "保存失败");
  assert.equal(apiErrorText(undefined, "保存失败"), "保存失败");
  assert.equal(apiErrorText(null, "保存失败"), "保存失败");
});

test("apiErrorText：ApiClientError 的 details 非法时不抛错", () => {
  assert.equal(apiErrorText(new ApiClientError("X", "出错了", null), "保存失败"), "出错了");
});
