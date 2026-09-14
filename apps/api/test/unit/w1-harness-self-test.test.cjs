// W1 自测：契约 harness 与不变量断言的正确性。
//
// 为什么必须给断言库写测试：断言库一旦"永远通过"，整套链路测试就变成了假安全
// —— 这正是 recon 对前端正则断言文件的批评（见 docs/test/00-recon-frontend-coverage.md）。
// 因此下面既测"能接受合法输入"，也逐条测"能拒绝非法输入"。
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  expectBusinessRuleViolation,
  expectErrorEnvelope,
  expectNoContent,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  login,
} = require("../../../../tests/helpers/api-client.cjs");
const {
  assertAllocationWithinBalance,
  assertAmountBalance,
  assertDecimalEquals,
  assertDecimalTransport,
  assertIdempotentReplay,
  assertNoNegativeInventory,
  assertQcBalance,
  assertReversalPreservesOriginal,
  assertSoftDeletedSourceNotReferenceable,
  assertStateTransition,
  decimalEqual,
} = require("../../../../tests/helpers/business-invariants.cjs");

const envelope = (overrides = {}) => ({ body: { data: [], meta: {} }, requestId: "3f0a4b2c-1d5e-4a7b-8c9d-0e1f2a3b4c5d", status: 200, ...overrides });

test("W1 decimal arithmetic is exact where floats are not", () => {
  // 经典浮点陷阱：0.1 + 0.2 !== 0.3。十进制字符串比较必须给出正确结论。
  assert.equal(0.1 + 0.2 === 0.3, false);
  assertDecimalEquals("float trap", "0.3", "0.1".length ? "0.3" : "0.3");
  assert.ok(decimalEqual("0.1", "0.10"), "trailing zeros must not affect equality");
  assert.ok(decimalEqual("100.0000", "100"));
  assert.ok(decimalEqual("-2.5", "-2.50"));
  assert.ok(!decimalEqual("0.30000000000000004", "0.3"), "float artifact must not compare equal");
  assert.throws(() => assertDecimalEquals("mismatch", "1.0001", "1"), /mismatch/);
});

test("W1 amount balance sums decimal strings without float drift", () => {
  // 三分项各 0.1，总额 0.3 —— 用浮点求和会得到 0.30000000000000004。
  assertAmountBalance("settlement split", "0.3", ["0.1", "0.1", "0.1"]);
  assertAmountBalance("payable amount", "20.0000", ["8", "12"]);
  assert.throws(() => assertAmountBalance("broken split", "0.3", ["0.1", "0.1"]), /broken split/);
});

test("W1 allocation must not exceed the allocatable balance", () => {
  assertAllocationWithinBalance("within balance", [{ amount: "6" }, { amount: "4" }], "10");
  assertAllocationWithinBalance("exact balance", [{ amount: "10" }], "10");
  assert.throws(() => assertAllocationWithinBalance("over allocated", [{ amount: "6" }, { amount: "5" }], "10"), /over allocated/);
});

test("W1 negative inventory is rejected per dimension", () => {
  assertNoNegativeInventory("balanced", [
    { materialId: "m-1", quantityDelta: "10", unitId: "u-1" },
    { materialId: "m-1", quantityDelta: "-4", unitId: "u-1" },
  ]);
  assert.throws(
    () =>
      assertNoNegativeInventory("over issued", [
        { materialId: "m-1", quantityDelta: "3", unitId: "u-1" },
        { materialId: "m-1", quantityDelta: "-4", unitId: "u-1" },
      ]),
    /over issued/,
  );
  // 维度必须独立核算：其它物料的盈余不得掩盖本物料的负库存
  assert.throws(
    () =>
      assertNoNegativeInventory("维度串味", [
        { materialId: "m-1", quantityDelta: "3", unitId: "u-1" },
        { materialId: "m-1", quantityDelta: "-4", unitId: "u-1" },
        { materialId: "m-2", quantityDelta: "5", unitId: "u-1" },
      ]),
    /维度串味/,
  );
  // 各维度各自非负时成立
  assertNoNegativeInventory("各自非负", [
    { materialId: "m-1", quantityDelta: "3", unitId: "u-1" },
    { materialId: "m-2", quantityDelta: "5", unitId: "u-1" },
    { materialId: "m-2", quantityDelta: "-5", unitId: "u-1" },
  ]);
});

