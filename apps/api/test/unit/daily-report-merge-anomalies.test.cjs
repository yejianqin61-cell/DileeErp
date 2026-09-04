const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { ProductionDailyAlertsService } = require("../../dist/modules/production/production-daily-alerts.service.js");

test("daily report merge anomalies can be resolved idempotently with an audit event", async () => {
  const anomaly = { id: "anomaly-1", reportKind: "employee", status: "pending", reportDate: new Date("2026-09-03") };
  const events = [];
  const tx = {
    dailyReportMergeAnomaly: {
      findUnique: async () => anomaly,
      update: async ({ data }) => ({ ...anomaly, ...data }),
    },
    auditEvent: { create: async (event) => events.push(event) },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const audit = { record: async () => undefined };
  const service = new ProductionDailyAlertsService(prisma, audit);
  await assert.rejects(() => service.resolveMergeAnomaly("anomaly-1", "", { id: "user-1" }), UnprocessableEntityException);
  const resolved = await service.resolveMergeAnomaly("anomaly-1", "已核对并保留人工计薪差异", { id: "user-1" });
  assert.equal(resolved.status, "resolved");
  assert.equal(events.length, 1);
});
