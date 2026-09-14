// 横切契约：37 个控制器的**鉴权矩阵**（AuthenticationGuard + ModulePermissionGuard）。
//
// 依据：
//   - docs/test/00-recon-api-contract.md §5.3（守卫求值顺序）与 §5.4（逐控制器矩阵，含类级/方法级要求）；
//   - 生产文件 apps/api/src/platform/authorization/module-permission.guard.ts:13-29。
//
// 覆盖的契约维度：
//   1. 匿名 → 401 UNAUTHENTICATED（每个受保护控制器的代表端点，逐一断言）；
//   2. 无模块权限用户 → 403 FORBIDDEN，且 message 能区分「需要管理员权限」/「无模块访问权限」；
//   3. 管理员短路（guard:22-23）→ 任何模块/管理员要求都放行；
//   4. 模块角色矩阵：允许的模块 → 放行，缺模块 → 403（含「文件位置与模块归属不一致」的 4 处反直觉归属）；
//   5. 类级与方法级元数据是 AND 语义（payroll-sources 的 A3 缺陷）；
//   6. 仅需登录（无模块要求）的端点：attachments / dictionaries 读取（A1/A2 越权面）；
//   7. 错误信封形状 + 响应头 x-request-id（唯一可靠的关联 id）。
//
// 只读纪律：本文件**不创建/修改/删除任何业务数据**。
//   - 匿名 401、403、登录仅需 401 的探测都是只读的；
//   - 写路由（POST/PATCH）只用**空 body 或随机 UUID**，最多走到校验层（400）或资源不存在（404），
//     唯一的例外是 production-progress/rebuild —— 它会真的重算落库，因此**只做 403 断言，绝不用管理员调用**。
//
// 会话约束（docs/test/02-test-environment-runbook.md §7.5）：
//   本 API 单会话（auth.service.ts:29 登录先删该用户全部 session），因此**每个用例内部自己登录并立即使用**，
//   任何两个请求之间不共享跨用例的 cookie，也绝不并发登录同一用户。
//   运行必须串行：
//     node --test --test-concurrency=1 apps/api/test/http/authorization-matrix-contract.test.cjs
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { after, before, test } = require("node:test");
const { PrismaClient } = require("@prisma/client");

const {
  apiClient,
  expectErrorEnvelope,
  expectForbidden,
  expectNoContent,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
  login,
  loginAs,
} = require("../../../../tests/helpers/api-client.cjs");
const { seedTestUsers } = require("../../../../tests/fixtures/seed-users.cjs");
const { assertIsTestDatabase } = require("../../../../tests/helpers/test-databases.cjs");

// 默认目标与任务描述一致（http://127.0.0.1:3001 已在运行）；显式配置时以 API_BASE_URL 为准。
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3001";

/**
 * 种子用户写进**运行中的 API 所连的那个库**，否则登录必然 401。
 * 优先 TEST_DATABASE_URL；未注入时回退 DATABASE_URL，但两者都必须通过「库名含 test」的强校验，
 * 杜绝误连生产库（tests/helpers/test-databases.cjs:36）。
 */
function resolveDatabaseUrl() {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return assertIsTestDatabase(explicit, "TEST_DATABASE_URL");
  return assertIsTestDatabase(process.env.DATABASE_URL, "DATABASE_URL");
}

// 缺少测试库连接串时**在模块加载期就明确阻断**。
// 否则 14 个用例会在 0.0x 毫秒内全部失败，看起来像"14 条契约断言不通过"，
// 实际只是环境未就绪 —— 这种误读会浪费大量排查时间（本文件作者与我各踩过一次）。
if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  throw new Error(
    "TEST_BLOCKED: this contract test seeds role users to assert 403, so it needs TEST_DATABASE_URL (or DATABASE_URL). " +
      "See docs/test/02-test-environment-runbook.md §7.5. Run: node --test --test-concurrency=1 apps/api/test/http/**/*.test.cjs"
  );
}

/** 详情类端点用随机 UUID 探测，避免命中真实数据、也避免相互干扰。 */
const RANDOM_UUID = randomUUID();

const ADMIN = "administrator";
const NO_MODULE = "noModule";
const MODULE_ROLES = ["sales", "procurement", "warehouse", "finance", "production", "hr"];
const ALL_ROLES = [...MODULE_ROLES, NO_MODULE, ADMIN];

