// E2E 共用的「临时管理员账号」夹具。
//
// 为什么每个 spec 都自己建账号：E2E 打的是真库真服务，共用一个固定账号会让
// 「谁建的、失败后要不要清」变得含糊；这里一次 run 一个账号，afterAll 精确删掉。
// 角色复用 `administrator`（upsert）：权限矩阵下财务三大模块都要求管理员或对应模块权限，
// 用管理员可以让 spec 专注在业务流程本身，而不是再铺一套角色/权限。
const { randomUUID } = require("node:crypto");
const argon2 = require("argon2");

const PASSWORD = "E2eFinance2026";

/**
 * 建一个 run 内唯一的管理员账号。
 * @returns {{ userId: string, username: string, password: string, runId: string }}
 */
async function seedE2eAdmin(prisma, prefix) {
  const runId = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const username = `e2e-${prefix}-${runId}`;
  const audit = { createdBy: userId, updatedBy: userId };
  const role = await prisma.role.upsert({
    where: { key: "administrator" },
    update: { name: "管理员", updatedBy: userId },
    create: { key: "administrator", name: "管理员", ...audit },
  });
  await prisma.user.create({
    data: { id: userId, username, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }), displayName: `E2E ${prefix}`, ...audit },
  });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  return { userId, username, password: PASSWORD, runId };
}

/** 删除账号及其会话/角色绑定（业务数据由各 spec 自己清）。 */
async function removeE2eAdmin(prisma, userId) {
  if (!userId) return;
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

module.exports = { removeE2eAdmin, seedE2eAdmin };
