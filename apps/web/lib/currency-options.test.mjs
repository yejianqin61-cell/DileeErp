// lib/currency-options.ts 的纯逻辑测试（node:test，与其它 lib 测试同一套约定）。
//
// 覆盖的关键行为：
//   1. 字典项 → 选项（过滤停用、按 sortOrder 排序、去重）；
//   2. 字典为空/请求失败时回落到内置清单（页面永远有可选项）；
//   3. 历史值兜底：库里存在但字典里没有的币种必须保留为「（历史值）」，否则编辑旧单据被迫改币种。
import assert from "node:assert/strict";
import test from "node:test";
import { currencyOptions, currencyOptionsWithCurrent, defaultCurrency, FALLBACK_CURRENCIES } from "./currency-options.ts";

const dictionary = [
  { key: "USD", label: "美元", sortOrder: 20, isActive: true },
  { key: "CNY", label: "人民币", sortOrder: 10, isActive: true },
  { key: "EUR", label: "欧元", sortOrder: 30, isActive: true },
];

test("currencyOptions: 按 sortOrder 排序并拼成「编码 名称」", () => {
  assert.deepEqual(currencyOptions(dictionary), [
    { value: "CNY", label: "CNY 人民币" },
    { value: "USD", label: "USD 美元" },
    { value: "EUR", label: "EUR 欧元" },
  ]);
});

test("currencyOptions: 停用项被过滤，不留任何入口", () => {
  const options = currencyOptions([...dictionary, { key: "JPY", label: "日元", sortOrder: 40, isActive: false }]);
  assert.equal(options.some((option) => option.value === "JPY"), false);
});

test("currencyOptions: 重复编码只保留一个选项", () => {
  const options = currencyOptions([{ key: "CNY", label: "人民币", sortOrder: 10 }, { key: "CNY", label: "人民币（重复）", sortOrder: 99 }]);
  assert.equal(options.filter((option) => option.value === "CNY").length, 1);
});

test("currencyOptions: 缺少名称时只显示编码，不出现悬空空格", () => {
  assert.deepEqual(currencyOptions([{ key: "CNY" }]), [{ value: "CNY", label: "CNY" }]);
});

test("currencyOptions: 空字典 / 未加载时回落到内置清单，页面永远有可选项", () => {
  for (const input of [undefined, null, []]) {
    const options = currencyOptions(input);
    assert.equal(options.length, FALLBACK_CURRENCIES.length);
    assert.equal(options[0].value, "CNY");
    // 内置清单必须包含业务已在用的人民币与美元
    assert.deepEqual(options.filter((option) => ["CNY", "USD"].includes(option.value)).map((option) => option.value).sort(), ["CNY", "USD"]);
  }
});

test("currencyOptionsWithCurrent: 当前值在字典里时不额外加选项", () => {
  assert.deepEqual(currencyOptionsWithCurrent(dictionary, "CNY"), currencyOptions(dictionary));
});

test("currencyOptionsWithCurrent: 字典里没有的历史币种被保留并标注（历史值）", () => {
  const options = currencyOptionsWithCurrent(dictionary, "RMB");
  assert.deepEqual(options[0], { value: "RMB", label: "RMB（历史值）" });
  assert.equal(options.length, dictionary.length + 1);
});

test("currencyOptionsWithCurrent: 空当前值不产生空选项", () => {
  for (const current of [undefined, null, "", "   "]) {
    assert.deepEqual(currencyOptionsWithCurrent(dictionary, current), currencyOptions(dictionary));
  }
});

test("defaultCurrency: 优先当前值，其次首选币种，最后第一个可选值", () => {
  assert.equal(defaultCurrency(dictionary, "USD"), "USD");
  assert.equal(defaultCurrency(dictionary, ""), "CNY");
  assert.equal(defaultCurrency(dictionary, undefined, "EUR"), "EUR");
  // 首选币种不在字典里时退回第一个可选值，保证 defaultValue 一定落在 options 内
  assert.equal(defaultCurrency([{ key: "HKD", label: "港币", sortOrder: 1 }], "", "CNY"), "HKD");
  // 字典为空时回落到内置清单，CNY 一定存在
  assert.equal(defaultCurrency(undefined, ""), "CNY");
});
