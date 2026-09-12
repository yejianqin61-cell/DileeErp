// 领料单 / 补料单接口路径的行为测试。
//
// 背景：补料单（MC-）的创建与过账路径和领料单（MI-）不同，
// 而「领料单/补料单」列表页与生产单详情的领料面板都同时列出两种单据。
// 之前列表页的「过账出库」写死了 /post，补料单点过账必然 422（该单据不是领料单）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMovementPath,
  isMaterialMovementDocumentType,
  movementEditorHref,
  postMovementPath,
} from "./material-slip-api.ts";

test("识别单据类型只接受领料单与补料单", () => {
  assert.equal(isMaterialMovementDocumentType("issue"), true);
  assert.equal(isMaterialMovementDocumentType("replenishment"), true);
  for (const value of ["return", "scrap", "reversal", "", null, undefined, "ISSUE"]) {
    assert.equal(isMaterialMovementDocumentType(value), false, `${String(value)} 不应被当成可领料类型`);
  }
});

test("创建路径：领料单走 material-movements，补料单走 replenishments", () => {
  assert.equal(createMovementPath("issue"), "/production/material-movements");
  assert.equal(createMovementPath("replenishment"), "/production/material-movements/replenishments");
  assert.equal(createMovementPath(undefined), "/production/material-movements");
});

test("过账路径：补料单必须走 post-replenishment，否则服务端 422", () => {
  assert.equal(postMovementPath("issue", "m1"), "/production/material-movements/m1/post");
  assert.equal(postMovementPath("replenishment", "m1"), "/production/material-movements/m1/post-replenishment");
  assert.equal(postMovementPath(undefined, "m1"), "/production/material-movements/m1/post");
});

test("编辑页链接：补料单带 type，草稿带 movement_id，续开带 production_order_id", () => {
  assert.equal(movementEditorHref("issue"), "/production/material-issues/new");
  assert.equal(movementEditorHref("replenishment"), "/production/material-issues/new?type=replenishment");
  assert.equal(
    movementEditorHref("issue", { movementId: "m1" }),
    "/production/material-issues/new?movement_id=m1",
  );
  assert.equal(
    movementEditorHref("replenishment", { movementId: "m2", productionOrderId: "p1" }),
    "/production/material-issues/new?type=replenishment&movement_id=m2&production_order_id=p1",
  );
  assert.equal(
    movementEditorHref("issue", { productionOrderId: "p1" }),
    "/production/material-issues/new?production_order_id=p1",
  );
});
