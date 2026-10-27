// Agent 编排器的单元测试（真状态管理器 + 内存假 Prisma + 假 provider/执行器）。
//
// 编排器是唯一运行入口：planning → querying → responding → completed，
// 所有异常落终态，取消后迟到的结果写不进终态（模块设计「Agent orchestrator」行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");

const USER_A = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = { user: { id: USER_A, username: "worker", display_name: "员工" }, accessLevel: "operational" };

/** 与 agent-state-manager.test.cjs 同一套内存假 Prisma（复制而非共享，保持测试文件自足）。 */
function createPrisma() {
  const store = { runs: [], events: [], sessions: [] };
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    const value = row[key];
    if (expected && typeof expected === "object" && Array.isArray(expected.in)) return expected.in.includes(value);
    if (expected && typeof expected === "object" && expected.gt !== undefined) return value > expected.gt;
    return value === expected;
  });
  const db = {
    store,
    agentSession: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.sessions.push(row); return row; },
      findMany: async ({ where = {} } = {}) => store.sessions.filter((row) => matches(row, where)),
    },
    agentRun: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.runs.push(row); return row; },
      findFirst: async ({ where = {} } = {}) => store.runs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} } = {}) => store.runs.filter((row) => matches(row, where)),
      updateMany: async ({ where = {}, data }) => { const matched = store.runs.filter((row) => matches(row, where)); for (const row of matched) Object.assign(row, data, { updatedAt: new Date() }); return { count: matched.length }; },
    },
    agentRunEvent: {
      findMany: async ({ where = {}, orderBy } = {}) => { const rows = store.events.filter((row) => matches(row, where)); if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq); if (orderBy?.seq === "desc") rows.sort((a, b) => b.seq - a.seq); return rows; },
      createMany: async ({ data }) => { for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() }); return { count: data.length }; },
    },
  };
  // $transaction 回调拿到同一个 db：与真实 Prisma 交互事务同构（状态与事件同事务）。
  db.$transaction = async (fn) => fn(db);
  return db;
}

const FACT = {
  operation: "search_orders", order_no: null, as_of: "2026-10-25T00:00:00.000Z",
  data: [{ order_no: "SO-001", product_name: "手机壳", quantity: "100", unit: "个", status: "confirmed", delivery_date: "2026-11-01T00:00:00.000Z" }],
  sources: [{ business_type: "sales_order", business_no: "SO-001", queried_at: "2026-10-25T00:00:00.000Z" }],
  access_level: "operational",
};

/** 假执行器：记录调用，可配置抛错 / 按调用返回事实。 */
function fakeExecutor({ error = null, factForCall = null } = {}) {
  const calls = [];
  return {
    calls,
    async execute(call, principal, signal) {
      calls.push({ call, principalAccess: principal.accessLevel });
      if (error) throw error;
      const fact = factForCall ? factForCall(call, principal) : FACT;
      return { ...fact, access_level: principal.accessLevel };
    },
  };
}

/** 假 provider：plan 默认第一轮返回一次 search_orders、之后返回空（多步循环的回归底线）；streamAnswer 产出 chunk。 */
function fakeProvider({ planCalls = null, onChunk = null } = {}) {
  const planInputs = [];
  return {
    planInputs,
    async plan(messages, tools, signal) {
      planInputs.push({ tools, toolMessages: messages.filter((message) => message.role === "tool").length });
      if (planCalls) return planCalls();
      if (planInputs.length === 1) return { toolCalls: [{ id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }] };
      return { toolCalls: [] };
    },
    async *streamAnswer(messages, signal) {
      const facts = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
      const rows = facts.flatMap((fact) => fact.data);
      const parts = [`根据本轮查询，找到 ${rows.length} 张订单：`, rows.map((row) => `${row.order_no}（${row.product_name}）`).join("；") + "。", `来源：${facts.flatMap((fact) => fact.sources).map((source) => source.business_no).join("、")}。`];
      for (const [index, text] of parts.entries()) {
        signal?.throwIfAborted();
        if (onChunk && index === 1) await onChunk();
        yield { type: "text", text };
      }
      signal?.throwIfAborted();
      yield { type: "usage", usage: { model: "fake-provider", input_tokens: 12, output_tokens: 34 } };
    },
  };
}

function fakeRoleReader(roleKeys = ["qita"]) { return { async readActiveRoleKeys() { return roleKeys; } }; }

async function planningRun(db, state) {
  const session = await state.createSession(USER_A);
  return state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: "cm-1", question: "SO 开头有哪些订单？", accessLevel: "operational" });
}

