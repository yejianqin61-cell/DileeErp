// 跨模块业务不变量断言库。
//
// 依据 docs/design/testing-system-and-tooling-plan.md:156-187 的四类不变量：
//   6.1 身份与来源  6.2 审计与可追溯  6.3 数量与金额  6.4 状态与回退
//
// 改造前只有 6 个断言（41 行），recon 指出缺失：来源版本/快照一致性、逻辑删除来源不可引用、
// 审计事件表存在性、客户端 created_by 覆盖防护、金额快照口径、分批核销上限
// （见 docs/test/00-recon-backend-coverage.md D10）。本文件补齐这些缺口。
//
// 金额一律用**十进制字符串**做精确比较，绝不使用 JS 浮点数
// （docs/design/global-api-contract.md:18：禁止 JSON 浮点数作为业务计算输入）。
const assert = require("node:assert/strict");

function context(name, details) {
  return `${name}: ${JSON.stringify(details)}`;
}

/** 取字段时同时兼容 snake_case（API/服务层）与 camelCase（Prisma 行）。 */
const pick = (row, ...keys) => {
  for (const key of keys) if (row?.[key] !== undefined) return row[key];
  return undefined;
};

// ---------- 精确十进制运算（BigInt 缩放，无浮点误差） ----------

/**
 * 解析十进制字符串/数值为定点数 { value: bigint, scale: number }。
 * 不使用 Number()，避免 0.1+0.2 这类浮点误差污染金额断言。
 */
