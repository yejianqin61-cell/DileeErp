// 领料单 / 补料单接口路径的行为测试。
//
// 背景：补料单（MC-）的创建与过账路径和领料单（MI-）不同，
// 而「领料单/补料单」列表页与生产单详情的领料面板都同时列出两种单据。
// 之前列表页的「过账出库」写死了 /post，补料单点过账必然 422（该单据不是领料单）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  canCrossOrderIssue,
  createMovementPath,
  crossOrderStockLabel,
  crossOrderStockPath,
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

test("跨订单调料权限：必须同时有生产与仓库模块（前端只决定是否显示入口）", () => {
  assert.equal(canCrossOrderIssue(null), false);
  assert.equal(canCrossOrderIssue({ module_keys: ["production"] }), false);
  assert.equal(canCrossOrderIssue({ module_keys: ["production", "warehouse"] }), true);
  assert.equal(canCrossOrderIssue({ module_keys: ["warehouse"] }), true, "后端同时要求 production+warehouse；前端入口只看仓库模块，生产页面本身已受生产模块守卫");
});

test("跨订单库存检索路径：带生产单与物料名称关键词，并做 URL 编码", () => {
  assert.equal(crossOrderStockPath("po-1", "伞布"), "/production/material-movements/cross-order-stock?production_order_id=po-1&keyword=%E4%BC%9E%E5%B8%83");
  assert.equal(crossOrderStockPath("", ""), "/production/material-movements/cross-order-stock");
});

test("跨订单候选文案：物料、规格、来源生产单/订单号与来源可用量都要显示", () => {
  const label = crossOrderStockLabel({
    material_id: "m-1", material_code: "RM-1", material_name: "伞布", specification_model: "58cm", color: "藏青",
    unit_id: "u-1", unit_name: "码", supplier_id: "s-1", supplier_name: "供应商甲",
    source_production_order_id: "po-2", source_production_order_no: "MO-002", source_order_no: "SO-002",
    source_available_quantity: "6", inventory_quantity: "6",
  });
  assert.match(label, /伞布/);
  assert.match(label, /58cm/);
  assert.match(label, /来源 MO-002（SO-002）/);
  assert.match(label, /可用 6码/);
  assert.match(label, /供应商甲/);
});