/** 37 个控制器文件（recon §5.4 的同一份清单）；矩阵必须逐一覆盖。 */
const CONTROLLER_FILES = [
  "health.controller.ts",
  "modules/alerts/alerts.controller.ts",
  "modules/finance/finance.controller.ts",
  "modules/finance/payable-notification.controller.ts",
  "modules/hr/hr.controller.ts",
  "modules/order-workbench/order-workbench.controller.ts",
  "modules/procurement/incoming-inspections.controller.ts",
  "modules/procurement/master-data-read.controller.ts",
  "modules/procurement/procurement-master-data.controller.ts",
  "modules/procurement/purchase-order-export.controller.ts",
  "modules/procurement/purchase-orders.controller.ts",
  "modules/procurement/raw-material-inbound-notices.controller.ts",
  "modules/procurement/raw-material-inbounds.controller.ts",
  "modules/production/employee-daily-reports.controller.ts",
  "modules/production/finished-goods-inbound-notices.controller.ts",
  "modules/production/finished-goods-qc.controller.ts",
  "modules/production/material-slip-export.controller.ts",
  "modules/production/operation-daily-reports.controller.ts",
  "modules/production/outsource-logistics.controller.ts",
  "modules/production/production-daily-alerts.controller.ts",
  "modules/production/production-master-data.controller.ts",
  "modules/production/production-orders.controller.ts",
  "modules/production/production-payroll-export.controller.ts",
  "modules/production/production-progress.controller.ts",
  "modules/production/raw-material-movements.controller.ts",
  "modules/reports/reports.controller.ts",
  "modules/sales/boms.controller.ts",
  "modules/sales/customers.controller.ts",
  "modules/sales/sales-orders.controller.ts",
  "modules/warehouse/finished-goods-inventory.controller.ts",
  "modules/warehouse/finished-goods-outbound.controller.ts",
  "platform/attachments/attachments.controller.ts",
  "platform/auth/auth.controller.ts",
  "platform/authorization/admin-users.controller.ts",
  "platform/dictionaries/dictionaries.controller.ts",
  "platform/forms/forms.controller.ts",
  "platform/inventory/inventory.controller.ts",
];

/**
 * 定义矩阵条目。
 *
 * @param {string} id 用例名后缀（唯一）
 * @param {string} file 控制器文件（相对 apps/api/src）
 * @param {"GET"|"POST"|"PATCH"|"PUT"|"DELETE"} method
 * @param {string} path 完整路径（含 /api/v1 前缀与 query）
 * @param {object} options
 * @param {"public"|"self-cookie"|"login"|"module"|"admin"} options.require
 *        公开 | 自行读 cookie（匿名 401） | 仅需登录 | 需要模块 | 需要管理员
 * @param {object} [options.allow] 角色 → 期望状态码（数字）或 "not403"（守卫放行即可）
 * @param {string[]} [options.deny] 期望 403 的角色
 * @param {unknown} [options.body] 请求体（只允许空对象等**非业务数据**）
 * @param {boolean} [options.adminProbe=true] 是否纳入管理员短路用例
 * @param {string} [options.note] 该端点的权限要点（供报告阅读）
 */
function endpoint(id, file, method, path, options = {}) {
  return {
    adminProbe: options.adminProbe ?? true,
    allow: options.allow ?? {},
    body: options.body,
    deny: options.deny ?? [],
    file,
    id,
    method,
    note: options.note,
    path,
    require: options.require ?? "module",
  };
}

