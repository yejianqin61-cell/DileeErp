// 货号归一与匹配键（`apps/web/lib/item-no.ts`）。
//
// ⚠️ 这份向量表与 `apps/api/test/unit/item-no.test.cjs` 里的**逐条相同**：两个 workspace 没有共享包，
// 靠同一组输入输出把两份镜像实现钉在一起。改一份就要改另一份。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ITEM_NO_MAX_LENGTH, normalizeItemNo, itemNoKey } from "./item-no.ts";

/** 两端共用的向量表：[输入, normalizeItemNo, itemNoKey]。 */
const VECTORS = [
  [null, null, ""],
  [undefined, null, ""],
  ["", null, ""],
  ["   ", null, ""],
  ["\t\n", null, ""],
  ["27621", "27621", "27621"],
  [" 27621 ", "27621", "27621"],
  ["27621\u3000", "27621", "27621"], // 全角空格（现场抄单最常见的空白）
  ["27621 流水花扇", "27621 流水花扇", "27621流水花扇"],
  ["27621\u3000流水花扇", "27621 流水花扇", "27621流水花扇"], // 全角 → 半角空格，便于展示与检索
  ["27621   流水", "27621 流水", "27621流水"],
  ["dl27621", "dl27621", "DL27621"], // 库里保留原样大小写，键统一大写
  ["DL27621", "DL27621", "DL27621"],
  ["27621/2", "27621/2", "27621/2"], // 斜杠是货号的一部分，不是路径分隔符
  ["流水花扇PKGY", "流水花扇PKGY", "流水花扇PKGY"],
];

test("item-no（web）：归一与匹配键的向量表，必须与 api 侧逐条一致", () => {
  for (const [input, normalized, key] of VECTORS) {
    assert.equal(normalizeItemNo(input), normalized, `normalizeItemNo(${JSON.stringify(input)})`);
    assert.equal(itemNoKey(input), key, `itemNoKey(${JSON.stringify(input)})`);
  }
});

test("item-no（web）：同一个货号的几种写法归到一个键（建议列表去重要靠它）", () => {
  const keys = new Set(["27621", " 27621 ", "27621\u3000", "27621 "].map((value) => itemNoKey(value)));
  assert.deepEqual([...keys], ["27621"]);
});

test("item-no（web）：没有货号时键是空串（不是 null）", () => {
  for (const input of [null, undefined, "", "   "]) assert.equal(itemNoKey(input), "");
});

test("item-no（web）：长度上限与数据库列一致（100）", () => {
  assert.equal(ITEM_NO_MAX_LENGTH, 100);
});
