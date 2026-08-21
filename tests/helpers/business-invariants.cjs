const assert = require("node:assert/strict");

function context(name, details) {
  return `${name}: ${JSON.stringify(details)}`;
}

function assertOrderNo(name, expected, facts) {
  for (const fact of facts) assert.equal(fact.order_no ?? fact.orderNo, expected, context(name, { expected, actual: fact.order_no ?? fact.orderNo, entity: fact.id }));
}

function assertAudit(name, fact) {
  for (const field of ["createdAt", "updatedAt", "createdBy", "updatedBy"]) assert.ok(fact[field], context(name, { field, entity: fact.id }));
}

function assertQcBalance(name, inspection) {
  const total = [inspection.accepted_quantity ?? inspection.acceptedQuantity, inspection.conditional_quantity ?? inspection.conditionalQuantity, inspection.rejected_quantity ?? inspection.rejectedQuantity]
    .reduce((sum, value) => sum + Number(value ?? 0), 0);
  assert.equal(total, Number(inspection.inspected_quantity ?? inspection.inspectedQuantity), context(name, { inspected: inspection.inspected_quantity ?? inspection.inspectedQuantity, total }));
}

function assertNoDuplicateSource(name, facts, sourceKey = "raw_material_inbound_id") {
  const values = facts.map((fact) => fact[sourceKey]);
  assert.equal(new Set(values).size, values.length, context(name, { sourceKey, values }));
}

function assertInventoryFacts(name, facts, expectedDelta) {
  const actual = facts.reduce((sum, fact) => sum + Number(fact.quantity_delta ?? fact.quantityDelta), 0);
  assert.equal(actual, Number(expectedDelta), context(name, { expectedDelta, actual }));
}

module.exports = { assertAudit, assertInventoryFacts, assertNoDuplicateSource, assertOrderNo, assertQcBalance };
