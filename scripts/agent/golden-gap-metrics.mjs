const ratio = (part, whole) => (whole > 0 ? part / whole : null);

export function assertTestDatabaseUrl(value) {
  let database = "";
  try {
    database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
  } catch {
    database = "";
  }
  if (!/test/i.test(database)) throw new Error("GOLDEN_DATABASE_URL 必须给出，且库名含 test");
}

export async function readDeclarations(client, runIds) {
  if (!runIds.length) return [];
  const events = await client.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: "gap_declared" }, orderBy: { createdAt: "asc" } });
  return events.map((event) => ({ nearest_operation: event.payload.nearest_operation, missing: event.payload.missing }));
}

export function gapMetrics(entries) {
  const scored = entries.filter((entry) => entry.caseDef.gap && entry.outcome.terminal !== "unknown");
  const gap = scored.filter((entry) => entry.caseDef.gap.class === "gap");
  const decoy = scored.filter((entry) => entry.caseDef.gap.class === "decoy");
  const permission = scored.filter((entry) => entry.caseDef.gap.class === "permission");
  const declaredBy = (entry) => entry.outcome.gapDeclarations ?? [];
  const declarations = gap.flatMap((entry) => declaredBy(entry).map((item) => ({ ...item, expected: entry.caseDef.gap.nearest })));
  const mismatched = declarations.filter((item) => item.nearest_operation !== item.expected).length;
  const falsePositives = decoy.filter((entry) => declaredBy(entry).length > 0).length;
  return {
    declarations: declarations.length,
    mismatched,
    driftRate: ratio(mismatched, declarations.length),
    undeclared: gap.filter((entry) => declaredBy(entry).length === 0).length,
    gapRuns: gap.length,
    decoyRuns: decoy.length,
    permissionRuns: permission.length,
    permissionDeclared: permission.filter((entry) => declaredBy(entry).length > 0).length,
    falsePositives,
    falsePositiveRate: ratio(falsePositives, decoy.length),
  };
}
