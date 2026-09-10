// 生产单候选与单位判定回归测试。
// 覆盖用户反馈的现象：已确认销售单还没有 BOM 时，“新建生产单”下拉框为空且没有任何解释；
// 以及生产单单位被错误地强制依赖工序默认单位。
import test from "node:test";
import assert from "node:assert/strict";
import { latestBom, productionCandidates, ordersAwaitingBom, unconfirmedOrders, resolveProductionUnit, productionCandidateHint } from "./production-candidates.ts";

const order = (orderNo, status, boms = [], unit = undefined) => ({ orderNo, quantity: "10", status, unit, boms });

test("只有已确认且已建 BOM 的销售单可作为生产单来源", () => {
  const orders = [
    order("SO-1", "confirmed", [{ id: "bom-1", version: 1 }]),
    order("SO-2", "confirmed", []),
    order("SO-3", "draft", [{ id: "bom-3", version: 1 }])
  ];
  assert.deepEqual(productionCandidates(orders).map((item) => item.orderNo), ["SO-1"]);
  assert.deepEqual(ordersAwaitingBom(orders).map((item) => item.orderNo), ["SO-2"]);
  assert.deepEqual(unconfirmedOrders(orders).map((item) => item.orderNo), ["SO-3"]);
});

test("候选为空时说明缺 BOM，而不是静默留空", () => {
  const hint = productionCandidateHint([order("SO-2", "confirmed", [])]);
  assert.match(hint, /SO-2/);
  assert.match(hint, /BOM/);
  assert.match(hint, /采购/);
});

test("完全没有销售单时提示先去销售模块建单", () => {
  assert.match(productionCandidateHint([]), /销售/);
});

test("有可用候选但另有缺 BOM 订单时仍提示剩余订单", () => {
  const hint = productionCandidateHint([order("SO-1", "confirmed", [{ id: "bom-1", version: 1 }]), order("SO-2", "confirmed", [])]);
  assert.match(hint, /SO-2/);
});

test("全部可就绪时不提示", () => {
  assert.equal(productionCandidateHint([order("SO-1", "confirmed", [{ id: "bom-1", version: 1 }])]), "");
});

test("生产单单位优先取销售单产品单位（打/个/码），不再强制依赖工序默认单位", () => {
  const units = [{ id: "u-da", name: "打" }, { id: "u-ge", name: "个" }, { id: "u-ma", name: "码" }, { id: "u-off", name: "件", isActive: false }];
  const operations = [{ isActive: true, defaultUnitId: "u-ge" }];
  assert.equal(resolveProductionUnit("码", units, operations), "u-ma");
  assert.equal(resolveProductionUnit("打", units, operations), "u-da");
  assert.equal(resolveProductionUnit("件", units, operations), "u-ge", "停用单位不应被选中，退回工序默认单位");
});

test("销售单单位缺失或对不上时退回工序默认单位；都没有则留空交给调用方报错", () => {
  const units = [{ id: "u-ge", name: "个" }];
  assert.equal(resolveProductionUnit(undefined, units, [{ isActive: true, defaultUnitId: "u-ge" }]), "u-ge");
  assert.equal(resolveProductionUnit("箱", units, [{ isActive: true, defaultUnitId: "u-ge" }]), "u-ge");
  assert.equal(resolveProductionUnit("箱", units, [{ isActive: false, defaultUnitId: "u-ge" }]), "");
  assert.equal(resolveProductionUnit(undefined, units, []), "");
});

test("退回的工序默认单位必须仍是启用单位，否则留空而不是让后端报 UNIT_NOT_FOUND", () => {
  const units = [{ id: "u-ge", name: "个", isActive: false }, { id: "u-ma", name: "码", isActive: true }];
  assert.equal(resolveProductionUnit(undefined, units, [{ isActive: true, defaultUnitId: "u-ge" }]), "", "停用的工序默认单位不应被使用");
  assert.equal(resolveProductionUnit(undefined, units, [{ isActive: true, defaultUnitId: "u-unknown" }]), "", "不存在的单位不应被使用");
  assert.equal(resolveProductionUnit("码", units, [{ isActive: true, defaultUnitId: "u-ge" }]), "u-ma", "销售单单位仍然优先");
});

test("BOM 取版本号最大的一张，避免历史版本触发 BOM_VERSION_CHANGED", () => {
  assert.equal(latestBom([{ id: "bom-v1", version: 1 }, { id: "bom-v3", version: 3 }, { id: "bom-v2", version: 2 }]).id, "bom-v3");
  assert.equal(latestBom([]), undefined);
  const boms = [{ id: "bom-v1", version: 1 }];
  assert.equal(latestBom(boms).id, "bom-v1");
  assert.deepEqual(boms.map((bom) => bom.id), ["bom-v1"], "不得就地修改传入数组");
});
