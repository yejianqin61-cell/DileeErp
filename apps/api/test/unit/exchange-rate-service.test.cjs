// 期末汇率服务的测试（用户 2026-09-24「1,3,4 都要」的第 ④ 件：期末汇率表 + 外币折算）。
//
// 无可用 PostgreSQL，用手写 Prisma 替身验证服务层规则（谁被写、谁被拦），不验证 SQL。
// 这里钉四件事：
//   ① **整批替换**：这次没出现的旧币种要软删、出现的 upsert（含把软删的行**恢复**回来 ——
//      唯一索引不区分软删，删了再加同一币种必须走更新）；
//   ② 校验：币种必填、**本币拒绝**（CNY 对自身恒为 1，录进来只会多一个「用哪条」的歧义）、
//      汇率必须是大于零的十进制、最多 8 位小数、同币种不许重复；
//   ③ 解析：`resolveRateOf` 按「不晚于该期间的最近一条」回退（9 月没维护就用 8 月的），
//      而不是拿未来汇率折过去的余额，也不是「没汇率就不折算」静默丢钱；
//   ④ 精度：汇率 1e-8、折算四舍五入到 1e-4，且**负数（红冲）对称**（不对称会冲不平）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  ExchangeRateService,
  monthOf,
  previousMonth,
  rateBookOf,
  resolveRateOf,
  resolvedPeriodOf,
} = require("../../dist/modules/finance/exchange-rate.service.js");
const { LOCAL_RATE_UNITS, convertUnits, formatRateUnits, formatUnits, toRateUnits, toUnits } = require("../../dist/modules/finance/money.js");

const audit = () => ({
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-24"), deletedBy: "user-1" }),
  record: async () => {},
});

const USER = { id: "user-1", username: "caiwu", display_name: "小叶" };

/** 汇率服务替身：记录写入与软删的行。 */
function harness({ existing = [] } = {}) {
  const created = [];
  const updated = [];
  const tx = {
    exchangeRate: {
      findMany: async () => existing,
      create: async ({ data }) => { created.push(data); return { id: `er-${created.length}`, ...data }; },
      update: async ({ where, data }) => { updated.push({ id: where.id, data }); return { id: where.id, ...data }; },
    },
  };
  const prisma = { exchangeRate: { findMany: async () => existing, findFirst: async () => null }, $transaction: async (fn) => fn(tx) };
  return { service: new ExchangeRateService(prisma, audit()), created, updated };
}

test("期末汇率：整批替换 —— 新币种建、旧币种软删、软删过的同一币种被恢复（而不是再插一条）", async () => {
  const { service, created, updated } = harness({
    existing: [
      { id: "er-usd", currency: "USD", deletedAt: null },
      { id: "er-eur", currency: "EUR", deletedAt: null },
      { id: "er-hkd", currency: "HKD", deletedAt: new Date("2026-09-01"), deletedBy: "user-1" },
    ],
  });
  const result = await service.replaceAll({ period: "2026-09", rows: [{ currency: "usd", rate: "7.1234" }, { currency: "HKD", rate: "0.91" }] }, USER);

  assert.equal(result.period, "2026-09");
  assert.equal(result.saved, 2);
  assert.equal(result.removed, 1, "这次没出现的 EUR 被软删");
  assert.deepEqual(updated.filter((row) => row.data.deletedAt).map((row) => row.id), ["er-eur"]);
  const hkd = updated.find((row) => row.id === "er-hkd");
  assert.equal(hkd.data.deletedAt, null, "软删过的 HKD 被恢复（唯一索引不区分软删，不能新插一条）");
  assert.equal(hkd.data.rate.toString(), "0.91");
  const usd = updated.find((row) => row.id === "er-usd");
  assert.equal(usd.data.rate.toString(), "7.1234");
  assert.equal(created.length, 0, "没有新币种");
  assert.equal(usd.data.period, undefined, "同一期间内替换不该再写 period");
});

