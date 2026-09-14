// 请求关联 id 的单元测试（RequestIdMiddleware + AuditService）。
//
// 这两块放在一起，因为它们是 D2 缺陷的两端：
//   - RequestIdMiddleware 生成 id 并写到**响应头**与 request.requestId（request-id.middleware.ts:7-8）；
//   - AuditService.record() 把订单号放进 details 而**不写 orderNo 列**（audit.service.ts:15）。
// 两者叠加的后果是"追踪链路只能靠响应头、审计无法按订单检索"，这正是
// docs/test/results/2026-09-13-w1-fixtures-and-harness.md §4 记录的两个缺口。
// 这里在单元层把机制钉住，HTTP/集成层的行为护栏见 contract-guardrails.test.cjs 与夹具的 auditScope()。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { RequestIdMiddleware } = require("../../dist/platform/http/request-id.middleware.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("request id middleware: generates a UUID, writes it to the response header and request.requestId", () => {
  const headers = {};
  const request = { header: () => undefined, requestId: undefined };
  let nextCalled = false;

  new RequestIdMiddleware().use(request, { setHeader: (name, value) => { headers[name] = value; } }, () => { nextCalled = true; });

  assert.match(headers["x-request-id"], UUID_PATTERN, "响应头 x-request-id 必须是 UUID（这是唯一可靠的关联手段）");
  assert.equal(request.requestId, headers["x-request-id"], "同时挂到 request.requestId 上");
  assert.equal(nextCalled, true, "必须放行");
});

test("request id middleware: honours a client-supplied header instead of generating one", () => {
  const headers = {};
  const request = { header: (name) => (name === "x-request-id" ? "client-provided-1" : undefined) };

  new RequestIdMiddleware().use(request, { setHeader: (name, value) => { headers[name] = value; } }, () => {});

  assert.equal(headers["x-request-id"], "client-provided-1");
  assert.equal(request.requestId, "client-provided-1");
});

test("KNOWN_CONTRACT_DEFECT D2 mechanism: the middleware never writes the id back into request.headers", () => {
  // 拦截器与异常过滤器读的是 request.header("x-request-id")（即**请求头**）。
  // 本中间件只写响应头与 request.requestId，不回写请求头 —— 这就是 meta.request_id
  // 在客户端不带该头时恒为 undefined 的根因。若哪天这里开始回写，D2 即被修复。
  const headers = {};
  const request = { headers: {}, header: () => undefined };

  new RequestIdMiddleware().use(request, { setHeader: (name, value) => { headers[name] = value; } }, () => {});

  assert.deepEqual(request.headers, {}, "中间件不回写请求头（D2 根因）；此处变红说明已修复，请同步更新护栏");
  assert.match(headers["x-request-id"], UUID_PATTERN);
});

/** 记录 AuditService 收到的 create 参数。 */
function fakePrisma() {
  const created = [];
  return {
    auditEvent: { async create({ data }) { created.push(data); return data; } },
    created,
  };
}

const user = { display_name: "测试", id: "u-1", username: "tester" };

test("audit service: create/update/softDelete build the audit field shapes", () => {
  const audit = new AuditService(fakePrisma());
  assert.deepEqual(audit.create(user), { createdBy: "u-1", updatedBy: "u-1" });
  assert.deepEqual(audit.update(user), { updatedBy: "u-1" });
  const deleted = audit.softDelete(user);
  assert.equal(deleted.deletedBy, "u-1");
  assert.equal(deleted.updatedBy, "u-1");
  assert.ok(deleted.deletedAt instanceof Date);
});

test("audit service: activeWhere appends the soft-delete filter without losing caller conditions", () => {
  const audit = new AuditService(fakePrisma());
  assert.deepEqual(audit.activeWhere({ orderNo: "ORD-1" }), { deletedAt: null, orderNo: "ORD-1" });
  assert.deepEqual(audit.activeWhere(), { deletedAt: null });
});

test("KNOWN_CONTRACT_DEFECT audit: record() stores order_no only inside details, never in the orderNo column", async () => {
  // 后果：按 WHERE order_no = ? 查审计**查不到**这些事件（schema 的 audit_events.order_no 恒为 NULL），
  // 测试清理若只按该列删就会让 audit_events 持续堆积。
  const prisma = fakePrisma();
  await new AuditService(prisma).record("raw_material_inbound.post", "raw_material_inbound", "u-1", "entity-1", { idempotency_key: "k", order_no: "ORD-1" });

  const written = prisma.created[0];
  assert.equal(written.action, "raw_material_inbound.post");
  assert.equal(written.entityType, "raw_material_inbound");
  assert.equal(written.entityId, "entity-1");
  assert.equal(written.actorId, "u-1");
  assert.equal(written.orderNo, undefined, "record() 不写 orderNo 列（缺口）；此处变红说明已修复");
  assert.equal(written.details.order_no, "ORD-1", "订单号只存在于 details 里");
});

test("audit service: recordWithOrderNo() is the variant that fills the orderNo column", async () => {
  const prisma = fakePrisma();
  await new AuditService(prisma).recordWithOrderNo("x.action", "x_entity", "ORD-2", "u-1", "entity-2", { extra: 1 });

  const written = prisma.created[0];
  assert.equal(written.orderNo, "ORD-2", "该变体才写列，因此按订单检索只对它有效");
  assert.equal(written.details.extra, 1);
});

test("KNOWN_CONTRACT_DEFECT audit: record() can omit the order reference entirely", async () => {
  // 实例：raw-material-inbound-notices.service.ts:103 的接收事件只传 { status }，
  // 于是既无 orderNo 列、也无 details.order_no，只能靠 entityId 关联。
  const prisma = fakePrisma();
  await new AuditService(prisma).record("raw_material_inbound_notice.acknowledge", "raw_material_inbound_notice", "u-1", "notice-1", { status: "acknowledged" });

  const written = prisma.created[0];
  assert.equal(written.orderNo, undefined);
  assert.equal(written.details.order_no, undefined, "该事件完全没有订单引用 —— 违反链路可追溯要求");
});