const ENDPOINTS = [
  // ---------- platform ----------
  endpoint("health.get", "health.controller.ts", "GET", "/api/v1/health", { require: "public", note: "无 guard → 公开" }),
  endpoint("auth.me", "platform/auth/auth.controller.ts", "GET", "/api/v1/auth/me", { require: "self-cookie", allow: { sales: 200 }, note: "无 guard，自行读 cookie" }),
  endpoint("admin-users.post", "platform/authorization/admin-users.controller.ts", "POST", "/api/v1/admin/users", {
    allow: { administrator: 400 }, body: {}, deny: ALL_ROLES.filter((role) => role !== ADMIN), note: "@RequireAdministrator()（4 路由全部）",
    require: "admin",
  }),
  endpoint("attachments.download", "platform/attachments/attachments.controller.ts", "GET", `/api/v1/attachments/${RANDOM_UUID}/download`, {
    allow: { noModule: 404 }, note: "只有 AuthenticationGuard（A1：任意登录用户可达）", require: "login",
  }),
  endpoint("dictionaries.get-types", "platform/dictionaries/dictionaries.controller.ts", "GET", "/api/v1/dictionaries/types", {
    allow: { noModule: 200, sales: 200 }, note: "GET×3 无装饰器（A2：只需登录）", require: "login",
  }),
  endpoint("dictionaries.get-employee-types", "platform/dictionaries/dictionaries.controller.ts", "GET", "/api/v1/dictionaries/hr/employee-types", {
    allow: { noModule: 200 }, note: "同上（A2）", require: "login",
  }),
  endpoint("dictionaries.post-types", "platform/dictionaries/dictionaries.controller.ts", "POST", "/api/v1/dictionaries/types", {
    allow: { administrator: 400 }, body: {}, deny: ["sales", NO_MODULE], note: "写路由 @RequireAdministrator()", require: "admin",
  }),
  endpoint("forms.list", "platform/forms/forms.controller.ts", "GET", "/api/v1/form-definitions", {
    allow: { sales: 200 }, deny: ["procurement", NO_MODULE], note: "类级 sales（A5：表单定义归 sales）",
  }),
  endpoint("inventory.balances", "platform/inventory/inventory.controller.ts", "GET", "/api/v1/inventory/balances", {
    allow: { procurement: 200, warehouse: 200 }, deny: ["sales", "hr", NO_MODULE], note: "ANY(warehouse, procurement)",
  }),

  // ---------- modules ----------
  endpoint("alerts.list", "modules/alerts/alerts.controller.ts", "GET", "/api/v1/alerts", {
    allow: { hr: 200, sales: 200 }, deny: [NO_MODULE], note: "ANY(6 个模块)",
  }),
  endpoint("order-workbench.orders", "modules/order-workbench/order-workbench.controller.ts", "GET", "/api/v1/order-workbench/orders", {
    allow: { finance: 200 }, deny: [NO_MODULE], note: "ANY(6 个模块)",
  }),
  endpoint("reports.orders", "modules/reports/reports.controller.ts", "GET", "/api/v1/reports/orders", {
    allow: { sales: 200 }, deny: [NO_MODULE], note: "ANY(6 个模块)",
  }),
  endpoint("finance.receivable-sources", "modules/finance/finance.controller.ts", "GET", "/api/v1/finance/receivable-sources", {
    allow: { finance: 200 }, deny: ["sales", NO_MODULE], note: "类级 finance（约 47 路由）",
  }),
  endpoint("payable-notification.payable-entries", "modules/finance/payable-notification.controller.ts", "GET", "/api/v1/finance/payable-entries", {
    allow: { finance: 200, procurement: 200 }, deny: ["sales", NO_MODULE], note: "独立 controller：ANY(finance, procurement)",
  }),
  endpoint("hr.attendance-records", "modules/hr/hr.controller.ts", "GET", "/api/v1/hr/attendance-records", {
    allow: { hr: 200 }, deny: ["sales", NO_MODULE], note: "类级 hr（33 路由）",
  }),
  endpoint("incoming-inspections.list", "modules/procurement/incoming-inspections.controller.ts", "GET", "/api/v1/incoming-inspections", {
    allow: { warehouse: 200 }, deny: ["procurement", NO_MODULE], note: "在 procurement 目录下但要求 warehouse",
  }),
  endpoint("master-data-read.materials", "modules/procurement/master-data-read.controller.ts", "GET", "/api/v1/materials", {
    allow: { sales: 200, warehouse: 200 }, deny: ["hr", NO_MODULE], note: "ANY(procurement, warehouse, production, sales)",
  }),
  endpoint("procurement-master-data.suppliers", "modules/procurement/procurement-master-data.controller.ts", "GET", "/api/v1/suppliers", {
    allow: { procurement: 200 }, deny: ["warehouse", NO_MODULE], note: "类级 procurement",
  }),
  endpoint("purchase-order-export.single", "modules/procurement/purchase-order-export.controller.ts", "GET", "/api/v1/procurement/reports/purchase-order.xlsx", {
    allow: { administrator: "not403" }, deny: ["procurement", NO_MODULE], note: "procurement 且 admin", require: "admin",
  }),
  endpoint("purchase-orders.list", "modules/procurement/purchase-orders.controller.ts", "GET", "/api/v1/purchase-orders", {
    allow: { procurement: 200 }, deny: ["warehouse", NO_MODULE], note: "类级 procurement",
  }),
  endpoint("inbound-notices.list", "modules/procurement/raw-material-inbound-notices.controller.ts", "GET", "/api/v1/raw-material-inbound-notices", {
    allow: { procurement: 200, warehouse: 200 }, deny: ["hr", NO_MODULE], note: "类级无要求，方法级 ANY(procurement, warehouse)",
  }),
  endpoint("inbound-notices.acknowledge", "modules/procurement/raw-material-inbound-notices.controller.ts", "PATCH", `/api/v1/raw-material-inbound-notices/${RANDOM_UUID}/acknowledge`, {
    allow: { administrator: "not403", warehouse: "not403" }, body: {}, deny: ["procurement", NO_MODULE], note: "方法级 warehouse（与同文件 list 不同）",
  }),
  endpoint("raw-material-inbounds.list", "modules/procurement/raw-material-inbounds.controller.ts", "GET", "/api/v1/raw-material-inbounds", {
    allow: { warehouse: 200 }, deny: ["procurement", NO_MODULE], note: "类级无要求，7 路由各自 warehouse",
  }),
  endpoint("raw-material-inbounds.payable-sources", "modules/procurement/raw-material-inbounds.controller.ts", "GET", "/api/v1/payable-sources", {
    allow: { finance: 200, procurement: 200 }, deny: ["sales", NO_MODULE], note: "同文件唯一例外：ANY(finance, procurement)",
  }),
  endpoint("employee-daily-reports.list", "modules/production/employee-daily-reports.controller.ts", "GET", "/api/v1/production/employee-reports", {
    allow: { production: 200 }, deny: ["hr", NO_MODULE], note: "类级 production",
  }),
  endpoint("employee-daily-reports.payroll-sources", "modules/production/employee-daily-reports.controller.ts", "GET", "/api/v1/production/payroll-sources?from=2026-01-01&to=2026-01-31", {
    allow: { administrator: "not403" }, note: "⚠️ AND 语义：production 且 ANY(hr, finance) → 见专用用例", require: "module",
  }),
  endpoint("fg-inbound-notices.production-list", "modules/production/finished-goods-inbound-notices.controller.ts", "GET", "/api/v1/production/finished-goods-inbound-notices", {
    allow: { production: 200 }, deny: ["warehouse", NO_MODULE], note: "同文件第 1 个 controller：production",
  }),
  endpoint("fg-inbound-notices.warehouse-list", "modules/production/finished-goods-inbound-notices.controller.ts", "GET", "/api/v1/finished-goods/inbound-notices", {
    allow: { warehouse: 200 }, deny: ["production", NO_MODULE], note: "同文件第 2 个 controller：warehouse",
  }),
  endpoint("finished-goods-qc.inspection-submissions", "modules/production/finished-goods-qc.controller.ts", "GET", "/api/v1/finished-goods/inspection-submissions", {
    allow: { warehouse: 200 }, deny: ["procurement", NO_MODULE], note: "在 production 包内但要求 warehouse（A5）",
  }),
  endpoint("material-slip-export.single", "modules/production/material-slip-export.controller.ts", "GET", "/api/v1/production/reports/material-issue.xlsx", {
    allow: { administrator: "not403" }, deny: ["production", NO_MODULE], note: "production 且 admin", require: "admin",
  }),
  endpoint("operation-daily-reports.list", "modules/production/operation-daily-reports.controller.ts", "GET", "/api/v1/production/operation-reports", {
    allow: { production: 200 }, deny: ["warehouse", NO_MODULE], note: "类级 production",
  }),
  endpoint("outsource-logistics.list", "modules/production/outsource-logistics.controller.ts", "GET", "/api/v1/production/outsource-logistics-batches", {
    allow: { production: 200 }, deny: ["warehouse", NO_MODULE], note: "类级无要求，25 路由各自声明",
  }),
  endpoint("outsource-logistics.payable-sources", "modules/production/outsource-logistics.controller.ts", "GET", "/api/v1/production/outsource-logistics-batches/payable-sources", {
    allow: { finance: 200 }, deny: ["production", NO_MODULE], note: "同文件内唯一 finance 路由",
  }),
  endpoint("production-daily-alerts.list", "modules/production/production-daily-alerts.controller.ts", "GET", "/api/v1/production/daily-alerts", {
    allow: { production: 200 }, deny: ["hr", NO_MODULE], note: "类级 production",
  }),
  endpoint("production-master-data.departments", "modules/production/production-master-data.controller.ts", "GET", "/api/v1/production/departments", {
    allow: { production: 200 }, deny: ["hr", NO_MODULE], note: "读路由仅类级 production",
  }),
  endpoint("production-master-data.create-employee", "modules/production/production-master-data.controller.ts", "POST", "/api/v1/production/employees", {
    allow: { administrator: 400 }, body: {}, deny: ["production", NO_MODULE], note: "写路由额外 @RequireAdministrator()", require: "admin",
  }),
  endpoint("production-orders.list", "modules/production/production-orders.controller.ts", "GET", "/api/v1/production/orders", {
    allow: { production: 200 }, deny: ["warehouse", NO_MODULE], note: "类级 production",
  }),
  endpoint("production-payroll-export.operation-payroll", "modules/production/production-payroll-export.controller.ts", "GET", "/api/v1/production/reports/operation-payroll.xlsx", {
    allow: { administrator: "not403" }, deny: ["production", NO_MODULE], note: "production 且 admin（4 路由）", require: "admin",
  }),
  endpoint("production-progress.measurements", "modules/production/production-progress.controller.ts", "GET", "/api/v1/production-progress/measurements", {
    allow: { finance: 200, hr: 200, production: 200 }, deny: ["warehouse", NO_MODULE], note: "方法级 ANY(production, finance, hr)",
  }),
  endpoint("production-progress.rebuild", "modules/production/production-progress.controller.ts", "POST", "/api/v1/production-progress/rebuild", {
    // ⚠️ 该端点会真的重算并落库，因此**绝不用管理员探测**，只断言无权角色的 403（守卫先于 handler）。
    adminProbe: false, body: {}, deny: ["hr", NO_MODULE], note: "方法级 @RequireAdministrator()（只做 403 断言）", require: "admin",
  }),
  endpoint("raw-material-movements.list", "modules/production/raw-material-movements.controller.ts", "GET", "/api/v1/production/material-movements", {
    allow: { production: 200 }, deny: ["procurement", NO_MODULE], note: "类级 production",
  }),
  endpoint("sales-orders.list", "modules/sales/sales-orders.controller.ts", "GET", "/api/v1/sales-orders", {
    allow: { sales: 200 }, deny: ["warehouse", NO_MODULE], note: "类级 sales",
  }),
  endpoint("boms.list", "modules/sales/boms.controller.ts", "GET", "/api/v1/boms", {
    allow: { procurement: 200, production: 200 }, deny: ["sales", NO_MODULE], note: "A5 + 生产共同维护：ANY(procurement, production)",
  }),
  endpoint("customers.list", "modules/sales/customers.controller.ts", "GET", "/api/v1/customers", {
    allow: { sales: 200 }, deny: ["procurement", NO_MODULE], note: "类级 sales",
  }),
  endpoint("fg-inventory.inbounds", "modules/warehouse/finished-goods-inventory.controller.ts", "GET", "/api/v1/finished-goods/inbounds", {
    allow: { warehouse: 200 }, deny: ["procurement", NO_MODULE], note: "类级无要求，每路由 warehouse",
  }),
  endpoint("fg-outbound.outbounds", "modules/warehouse/finished-goods-outbound.controller.ts", "GET", "/api/v1/finished-goods/outbounds", {
    allow: { warehouse: 200 }, deny: ["production", NO_MODULE], note: "类级 warehouse",
  }),
];