test("编排正常完成：planning → querying → responding → completed，事件类型与 seq 齐全", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const executor = fakeExecutor();
  const orchestrator = new AgentOrchestrator(state, executor, fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "completed");
  assert.equal(saved.answer, "根据本轮查询，找到 1 张订单：SO-001（手机壳）。来源：SO-001。");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1), "seq 必须从 1 起单调");
  assert.deepEqual(events.map((event) => event.type), ["state", "state", "tool_args", "tool_status", "tool_status", "source", "state", "answer_delta", "answer_delta", "answer_delta", "state", "completed"], "状态迁移自动补 state 事件；每次调用先留一条入参事件，completed 前也有");
  const completed = events.at(-1).payload;
  assert.equal(completed.answer, saved.answer);
  assert.deepEqual(completed.sources.map((source) => source.business_no), ["SO-001"]);
  assert.equal(completed.usage.tool_calls, 1);
  assert.equal(completed.usage.answer_chunks, 3);
  assert.equal(completed.usage.model, "fake-provider");
  assert.equal(completed.usage.input_tokens, 12, "provider 用量聚合进 completed.usage");
  assert.deepEqual(executor.calls[0].call, { id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } });
  assert.equal(executor.calls[0].principalAccess, "operational", "执行器拿到的档位来自 run 创建时");
});

test("工具入参写进事件表：只记白名单键，单值截断 100 字符", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const longQ = "x".repeat(150);
  let step = 0;
  const provider = {
    async plan() {
      step += 1;
      if (step === 1) return { toolCalls: [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: longQ } }] };
      if (step === 2) return { toolCalls: [{ id: "c2", tool: "procurement_query", operation: "get_purchase_orders", args: { order_no: "SO-001", page: 2, filters: { x: 1 } } }] };
      return { toolCalls: [] };
    },
    async *streamAnswer() { yield { type: "text", text: "ok" }; },
  };
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const argsEvents = db.store.events.filter((event) => event.runId === run.id && event.type === "tool_args");
  assert.equal(argsEvents.length, 2, "每次工具调用都要留一条入参事件");
  assert.equal(argsEvents[0].payload.operation, "search_orders");
  assert.equal(argsEvents[0].payload.args.q.length, 100, "超长入参必须截断");
  assert.equal(argsEvents[1].payload.args.order_no, "SO-001");
  assert.equal(argsEvents[1].payload.args.page, 2);
  assert.ok(!("filters" in argsEvents[1].payload.args), "白名单之外的键不得落库");
});

/** 建一个 planning run，用给定 provider 与按调用取事实的执行器跑完，返回三者供断言。 */
async function driveWith(provider, factForCall) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const executor = { calls: [], async execute(call) { this.calls.push(call); return factForCall(call); } };
  await new AgentOrchestrator(state, executor, provider, fakeRoleReader()).run(run, PRINCIPAL, new AbortController().signal);
  return { provider, executor, db, run };
}

/** 记录每轮 messages 的 provider：用来断言模型实际看到了什么事实。 */
function scriptedProvider(plans) {
  const captured = [];
  return {
    captured,
    async plan(messages) { captured.push(messages); const next = plans[captured.length - 1]; return { toolCalls: next ? next() : [] }; },
    async *streamAnswer() { yield { type: "text", text: "ok" }; },
  };
}
const toolFacts = (messages) => messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
const searchFact = (rows) => ({
  operation: "search_orders", order_no: null, as_of: "2026-10-27T00:00:00.000Z", data: rows,
  sources: rows.map((row) => ({ business_type: "sales_order", business_no: row.order_no })), access_level: "operational",
});

test("检索结果带本轮句柄：单行 o_1，两行 o_1 与 o_2", async () => {
  const single = await driveWith(scriptedProvider([() => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }]]), () => searchFact([FACT.data[0]]));
  assert.equal(toolFacts(single.provider.captured[1])[0].data[0].order_ref, "o_1");
  assert.equal(toolFacts(single.provider.captured[1])[0].data[0].order_no, "SO-001", "单号仍要留给人和回放看");

  const rows = [FACT.data[0], { ...FACT.data[0], order_no: "SO-002" }];
  const double = await driveWith(scriptedProvider([() => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }]]), () => searchFact(rows));
  assert.deepEqual(toolFacts(double.provider.captured[1])[0].data.map((row) => row.order_ref), ["o_1", "o_2"]);
});

