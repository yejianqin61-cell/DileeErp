const test = require("node:test");
const assert = require("node:assert/strict");
const { deduplicateAlerts } = require("../../dist/modules/alerts/alerts.domain.js");

test("G3 deduplicates alerts by source and alert type", () => {
  const rows = [
    { source_type: "production_daily_alert", source_id: "a", alert_type: "over_order", order_no: "SO-1", severity: "high", title: "超单", suggestion: "处理", status: "pending", created_at: new Date("2026-08-23T01:00:00Z") },
    { source_type: "production_daily_alert", source_id: "a", alert_type: "over_order", order_no: "SO-1", severity: "high", title: "超单", suggestion: "处理", status: "pending", created_at: new Date("2026-08-23T02:00:00Z") },
    { source_type: "finished_goods_qc", source_id: "b", alert_type: "qc_rejected", order_no: "SO-2", severity: "high", title: "QC", suggestion: "处理", status: "pending", created_at: new Date("2026-08-23T03:00:00Z") },
  ];
  assert.equal(deduplicateAlerts(rows).length, 2);
});

test("G3 prioritizes high severity alerts", () => {
  const rows = [
    { source_type: "inventory", source_id: "a", alert_type: "inventory_delta", order_no: null, severity: "medium", title: "库存", suggestion: "处理", status: "pending", created_at: new Date("2026-08-23T03:00:00Z") },
    { source_type: "finished_goods_qc", source_id: "b", alert_type: "qc_rejected", order_no: "SO-2", severity: "high", title: "QC", suggestion: "处理", status: "pending", created_at: new Date("2026-08-23T01:00:00Z") },
  ];
  assert.equal(deduplicateAlerts(rows)[0].severity, "high");
});
