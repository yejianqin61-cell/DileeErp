const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");
const { StreamTransport } = require("../../dist/modules/business-query-agent/stream-transport.js");

const operational = { user: { id: "ops", username: "ops", display_name: "员工" }, accessLevel: "operational" };

test("七项财务 operation：operational 全部在任何读库前得到 403", async () => {
  let roleReads = 0;
  const executor = new ToolExecutor({}, { async readActiveRoleKeys() { roleReads += 1; return ["qita"]; } });
  const finance = TOOL_CAPABILITIES.filter((item) => item.tool === "finance_query");
  assert.equal(finance.length, 7);
  for (const capability of finance) {
    await assert.rejects(executor.execute({ tool: capability.tool, operation: capability.operation, args: { order_no: "SO-1" } }, operational), (error) => error.getStatus() === 403, capability.operation);
    assert.equal(capability.minAccess, "full");
    assert.equal(capability.implemented, true);
  }
  assert.equal(roleReads, 0);
});

test("降权重连 SSE：先拒绝、从不读取旧 full run 的事件、只发 ACCESS_REVOKED 后关闭", async () => {
  let eventReads = 0;
  const state = { async eventsAfter() { eventReads += 1; return [{ seq: 1, type: "answer_delta", createdAt: new Date(), payload: { text: "财务金额" } }]; } };
  const response = { writableEnded: false, status() { return this; }, setHeader() {}, flushHeaders() {}, on() {}, write(chunk) { this.output = (this.output ?? "") + chunk; }, end() { this.writableEnded = true; } };
  const transport = new StreamTransport(state, { async readActiveRoleKeys() { return ["qita"]; } });
  await transport.follow(response, { id: "r-full", userId: "u-1", accessLevel: "full" }, 0);
  assert.equal(eventReads, 0);
  assert.match(response.output, /ACCESS_REVOKED/);
  assert.doesNotMatch(response.output, /财务金额/);
  assert.equal(response.writableEnded, true);
});