test("句柄跨次检索继续编号，不重号", async () => {
  const queue = [searchFact([FACT.data[0]]), searchFact([{ ...FACT.data[0], order_no: "SO-009" }])];
  const { provider } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "search_orders", args: { q: "SO-9" } }],
  ]), () => queue.shift());
  const facts = toolFacts(provider.captured[2]);
  assert.deepEqual(facts.map((fact) => fact.data[0].order_ref), ["o_1", "o_2"]);
});

test("非检索操作不发句柄", async () => {
  const queue = [searchFact([FACT.data[0]]), { ...FACT, operation: "get_order_overview", order_no: "SO-001", data: { status: "confirmed" } }];
  const { provider } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_no: "SO-001" } }],
  ]), () => queue.shift());
  const facts = toolFacts(provider.captured[2]);
  assert.ok(!JSON.stringify(facts[1]).includes("order_ref"), "根查询事实不带句柄");
});

test("根查询用句柄还原单号：执行器收到 order_no，且不含 order_ref", async () => {
  const queue = [searchFact([FACT.data[0]]), { ...FACT, operation: "get_order_overview", order_no: "SO-001", data: { status: "confirmed" } }];
  const { executor } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }],
  ]), () => queue.shift());

  assert.equal(executor.calls.length, 2);
  assert.equal(executor.calls[1].args.order_no, "SO-001", "句柄被还原成真实单号");
  assert.ok(!("order_ref" in executor.calls[1].args), "句柄不得漏进执行器，它只认固定 schema");
});

test("本轮只有一张单时，根查询省略参数也能查", async () => {
  const queue = [searchFact([FACT.data[0]]), { ...FACT, operation: "get_order_overview", order_no: "SO-001", data: { status: "confirmed" } }];
  const { executor, db } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: {} }],
  ]), () => queue.shift());

  assert.equal(executor.calls.length, 2, "第二张单自动沿用唯一命中");
  assert.equal(executor.calls[1].args.order_no, "SO-001");
  assert.equal(db.store.runs.at(-1).state, "completed");
});

test("本轮多张单、根查询不带句柄 → 拒绝且不触达执行器", async () => {
  const rows = [FACT.data[0], { ...FACT.data[0], order_no: "SO-002" }];
  const { executor, db } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: {} }],
  ]), () => searchFact(rows));

  assert.equal(executor.calls.length, 1, "歧义时不得猜一张单去查");
  const failed = db.store.events.filter((event) => event.type === "tool_status" && event.payload.status === "failed");
  assert.equal(failed[0].payload.code, "ORDER_REF_REQUIRED");
});

test("两步链路完整：检索 → 根查询 → 回答带真实来源", async () => {
  const queue = [searchFact([FACT.data[0]]), { ...FACT, operation: "get_order_overview", order_no: "SO-001", data: { status: "confirmed" } }];
  const { db } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }],
  ]), () => queue.shift());

  const saved = db.store.runs.at(-1);
  assert.equal(saved.state, "completed");
  const completed = db.store.events.filter((event) => event.type === "completed").at(-1).payload;
  assert.deepEqual(completed.sources.map((source) => source.business_no), ["SO-001", "SO-001"], "来源必须指向真实单号");
});

test("伪造句柄被拒且不触达执行器，错误只有操作名与错误码", async () => {
  const { executor, db } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_9" } }],
  ]), () => searchFact([FACT.data[0]]));

  assert.equal(executor.calls.length, 1, "伪造句柄不得进入执行器");
  const failed = db.store.events.filter((event) => event.type === "tool_status" && event.payload.status === "failed");
  assert.equal(failed[0].payload.code, "ORDER_REF_INVALID");
  assert.deepEqual(Object.keys(failed[0].payload).sort(), ["code", "operation", "status", "tool"], "拒绝事件不带猜测值");
});

test("上一轮的句柄在新一轮不可用", async () => {
  const first = await driveWith(scriptedProvider([() => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }]]), () => searchFact([FACT.data[0]]));
  assert.equal(first.executor.calls.length, 1);

  const second = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }],
  ]), () => searchFact([FACT.data[0]]));
  assert.equal(second.executor.calls.length, 0, "句柄只在本轮有效");
  const failed = second.db.store.events.filter((event) => event.type === "tool_status" && event.payload.status === "failed");
  assert.equal(failed[0].payload.code, "ORDER_REF_INVALID");
});

