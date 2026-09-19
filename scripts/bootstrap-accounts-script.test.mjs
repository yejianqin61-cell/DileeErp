// 账号初始化脚本（scripts/bootstrap-permission-accounts.mjs）的守卫测试。
//
// 为什么这个脚本需要源码级守卫：它**直接动生产账号**——建的是所有人的登录凭据，
// 清的是厂里原来在用的账号。它的几条安全性质一旦在后续改动里丢掉，后果不是"测试变红"，
// 而是"厂里没人能登录"或"历史记录的创建人全变成 —"。这里的每一条都对着一个具体事故：
//   1) 只软删不硬删 —— 硬删会让 87 张表的 created_by/updated_by 与 1577 条审计记录对不上人；
//   2) 先建号后清理 —— 反过来会留下"谁都进不去"的窗口；
//   3) 就位护栏 —— 建号失败时绝不允许继续清理旧账号；
//   4) 初始密码只打印、不落盘、不硬编码 —— 库里只有 argon2 哈希，落盘的明文就是永久泄漏。
//
// 运行：node --test scripts/bootstrap-accounts-script.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts", "bootstrap-permission-accounts.mjs"), "utf8");

test("账号初始化脚本存在，且九个新账号的角色分布就是用户拍板的 2/1/1/5", () => {
  const seed = source.slice(source.indexOf("const SEED_ACCOUNTS"), source.indexOf("const LEGACY_USERNAMES"));
  const roleOf = (key) => (seed.match(new RegExp(`"${key}"\\]`, "g")) ?? []).length;
  assert.equal(roleOf("laoban"), 2, "两个老板");
  assert.equal(roleOf("caiwu"), 1, "一个财务");
  assert.equal(roleOf("renshi"), 1, "一个人事");
  assert.equal(roleOf("qita"), 5, "五个其他");
  assert.match(seed, /"laoban1"/);
  assert.match(seed, /"caiwu"/);
  assert.match(seed, /"renshi"/);
});

test("旧账号只软删不硬删：用 deletedAt 标记，不得出现 user.delete / user.deleteMany", () => {
  assert.match(source, /deletedAt: new Date\(\)/, "必须写 deletedAt（软删）");
  assert.equal(/prisma\.user\.delete\b/.test(source), false, "不得硬删用户：87 张表的创建人列会一起变成死引用");
  assert.equal(/prisma\.user\.deleteMany/.test(source), false, "不得批量硬删用户");
  // 软删之外还必须做这三件事，否则旧账号仍能被使用或继续持有权限
  assert.match(source, /isActive: false/, "必须同时停用");
  assert.match(source, /userRole\.deleteMany/, "必须清空旧账号的角色");
  assert.match(source, /session\.deleteMany/, "必须立刻踢掉旧账号的会话（不等会话自然过期）");
});

test("顺序：先建新账号、再清理旧账号（不留『谁都进不去』的窗口）", () => {
  const createIndex = source.indexOf("created.push(");
  const purgeIndex = source.indexOf("LEGACY_USERNAMES"), purgeLoop = source.indexOf("for (const user of legacy)");
  assert.ok(createIndex > 0 && purgeLoop > 0, "两段都必须存在");
  assert.ok(createIndex < purgeLoop, "建号必须排在清理之前");
  assert.ok(purgeIndex < purgeLoop);
});

test("就位护栏：九个账号没全部就位时，必须抛错并拒绝清理", () => {
  assert.match(source, /const ready = SEED_ACCOUNTS\.every/, "必须逐个核对用户名与角色");
  assert.match(source, /if \(!ready\) throw new Error\([^)]*不清理旧账号/, "护栏必须以抛错终止，而不是打个警告继续清理");
  // 护栏必须真的挡住清理：它要出现在清理循环之前
  assert.ok(source.indexOf("if (!ready) throw") < source.indexOf("for (const user of legacy)"), "护栏必须在校验之后、清理之前");
});

test("初始密码：随机生成、只打印一次，不得硬编码或写进文件", () => {
  assert.match(source, /randomBytes/, "密码必须来自随机源");
  assert.match(source, /argon2\.hash\(/, "库里只能存哈希");
  assert.match(source, /console\.log\(`ACCOUNT\\t/, "密码只在创建时打印一次");
  assert.equal(/writeFileSync|appendFileSync|createWriteStream/.test(source), false, "密码不得落盘：明文的副本就是永久泄漏");
  assert.equal(/password\s*[=:]\s*"/.test(source), false, "不得硬编码初始密码");
});

test("可重入：已存在的用户名跳过，绝不重置已有账号的密码或角色", () => {
  assert.match(source, /const existing = await prisma\.user\.findFirst\(\{ where: \{ username \} \}\)/, "必须按用户名判重");
  assert.match(source, /if \(existing\) \{ skipped\.push\(username\); continue; \}/, "已存在就跳过，而不是覆盖");
});

test("角色缺失时明确失败：提示先跑迁移，而不是建出一批没有角色的账号", () => {
  assert.match(source, /角色不存在/, "角色字典由迁移创建，缺了要说清楚");
  assert.match(source, /请先执行迁移/);
});

test("提供 --keep-legacy 逃生开关（只建号、不清理）", () => {
  assert.match(source, /--keep-legacy/, "运维要能在不清理旧账号的前提下先把号建出来");
});
