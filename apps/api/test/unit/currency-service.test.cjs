// 币种字典平台服务的单元测试（手写假 Prisma，不连数据库）。
//
// 生产文件：apps/api/src/platform/currency/currency.service.ts
// 决策依据：docs/product/PRD.md「支持多币种，币种为可配置字典」、
//           docs/product/SRS.md「币种……应支持授权用户通过管理接口维护，不写死在前端或后端代码中」、
//           .agent/constitution/constitution.md 的 Configurable Business Categories。
//
// 覆盖的关键行为：
//   1. 只认启用且未软删的 currency 字典项，按 sortOrder/key 排序；
//   2. 不在字典里的编码 → 422 CURRENCY_NOT_SUPPORTED（前端下拉之外的手工请求会被挡住）；
//   3. 字典缺失/为空时放行（部署未迁移不应把全站金额录入锁死）—— 这是刻意的兜底，不是遗漏；
//   4. 空/缺省币种不触发查询（可选币种字段传 undefined 时不做多余 IO）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { CurrencyService, CURRENCY_DICTIONARY_KEY, DEFAULT_CURRENCIES } = require("../../dist/platform/currency/currency.service.js");

/** 记录型假 Prisma：只回答 dictionaryItem.findMany，并记录查询形状。 */
function fakePrisma(rows = []) {
  const calls = [];
  return {
    calls,
    dictionaryItem: {
      async findMany(args) {
        calls.push(args);
        return rows;
      },
    },
  };
}

const serviceWith = (rows) => {
  const prisma = fakePrisma(rows);
  return { prisma, calls: prisma.calls, service: new CurrencyService(prisma) };
};

const codeOf = (error) => error.getResponse().code;

test("currency.listActive_only_reads_active_items_of_the_currency_dictionary_type", async () => {
  const rows = [{ key: "CNY", label: "人民币", sortOrder: 10 }];
  const { service, calls } = serviceWith(rows);
  assert.equal(await service.listActive(), rows, "原样返回 Prisma 结果，不做二次加工");
  assert.deepEqual(calls[0], {
    where: { deletedAt: null, isActive: true, type: { key: CURRENCY_DICTIONARY_KEY, deletedAt: null } },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: { key: true, label: true, sortOrder: true },
  });
  assert.equal(CURRENCY_DICTIONARY_KEY, "currency", "字典 key 必须与前端 /dictionaries/currency/items 一致");
});

test("currency.assertSupported_accepts_an_active_dictionary_code_without_trimming_it_away", async () => {
  const { service } = serviceWith([{ key: "USD", label: "美元", sortOrder: 20 }]);
  await service.assertSupported("USD");
  await service.assertSupported("  USD  ", "采购单币种");
});

test("currency.assertSupported_rejects_a_code_outside_the_dictionary_with_422_and_the_supported_list", async () => {
  const { service } = serviceWith([
    { key: "CNY", label: "人民币", sortOrder: 10 },
    { key: "USD", label: "美元", sortOrder: 20 },
  ]);
  await assert.rejects(
    () => service.assertSupported("RMB", "采购单币种"),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const response = error.getResponse();
      assert.equal(codeOf(error), "CURRENCY_NOT_SUPPORTED");
      assert.match(response.message, /采购单币种/, "错误信息要指出是哪个字段的币种不合规");
      assert.deepEqual(response.details[0], { currency: "RMB", supported: ["CNY", "USD"] });
      return true;
    },
  );
});

test("currency.assertSupported_skips_validation_while_the_dictionary_is_empty", async () => {
  // 刻意的兜底：字典是部署/迁移产物，缺失时不应让全站金额录入不可用。
  // 一旦字典有启用项，就以字典为唯一口径（上一条用例）。
  const { service } = serviceWith([]);
  await service.assertSupported("ANYTHING", "收款币种");
});

test("currency.assertSupported_does_not_query_for_empty_or_missing_codes", async () => {
  const { service, calls } = serviceWith([{ key: "CNY", label: "人民币", sortOrder: 10 }]);
  await service.assertSupported(undefined);
  await service.assertSupported(null);
  await service.assertSupported("");
  await service.assertSupported("   ");
  assert.deepEqual(calls, [], "可选币种字段缺省时不应产生任何查询");
});

test("currency.isSupported_reports_boolean_without_throwing", async () => {
  const { service } = serviceWith([{ key: "CNY", label: "人民币", sortOrder: 10 }]);
  assert.equal(await service.isSupported("CNY"), true);
  assert.equal(await service.isSupported("RMB"), false);
  assert.equal(await service.isSupported(""), false);
  assert.equal(await service.isSupported(undefined), false);
});

test("currency.DEFAULT_CURRENCIES_covers_the_codes_already_used_by_business_data", () => {
  const keys = DEFAULT_CURRENCIES.map((item) => item.key);
  assert.deepEqual([...new Set(keys)], keys, "内置清单不允许重复编码");
  for (const code of ["CNY", "USD", "EUR"]) {
    assert.ok(keys.includes(code), `内置清单必须包含 ${code}（历史单据与既有测试都在用）`);
  }
  for (const item of DEFAULT_CURRENCIES) {
    assert.equal(typeof item.label, "string");
    assert.ok(item.label.length > 0, `${item.key} 必须有中文名，否则下拉里只剩编码`);
    assert.ok(Number.isInteger(item.sortOrder), `${item.key} 必须有整数排序号`);
  }
  assert.equal(DEFAULT_CURRENCIES[0].key, "CNY", "人民币排在第一位：默认币种要选得到它");
});