test("期末汇率：币种必填、本币拒绝、汇率必须是大于零的十进制（最多 8 位）、同币种不许重复", async () => {
  const { service } = harness();
  const run = (rows, period = "2026-09") => assert.rejects(() => service.replaceAll({ period, rows }, USER));

  await run([{ currency: "  ", rate: "7" }]);
  await run([{ currency: "CNY", rate: "1" }]);
  await run([{ currency: "USD", rate: "0" }], "2026-09");
  await run([{ currency: "USD", rate: "-7" }]);
  await run([{ currency: "USD", rate: "7.123456789" }], "2026-09");
  await run([{ currency: "USD", rate: "七" }]);
  await run([{ currency: "USD", rate: "7" }, { currency: "usd", rate: "7.1" }]);
  await run([{ currency: "USD", rate: "7" }], "2026-13");
  await run([{ currency: "USD", rate: "7" }], "2026/09");

  const codes = [];
  for (const rows of [[{ currency: "CNY", rate: "1" }], [{ currency: "USD", rate: "7.123456789" }], [{ currency: "USD", rate: "7" }, { currency: "USD", rate: "7" }]]) {
    await service.replaceAll({ period: "2026-09", rows }, USER).catch((error) => codes.push(typeof error.getResponse === "function" ? error.getResponse().code : error.message));
  }
  assert.deepEqual(codes, ["LOCAL_CURRENCY_RATE", "INVALID_RATE", "EXCHANGE_RATE_DUPLICATED"]);
});

test("期末汇率：期间解析与「不晚于该期间的最近一条」回退（不拿未来汇率折过去的余额）", () => {
  assert.equal(monthOf("2026-09-30"), "2026-09");
  assert.equal(monthOf("2026-09"), "2026-09");
  assert.equal(previousMonth("2026-09"), "2026-08");
  assert.equal(previousMonth("2026-01"), "2025-12", "跨年");
  assert.throws(() => monthOf("2026-13"), /INVALID_RATE_PERIOD|汇率期间无效/);

  const book = rateBookOf([
    { currency: "USD", period: "2026-08", rate: "7" },
    { currency: "USD", period: "2026-09", rate: "7.2" },
    { currency: "EUR", period: "2026-09", rate: "8" },
  ]);
  assert.equal(formatRateUnits(resolveRateOf(book, "USD", "2026-09")), "7.2");
  assert.equal(formatRateUnits(resolveRateOf(book, "USD", "2026-10")), "7.2", "10 月没维护 → 用最近一条（9 月）");
  assert.equal(resolveRateOf(book, "USD", "2026-07"), null, "7 月之前没有汇率 → null（上层写进表尾），不许瞎猜");
  assert.equal(resolveRateOf(book, "HKD", "2026-09"), null, "从没维护过的币种");
  assert.equal(resolvedPeriodOf(book, "USD", "2026-10"), "2026-09", "表尾要写明用的是 9 月的汇率");
});

test("期末汇率：折算精度（1e-8 汇率 × 1e-4 金额 → 1e-4，四舍五入，负数对称）", () => {
  assert.equal(formatRateUnits(toRateUnits("7.12345678")), "7.12345678");
  assert.equal(toRateUnits("7.123456789"), null, "超过 8 位小数直接拒绝，不静默截断");
  assert.equal(toRateUnits("0"), null);
  assert.equal(formatRateUnits(LOCAL_RATE_UNITS), "1");

  // 100.0001 × 7.12345678 = 712.3463903... → 712.3464（四舍五入到 1e-4；汇率本身留 8 位是为了这笔乘积）
  // 注意金额用 `toUnits`（1e-4）、汇率用 `toRateUnits`（1e-8）：两个精度混用正是这个函数最容易写错的地方。
  assert.equal(formatUnits(convertUnits(toUnits("100.0001"), toRateUnits("7.12345678"))), "712.3464");
  assert.equal(formatUnits(convertUnits(toUnits("-100.0001"), toRateUnits("7.12345678"))), "-712.3464", "红冲对称：不对称会让凭证冲不平");
  assert.equal(convertUnits(toRateUnits("100"), LOCAL_RATE_UNITS), toRateUnits("100"), "本币汇率 1 折算后分毫不变");
  assert.equal(formatUnits(convertUnits(0n, toRateUnits("7.2"))), "0");
});

test("期末汇率：纯函数 rateBookOf 保留多条并按币种分组（解析时自己挑「不晚于」的那条）", () => {
  const book = rateBookOf([
    { currency: "USD", period: "2026-07", rate: { toString: () => "6.9" } },
    { currency: "USD", period: "2026-09", rate: { toString: () => "7.2" } },
    { currency: "USD", period: "2026-10", rate: { toString: () => "0" } },
  ]);
  assert.equal(book.get("USD").length, 2, "非法（0）那条被跳过，不让它把整张表乘成 0");
  assert.deepEqual(book.get("USD").map((entry) => entry.period), ["2026-07", "2026-09"]);
});
