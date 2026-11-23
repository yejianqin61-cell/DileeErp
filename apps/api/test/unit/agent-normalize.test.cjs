const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeKeyword } = require("../../dist/modules/business-query-agent/tools/normalize.js");

test("全角单号折叠成半角", () => {
  assert.equal(normalizeKeyword("ＭＯＣＫ－ＯＲＤ－００１"), "MOCK-ORD-001");
});

test("全角空格包裹照样去掉", () => {
  assert.equal(normalizeKeyword("\u3000MOCK-ORD-001\u3000"), "MOCK-ORD-001");
});

test("零宽字符不参与比对", () => {
  assert.equal(normalizeKeyword("MOCK-ORD-001\u200b"), "MOCK-ORD-001");
});

test("连续空白合并成一个", () => {
  assert.equal(normalizeKeyword("MOCK  ORD-001"), "MOCK ORD-001");
});

test("中文产品名不被改动", () => {
  assert.equal(normalizeKeyword("伞布-蓝色（模拟）"), "伞布-蓝色（模拟）");
});

test("单号里的空格是真实内容，保留", () => {
  assert.equal(normalizeKeyword("DL260170-4H 伞头"), "DL260170-4H 伞头");
});

test("半角单号原样返回", () => {
  assert.equal(normalizeKeyword("MOCK-ORD-001"), "MOCK-ORD-001");
});