// ---------- 运行期夹具 ----------

let prisma;
let seeded;

before(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
  seeded = await seedTestUsers(prisma, { prefix: "authz-matrix" });
});

after(async () => {
  try {
    await seeded?.cleanup(); // 种子用户/角色/会话必须清理干净，否则毒化后续用例
  } finally {
    await prisma?.$disconnect();
  }
});

/** 按种子角色登录并返回立即使用的客户端（单会话：cookie 不跨用例共享）。 */
async function clientAs(role) {
  const session = await loginAs(baseUrl, seeded, role);
  return apiClient(baseUrl, { cookie: session.cookie });
}

/** 按条目定义发请求（body 只用于校验层探测）。 */
function send(client, entry) {
  const options = { method: entry.method };
  if (entry.body !== undefined) options.body = JSON.stringify(entry.body);
  return client.request(entry.path, options);
}

/** 该角色在该端点上的期望结果；undefined = 该角色与该端点无关，不探测。 */
function expectedFor(entry, role) {
  if (entry.deny.includes(role)) return 403;
  if (Object.prototype.hasOwnProperty.call(entry.allow, role)) return entry.allow[role];
  return undefined;
}

/**
 * 断言 403 且 message 能区分两种拒绝原因（module-permission.guard.ts:24/26-27）。
 * 前端只应依赖 code，这里额外固定 message 是为了锁住「管理员要求」与「模块要求」的语义差异。
 */
