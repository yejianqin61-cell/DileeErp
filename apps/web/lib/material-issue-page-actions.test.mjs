// 领料单/补料单页面的操作入口回归检查。
//
// 背景：该页面此前只能查看与导出，「草稿」单据没有任何操作入口，
// 既不能过账出库（草稿 → 出库），也不能冲销/重新打开，导致用户
// 「无法把单据从草稿转成出库状态，也无法推进仓库领料出库」。
//
// 本页同时列出领料单（issue）与补料单（replenishment），二者过账接口不同：
// 之前写死 /post，补料单点「过账出库」必然 422（该单据不是领料单）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const page = readFileSync(fileURLToPath(new URL("../app/production/material-issues/page.tsx", import.meta.url)), "utf8");

test("领料单页面可以对草稿过账出库并删除", () => {
  assert.match(page, /postMovementPath\(slip\.documentType, slip\.id\)/, "过账必须按单据类型选路径");
  assert.doesNotMatch(page, /material-movements\/\$\{slip\.id\}\/post`/, "不能再写死 /post");
  assert.match(page, /过账出库/);
  assert.match(page, /slip\.status === "draft"/);
  assert.match(page, /method: "DELETE"/);
});

test("草稿「编辑」跳转到全屏编辑页并带上单据类型", () => {
  assert.match(page, /movementEditorHref\(slip\.documentType, \{ movementId: slip\.id \}\)/);
});

test("同一生产单可续开多张领料单/补料单", () => {
  assert.match(page, /movementEditorHref\("issue", \{ productionOrderId: slip\.productionOrderId \}\)/);
  assert.match(page, /movementEditorHref\("replenishment", \{ productionOrderId: slip\.productionOrderId \}\)/);
});

test("领料单页面可以对已过账单据重新打开与冲销", () => {
  assert.match(page, /\/reopen`, \{ reason: values\.reason \}/);
  assert.match(page, /\/reverse`, \{ reason: values\.reason, idempotency_key/);
  assert.match(page, /slip\.status === "posted"/);
});

test("过账出库后发出变更事件，便于生产单页刷新库存与进度", () => {
  assert.match(page, /window\.dispatchEvent\(new Event\("dilee:material-movement-changed"\)\)/);
});