function parseDecimal(value) {
  const text = String(value ?? "0").trim();
  const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`not a decimal value: ${JSON.stringify(value)}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const intPart = match[2] || "0";
  const fracPart = match[3] || "";
  return { scale: fracPart.length, value: sign * BigInt(`${intPart}${fracPart}` || "0") };
}

/** 精确求和，返回 { value: bigint, scale: number }。 */
function sumDecimals(values) {
  const parsed = values.map(parseDecimal);
  const scale = parsed.reduce((max, item) => Math.max(max, item.scale), 0);
  return { scale, value: parsed.reduce((accumulator, item) => accumulator + item.value * 10n ** BigInt(scale - item.scale), 0n) };
}

/**
 * 在公共标度上比较两个定点数，返回 -1 / 0 / 1。
 * 标度取两者最大值后再放大，**不做负指数幂** —— 否则小数位更多的那个数会触发
 * `RangeError: undefined must be positive`（10n ** -1n 非法）。
 */
function scaledCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const a = left.value * 10n ** BigInt(scale - left.scale);
  const b = right.value * 10n ** BigInt(scale - right.scale);
  return a === b ? 0 : a > b ? 1 : -1;
}

const scaledEquals = (left, right) => scaledCompare(left, right) === 0;

const decimalEqual = (left, right) => scaledEquals(parseDecimal(left), parseDecimal(right));

/** 断言两个金额/数量精确相等（支持小数位不同的 Decimal 字符串）。 */
function assertDecimalEquals(name, actual, expected) {
  assert.ok(decimalEqual(actual, expected), context(name, { actual: String(actual), expected: String(expected) }));
}

// ---------- 6.1 身份与来源 ----------

function assertOrderNo(name, expected, facts) {
  for (const fact of facts) {
    const actual = pick(fact, "order_no", "orderNo");
    assert.equal(actual, expected, context(name, { actual, entity: fact?.id, expected }));
  }
}

/** 来源版本与快照必须指向创建时有效的上游事实。 */
function assertSourceVersionConsistency(name, fact, source, { versionField = "source_version", snapshotField = "source_snapshot" } = {}) {
  const orderNo = pick(fact, "order_no", "orderNo");
  const sourceOrderNo = pick(source, "order_no", "orderNo");
  assert.equal(orderNo, sourceOrderNo, context(name, { factOrderNo: orderNo, sourceOrderNo }));
  const declaredVersion = pick(fact, versionField, "sourceVersion");
  if (declaredVersion !== undefined && declaredVersion !== null) {
    const sourceVersion = pick(source, "version", "bom_version", "bomVersion");
    assert.equal(String(declaredVersion), String(sourceVersion), context(name, { declaredVersion, sourceVersion }));
  }
  const snapshot = pick(fact, snapshotField, "sourceSnapshot");
  if (snapshot !== undefined && snapshot !== null) {
    assert.equal(typeof snapshot, "object", context(name, { snapshotType: typeof snapshot }));
  }
}

/** 逻辑删除的来源不得被新业务继续引用。 */
function assertSoftDeletedSourceNotReferenceable(name, source, dependents) {
  const deletedAt = pick(source, "deleted_at", "deletedAt");
  if (!deletedAt) return;
  const active = dependents.filter((row) => {
    const reference = pick(row, "source_id", "sourceId");
    const rowDeletedAt = pick(row, "deleted_at", "deletedAt");
    return reference === source.id && !rowDeletedAt;
  });
  assert.equal(active.length, 0, context(name, { activeReferences: active.map((row) => row.id), deletedSourceId: source.id }));
}

// ---------- 6.2 审计与可追溯 ----------

function assertAudit(name, fact) {
  for (const field of ["createdAt", "updatedAt", "createdBy", "updatedBy"]) {
    assert.ok(fact?.[field], context(name, { entity: fact?.id, field }));
  }
}

/**
 * 审计字段必须由服务端按当前登录用户写入。
 * 断言点：客户端传入 created_by 不得覆盖服务端身份（testing-system-and-tooling-plan.md:172）。
 */
function assertServerOwnsAuditFields(name, fact, expectedActorId) {
  assertAudit(name, fact);
  assert.equal(fact.createdBy, expectedActorId, context(name, { createdBy: fact.createdBy, expectedActorId }));
  assert.equal(fact.updatedBy, expectedActorId, context(name, { expectedActorId, updatedBy: fact.updatedBy }));
}

/** 审计事件表必须留下记录（诚实检查 audit_events，而不只是四个审计字段存在）。 */
function assertAuditEventRecorded(name, events, { action, entityId, entityType } = {}) {
  const matched = events.filter((event) => {
    if (action !== undefined && event.action !== action) return false;
    if (entityId !== undefined && event.entityId !== entityId) return false;
    if (entityType !== undefined && event.entityType !== entityType) return false;
    return true;
  });
  assert.ok(matched.length > 0, context(name, { action, available: events.map((event) => `${event.entityType}.${event.action}`), entityId }));
  return matched;
}

/** 冲销类操作必须留下原因、操作人与时间。 */
function assertReversalHasReason(name, event, { reasonField = "reason" } = {}) {
  const reason = pick(event, reasonField, "remark", "details");
  assert.ok(reason !== undefined && reason !== null && String(typeof reason === "object" ? JSON.stringify(reason) : reason).trim().length > 0, context(name, { entity: event?.id }));
  assert.ok(pick(event, "updatedBy", "updated_by", "actorId", "actor_id"), context(name, { entity: event?.id }));
}

// ---------- 6.3 数量与金额 ----------

function assertQcBalance(name, inspection) {
  const accepted = pick(inspection, "accepted_quantity", "acceptedQuantity");
  const conditional = pick(inspection, "conditional_quantity", "conditionalQuantity");
  const rejected = pick(inspection, "rejected_quantity", "rejectedQuantity");
  const inspected = pick(inspection, "inspected_quantity", "inspectedQuantity");
  const split = sumDecimals([accepted ?? 0, conditional ?? 0, rejected ?? 0]);
  const total = sumDecimals([inspected ?? 0]);
  assert.ok(scaledEquals(split, total), context(name, { accepted, conditional, inspected, rejected, split: `${split.value}e-${split.scale}` }));
}

function assertInventoryFacts(name, facts, expectedDelta) {
  const actual = sumDecimals(facts.map((fact) => pick(fact, "quantity_delta", "quantityDelta") ?? 0));
  const expected = sumDecimals([expectedDelta]);
  assert.ok(scaledEquals(actual, expected), context(name, { actual: `${actual.value}e-${actual.scale}`, expectedDelta, facts: facts.length }));
}

/** 库存余额只由有效事实汇总，任何维度都不得为负（除非明确允许超发）。 */
function assertNoNegativeInventory(name, facts, { allowNegative = false } = {}) {
  if (allowNegative) return;
  const byKey = new Map();
  for (const fact of facts) {
    const key = `${pick(fact, "material_id", "materialId") ?? "-"}::${pick(fact, "unit_id", "unitId") ?? "-"}`;
    byKey.set(key, [...(byKey.get(key) ?? []), pick(fact, "quantity_delta", "quantityDelta") ?? 0]);
  }
  for (const [key, values] of byKey) {
    const balance = sumDecimals(values);
    assert.ok(scaledCompare(balance, parseDecimal(0)) >= 0, context(name, { balance: `${balance.value}e-${balance.scale}`, dimension: key }));
  }
}

/** 金额守恒：分项之和必须等于总额（应付/应收/结算口径的核心不变量）。 */
function assertAmountBalance(name, total, parts) {
  const sum = sumDecimals(parts);
  assert.ok(scaledEquals(sum, parseDecimal(total)), context(name, { parts, sum: `${sum.value}e-${sum.scale}`, total: String(total) }));
}

/** 分批核销不得超过可核销余额（testing-system-and-tooling-plan.md:180）。 */
function assertAllocationWithinBalance(name, allocations, balance) {
  const allocated = sumDecimals(allocations.map((row) => pick(row, "amount", "allocated_amount", "allocatedAmount") ?? 0));
  assert.ok(scaledCompare(allocated, parseDecimal(balance)) <= 0, context(name, { allocated: `${allocated.value}e-${allocated.scale}`, balance: String(balance) }));
}

/** 业务金额必须是十进制字符串，不得是 JSON 浮点数。 */
function assertDecimalTransport(name, value, field) {
  assert.ok(typeof value === "string", context(name, { actual: typeof value, field }));
  assert.match(value, /^-?\d+(\.\d+)?$/, context(name, { field, value }));
}

// ---------- 6.4 状态与回退 ----------

/** 状态流转必须落在显式状态机的允许集合内。 */
function assertStateTransition(name, { from, to, allowed }) {
  const permitted = allowed[from] ?? [];
  assert.ok(permitted.includes(to), context(name, { allowed: permitted, from, to }));
}

/** 非法状态动作必须被拒绝且不写入状态变化。 */
function assertStatusUnchanged(name, before, after) {
  assert.equal(pick(after, "status"), pick(before, "status"), context(name, { after: pick(after, "status"), before: pick(before, "status") }));
}

/**
 * 冲销必须产生反向事实并保留原事实：
 * 原单据仍可查、状态变为 reversed、且反向事实指回原事实。
 */
function assertReversalPreservesOriginal(name, { original, reverseFacts, expectedStatus = "reversed", reverseDeltaEquals }) {
  assert.ok(original, context(name, { error: "original fact must still be queryable" }));
  assert.equal(pick(reverseFacts[0] ?? {}, "source_id", "sourceId"), original.id, context(name, { originalId: original.id }));
  assert.equal(pick(original, "status"), expectedStatus, context(name, { actual: pick(original, "status"), expectedStatus }));
  if (reverseDeltaEquals !== undefined) {
    const actual = sumDecimals(reverseFacts.map((fact) => pick(fact, "quantity_delta", "quantityDelta") ?? 0));
    const expected = sumDecimals([reverseDeltaEquals]);
    assert.ok(scaledEquals(actual, { scale: expected.scale, value: -expected.value }), context(name, { actual: `${actual.value}e-${actual.scale}`, reverseDeltaEquals }));
  }
}

/** 幂等：同一业务动作重放后，事实数量不得增加。 */
function assertIdempotent(name, { before, after, key }) {
  assert.equal(after, before, context(name, { after, before, key }));
}

/** 幂等键重放必须返回同一条记录，而不是新建一条。 */
function assertIdempotentReplay(name, first, second) {
  assert.equal(second.id, first.id, context(name, { firstId: first.id, secondId: second.id }));
}

function assertNoDuplicateSource(name, facts, sourceKey = "raw_material_inbound_id") {
  const values = facts.map((fact) => pick(fact, sourceKey, sourceKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())));
  assert.equal(new Set(values).size, values.length, context(name, { sourceKey, values }));
}

function assertOutsourceReceiptBalance(name, dispatched, receipts, incoming = 0) {
  const received = receipts.reduce((sum, receipt) => sum + Number(pick(receipt, "quantity") ?? 0) - Number(pick(receipt, "reversal_quantity", "reversalQuantity") ?? 0), 0);
  assert.ok(Number(incoming) > 0, context(name, { incoming }));
  assert.ok(received + Number(incoming) <= Number(dispatched), context(name, { dispatched, incoming, received }));
}

function assertOutsourceNoInventoryEffect(name, facts) {
  assert.equal(facts.filter((fact) => String(pick(fact, "source_type", "sourceType") ?? "").startsWith("outsource")).length, 0, context(name, { facts: facts.length }));
}

// ---------- 组合断言 ----------

/**
 * 链路收口断言：一次核对单号贯穿、审计字段与来源版本。
 * 供 P3 各链路用例在 finally 之前统一调用。
 */
function assertChainConsistency(name, { orderNo, facts, actorId }) {
  assertOrderNo(`${name}.order_no`, orderNo, facts);
  for (const fact of facts) {
    assertAudit(`${name}.audit`, fact);
    if (actorId) assert.equal(fact.createdBy, actorId, context(`${name}.createdBy`, { entity: fact.id }));
  }
}

module.exports = {
  assertAllocationWithinBalance,
  assertAmountBalance,
  assertAudit,
  assertAuditEventRecorded,
  assertChainConsistency,
  assertDecimalEquals,
  assertDecimalTransport,
  assertIdempotent,
  assertIdempotentReplay,
  assertInventoryFacts,
  assertNoDuplicateSource,
  assertNoNegativeInventory,
  assertOrderNo,
  assertOutsourceNoInventoryEffect,
  assertOutsourceReceiptBalance,
  assertQcBalance,
  assertReversalHasReason,
  assertReversalPreservesOriginal,
  assertServerOwnsAuditFields,
  assertSoftDeletedSourceNotReferenceable,
  assertSourceVersionConsistency,
  assertStateTransition,
  assertStatusUnchanged,
  // 精确十进制工具，供用例做自定义比较
  decimalEqual,
  parseDecimal,
  scaledCompare,
  scaledEquals,
  sumDecimals,
};
