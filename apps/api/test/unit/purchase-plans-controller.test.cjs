// 采购计划控制器与采购单控制器的**路由形状**静态守卫（不需要数据库、不需要启动 API）。
//
// 为什么值得单独一个文件：这两件事在真实请求里才暴露，而真实请求需要 TEST_DATABASE_URL，
// 本地跑不到 —— 于是错误会一直等到部署核验才被发现。
//
//   1. **路由顺序**：`@Get("candidates")` 必须声明在 `@Get(":id")` 之前。
//      Nest 按声明顺序匹配，反过来的话 `candidates` 会被当成一个计划 id 吃掉
//      （`purchase-orders` 的 `bom-item-status` 踩过同一个坑，那里也有一条同样的守卫）。
//   2. **死端点不许复活**：`POST /purchase-orders/:id/revert-draft` 与 `/:id/cancel` 已在
//      2026-09-27 删除（草稿被采购计划接管），出口是 `/:id/revert-to-plan`。
//      路由表里留着它们就是给死代码续命。
//   3. **模块门禁**：计划控制器必须与采购单同一道门（类级 `@RequireModules("procurement")`），
//      不能悄悄变成无门禁的公开接口。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src", "modules", "procurement");
const plans = fs.readFileSync(path.join(SRC, "purchase-plans.controller.ts"), "utf8");
const orders = fs.readFileSync(path.join(SRC, "purchase-orders.controller.ts"), "utf8");

test("路由顺序：`@Get(\"candidates\")` 必须声明在 `@Get(\":id\")` 之前", () => {
  const candidates = plans.indexOf('@Get("candidates")');
  const byId = plans.indexOf('@Get(":id") async');
  assert.ok(candidates > 0, "candidates 路由必须存在（新建计划的下拉数据源）");
  assert.ok(byId > 0, ":id 路由必须存在");
  assert.ok(candidates < byId, "Nest 按声明顺序匹配：candidates 必须在 :id 之前，否则会被当成计划 id 吃掉");
});

test("计划控制器：类级模块门禁是 procurement（与采购单同一道门，不新增模块键）", () => {
  assert.match(plans, /@UseGuards\(AuthenticationGuard, ModulePermissionGuard\)/);
  assert.match(plans, /@RequireModules\("procurement"\)/);
  assert.match(plans, /@Controller\("purchase-plans"\)/);
});

test("计划控制器：五个路由的形状（列表 / 候选 / 新建 / 保存 / 删除 / 下单）", () => {
  assert.match(plans, /@Get\(\) async list\(/);
  assert.match(plans, /@Post\(\) async create\(/);
  assert.match(plans, /@Patch\(":id"\) async update\(/);
  assert.match(plans, /@Delete\(":id"\) async remove\(/);
  assert.match(plans, /@Post\(":id\/order"\) async order\(/);
});

test("删除的端点不许复活：revert-draft / cancel 都不在了，出口是 revert-to-plan", () => {
  assert.equal(orders.includes('@Post(":id/revert-draft")'), false, "草稿不存在了，这个端点没有语义");
  assert.equal(orders.includes('@Post(":id/cancel")'), false, "它只允许取消草稿，草稿消失后是死代码");
  assert.match(orders, /@Post\(":id\/revert-to-plan"\)/, "退回采购计划是唯一的出口");
  // 而 service 侧也不该留下那两个方法（控制器删了、服务留着 = 半死）。
  const service = fs.readFileSync(path.join(SRC, "purchase-orders.service.ts"), "utf8");
  assert.equal(/async revertToDraft\(/.test(service), false);
  assert.equal(/async cancel\(id: string/.test(service), false);
  assert.equal(/PURCHASE_ORDER_DETAIL_READONLY/.test(service), true, "明细只读的门禁在");
});

test("退回采购计划复用既有的 PURCHASE_ORDER_NOT_REVERTIBLE（不新造同义码）", () => {
  const planService = fs.readFileSync(path.join(SRC, "purchase-plans.service.ts"), "utf8");
  assert.match(planService, /async revertPurchaseOrder\(/);
  // 这个码原来在 `revertToDraft()` 里（守的是同一条不变式），删掉那个方法时**搬**过来，不是新起。
  assert.match(planService, /code: "PURCHASE_ORDER_NOT_REVERTIBLE"/);
  assert.match(planService, /code: "PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE"/);
});