function expectForbiddenWithReason(response, requirement, context) {
  const body = expectForbidden(response, context);
  const expectedMessage = requirement === "admin" ? "需要管理员权限" : "无模块访问权限";
  assert.equal(body.error.message, expectedMessage, `${context} 的 403 message 应能区分管理员要求与模块要求`);
  return body;
}

/** 统一断言：数字状态码 → 成功/失败信封；"not403" → 守卫已放行（具体状态由业务/校验层决定）。 */
function assertExpected(response, expected, context) {
  if (expected === "not403") {
    assert.notEqual(response.status, 403, `${context} 守卫应放行，实际 403：${JSON.stringify(response.body)}`);
    assert.notEqual(response.status, 401, `${context} 不应是 401`);
    return;
  }
  if (typeof expected !== "number") throw new Error(`unsupported expectation ${expected} for ${context}`);
  if (expected === 404) {
    expectNotFound(response, context);
    return;
  }
  if (expected >= 200 && expected < 300) {
    expectSuccessEnvelope(response, { context, status: expected });
    return;
  }
  if (expected === 400) {
    expectValidationError(response, context);
    return;
  }
  expectErrorEnvelope(response, { context, status: expected });
}

/** 失败响应也必须带 x-request-id 响应头，且 meta.path 指向实际请求 URL。 */
function assertErrorTracing(response, entry, context) {
  expectRequestIdHeader(response, context);
  assert.equal(response.body.meta.path, entry.path, `${context} 错误信封的 meta.path 应等于请求 URL`);
}

