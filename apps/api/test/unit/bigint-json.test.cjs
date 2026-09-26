// `installBigIntJson`（platform/http/bigint-json.ts）的测试 —— 2026-09-26 那两处 500 的防线。
//
// 事故现场：`JSON.stringify(BigInt)` 抛 `TypeError: Do not know how to serialize a BigInt`，
//   * `GET /finance/opening-balances` 返回试算平衡的 BigInt 金额 → 500；
//   * `POST /attachments` 返回 Prisma 整行（`attachments.file_size` 是 BigInt）→ 500（附件表当时 0 行，还没被踩到）。
// 两次都不是算错了，而是"算对了却送不出去"。
//
// 注意测试顺序有意义：**第一条必须在安装补丁之前跑**（同一个进程里，补丁装上就摘不掉）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { installBigIntJson } = require("../../dist/platform/http/bigint-json.js");

test("未安装补丁时 JSON.stringify(BigInt) 会抛错（这就是那两个接口 500 的根因）", () => {
  assert.equal(typeof BigInt.prototype.toJSON, "undefined", "补丁不该在 import 时就被装上（安装必须是显式动作）");
  assert.throws(() => JSON.stringify({ amount: 1n }), /Do not know how to serialize a BigInt/);
});

test("安装后：BigInt 序列化成**字符串十进制**，不丢精度", () => {
  installBigIntJson();
  assert.equal(JSON.stringify({ amount: 1n }), '{"amount":"1"}');
  assert.equal(JSON.stringify({ amount: -12345n }), '{"amount":"-12345"}');
  // 用字符串而不是 Number 的理由：超过 2^53 会静默丢精度，那比 500 更难发现。
  assert.equal(JSON.stringify({ amount: 90071992547409931n }), '{"amount":"90071992547409931"}');
  // 与全站金额约定一致（`money.ts` 的 formatUnits 也给字符串）。
  assert.equal(JSON.stringify([1n, "x", null]), '["1","x",null]');
});

test("幂等：重复安装不会把 toJSON 叠起来", () => {
  const once = BigInt.prototype.toJSON;
  installBigIntJson();
  installBigIntJson();
  assert.equal(BigInt.prototype.toJSON, once);
  assert.equal(JSON.stringify(1n), '"1"');
});

test("嵌套结构（Prisma 行形态：BigInt 字段 + 数组 + null）整体可序列化", () => {
  installBigIntJson();
  const row = { id: "a", fileSize: 1024n, links: [{ n: 2n }], remark: null };
  assert.equal(JSON.stringify(row), '{"id":"a","fileSize":"1024","links":[{"n":"2"}],"remark":null}');
});
