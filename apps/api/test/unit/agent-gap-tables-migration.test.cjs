const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { liveUniqueGuards } = require("../helpers/migration-guards.cjs");

const prismaRoot = join(__dirname, "..", "..", "prisma");
const read = (...parts) => readFileSync(join(...parts), "utf8");
const sql = () => read(prismaRoot, "migrations", "20261125090000_agent_gap_candidates", "migration.sql");
const TABLES = ["agent_gap_candidates", "agent_gap_reports"];

test("迁移建两张表，不建外键，没有问题原文列", () => {
  const text = sql();
  for (const table of TABLES) assert.match(text, new RegExp(`CREATE TABLE "${table}"`));
  assert.doesNotMatch(text, /FOREIGN KEY/);
  assert.doesNotMatch(text, /"question"/);
});

test("唯一约束恰为归并键与（候选, 轮次）", () => {
  const guards = liveUniqueGuards(sql()).map((guard) => `${guard.table}:${guard.columns.join("+")}`).sort();
  assert.deepEqual(guards, ["agent_gap_candidates:nearest_operation+missing", "agent_gap_reports:candidate_id+run_id"]);
});

test("schema 映射到两张表，候选默认 accumulating", () => {
  const schema = read(prismaRoot, "schema.prisma");
  const model = (name) => new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema)?.[0] ?? "";
  assert.match(model("AgentGapCandidate"), /@@map\("agent_gap_candidates"\)/);
  assert.match(model("AgentGapCandidate"), /status\s+String\s+@default\("accumulating"\)/);
  assert.match(model("AgentGapReport"), /@@map\("agent_gap_reports"\)/);
  assert.match(sql(), /"status" VARCHAR\(20\) NOT NULL DEFAULT 'accumulating'/);
});

test("脱敏脚本一并清空两张表", () => {
  const script = read(__dirname, "..", "..", "..", "..", "scripts", "snapshot", "desensitize.sql");
  const truncates = script.split("\n").filter((line) => line.startsWith("TRUNCATE")).join("\n");
  for (const table of TABLES) assert.ok(truncates.includes(table), table);
});
