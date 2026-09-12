// 财务页「编辑草稿」的请求方法回归检查。
//
// 背景：finance/page.tsx 的 action() 只发 POST，但应收来源 / 收款 / 付款 / 应付条目的
// 草稿编辑接口在 API 里只注册了 PATCH（finance.controller.ts 的 @Patch(".../:id")），
// 于是每次「编辑 → 保存」都是 404 Cannot POST ...，「保存失败」但看不出原因。
// 这里固化：四个编辑入口必须显式走 PATCH。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const page = readFileSync(fileURLToPath(new URL("../app/finance/page.tsx", import.meta.url)), "utf8");
const lineWith = (needle) => page.split("\n").find((line) => line.includes(needle)) ?? "";

test("action() 支持显式指定 PATCH", () => {
  assert.match(page, /method: "post" \| "patch" = "post"/);
  assert.match(page, /apiPatch\(path, body \?\? \{\}\)/);
});

test("应收 / 收款 / 付款 / 应付草稿的编辑都走 PATCH", () => {
  for (const [name, needle] of [
    ["编辑应收草稿", "function editReceivable"],
    ["编辑收款/付款草稿", "function editPayment"],
    ["编辑应付草稿", "function editPayable"],
  ]) {
    const line = lineWith(needle);
    assert.ok(line, `找不到 ${name}（${needle}）`);
    assert.match(line, /, "patch"\) \}\); \}/, `${name} 必须用 PATCH，否则 API 返回 404`);
  }
});

test("过账/确认/取消/冲销等动作仍然走 POST", () => {
  for (const needle of ["/post`, { allocations", "/reopen`, { reason", `{ reason: v.reason }, "支付已冲销"`]) {
    const line = lineWith(needle);
    assert.ok(line, `找不到动作入口（${needle}）`);
    assert.doesNotMatch(line, /, "patch"\)/, `${needle} 不应改成 PATCH`);
  }
});
