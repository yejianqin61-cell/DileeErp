// 生产进度表工序列顺序的单元测试（纯函数，不需要数据库）。
//
// 这一层承载用户 2026-09-15 的要求：「导出生产进度表时允许拖拽调整工序排序，导出的工序 column
// 按这个顺序排」。规则本身在 domain 里，这里钉住三种边界：
//   - 给出的顺序生效；
//   - 没提到的工序按原相对顺序跟在后面（存过顺序 + 后来新增工序时不能丢列）；
//   - 未知 id / 重复 id / 空参数都被安全吸收。
const assert = require("node:assert/strict");
const test = require("node:test");
const { parseOperationOrder, orderProgressColumns } = require("../../dist/modules/production/production-progress-columns.domain.js");

const columns = [{ id: "op-a" }, { id: "op-b" }, { id: "op-c" }, { id: "op-d" }];
const ids = (rows) => rows.map((row) => row.id);

test("parseOperationOrder：逗号分隔、去空白、去重、丢空串", () => {
  assert.deepEqual(parseOperationOrder("op-b, op-a ,,op-b"), ["op-b", "op-a"]);
  assert.deepEqual(parseOperationOrder("   "), []);
  assert.deepEqual(parseOperationOrder(null), []);
  assert.deepEqual(parseOperationOrder(undefined), []);
  assert.equal(parseOperationOrder(Array.from({ length: 300 }, (_, index) => `op-${index}`).join(",")).length, 200, "超长参数被截断，不让它变成无界查询");
});

test("orderProgressColumns：按用户顺序重排，没提到的接在后面", () => {
  assert.deepEqual(ids(orderProgressColumns(columns, ["op-c", "op-a"])), ["op-c", "op-a", "op-b", "op-d"]);
  assert.deepEqual(ids(orderProgressColumns(columns, ["op-d", "op-c", "op-b", "op-a"])), ["op-d", "op-c", "op-b", "op-a"]);
});

test("orderProgressColumns：新增/未知/重复 id 都不会让列消失或重复", () => {
  const withNew = [...columns, { id: "op-e" }];
  assert.deepEqual(ids(orderProgressColumns(withNew, ["op-c", "op-a"])), ["op-c", "op-a", "op-b", "op-d", "op-e"], "新增工序排在后面，不会被丢掉");
  assert.deepEqual(ids(orderProgressColumns(columns, ["op-ghost", "op-b", "op-b", "op-a"])), ["op-b", "op-a", "op-c", "op-d"]);
});

test("orderProgressColumns：空顺序或单列时保持默认（原样返回，不产生无谓的拷贝语义变化）", () => {
  assert.deepEqual(ids(orderProgressColumns(columns, [])), ["op-a", "op-b", "op-c", "op-d"]);
  assert.deepEqual(ids(orderProgressColumns([{ id: "only" }], ["only"])), ["only"]);
  assert.deepEqual(orderProgressColumns([], ["op-a"]), []);
});

test("orderProgressColumns 不改动入参数组（导出时同一批 columns 还要算合计）", () => {
  const source = [...columns];
  orderProgressColumns(source, ["op-d", "op-a"]);
  assert.deepEqual(ids(source), ["op-a", "op-b", "op-c", "op-d"]);
});
