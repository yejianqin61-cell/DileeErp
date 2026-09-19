// 表面权限词汇表（platform/authorization/surface-scope.ts）的单元测试。
//
// 为什么值得单独测：用户 2026-09-19 拍板的规则是「老板/财务＝全部页面、人事＝仅人事、
// 其他＝除财务人事外」。这三条**只在这一处成立**——后端把它算成 `surface_sections` 下发给前端，
// 前端据此过滤菜单与拦页面。这里一旦算错，前端的门禁与菜单会同时错，而且不会有任何报错。
//
// 本文件与前端 apps/web/lib/surface-permission.test.mjs **共用同一张范围矩阵**：
// 一边按角色算栏目、一边按路径判栏目，两边必须对得上才拦得准。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  SURFACE_ROLES,
  SURFACE_ROLE_KEYS,
  SURFACE_SECTIONS,
  SURFACE_SCOPE_LABELS,
  isSurfaceRoleKey,
  surfaceRoleName,
  surfaceScopeOf,
  surfaceSectionsOf,
} = require("../../dist/platform/authorization/surface-scope.js");

const ALL = [...SURFACE_SECTIONS];
const FINANCE_FREE = ALL.filter((section) => section !== "finance");

function sorted(values) { return [...values].sort(); }

test("四个表面角色就是老板/财务/人事/其他，key 用拼音以避免与模块 key 撞名", () => {
  assert.deepEqual(SURFACE_ROLES.map((role) => role.key), ["laoban", "caiwu", "renshi", "qita"]);
  assert.deepEqual(SURFACE_ROLES.map((role) => role.name), ["老板", "财务", "人事", "其他"]);
  // 模块 key 里已经有 finance / hr（MODULE_KEYS）。角色若同名，日志与审计里就分不清了。
  assert.equal(SURFACE_ROLE_KEYS.includes("finance"), false, "角色 key 不得与模块 key 重名");
  assert.equal(SURFACE_ROLE_KEYS.includes("hr"), false, "角色 key 不得与模块 key 重名");
  assert.deepEqual(SURFACE_ROLE_KEYS, ["laoban", "caiwu", "renshi", "qita"]);
});

test("老板与财务：看得见全部栏目（含财务与人事）", () => {
  for (const key of ["laoban", "caiwu"]) {
    assert.deepEqual(sorted(surfaceSectionsOf([key])), sorted(ALL), `${key} 应看到全部栏目`);
    assert.equal(surfaceScopeOf([key]), "full");
  }
});

test("人事：只能访问人事页面及其下属页面（账号中心是唯一例外）", () => {
  // 用户原话"人事，只能访问人事页面及其下属页面"。账号中心是同一轮里单独拍板的"所有人可进"，
  // 没有它人事连自己的密码都改不了，所以它是规则内唯一被允许的额外栏目。
  assert.deepEqual(sorted(surfaceSectionsOf(["renshi"])), ["account", "hr"]);
  assert.equal(surfaceScopeOf(["renshi"]), "hr");
  // 人事**看不到工作台**：这是按用户规则严格实现的，不是漏配。要放开只需把 dashboard 加进 hr 范围。
  assert.equal(surfaceSectionsOf(["renshi"]).includes("dashboard"), false);
});

test("其他：除财务、人事之外的页面（工作台与报表都在内）", () => {
  const sections = surfaceSectionsOf(["qita"]);
  assert.deepEqual(sorted(sections), sorted(FINANCE_FREE.filter((section) => section !== "hr")));
  assert.ok(sections.includes("dashboard"), "工作台属于其他角色");
  assert.ok(sections.includes("reports"), "报表与告警属于其他角色（用户 2026-09-19 拍板）");
  assert.equal(sections.includes("finance"), false);
  assert.equal(sections.includes("hr"), false);
  assert.equal(surfaceScopeOf(["qita"]), "general");
});

test("administrator 视为最高表面权限（它就是「实际权限」那个角色）", () => {
  assert.deepEqual(sorted(surfaceSectionsOf(["administrator"])), sorted(ALL));
  assert.equal(surfaceScopeOf(["administrator"]), "full");
});

test("认不出来的角色落到「其他」兜底，而不是被关在门外", () => {
  // 一个刚建好、还没分配角色的账号如果什么都看不到，登录后会像"系统坏了"，更难排查。
  assert.deepEqual(sorted(surfaceSectionsOf(["not-a-role"])), sorted(surfaceSectionsOf(["qita"])));
  assert.deepEqual(sorted(surfaceSectionsOf([])), sorted(surfaceSectionsOf(["qita"])));
  assert.equal(surfaceScopeOf([]), "general");
});

test("多角色取并集：「人事＋其他」= 除财务外全部（一个范围名表达不了，所以下发栏目集合）", () => {
  const union = surfaceSectionsOf(["renshi", "qita"]);
  assert.deepEqual(sorted(union), sorted(FINANCE_FREE));
  assert.ok(union.includes("hr"), "并集里必须保留人事栏目");
  assert.equal(union.includes("finance"), false);
  // 标签只是给人看的，多角色并集落到 general 是最不误导的说法；门禁用的一直是栏目集合。
  assert.equal(surfaceScopeOf(["renshi", "qita"]), "general");
});

test("isSurfaceRoleKey / surfaceRoleName / 范围文案", () => {
  assert.equal(isSurfaceRoleKey("laoban"), true);
  assert.equal(isSurfaceRoleKey("administrator"), false, "administrator 不是表面角色，它是实际权限角色");
  assert.equal(surfaceRoleName("qita"), "其他");
  assert.equal(surfaceRoleName("unknown"), "unknown", "认不出来就原样返回，不要编一个中文名");
  assert.equal(SURFACE_SCOPE_LABELS.full, "全部页面（含财务、人事）");
  assert.equal(SURFACE_SCOPE_LABELS.hr, "仅人事页面");
  assert.equal(SURFACE_SCOPE_LABELS.general, "除财务、人事之外的页面");
});

test("规则矩阵：每个范围对每个栏目的可达性（前后端共用的那张表）", () => {
  const expected = {
    full: { dashboard: true, production: true, procurement: true, qc: true, warehouse: true, sales: true, customers: true, reports: true, finance: true, hr: true, account: true },
    hr: { dashboard: false, production: false, procurement: false, qc: false, warehouse: false, sales: false, customers: false, reports: false, finance: false, hr: true, account: true },
    general: { dashboard: true, production: true, procurement: true, qc: true, warehouse: true, sales: true, customers: true, reports: true, finance: false, hr: false, account: true },
  };
  const sectionsOfScope = { full: ["laoban"], hr: ["renshi"], general: ["qita"] };
  for (const [scope, row] of Object.entries(expected)) {
    const sections = surfaceSectionsOf(sectionsOfScope[scope]);
    for (const [section, allowed] of Object.entries(row)) {
      assert.equal(sections.includes(section), allowed, `范围 ${scope} 对栏目 ${section} 的可达性应为 ${allowed}`);
    }
  }
});
