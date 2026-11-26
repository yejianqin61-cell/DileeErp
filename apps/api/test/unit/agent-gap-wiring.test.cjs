const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const QUESTION = "各仓库库存多少";
const declare = (id, patch = {}) => ({ id, tool: "report_gap", operation: "declare_gap", args: { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", ...patch } });
const recorder = () => ({ calls: [], async record(input) { this.calls.push(input); } });

async function drive(calls, gapCandidates) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await createPlanningRun(state, "operational", QUESTION);
  const provider = scriptedProvider([() => calls]);
  const executor = { async execute() { throw new Error("不应触达执行器"); } };
  const options = gapCandidates ? { gapCandidates } : undefined;
  await new AgentOrchestrator(state, executor, provider, roleReaderFor("operational"), undefined, options).run(run, principalFor("operational"), new AbortController().signal);
  const saved = db.store.runs.find((row) => row.id === run.id);
  return { run, saved, gaps: db.store.events.filter((event) => event.type === "gap_declared"), toolMessages: provider.answerInputs[0].filter((message) => message.role === "tool") };
}

test("放行的声明进入候选路径一次，带会话与轮次，不带原话", async () => {
  const service = recorder();
  const { run } = await drive([declare("g1")], service);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].sessionId, run.sessionId);
  assert.equal(service.calls[0].runId, run.id);
  assert.equal(service.calls[0].gap.nearest_operation, "list_low_stock_materials");
  assert.equal(JSON.stringify(service.calls[0]).includes(QUESTION), false);
});

test("同批同键只调一次；被驳回的不调", async () => {
  const twice = recorder();
  await drive([declare("g1"), declare("g2", { missing_detail: "分仓库看" })], twice);
  assert.equal(twice.calls.length, 1);
  const rejected = recorder();
  await drive([declare("g1", { nearest_operation: "made_up" })], rejected);
  assert.equal(rejected.calls.length, 0);
});

test("不注入候选服务时行为不变", async () => {
  const { saved, gaps } = await drive([declare("g1")]);
  assert.equal(saved.state, "completed");
  assert.equal(gaps.length, 1);
});

test("候选记录抛错不影响问答", async () => {
  const { saved, toolMessages } = await drive([declare("g1")], { async record() { throw new Error("库不可写"); } });
  assert.equal(saved.state, "completed");
  assert.equal(toolMessages[0].content, '{"result":"已记录"}');
});
