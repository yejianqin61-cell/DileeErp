#!/usr/bin/env node
/**
 * 账号初始化：按 2026-09-19 权限规范重建账号。
 *
 * 用户拍板：
 *   * 当前所有账号清空（**软删 + 停用**，不是硬删——硬删会让 87 张表的
 *     「创建人 / 最后修改人」和 1577 条审计记录全部对不上人，历史就不可读了）；
 *   * 重新建立 9 个账号：2 老板、1 财务、1 人事、5 其他。
 *
 * 顺序是刻意的：**先建新账号、并确认它们都能用，再清理旧账号**。
 * 反过来做会留下一个"谁都登不进来"的窗口——万一建号失败，厂里就得停工等人。
 * 所以脚本还有一道硬护栏：9 个账号没全部就位，绝不执行清理。
 *
 * 角色来自迁移 20260919160000_surface_permission_roles（四个角色 + 全部模块授权），
 * 所以本脚本只建账号、不建角色。
 *
 * 用法（在仓库根目录、连上生产库的环境里执行）：
 *   node scripts/bootstrap-permission-accounts.mjs              # 建号 + 清理旧账号
 *   node scripts/bootstrap-permission-accounts.mjs --keep-legacy  # 只建号
 *
 * 幂等：已存在的用户名跳过（不重置密码、不改角色）；旧账号已软删的跳过。
 * 初始密码只在**新建时**打印一次，请立刻抄进交接文档——库里只有 argon2 哈希，找不回来。
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

/** 9 个新账号：用户名 → [姓名, 角色 key]。姓名是占位，各人可在账号中心自己改。 */
const SEED_ACCOUNTS = [
  ["laoban1", "老板一", "laoban"],
  ["laoban2", "老板二", "laoban"],
  ["caiwu", "财务", "caiwu"],
  ["renshi", "人事", "renshi"],
  ["yuangong1", "员工一", "qita"],
  ["yuangong2", "员工二", "qita"],
  ["yuangong3", "员工三", "qita"],
  ["yuangong4", "员工四", "qita"],
  ["yuangong5", "员工五", "qita"],
];

/** 旧账号：全部是部署前的测试号（admin 是唯一在用的那个，其余 19 个都是测试管理员）。 */
const LEGACY_USERNAMES = ["admin", ...Array.from({ length: 19 }, (_, index) => `admin${index + 1}`)];

const DIGITS = "23456789";
const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
const pick = (set) => set[randomBytes(1)[0] % set.length];

/** 17 位随机密码：保证同时含字母与数字（后端策略要求），并避开 0/O/1/l/I 这类看错的字符。 */
function makePassword() {
  const body = Array.from({ length: 3 }, () => pick(DIGITS)).join("") + Array.from({ length: 9 }, () => pick(LETTERS)).join("");
  const shuffled = [...body].sort(() => (randomBytes(1)[0] % 2 ? 1 : -1)).join("");
  return `Dilee${shuffled}`;
}

/** 没给 DATABASE_URL 时从 .env 读（避免把连接串写进命令行、进 shell 历史）。 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [join(root, ".env"), join(root, "apps/api/.env")]) {
    try {
      const line = readFileSync(candidate, "utf8").split(/\r?\n/).find((item) => item.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* 文件不存在就试下一个 */ }
  }
  throw new Error("没有 DATABASE_URL：请在环境变量里给出，或确认仓库根目录的 .env 存在");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const keepLegacy = process.argv.includes("--keep-legacy");