// ---------- 用例 ----------

test("authz.public_endpoints_are_reachable_without_a_cookie", async () => {
  const anonymous = apiClient(baseUrl);

  // GET /health 无 guard 且**公开**；数据库竞争下 503 是合法结果（runbook §7.5 ②），两种都校验信封。
  const health = await anonymous.get("/api/v1/health");
  if (health.status === 200) expectSuccessEnvelope(health, { context: "health" });
  else expectErrorEnvelope(health, { code: "DEPENDENCY_UNAVAILABLE", context: "health", status: 503 });
  expectRequestIdHeader(health, "health");

  // POST /auth/login 公开：不存在的用户名 → 401（用随机用户名，避免触发真实账号的失败限流）。
  const bogus = await login(baseUrl, { password: "WrongPassword2026", username: `authz-probe-${randomUUID()}` });
  expectErrorEnvelope(bogus, { context: "auth.login", status: 401 });

  // GET /auth/me 自行读 cookie：无 cookie → 401。
  expectUnauthenticated(await anonymous.get("/api/v1/auth/me"), "auth.me anonymous");

  // POST /auth/logout 无 guard 且无 cookie 也静默成功 → 204 空体。
  expectNoContent(await anonymous.post("/api/v1/auth/logout"), "auth.logout anonymous");

  // 带真实会话时 /auth/me 返回当前用户（覆盖 cookie 会话链路）。
  const session = await loginAs(baseUrl, seeded, "sales");
  const me = await apiClient(baseUrl, { cookie: session.cookie }).get("/api/v1/auth/me");
  const body = expectSuccessEnvelope(me, { context: "auth.me authenticated" });
  assert.equal(body.data.username, seeded.credentials.sales.username, "/auth/me 必须回显当前会话用户");
});

test("authz.anonymous_matrix_rejects_every_guarded_controller_with_401", async (t) => {
  const anonymous = apiClient(baseUrl);
  let probed = 0;
  for (const entry of ENDPOINTS) {
    if (entry.require === "public") continue;
    probed += 1;
    await t.test(`${entry.id} -> 401 UNAUTHENTICATED`, async () => {
      const response = await send(anonymous, entry);
      // 匿名请求必须在 AuthenticationGuard 就被拦下：401，而不是 403（guard 顺序的回归护栏）。
      expectUnauthenticated(response, `anonymous ${entry.id}`);
      expectRequestIdHeader(response, `anonymous ${entry.id}`);
      assert.equal(response.body.meta.path, entry.path, `${entry.id} 错误信封的 meta.path 应等于请求 URL`);
    });
  }
  assert.equal(probed, ENDPOINTS.length - 1, "除 health 外的全部代表端点都必须纳入匿名 401 矩阵");
});

