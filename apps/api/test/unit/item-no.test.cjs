// 货号归一与匹配键（`apps/api/src/modules/sales/item-no.ts`）。
//
// 这一组向量同时被 web 侧镜像实现（`apps/web/lib/item-no.ts`）的测试使用 —— 两个 workspace
// 之间没有共享包（本仓库既有约定），所以用**同一组输入输出**把两份实现钉在一起，
// 而不是靠"读一遍代码看看一样不一样"。改这里的向量就要同时改 web 侧那份。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ITEM_NO_MAX_LENGTH, normalizeItemNo, itemNoKey, itemNoKeyOrNull } = require("../../dist/modules/sales/item-no.js");

/** 两端共用的向量表：[输入, normalizeItemNo, itemNoKey]。 */
const VECTORS = [
  [null, null, ""],
  [undefined, null, ""],
  ["", null, ""],
  ["   ", null, ""],
  ["\t\n", null, ""],
  ["27621", "27621", "27621"],
  [" 27621 ", "27621", "27621"],
  ["27621　", "27621", "27621"], // 全角空格（现场抄单最常见的空白）
  ["27621 流水花扇", "27621 流水花扇", "27621流水花扇"],
  ["27621　流水花扇", "27621 流水花扇", "27621流水花扇"], // 全角 → 半角空格，便于展示与检索
  ["27621   流水", "27621 流水", "27621流水"],
  ["dl27621", "dl27621", "DL27621"], // 库里保留原样大小写，键统一大写
  ["DL27621", "DL27621", "DL27621"],
  ["27621/2", "27621/2", "27621/2"], // 斜杠是货号的一部分，不是路径分隔符
  ["流水花扇PKGY", "流水花扇PKGY", "流水花扇PKGY"],
];

test("item-no：归一与匹配键的向量表（api 与 web 共用同一组）", () => {
  for (const [input, normalized, key] of VECTORS) {
    assert.equal(normalizeItemNo(input), normalized, `normalizeItemNo(${JSON.stringify(input)})`);
    assert.equal(itemNoKey(input), key, `itemNoKey(${JSON.stringify(input)})`);
  }
});

test("item-no：匹配键把「同一个货号的几种写法」归到一个键", () => {
  const keys = new Set(["27621", " 27621 ", "27621　", "27621 "].map((value) => itemNoKey(value)));
  assert.deepEqual([...keys], ["27621"], "这四种写法必须是同一个货号，否则返单会把历次批次拆成两组");
});

test("item-no：归一不改大小写、不删内部空格（库里存的是人能读的原样）", () => {
  assert.equal(normalizeItemNo("  dl27621 流水  "), "dl27621 流水");
  // 只有当**匹配**时才丢掉大小写与空白。
  assert.equal(itemNoKey("  dl27621 流水  "), "DL27621流水");
});

test("item-no：不猜相近写法（DL27621 与 27621 是两个货号）", () => {
  assert.notEqual(itemNoKey("DL27621"), itemNoKey("27621"));
  assert.notEqual(itemNoKey("27621/2"), itemNoKey("27621"));
});

test("item-no：没有货号时键是空串，可为空的入口给 null", () => {
  for (const input of [null, undefined, "", "   "]) {
    assert.equal(itemNoKey(input), "", "Map 的键用空串，不要用 null");
    assert.equal(itemNoKeyOrNull(input), null);
  }
  assert.equal(itemNoKeyOrNull(" 27621 "), "27621");
});

test("item-no：长度上限与数据库列一致（100）", () => {
  assert.equal(ITEM_NO_MAX_LENGTH, 100);
});
