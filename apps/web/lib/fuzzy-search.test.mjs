// 全站共用的模糊搜索匹配规则（纯函数，无需渲染）。
import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch } from "./fuzzy-search.ts";

const material = ["M-001", "涤纶布", "150D", "本白", "米"];

test("空查询不过滤（null / undefined / 纯空白都视为无筛选）", () => {
  for (const query of [null, undefined, "", "   ", "\t\n"]) {
    assert.equal(fuzzyMatch(query, material), true, `查询 ${JSON.stringify(query)} 不应过滤任何行`);
  }
});

test("单词匹配任意字段（编码 / 名称 / 规格 / 颜色 / 单位）", () => {
  for (const query of ["m-001", "涤纶", "150d", "本白", "米"]) {
    assert.equal(fuzzyMatch(query, material), true, `${query} 应命中`);
  }
});

test("大小写与空白不敏感：'150 D' 与 '150d' 等价", () => {
  assert.equal(fuzzyMatch("150 D", material), true);
  assert.equal(fuzzyMatch("  150d  ", material), true);
  assert.equal(fuzzyMatch("M - 001", material), true, "字段内部的空白也被忽略");
});

test("多词是 AND 语义：所有词都必须命中（可跨字段）", () => {
  assert.equal(fuzzyMatch("涤纶 150d", material), true, "两个词分别命中名称与规格");
  assert.equal(fuzzyMatch("涤纶 本白", material), true, "两个词都命中");
  assert.equal(fuzzyMatch("涤纶 尼龙", material), false, "只要有一个词不命中就整体不命中");
  assert.equal(fuzzyMatch("M-001 涤纶 150D 本白 米", material), true, "同一行的多个词都命中");
});

test("查不到就是查不到：不做同音/近义/拼写纠正", () => {
  assert.equal(fuzzyMatch("锦纶", material), false);
  assert.equal(fuzzyMatch("150E", material), false);
});

test("null / undefined / 数字字段安全参与匹配", () => {
  assert.equal(fuzzyMatch("2", ["第", 2, "批", null, undefined]), true);
  assert.equal(fuzzyMatch("2", [null, undefined]), false);
  assert.equal(fuzzyMatch("2", []), false);
});

test("未选规格的物料：查询规格不会误命中", () => {
  const withoutSpec = ["M-002", "松紧带", null, null, "条"];
  assert.equal(fuzzyMatch("松紧", withoutSpec), true);
  assert.equal(fuzzyMatch("150D", withoutSpec), false);
});