test("authz.moduleless_user_is_forbidden_on_module_routes_but_passes_login_only_routes", async (t) => {
  const client = await clientAs(NO_MODULE);
  for (const entry of ENDPOINTS) {
    if (entry.require === "public" || entry.require === "self-cookie") continue;
    const expected = expectedFor(entry, NO_MODULE);
    if (expected === undefined) continue;
    await t.test(`${entry.id} -> ${expected}`, async () => {
      const response = await send(client, entry);
      if (expected === 403) {
        expectForbiddenWithReason(response, entry.require, `noModule ${entry.id}`);
        assertErrorTracing(response, entry, `noModule ${entry.id}`);
        return;
      }
      // 仅需登录、无模块要求的端点必须放行（A1/A2：attachments/download、dictionaries 读取）。
      assertExpected(response, expected, `noModule ${entry.id}`);
    });
  }
});

test("authz.administrator_short_circuits_every_module_and_admin_requirement", async (t) => {
  const client = await clientAs(ADMIN);
  for (const entry of ENDPOINTS) {
    if (!entry.adminProbe) continue;
    if (entry.require !== "module" && entry.require !== "admin") continue;
    const declared = entry.allow[ADMIN];
    const expected = declared ?? (entry.method === "GET" ? 200 : 400);
    await t.test(`${entry.id} -> ${expected}`, async () => {
      const response = await send(client, entry);
      const context = `admin ${entry.id}`;
      // module-permission.guard.ts:22-23：administrator 角色在模块检查之前短路放行。
      assert.notEqual(response.status, 403, `${context} 管理员必须短路放行，实际 403：${JSON.stringify(response.body)}`);
      assert.notEqual(response.status, 401, `${context} 会话必须有效`);
      assertExpected(response, expected, context);
    });
  }
});

for (const role of MODULE_ROLES) {
  test(`authz.role_matrix.${role}_user_passes_only_its_own_modules`, async (t) => {
    const client = await clientAs(role);
    const probes = ENDPOINTS.filter((entry) => expectedFor(entry, role) !== undefined);
    assert.ok(probes.length >= 5, `${role} 的矩阵条目过少（${probes.length}），请检查矩阵是否漏填`);
    for (const entry of probes) {
      const expected = expectedFor(entry, role);
      await t.test(`${entry.id} -> ${expected}`, async () => {
        const response = await send(client, entry);
        const context = `${role} ${entry.id}`;
        if (expected === 403) {
          expectForbiddenWithReason(response, entry.require, context);
          assertErrorTracing(response, entry, context);
          return;
        }
        assertExpected(response, expected, context);
      });
    }
  });
}

test("KNOWN_CONTRACT_DEFECT authz.class_level_and_method_level_any_modules_are_ANDed_on_payroll_sources", async () => {
  // 端点：GET /api/v1/production/payroll-sources
  //   类级 @RequireModules("production") + 方法级 @RequireAnyModules("hr","finance")
  //   （employee-daily-reports.controller.ts:20,30）。
  // ModulePermissionGuard 分两步校验（:26 全命中 modules、:27 至少命中一个 anyModules），
  // 两者是 **AND**：只有同时拥有 production 与（hr 或 finance）的角色才能通过。
  // 后果：任何**单模块**角色都被 403，该端点实际上只对 administrator 可达 ——
  // recon §5.4 A3 记录这是与设计意图不符的语义（前端也无调用点）。
  // 期望：production 权限者应能读取（方法级 ANY 视为放宽），实际：403。
  const payrollSourcesPath = "/api/v1/production/payroll-sources?from=2026-01-01&to=2026-01-31";
  const entry = ENDPOINTS.find((item) => item.id === "employee-daily-reports.payroll-sources");

  const production = await clientAs("production");
  const byProduction = await production.request(payrollSourcesPath, { method: "GET" });
  expectForbiddenWithReason(byProduction, "module", "payroll-sources by production-only");
  assertErrorTracing(byProduction, entry, "payroll-sources by production-only");

  const hr = await clientAs("hr");
  const byHr = await hr.request(payrollSourcesPath, { method: "GET" });
  expectForbiddenWithReason(byHr, "module", "payroll-sources by hr-only");

  const admin = await clientAs(ADMIN);
  const byAdmin = await admin.request(payrollSourcesPath, { method: "GET" });
  assert.notEqual(byAdmin.status, 403, "管理员短路放行：该端点当前只有管理员可达");
});

