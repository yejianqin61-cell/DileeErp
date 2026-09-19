// 表面权限（app/web/lib/surface-permission.ts）的单元测试（node:test，与 lib 下其它纯函数一致）。
//
// 这一层是**门禁与菜单的唯一判定**：路径属于哪个栏目、这个栏目他能不能进。
// 它与后端 apps/api/test/unit/surface-scope.test.cjs 是同一张矩阵的两半——
// 后端算"谁能看哪些栏目"，这里算"哪个路径属于哪个栏目"。两边一起改。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_MODULE_KEYS,
  canManageAccounts,
  canVisitPath,
  describeSurfaceScope,
  hasAllModules,
  landingPathFor,
  MODULE_LABELS,
  sectionOfPath,
  SECTION_LABELS,
  SURFACE_ROLES,
  surfaceRoleName,
  SURFACE_SECTIONS,
} from "./surface-permission.ts";

/** 与会话接口下发的栏目集合等价的三个范围（按角色算出来的一样）。 */
const FULL = [...SURFACE_SECTIONS];
const HR = ["hr", "account"];
const GENERAL = ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "customers", "reports", "account"];

test("sectionOfPath：一级路径与子路径都归到自己的栏目", () => {
  assert.equal(sectionOfPath("/"), "dashboard");
  assert.equal(sectionOfPath("/production"), "production");
  assert.equal(sectionOfPath("/production/material-issues"), "production");
  assert.equal(sectionOfPath("/warehouse/raw-material-storage"), "warehouse");
  assert.equal(sectionOfPath("/finance/salary/ledger"), "finance");
  assert.equal(sectionOfPath("/hr"), "hr");
  assert.equal(sectionOfPath("/sales/orders/new"), "sales");
  assert.equal(sectionOfPath("/account"), "account");
});

test("sectionOfPath：按「段」匹配，前缀相同的另一个页面不会被误判", () => {
  // /financex 不是 /finance 的子路径。用 startsWith(prefix) 会在这里出错，
  // 后果是"其他"角色能进一个本该被拦的页面（或反过来被误拦）。
  assert.equal(sectionOfPath("/financex"), "dashboard");
  assert.equal(sectionOfPath("/hrm"), "dashboard");
  assert.notEqual(sectionOfPath("/finances"), "finance");
});

test("sectionOfPath：查询串、hash、尾斜杠都不影响判定", () => {
  assert.equal(sectionOfPath("/finance?section=payable"), "finance");
  assert.equal(sectionOfPath("/finance/#top"), "finance");
  assert.equal(sectionOfPath("/warehouse/"), "warehouse");
  assert.equal(sectionOfPath(""), "dashboard");
});

test("canVisitPath：三个范围的规则矩阵（与后端同一张表）", () => {
  const expected = [
    // [路径, 老板/财务, 人事, 其他]
    ["/", true, false, true],
    ["/production", true, false, true],
    ["/procurement", true, false, true],
    ["/qc", true, false, true],
    ["/warehouse", true, false, true],
    ["/sales", true, false, true],
    ["/customers", true, false, true],
    ["/reports", true, false, true],
    ["/finance", true, false, false],
    ["/finance/receivable", true, false, false],
    ["/hr", true, true, false],
    ["/hr/employees", true, true, false],
    ["/account", true, true, true],
  ];
  for (const [path, full, hr, general] of expected) {
    assert.equal(canVisitPath(FULL, path), full, `老板/财务 ${path}`);
    assert.equal(canVisitPath(HR, path), hr, `人事 ${path}`);
    assert.equal(canVisitPath(GENERAL, path), general, `其他 ${path}`);
  }
});

test("canVisitPath：还没有权限信息时一律拦住（不能默认放行）", () => {
  // 权限还没取到时若默认放行，会出现"先闪一下页面内容再被门禁替换"的观感；
  // 拦住更安全：AppShell 在拿到档案之前根本不渲染 children。
  assert.equal(canVisitPath(undefined, "/finance"), false);
  assert.equal(canVisitPath([], "/"), false);
});

test("landingPathFor：登录后落到自己进得去的第一个页面", () => {
  assert.equal(landingPathFor(FULL), "/");
  assert.equal(landingPathFor(GENERAL), "/");
  // 人事按规则看不到工作台，所以不能落在 "/"，否则一登录就撞门禁。
  assert.equal(landingPathFor(HR), "/hr");
  assert.equal(landingPathFor(["account"]), "/account");
  assert.equal(landingPathFor(undefined), "/");
});