async function main() {
  const roles = await prisma.role.findMany({ where: { key: { in: SEED_ACCOUNTS.map(([, , key]) => key) }, deletedAt: null } });
  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const missingRoles = [...new Set(SEED_ACCOUNTS.map(([, , key]) => key))].filter((key) => !roleByKey.has(key));
  if (missingRoles.length) {
    // 角色由迁移创建；缺了说明迁移没跑，这时候建出来的账号会没有角色（落到"其他"兜底范围）。
    throw new Error(`角色不存在：${missingRoles.join("、")}。请先执行迁移（npm run deploy 会跑）。`);
  }

  // 记账人：优先用已有的老板，其次任何活跃账号；都没有就用全零 UUID（roles.created_by 的先例）。
  const actor = await prisma.user.findFirst({ where: { deletedAt: null, roles: { some: { role: { key: "laoban" } } } }, orderBy: { createdAt: "asc" } })
    ?? await prisma.user.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
  const actorId = actor?.id ?? "00000000-0000-0000-0000-000000000000";

  const created = [];
  const skipped = [];
  for (const [username, displayName, roleKey] of SEED_ACCOUNTS) {
    const existing = await prisma.user.findFirst({ where: { username } });
    if (existing) { skipped.push(username); continue; }
    const password = makePassword();
    const user = await prisma.user.create({
      data: {
        username,
        displayName,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
        roles: { create: [{ roleId: roleByKey.get(roleKey).id }] },
      },
    });
    await prisma.auditEvent.create({
      data: { action: "user.create", entityType: "user", entityId: user.id, actorId, details: { username, role_keys: [roleKey], source: "bootstrap-permission-accounts" } },
    }).catch(() => { /* 审计写入失败不该拦住建号（字段口径可能随版本变化） */ });
    created.push({ username, displayName, roleKey, password });
  }

  // ---- 清理前的硬护栏：9 个账号必须全部就位且启用 ----
  const seeded = await prisma.user.findMany({ where: { username: { in: SEED_ACCOUNTS.map(([username]) => username) }, deletedAt: null, isActive: true }, include: { roles: { include: { role: true } } } });
  const ready = SEED_ACCOUNTS.every(([username, , roleKey]) => seeded.some((user) => user.username === username && user.roles.some(({ role }) => role.key === roleKey)));
  if (!ready) throw new Error("9 个账号尚未全部就位（用户名或角色不符），为安全起见不清理旧账号。");

  let purged = [];
  if (!keepLegacy) {
    const legacy = await prisma.user.findMany({ where: { username: { in: LEGACY_USERNAMES }, deletedAt: null } });
    for (const user of legacy) {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.session.deleteMany({ where: { userId: user.id } }); // 立刻踢下线，不等会话过期
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false, deletedAt: new Date(), deletedBy: actorId, updatedBy: actorId } });
      purged.push(user.username);
    }
  }

  // ---- 输出：密码只在这里出现一次，请立刻抄走 ----
  console.log("=== 新建账号（初始密码只打印这一次） ===");
  for (const item of created) console.log(`ACCOUNT\t${item.username}\t${item.displayName}\t${item.roleKey}\t${item.password}`);
  if (skipped.length) console.log(`SKIPPED\t${skipped.join(",")}\t（已存在，未改动）`);
  console.log("=== 旧账号清理 ===");
  console.log(purged.length ? `PURGED\t${purged.join(",")}\t（软删 + 停用 + 清空角色 + 踢下线）` : `PURGED\t(none)\t${keepLegacy ? "--keep-legacy" : "没有需要清理的旧账号"}`);

  // 与用户拍板的 2/1/1/5 对账：只看未删除账号，这样"旧号还留着"会被一眼看出来。
  const activeUsers = await prisma.user.findMany({ where: { deletedAt: null }, include: { roles: { include: { role: true } } } });
  const perRole = new Map();
  for (const user of activeUsers) for (const { role } of user.roles) perRole.set(role.key, (perRole.get(role.key) ?? 0) + 1);
  console.log("=== 清理后：未删除账号的角色分布（期望 laoban=2 caiwu=1 renshi=1 qita=5） ===");
  for (const [key, count] of [...perRole.entries()].sort()) console.log(`ROLE_COUNT\t${key}\t${count}`);
  console.log(`SUMMARY\tcreated=${created.length}\tskipped=${skipped.length}\tpurged=${purged.length}\taccounts=${activeUsers.length}`);
  console.log("BOOTSTRAP_OK");
}

main()
  .catch((error) => { console.error(`BOOTSTRAP_FAILED ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