test("W1 QC split must add up to the inspected quantity", () => {
  assertQcBalance("accepted only", { acceptedQuantity: "10", conditionalQuantity: "0", inspectedQuantity: "10", rejectedQuantity: "0" });
  assertQcBalance("mixed decimal split", { acceptedQuantity: "0.1", conditionalQuantity: "0.2", inspectedQuantity: "0.3", rejectedQuantity: "0" });
  assert.throws(() => assertQcBalance("unbalanced", { acceptedQuantity: "8", conditionalQuantity: "1", inspectedQuantity: "10", rejectedQuantity: "0" }), /unbalanced/);
});

test("W1 state transitions must be explicitly permitted", () => {
  const allowed = { completed: ["closed", "in_progress"], draft: ["in_progress"], in_progress: ["paused", "completed"] };
  assertStateTransition("legal start", { allowed, from: "draft", to: "in_progress" });
  assert.throws(() => assertStateTransition("skipped step", { allowed, from: "draft", to: "completed" }), /skipped step/);
});

test("W1 idempotent replay must return the same record", () => {
  assertIdempotentReplay("same key", { id: "movement-1" }, { id: "movement-1" });
  assert.throws(() => assertIdempotentReplay("same key", { id: "movement-1" }, { id: "movement-2" }), /same key/);
});

test("W1 reversal must keep the original fact and link the reverse fact back", () => {
  const original = { id: "inbound-1", status: "reversed" };
  const reverseFacts = [{ quantityDelta: "-10", sourceId: "inbound-1" }];
  assertReversalPreservesOriginal("reversed inbound", { original, reverseDeltaEquals: "10", reverseFacts });
  assert.throws(() => assertReversalPreservesOriginal("still posted", { expectedStatus: "reversed", original: { id: "x", status: "posted" }, reverseFacts: [{ sourceId: "x" }] }), /still posted/);
  assert.throws(() => assertReversalPreservesOriginal("dangling reverse", { original: { id: "x", status: "reversed" }, reverseFacts: [{ sourceId: "other" }] }), /dangling reverse/);
});

test("W1 soft-deleted sources must not be referenced by active rows", () => {
  const deleted = { deletedAt: new Date("2026-01-01"), id: "src-1" };
  assertSoftDeletedSourceNotReferenceable("no live reference", deleted, [{ deletedAt: new Date(), sourceId: "src-1" }]);
  assert.throws(() => assertSoftDeletedSourceNotReferenceable("live reference", deleted, [{ sourceId: "src-1" }]), /live reference/);
});

test("W1 money must travel as decimal strings, never floats", () => {
  assertDecimalTransport("unit price", "12.5000", "unit_price");
  assertDecimalTransport("integer quantity", "10", "quantity");
  assert.throws(() => assertDecimalTransport("float amount", 12.5, "amount"), /float amount/);
});

test("W1 success envelope assertion accepts the real shape and rejects deviations", () => {
  expectSuccessEnvelope(envelope());
  expectSuccessEnvelope(envelope({ body: { data: [], meta: { page: 1, page_size: 20, total: 0 } } }), { paginated: true });
  expectSuccessEnvelope(envelope({ body: { data: { id: "1" }, meta: {} }, status: 201 }), { status: 201 });

  assert.throws(() => expectSuccessEnvelope(envelope({ body: { meta: {} } })), /必须含 data/);
  assert.throws(() => expectSuccessEnvelope(envelope({ body: { data: [] } })), /必须含对象型 meta/);
  assert.throws(() => expectSuccessEnvelope(envelope({ body: { data: [], error: {}, meta: {} } })), /不应含 error/);
  assert.throws(() => expectSuccessEnvelope(envelope({ status: 201 })), /期望状态码 200/);
  assert.throws(() => expectSuccessEnvelope(envelope({ body: { data: [], meta: {} } }), { paginated: true }), /分页 meta 缺少 page/);
});

