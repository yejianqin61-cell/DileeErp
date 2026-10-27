// SSE 传输层的单元测试：内部事件只落库、不下发。
//
// 背景：`tool_args` 是取证事件（模型实际传了什么），写进事件表是为了排查口径问题，
// 但它含业务单号与检索词，不能给浏览器。重放与轮询两个发送点都必须跳过。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { StreamTransport } = require("../../dist/modules/business-query-agent/stream-transport.js");

const RUN = { id: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", accessLevel: "operational" };

function fakeResponse() {
  const state = { ended: false, chunks: [], headers: {} };
  return {
    state,
    status() { return this; },
    setHeader(key, value) { state.headers[key] = value; return this; },
    flushHeaders() {},
    on() {},
    write(chunk) { state.chunks.push(chunk); return true; },
    end() { state.ended = true; },
    get writableEnded() { return state.ended; },
  };
}

/** eventsAfter 按队列逐次返回，用来分别驱动重放与轮询两条路径。 */
function fakeState(batches) {
  let index = 0;
  return {
    async eventsAfter() {
      const batch = batches[Math.min(index, batches.length - 1)];
      index += 1;
      return batch;
    },
  };
}

const roleReader = { async readActiveRoleKeys() { return ["qita"]; } };
const event = (seq, type, payload = {}) => ({ seq, type, payload, createdAt: new Date("2026-10-27T00:00:00.000Z") });
const body = (response) => response.state.chunks.join("");

test("重放遇到内部事件：不下发，但后续事件照常", async () => {
  const response = fakeResponse();
  const state = fakeState([[event(1, "tool_args", { operation: "search_orders", args: { q: "DL260" } }), event(2, "tool_status", { status: "running" }), event(3, "completed", {})]]);

  await new StreamTransport(state, roleReader).follow(response, RUN, 0);

  assert.ok(!body(response).includes("DL260"), "内部事件的内容不得出现在流里");
  assert.ok(!body(response).includes("tool_args"), "内部事件的类型名也不得出现");
  assert.ok(body(response).includes('"tool_status"'), "普通事件照常下发");
});

test("轮询遇到内部事件：同样跳过", async () => {
  const response = fakeResponse();
  const state = fakeState([
    [event(1, "tool_status", { status: "running" })],
    [event(2, "tool_args", { operation: "search_orders", args: { q: "PO-9" } })],
    [event(3, "completed", {})],
  ]);

  await new StreamTransport(state, roleReader).follow(response, RUN, 0);

  assert.ok(!body(response).includes("PO-9"), "轮询路径也不能带出内部事件内容");
  assert.ok(body(response).includes('"completed"'));
});

test("终态事件发完即关闭连接", async () => {
  const response = fakeResponse();
  const state = fakeState([[event(1, "completed", { answer: "ok" })]]);

  await new StreamTransport(state, roleReader).follow(response, RUN, 0);

  assert.equal(response.state.ended, true);
});

test("降权者只收到 ACCESS_REVOKED，且不重放任何历史事件", async () => {
  const response = fakeResponse();
  const state = fakeState([[event(1, "tool_status", { status: "running" })]]);
  const denied = { async readActiveRoleKeys() { return []; } };

  await new StreamTransport(state, denied).follow(response, RUN, 0);

  assert.ok(body(response).includes("ACCESS_REVOKED"));
  assert.ok(!body(response).includes("tool_status"));
});
