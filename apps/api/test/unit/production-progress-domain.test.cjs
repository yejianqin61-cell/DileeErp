const assert = require("node:assert/strict");
const { test } = require("node:test");
const { aggregateMeasurementRows, calculateQuantityProgress, deriveOrderProgressStatus } = require("../../dist/modules/production/production-progress.domain.js");

test("quantity progress uses exact decimal arithmetic and preserves over-order", () => {
  assert.deepEqual(calculateQuantityProgress("3.30", "3.31"), {
    planned_quantity: "3.3",
    actual_quantity: "3.31",
    difference_quantity: "-0.01",
    over_order_quantity: "0.01",
    completion_rate: "1.0030303030303030303",
    status: "over_order",
  });
});

test("cancelled rows do not contribute to aggregates and mixed units are explicit", () => {
  const result = aggregateMeasurementRows([
    { order_no: "SO-1", production_order_id: "po-1", production_order_no: "MO-1", source_type: "operation_report", source_id: "r-1", unit: "个", planned_quantity: "10", actual_quantity: "4", execution_mode: "in_house" },
    { order_no: "SO-1", production_order_id: "po-1", production_order_no: "MO-1", source_type: "operation_report", source_id: "r-2", unit: "个", planned_quantity: "10", actual_quantity: "1", execution_mode: "in_house", cancelled: true },
    { order_no: "SO-1", production_order_id: "po-2", production_order_no: "MO-2", source_type: "outsource_direct_shipment", source_id: "s-1", unit: "箱", planned_quantity: "0", actual_quantity: "2", execution_mode: "outsourced" },
  ]);
  assert.equal(result.groups[0].actual_quantity, "4");
  assert.deepEqual(result.warnings, ["mixed_units"]);
});

test("order status prioritizes blockers and exposes unavailable downstream capabilities", () => {
  assert.equal(deriveOrderProgressStatus({ has_production_orders: true, has_started_production: true, all_production_complete: true, blockers: ["daily_discrepancy"] }).status, "blocked");
  assert.deepEqual(deriveOrderProgressStatus({ has_production_orders: true, has_started_production: true, all_production_complete: true, has_finished_goods_source: true, qc_capability_available: false }).capability_not_implemented, ["quality_control"]);
  assert.equal(deriveOrderProgressStatus({ has_production_orders: true, has_started_production: true, all_production_complete: true, has_finished_goods_source: true, qc_capability_available: true, shipping_capability_available: true }).status, "ready_to_ship");
});