test("W1 error envelope assertion pins the stable code and meta.path contract", () => {
  const failure = { body: { error: { code: "NOT_FOUND", details: [], message: "生产单不存在" }, meta: { path: "/api/v1/production/orders/x" } }, requestId: "3f0a4b2c-1d5e-4a7b-8c9d-0e1f2a3b4c5d", status: 404 };
  expectErrorEnvelope(failure, { code: "NOT_FOUND", status: 404 });

  assert.throws(() => expectErrorEnvelope({ ...failure, body: { meta: { path: "/x" } } }, { code: "NOT_FOUND" }), /必须含 error 对象/);
  assert.throws(() => expectErrorEnvelope({ ...failure, body: { error: { code: "X", details: "no", message: "m" }, meta: { path: "/x" } } }), /details 必须是数组/);
  assert.throws(
    () => expectErrorEnvelope({ ...failure, body: { error: { code: "OTHER", details: [], message: "m" }, meta: { path: "/x" } } }, { code: "NOT_FOUND" }),
    /期望错误码 NOT_FOUND/,
  );
  assert.throws(() => expectErrorEnvelope({ ...failure, body: { error: { code: "X", details: [], message: "m" }, meta: {} } }), /meta.path 必须存在/);
  // 机器码必须是稳定的大写下划线形式：这是前端唯一可依赖的契约面
  assert.throws(() => expectErrorEnvelope({ ...failure, body: { error: { code: "not-a-stable-code", details: [], message: "m" }, meta: { path: "/x" } } }), /大写下划线码/);
});

test("W1 unauthenticated and business-rule assertions use the documented codes", () => {
  expectUnauthenticated({ body: { error: { code: "UNAUTHENTICATED", details: [], message: "Unauthorized" }, meta: { path: "/api/v1/customers" } }, status: 401 });
  expectBusinessRuleViolation({ body: { error: { code: "BUSINESS_RULE_VIOLATION", details: [], message: "库存不足" }, meta: { path: "/api/v1/x" } }, status: 422 });
  // 契约允许 422/409 使用更精确的业务码（global-api-contract.md:69），因此默认封装不固定 code
  expectBusinessRuleViolation({ body: { error: { code: "INSUFFICIENT_INVENTORY", details: [], message: "库存不足" }, meta: { path: "/api/v1/x" } }, status: 422 });
  // 需要精确匹配时显式传 code
  expectBusinessRuleViolation({ body: { error: { code: "INSUFFICIENT_INVENTORY", details: [], message: "库存不足" }, meta: { path: "/api/v1/x" } }, status: 422 }, { code: "INSUFFICIENT_INVENTORY" });
  assert.throws(
    () => expectBusinessRuleViolation({ body: { error: { code: "OTHER_CODE", details: [], message: "m" }, meta: { path: "/x" } }, status: 422 }, { code: "INSUFFICIENT_INVENTORY" }),
    /期望错误码 INSUFFICIENT_INVENTORY/,
  );
});

test("W1 request id header must be a UUID, not merely present", () => {
  expectRequestIdHeader(envelope());
  assert.throws(() => expectRequestIdHeader(envelope({ requestId: null })), /缺少 x-request-id/);
  assert.throws(() => expectRequestIdHeader(envelope({ requestId: "req-1" })), /应为 UUID/);
});

test("W1 logout 204 contract requires an empty body", () => {
  expectNoContent({ body: {}, status: 204 });
  expectNoContent({ body: "", status: 204 });
  assert.throws(() => expectNoContent({ body: { data: null, meta: {} }, status: 204 }), /必须无响应体/);
  assert.throws(() => expectNoContent({ body: {}, status: 200 }), /期望 204/);
});

test("W1 login helper extracts the session cookie and expects 201", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url: String(url) });
    return new Response(JSON.stringify({ data: { user: { id: "u-1" } }, meta: {} }), {
      headers: { "content-type": "application/json", "set-cookie": "dilee_session=tok-abc; Path=/; HttpOnly; SameSite=Lax", "x-request-id": "3f0a4b2c-1d5e-4a7b-8c9d-0e1f2a3b4c5d" },
      status: 201,
    });
  };
  try {
    const session = await login("http://127.0.0.1:3001", { password: "DileeTest2026", username: "admin" });
    assert.equal(session.status, 201);
    // 只保留键值对，丢掉 Path/HttpOnly 等属性，后续请求才能直接复用
    assert.equal(session.cookie, "dilee_session=tok-abc");
    assert.equal(session.requestId, "3f0a4b2c-1d5e-4a7b-8c9d-0e1f2a3b4c5d");
    assert.equal(calls[0].url, "http://127.0.0.1:3001/api/v1/auth/login");
    assert.equal(JSON.parse(calls[0].init.body).username, "admin");
  } finally {
    globalThis.fetch = original;
  }
});