test("authz.method_level_requirement_is_enforced_per_route_inside_one_controller", async (t) => {
  // raw-material-inbound-notices.controller.ts：类级**无**模块要求，4 个路由各自声明：
  //   GET  /（:19）ANY(procurement, warehouse)
  //   GET  /:id（:25）ANY(procurement, warehouse)
  //   POST /（:31）procurement
  //   PATCH /:id/acknowledge（:37）warehouse
  // 因此同一控制器内不同路由的授权结果必须不同 —— 这是方法级元数据真正生效的证据。
  const procurement = await clientAs("procurement");
  const warehouse = await clientAs("warehouse");

  await t.test("procurement: GET list 放行 / PATCH acknowledge 403", async () => {
    const list = await procurement.get("/api/v1/raw-material-inbound-notices");
    expectSuccessEnvelope(list, { context: "notices list by procurement" });

    const acknowledge = await procurement.patch(`/api/v1/raw-material-inbound-notices/${RANDOM_UUID}/acknowledge`, {});
    expectForbiddenWithReason(acknowledge, "module", "acknowledge by procurement");
  });

  await t.test("warehouse: GET list 放行 / PATCH acknowledge 也放行（资源不存在 → 404）", async () => {
    const list = await warehouse.get("/api/v1/raw-material-inbound-notices");
    expectSuccessEnvelope(list, { context: "notices list by warehouse" });

    const acknowledge = await warehouse.patch(`/api/v1/raw-material-inbound-notices/${RANDOM_UUID}/acknowledge`, {});
    assert.notEqual(acknowledge.status, 403, "warehouse 拥有 acknowledge 的方法级权限，不得 403");
    assert.notEqual(acknowledge.status, 401, "会话必须有效");
    // 随机 UUID → 资源不存在。**注意**：404 并不总是用通用码 NOT_FOUND ——
    // 该服务抛的是业务精确码 INBOUND_NOTICE_NOT_FOUND（实测），
    // 因此这里只固定「状态码 + 信封形状」，不固定 code（与 400/409/422 同一原则）。
    expectErrorEnvelope(acknowledge, { context: "acknowledge unknown id by warehouse", status: 404 });
    assert.match(acknowledge.body.error.code, /NOT_FOUND$/, "404 的 code 至少应可被客户端识别为「不存在」类语义");
  });
});

test("authz.require_administrator_separates_read_routes_from_write_routes_on_master_data", async () => {
  // production-master-data.controller.ts:49-51 类级 production；写路由额外 @RequireAdministrator()。
  // 因此同一模块的读（GET /production/employees）与写（POST /production/employees、导出 xlsx）
  // 对**非管理员**的 production 用户必须给出不同结果：读放行、写 403「需要管理员权限」。
  const production = await clientAs("production");

  const read = await production.get("/api/v1/production/employees");
  expectSuccessEnvelope(read, { context: "GET /production/employees by production（读路由无 admin 要求）" });

  const write = await production.post("/api/v1/production/employees", {});
  expectForbiddenWithReason(write, "admin", "POST /production/employees by production");
  assert.equal(write.body.meta.path, "/api/v1/production/employees");

  const exportEmployee = await production.get("/api/v1/production/employees/export.xlsx");
  expectForbiddenWithReason(exportEmployee, "admin", "GET /production/employees/export.xlsx by production");

  const admin = await clientAs(ADMIN);
  const adminExport = await admin.get("/api/v1/production/employees/export.xlsx");
  assert.notEqual(adminExport.status, 403, "管理员必须能访问导出端点");
  assert.notEqual(adminExport.status, 401, "会话必须有效");
});

test("authz.matrix_covers_all_37_controllers_and_their_route_shapes", () => {
  const covered = new Set(ENDPOINTS.map((entry) => entry.file));
  assert.equal(covered.size, 37, `矩阵应覆盖 37 个控制器文件，实际 ${covered.size}`);
  for (const file of CONTROLLER_FILES) assert.ok(covered.has(file), `矩阵缺少控制器：${file}`);

  const ids = ENDPOINTS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "矩阵条目的 id 必须唯一");

  for (const entry of ENDPOINTS) {
    assert.match(entry.path, /^\/api\/v1\//, `${entry.id} 必须带全局前缀 /api/v1`);
    if (entry.require === "public" || entry.require === "login") assert.deepEqual(entry.deny, [], `${entry.id} 无模块要求，不应有 403 期望`);
    if (entry.require === "admin") assert.ok(entry.deny.length > 0, `${entry.id} 为管理员端点，必须断言无权角色 403`);
    // 只读纪律：本文件不提交任何业务数据，写路由只允许空 body。
    if (entry.method !== "GET") assert.deepEqual(entry.body, {}, `${entry.id} 写路由只允许空 body 探测校验层`);
  }
});