test("菜单过滤：无权入口必须被隐藏（用户拍板）", () => {
  const navigation = [["工作台", "/"], ["生产", "/production"], ["采购", "/procurement"], ["质检", "/qc"], ["财务", "/finance"], ["仓库", "/warehouse"], ["人事", "/hr"], ["客户与销售", "/sales"], ["报表与告警", "/reports"]];
  const visible = (sections) => navigation.filter(([, href]) => canVisitPath(sections, href)).map(([label]) => label);
  assert.deepEqual(visible(FULL), ["工作台", "生产", "采购", "质检", "财务", "仓库", "人事", "客户与销售", "报表与告警"]);
  assert.deepEqual(visible(HR), ["人事"], "人事只应看到人事");
  assert.deepEqual(visible(GENERAL), ["工作台", "生产", "采购", "质检", "仓库", "客户与销售", "报表与告警"], "其他不应看到财务与人事");
});

test("工作台卡片：财务卡片对「其他」角色不显示（按卡片目标路径判定）", () => {
  // workbench 里的卡片形如 [名称, 目标路径]；用同一套 canVisitPath 过滤，
  // 所以"哪些卡片该藏"不需要单独维护一张表。
  const cards = [["采购 / 应付", "/procurement"], ["原料库存", "/warehouse"], ["生产", "/production"], ["成品质检", "/qc"], ["应收", "/finance"], ["应付", "/finance"]];
  const shown = (sections) => cards.filter(([, href]) => canVisitPath(sections, href)).map(([label]) => label);
  assert.deepEqual(shown(FULL), ["采购 / 应付", "原料库存", "生产", "成品质检", "应收", "应付"]);
  assert.deepEqual(shown(GENERAL), ["采购 / 应付", "原料库存", "生产", "成品质检"], "其他角色不该在工作台看到应收/应付");
});

test("canManageAccounts：仅老板与财务（administrator 也算，迁移前的老账号要用）", () => {
  const profile = (surface_roles, role_keys = surface_roles) => ({ surface_roles, role_keys });
  assert.equal(canManageAccounts(profile(["laoban"])), true);
  assert.equal(canManageAccounts(profile(["caiwu"])), true);
  assert.equal(canManageAccounts(profile(["renshi"])), false);
  assert.equal(canManageAccounts(profile(["qita"])), false);
  assert.equal(canManageAccounts(profile([], ["administrator"])), true);
  assert.equal(canManageAccounts(null), false);
  assert.equal(canManageAccounts(undefined), false);
});

test("hasAllModules：实际权限是否已等同管理员", () => {
  assert.equal(hasAllModules([...ALL_MODULE_KEYS]), true);
  assert.equal(hasAllModules(["sales", "hr"]), false);
  assert.equal(hasAllModules([]), false);
  assert.equal(hasAllModules(undefined), false);
});

test("展示文案：角色名、栏目名、权限范围说明", () => {
  assert.deepEqual(SURFACE_ROLES.map((role) => role.key), ["laoban", "caiwu", "renshi", "qita"]);
  assert.deepEqual(SURFACE_ROLES.map((role) => role.name), ["老板", "财务", "人事", "其他"]);
  assert.equal(surfaceRoleName("laoban"), "老板");
  assert.equal(surfaceRoleName("administrator"), "administrator", "认不出来就原样显示，不要编中文名");
  assert.equal(SECTION_LABELS.finance, "财务");
  assert.equal(SECTION_LABELS.account, "账号管理中心");
  assert.equal(MODULE_LABELS.procurement, "采购");
  assert.equal(describeSurfaceScope(FULL, "full"), "全部页面（含财务、人事）");
  assert.equal(describeSurfaceScope(HR, "hr"), "仅人事页面");
  assert.equal(describeSurfaceScope(GENERAL, "general"), "除财务、人事之外的页面");
  // 范围名认不出来时退回列举栏目，至少让人看懂自己能看到什么。
  assert.equal(describeSurfaceScope(["hr", "account"], "unknown-scope"), "人事、账号管理中心");
  assert.equal(describeSurfaceScope([], undefined), "未分配任何页面权限");
});
