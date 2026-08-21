import * as argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const displayName = process.env.INITIAL_ADMIN_DISPLAY_NAME ?? "系统管理员";
  if (!username || !password) throw new Error("必须设置 INITIAL_ADMIN_USERNAME 和 INITIAL_ADMIN_PASSWORD 后才可初始化管理员");
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new Error("初始管理员密码至少 10 位且必须同时包含字母和数字");

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return;

  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    const role = await tx.role.upsert({ where: { key: "administrator" }, update: { name: "管理员", updatedBy: id }, create: { id: randomUUID(), key: "administrator", name: "管理员", createdBy: id, updatedBy: id } });
    const user = await tx.user.create({ data: { id, username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), displayName, createdBy: id, updatedBy: id } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  });
}

main().finally(() => prisma.$disconnect());
