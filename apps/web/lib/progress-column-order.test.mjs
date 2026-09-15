// 生产进度表工序列顺序的纯逻辑测试（node:test 直跑 .ts，与 lib 其余测试同口径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyColumnOrder,
  isDefaultColumnOrder,
  moveColumn,
  parseStoredColumnOrder,
  progressColumnOrderKey,
  serializeColumnOrder,
} from "./progress-column-order.ts";

const columns = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
// 注意：本文件是 .mjs，Node 的类型擦除只作用于 .ts —— 这里不能写类型标注（被导入的 .ts 可以）。
const ids = (rows) => rows.map((row) => row.id);

test("按用户顺序重排：给出的顺序在前，没提到的按原相对顺序接在后面", () => {
  assert.deepEqual(ids(applyColumnOrder(columns, ["c", "a"])), ["c", "a", "b", "d"]);
  assert.deepEqual(ids(applyColumnOrder(columns, ["d", "c", "b", "a"])), ["d", "c", "b", "a"]);
});

test("新增的工序不会因为存过顺序而消失（没提到的排后面）", () => {
  const withNew = [...columns, { id: "e" }];
  assert.deepEqual(ids(applyColumnOrder(withNew, ["c", "a"])), ["c", "a", "b", "d", "e"]);
});

test("未知 id 与重复 id 都不影响结果；空顺序 = 保持默认", () => {
  assert.deepEqual(ids(applyColumnOrder(columns, ["ghost", "b", "b", "a"])), ["b", "a", "c", "d"]);
  assert.deepEqual(ids(applyColumnOrder(columns, [])), ["a", "b", "c", "d"]);
});

test("isDefaultColumnOrder 只在顺序真的改变时返回 false（决定要不要往 URL 塞参数）", () => {
  assert.equal(isDefaultColumnOrder(columns, []), true);
  assert.equal(isDefaultColumnOrder(columns, ["a", "b", "c", "d"]), true);
  assert.equal(isDefaultColumnOrder(columns, ["a", "b"]), true, "只提到前两列、顺序没变 → 仍是默认");
  assert.equal(isDefaultColumnOrder(columns, ["b", "a"]), false);
});

test("移动：拖拽与上移/下移共用，越界夹到两端", () => {
  assert.deepEqual(moveColumn(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], 0, 99), ["b", "c", "a"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], -1, 0), ["a", "b", "c"], "非法下标原地不动，不抛异常");
});

test("存取：只认自己写过的字符串数组，坏数据当没设置过", () => {
  const key = progressColumnOrderKey("SO-1");
  assert.equal(key, "dilee:progress-columns:SO-1");
  assert.equal(serializeColumnOrder(["b", "a", "b", ""]), '["b","a"]');
  assert.deepEqual(parseStoredColumnOrder('["b","a"]'), ["b", "a"]);
  assert.deepEqual(parseStoredColumnOrder('{"a":1}'), [], "对象不是顺序");
  assert.deepEqual(parseStoredColumnOrder("[1,2]"), [], "非字符串元素被丢掉");
  assert.deepEqual(parseStoredColumnOrder("not json"), [], "坏 JSON 不能抛到调用方");
  assert.deepEqual(parseStoredColumnOrder(null), []);
  assert.deepEqual(parseStoredColumnOrder(undefined), []);
});
