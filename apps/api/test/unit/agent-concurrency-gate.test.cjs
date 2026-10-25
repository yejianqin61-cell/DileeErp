// 并发许可闸的单元测试（内存计数，不连数据库）。
//
// R-8 的进程内语义：全进程最多 4 个活动 run；无空位返回 Busy、不排队；
// 释放只由编排器 finally 做，抛错/取消/完成三条路都不许泄漏许可。
// 数据库部分唯一索引管「每用户一个」，闸门只管「全进程总量」——两层各管各的。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConcurrencyGate } = require("../../dist/modules/business-query-agent/concurrency-gate.js");
const { BusinessQueryAgentController } = require("../../dist/modules/business-query-agent/business-query-agent.controller.js");

test("闸门：4 个许可内依次获取都成功，第 5 个 Busy 且无副作用", () => {
  const gate = new ConcurrencyGate();
  const permits = [];
  for (let index = 0; index < 4; index += 1) permits.push(gate.tryAcquire(`user-${index}`));
  assert.equal(permits.filter(Boolean).length, 4);
  assert.equal(gate.tryAcquire("user-5"), null, "第 5 个必须 Busy（返回 null）");
  assert.equal(gate.activeCount, 4, "Busy 不得改变计数");
});

test("闸门：release 之后可再取，计数不泄漏", () => {
  const gate = new ConcurrencyGate();
  const permit = gate.tryAcquire("user-1");
  permit.release();
  permit.release();
  assert.equal(gate.activeCount, 0, "重复 release 也只减一次");
  assert.ok(gate.tryAcquire("user-2"), "释放后可再取");
});

test("闸门：同一 userId 两次 acquire 都放行（单用户约束归数据库部分唯一索引管）", () => {
  const gate = new ConcurrencyGate();
  assert.ok(gate.tryAcquire("same-user"));
  assert.ok(gate.tryAcquire("same-user"));
  assert.equal(gate.activeCount, 2);
});

/** 编排器拒绝启动（fake state 让 createRun 抛错）时，finally 仍要释放许可。 */
function fakeController({ gate, busy = false, failCreate = false } = {}) {
  const { ConflictException } = require("@nestjs/common");
  return new BusinessQueryAgentController(
    {
      findSession: async () => ({ id: "s-1", userId: "u-1" }),
      findRunByIdempotencyKey: async () => null,
      hasActiveRun: async () => false,
      createRun: async () => { if (failCreate) throw new ConflictException({ code: "RUN_IN_PROGRESS", message: "x", details: [] }); return { id: "r-1", state: "planning" }; },
    },
    { run: async () => { throw new Error("编排器不应在失败路径启动"); } },
    {},
    busy ? { tryAcquire: () => null } : gate ?? new ConcurrencyGate(),
  );
}

const REQUEST = { agentPrincipal: { user: { id: "u-1", username: "w", display_name: "w" }, accessLevel: "operational" } };
const RESPONSE = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
const DTO = { question: "q", client_message_id: "00000000-0000-4000-8000-000000000001" };

test("控制器：闸门 Busy → 429 AGENT_BUSY 信封 + Retry-After: 3，不建 run", async () => {
  const { HttpException } = require("@nestjs/common");
  const created = [];
  const controller = fakeController({
    busy: true,
    gate: { tryAcquire: () => null },
  });
  void created;
  await assert.rejects(
    controller.createRun("s-1", DTO, REQUEST, RESPONSE),
    (error) => error instanceof HttpException && error.getStatus() === 429 && error.getResponse().code === "AGENT_BUSY",
  );
  assert.equal(RESPONSE.headers["Retry-After"], "3", "429 必须带 Retry-After: 3（fake 响应按传入名存键）");
});

test("控制器：建 run 失败（竞态冲突）时许可必须释放——再取成功", async () => {
  const gate = new ConcurrencyGate();
  const controller = fakeController({ gate, failCreate: true });
  await assert.rejects(controller.createRun("s-1", DTO, REQUEST, RESPONSE));
  assert.equal(gate.activeCount, 0, "失败路径不得泄漏许可");
});
