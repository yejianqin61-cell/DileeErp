import assert from "node:assert/strict";
import { test } from "node:test";

import { assertTestDatabaseUrl, gapMetrics, readDeclarations } from "./golden-gap-metrics.mjs";

const declare = (nearest) => ({ nearest_operation: nearest, missing: "group_by" });
const entry = (kind, declarations, terminal = "completed") => ({
  caseDef: { id: `${kind}-1`, group: "gap", gap: { class: kind, nearest: "get_payables" } },
  outcome: { terminal, gapDeclarations: declarations },
});

test("三轮声明：一致、不一致、未声明", () => {
  const result = gapMetrics([entry("gap", [declare("get_payables")]), entry("gap", [declare("get_receivables")]), entry("gap", [])]);
  assert.equal(result.declarations, 2);
  assert.equal(result.mismatched, 1);
  assert.equal(result.driftRate, 0.5);
  assert.equal(result.undeclared, 1);
  assert.equal(result.gapRuns, 3);
});

test("一轮两条声明逐条计", () => {
  const result = gapMetrics([entry("gap", [declare("get_payables"), declare("list_documents")])]);
  assert.equal(result.declarations, 2);
  assert.equal(result.mismatched, 1);
});

test("干扰题误报按轮次计，unknown 不进分母", () => {
  const result = gapMetrics([entry("decoy", [declare("get_payables"), declare("list_documents")]), entry("decoy", []), entry("decoy", []), entry("decoy", [declare("x")], "unknown")]);
  assert.equal(result.decoyRuns, 3);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falsePositiveRate, 1 / 3);
  assert.equal(result.declarations, 0);
});

test("没有任何声明或没有缺口题时比率为 null", () => {
  assert.equal(gapMetrics([entry("gap", [])]).driftRate, null);
  const none = gapMetrics([{ caseDef: { id: "a", group: "entry" }, outcome: { terminal: "completed" } }]);
  assert.equal(none.driftRate, null);
  assert.equal(none.falsePositiveRate, null);
  assert.equal(none.gapRuns, 0);
});

test("按轮次号读出缺口声明", async () => {
  const queries = [];
  const client = { agentRunEvent: { async findMany(query) { queries.push(query); return [{ payload: { nearest_operation: "get_payables", missing: "group_by", missing_detail: "x" } }, { payload: { nearest_operation: "list_documents", missing: "filter" } }]; } } };
  const result = await readDeclarations(client, ["r-1", "r-2"]);
  assert.deepEqual(result, [{ nearest_operation: "get_payables", missing: "group_by" }, { nearest_operation: "list_documents", missing: "filter" }]);
  assert.deepEqual(queries[0].where, { runId: { in: ["r-1", "r-2"] }, type: "gap_declared" });
  assert.deepEqual(await readDeclarations(client, []), []);
  assert.equal(queries.length, 1);
});

test("只接受库名带 test 的连接串", () => {
  assert.doesNotThrow(() => assertTestDatabaseUrl("postgresql://u:p@127.0.0.1:55499/dilee_test?schema=public"));
  for (const url of ["postgresql://u:p@127.0.0.1:5432/dilee_erp", "postgresql://test:p@127.0.0.1:5432/dilee_erp?schema=test", undefined, "乱码"]) {
    assert.throws(() => assertTestDatabaseUrl(url), /GOLDEN_DATABASE_URL/, String(url));
  }
});

test("权限题单独计，不进漂移、漏报与误报", () => {
  const result = gapMetrics([entry("permission", [declare("list_documents")]), entry("permission", []), entry("permission", [declare("x")], "unknown")]);
  assert.equal(result.permissionRuns, 2);
  assert.equal(result.permissionDeclared, 1);
  assert.equal(result.declarations, 0);
  assert.equal(result.gapRuns, 0);
  assert.equal(result.undeclared, 0);
  assert.equal(result.falsePositives, 0);
});
