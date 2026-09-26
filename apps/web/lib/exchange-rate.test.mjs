// 期末汇率面板纯逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 用户 2026-09-24：「1,3,4 都要」的第 ④ 件 —— 期末汇率表 + 外币折算。
// 四件事：
//   ① 汇率按「整数 1e-8」精确解析/格式化（比金额多 4 位小数：汇率是乘数，精度不够会被报表当成汇率变动）；
//   ② 保存的请求体是**整批**（这张表就是「这个月的汇率」），丢掉整行空白、币种统一大写；
//   ③ 拦在保存前的问题一次说完：期间非法 / 缺币种 / **本币不需要汇率** / 同币种重复 / 汇率非法；
//   ④ 「回退」提示要说清楚：本期没维护时报表用不晚于它的最近一个月折算，而不是不折算。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyRateRow,
  formatRate,
  isRatePeriod,
  nextRateRowKey,
  parseRate,
  previousRatePeriod,
  rateBlockers,
  rateFallbackNote,
  ratePayload,
  rateRowsFromApi,
  rateSummary,
} from "./exchange-rate.ts";

const row = (extra = {}) => ({ ...emptyRateRow(nextRateRowKey()), ...extra });

test("exchange-rate：汇率按 1e-8 精确解析与格式化（0 与超过 8 位小数一律拒绝）", () => {
  assert.equal(parseRate("7"), 700000000n);
  assert.equal(parseRate(" 7.1234 "), 712340000n);
  assert.equal(parseRate("0.00000001"), 1n, "最小的一档汇率（1e-8）必须能存");
  assert.equal(parseRate("7.12345678"), 712345678n);
  assert.equal(parseRate("7.123456789"), null, "超过 8 位小数直接拒，不静默截断");
  assert.equal(parseRate("0"), null, "0 汇率会把整张报表乘成 0 —— 最坏的一种静默");
  assert.equal(parseRate("-7"), null);
  assert.equal(parseRate("七"), null);
  assert.equal(formatRate(712345678n), "7.12345678");
  assert.equal(formatRate(700000000n), "7", "去掉无意义的尾零");
  assert.equal(formatRate(1n), "0.00000001");
});

test("exchange-rate：期间解析（YYYY-MM，月份 1–12）与上一期", () => {
  assert.equal(isRatePeriod("2026-09"), true);
  assert.equal(isRatePeriod("2026-9"), false, "必须是两位月份（与后端同一口径）");
  assert.equal(isRatePeriod("2026-13"), false);
  assert.equal(isRatePeriod("2026-09-30"), false);
  assert.equal(previousRatePeriod("2026-09"), "2026-08");
  assert.equal(previousRatePeriod("2026-01"), "2025-12");
});

test("exchange-rate：后端行 → 编辑器行；保存请求体是整批且丢掉整行空白", () => {
  const editor = rateRowsFromApi([{ currency: "USD", rate: "7.1234", remark: null }]);
  assert.equal(editor.length, 1);
  assert.equal(editor[0].remark, "", "备注 null → 空串（受控输入不能是 null）");

  const payload = ratePayload("2026-09", [
    row({ currency: "usd", rate: "7.1234 ", remark: " 中国银行 " }),
    row({ currency: "", rate: "", remark: "" }),
    row({ currency: "HKD", rate: "0.91" }),
  ]);
  assert.equal(payload.period, "2026-09");
  assert.deepEqual(payload.rows, [
    { currency: "USD", rate: "7.1234", remark: "中国银行" },
    { currency: "HKD", rate: "0.91", remark: undefined },
  ], "整批提交（服务层按期间整批替换）：没出现的币种会被软删");
});

test("exchange-rate：保存前把问题一次说完（期间/币种/本币/重复/汇率）", () => {
  assert.deepEqual(rateBlockers([], "2026-09"), [], "空表不拦（整批替换成空 = 这一期不维护汇率）");
  assert.deepEqual(rateBlockers([row({ currency: "USD", rate: "7" })], "2026-9"), ["请选择汇率期间（YYYY-MM）"]);

  const problems = rateBlockers([
    row({ currency: "USD", rate: "7" }),
    row({ currency: "usd", rate: "7.1" }),
    row({ currency: "CNY", rate: "1" }),
    row({ currency: "EUR", rate: "abc" }),
    row({ currency: "HKD", rate: "" }),
    row({ currency: "", rate: "9" }),
  ], "2026-09");
  assert.deepEqual(problems, [
    "第 2 行币种 USD 重复了（一个期间一个币种只能有一条汇率）",
    "第 3 行是本币 CNY：本币不需要汇率",
    "第 4 行汇率必须是大于零的数字（最多 8 位小数）",
    "第 5 行请填写汇率（1 HKD = ? CNY）",
    "第 6 行请填写币种",
  ]);
});

test("exchange-rate：小计与「回退到哪一期」的提示（报表不会因为没维护就报错，会回退并写明）", () => {
  assert.deepEqual(rateSummary([row({ currency: "USD", rate: "7" }), row({ currency: "EUR", rate: "abc" }), row({})]), { count: 1, invalid: 1 });

  assert.equal(rateFallbackNote("2026-09", ["2026-09", "2026-08"]), "2026-09 的汇率已维护，报表用这一期折算");
  assert.equal(rateFallbackNote("2026-10", ["2026-09", "2026-08"]), "2026-10 还没维护：报表会回退用 2026-09 的汇率折算，并在表尾写明");
  assert.equal(rateFallbackNote("2026-07", ["2026-09"]), "2026-07 还没有汇率：报表不会折算这个月的外币，会把缺的币种写在表尾");
  assert.equal(rateFallbackNote("2026-7", ["2026-09"]), "", "期间还不合法时不给提示（先让她把期间填对）");
});