test("被拒之后模型带正确句柄重试，该次执行成功", async () => {
  const queue = [searchFact([FACT.data[0]]), { ...FACT, operation: "get_order_overview", order_no: "SO-001", data: { status: "confirmed" } }];
  const { executor } = await driveWith(scriptedProvider([
    () => [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }],
    () => [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_9" } }],
    () => [{ id: "c3", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }],
  ]), () => queue.shift());

  assert.equal(executor.calls.length, 2, "第二次用对句柄时应真正执行");
  assert.equal(executor.calls[1].args.order_no, "SO-001");
});

test("多步循环：plan 连续两轮都返回调用后第三轮为空，工具按序执行且每轮结果回填消息", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const provider = fakeProvider({
    planCalls: () => (provider.planInputs.length <= 2 ? { toolCalls: [{ id: `call-${provider.planInputs.length}`, tool: "order_query", operation: "search_orders", args: { q: "SO" } }] } : { toolCalls: [] }),
  });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  assert.deepEqual(provider.planInputs.map((input) => input.toolMessages), [0, 1, 2], "每轮 plan 都拿到上一轮的工具结果");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.equal(events.filter((event) => event.type === "tool_status" && event.payload.status === "completed").length, 2);
});

test("run 级超时：provider 卡住超过 AGENT_RUN_TIMEOUT_MS → failed/AGENT_RUN_TIMEOUT", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const slowProvider = {
    async plan() { return { toolCalls: [] }; },
    async *streamAnswer(messages, signal) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      signal.throwIfAborted();
      yield { type: "text", text: "不会到达" };
    },
  };
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), slowProvider, fakeRoleReader(), undefined, { runTimeoutMs: 50 });

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_RUN_TIMEOUT");
});

test("无工具可调（澄清路径）：planning 直达 responding，再完成，无 tool_status 事件", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const provider = fakeProvider({ planCalls: () => ({ toolCalls: [] }) });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.ok(!events.some((event) => event.type === "tool_status"));
  const states = events.filter((event) => event.type === "state").map((event) => event.payload.state);
  assert.deepEqual(states, ["planning", "responding", "completed"]);
});

test("可回传工具失败：错误信封回喂模型，第二轮 plan 继续，最终完成（不再整轮 failed）", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const { HttpException } = require("@nestjs/common");
  const failure = new HttpException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message: "搜索词 q 不能为空", details: [] }, 400);
  let planCount = 0;
  const provider = {
    planInputs: [],
    async plan(messages) {
      this.planInputs.push(messages);
      planCount += 1;
      if (planCount === 1) return { toolCalls: [{ id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }] };
      return { toolCalls: [] };
    },
    async *streamAnswer(messages) {
      const toolMessages = messages.filter((message) => message.role === "tool");
      assert.deepEqual(JSON.parse(toolMessages[0].content), { error: { code: "AGENT_TOOL_ARGUMENT_INVALID", message: "搜索词 q 不能为空" } }, "失败信封必须进入 tool 消息");
      yield { type: "text", text: "没有查到匹配的订单。" };
      yield { type: "usage", usage: { model: "fake-provider" } };
    },
  };
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: failure }), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "completed", "可回传失败不应终止整轮");
  assert.equal(planCount, 2, "模型必须拿到失败结果后再规划一次");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.ok(events.some((event) => event.type === "tool_status" && event.payload.status === "failed" && event.payload.code === "AGENT_TOOL_ARGUMENT_INVALID"));
  assert.ok(!events.some((event) => event.type === "error"), "可回传失败不应写 error 终态");
});

test("致命工具失败（撤权）仍终止：run 落 failed，错误码来自业务异常", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const { HttpException } = require("@nestjs/common");
  const failure = new HttpException({ code: "AGENT_ACCESS_REVOKED", message: "当前账号已无可用角色", details: [] }, 403);
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: failure }), fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_ACCESS_REVOKED");
  const lastEvent = db.store.events.filter((event) => event.runId === run.id).at(-1);
  assert.equal(lastEvent.type, "error");
  assert.equal(lastEvent.payload.code, "AGENT_ACCESS_REVOKED");
});

test("失败预算：同一 run 连续 3 次可回传失败后终止，错误码 AGENT_TOOL_RETRIES_EXHAUSTED", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const { HttpException } = require("@nestjs/common");
  const failure = new HttpException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] }, 404);
  let planCount = 0;
  const provider = {
    async plan() {
      planCount += 1;
      return { toolCalls: [{ id: `call-${planCount}`, tool: "order_query", operation: "search_orders", args: { q: "SO" } }] };
    },
    async *streamAnswer() { yield { type: "text", text: "不会到达" }; },
  };
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: failure }), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_TOOL_RETRIES_EXHAUSTED");
  assert.equal(planCount, 3, "预算用尽后不再调模型");
});

test("运行时守卫：未先 search 的根查询不触达数据库，回传 ORDER_SEARCH_REQUIRED 后模型可自纠", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const exactOrderNo = "DL260170-4H 伞头";
  const provider = {
    planInputs: [],
    async plan(messages) {
      this.planInputs.push(messages);
      const step = this.planInputs.length;
      if (step === 1) return { toolCalls: [{ id: "call-1", tool: "order_query", operation: "get_order_overview", args: { order_no: "DL260170-4H" } }] };
      if (step === 2) return { toolCalls: [{ id: "call-2", tool: "order_query", operation: "search_orders", args: { q: "DL260170-4H" } }] };
      if (step === 3) return { toolCalls: [{ id: "call-3", tool: "order_query", operation: "get_order_overview", args: { order_no: exactOrderNo } }] };
      return { toolCalls: [] };
    },
    async *streamAnswer() { yield { type: "text", text: "查询完成。" }; yield { type: "usage", usage: {} }; },
  };
  const executor = fakeExecutor({
    factForCall: (call) => call.operation === "search_orders"
      ? { ...FACT, data: [{ order_no: exactOrderNo, product_name: "伞头" }], sources: [{ business_type: "sales_order", business_no: exactOrderNo, queried_at: "x" }] }
      : { operation: "get_order_overview", order_no: exactOrderNo, as_of: "x", data: { status: "生产中" }, sources: [{ business_type: "sales_order", business_no: exactOrderNo, queried_at: "x" }] },
  });
  const orchestrator = new AgentOrchestrator(state, executor, provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "completed");
  assert.deepEqual(executor.calls.map((item) => item.call.operation), ["search_orders", "get_order_overview"], "未搜索的根查询必须被守卫拦下，只有 search 后精确单号的根查询才会执行");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.ok(events.some((event) => event.type === "tool_status" && event.payload.code === "ORDER_SEARCH_REQUIRED"), "必须记录 ORDER_SEARCH_REQUIRED");
  const guardFeedback = provider.planInputs[1].find((message) => message.role === "tool");
  assert.equal(guardFeedback.operation, "get_order_overview", "失败回放必须保留 operation");
  assert.equal(JSON.parse(guardFeedback.content).error.code, "ORDER_SEARCH_REQUIRED");
});

test("调用预算：单轮 20 个调用只执行 16 个，超出部分丢弃且不产生 tool_status", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const provider = {
    async plan() {
      return { toolCalls: Array.from({ length: 20 }, (_, index) => ({ id: `call-${index}`, tool: "order_query", operation: "search_orders", args: { q: `SO-${index}` } })) };
    },
    async *streamAnswer() { yield { type: "text", text: "完成。" }; yield { type: "usage", usage: {} }; },
  };
  const executor = fakeExecutor();
  const orchestrator = new AgentOrchestrator(state, executor, provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  assert.equal(executor.calls.length, 16, "调用预算 16 之外的调用不得执行");
  const toolStatuses = db.store.events.filter((event) => event.runId === run.id && event.type === "tool_status");
  assert.equal(toolStatuses.length, 32, "只应有 16 组 running/completed；被丢调用不发 tool_status");
});

test("非业务异常的错误文本不进事件流（可能夹带业务值）：对外只有稳定文案", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const leaky = Object.assign(new Error('relation "orders" does not exist near "SECRET_VALUE"'), {});
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: leaky }), fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const events = db.store.events.filter((event) => event.runId === run.id);
  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(errorEvent.payload.code, "AGENT_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(db.store.events).includes("SECRET_VALUE"), "数据库异常原文不得进入事件流");
});

test("responding 中被取消：迟到增量写不进终态，最终状态保持 cancelled", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  // 第二段产出前把 run 取消（模拟用户在流式中途点取消）。
  const provider = fakeProvider({ onChunk: () => state.cancel(run.id, USER_A) });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "cancelled", "取消后的迟到结果不得把 run 写成 completed/failed");
  const types = db.store.events.filter((event) => event.runId === run.id).map((event) => event.type);
  assert.ok(!types.includes("completed"));
});

test("已有非 planning 状态的 run 不重跑（取消后编排器迟到启动是无害空转）", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  await state.cancel(run.id, USER_A);
  const executor = fakeExecutor();
  const orchestrator = new AgentOrchestrator(state, executor, fakeProvider(), fakeRoleReader());

  await orchestrator.run({ ...run, state: "cancelled" }, PRINCIPAL, new AbortController().signal);
  assert.equal(executor.calls.length, 0);
});
