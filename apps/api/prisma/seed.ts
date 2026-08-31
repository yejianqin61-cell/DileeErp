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
  const id = existing?.id ?? randomUUID();
  await prisma.$transaction(async (tx) => {
    const role = await tx.role.upsert({ where: { key: "administrator" }, update: { name: "管理员", updatedBy: id }, create: { id: randomUUID(), key: "administrator", name: "管理员", createdBy: id, updatedBy: id } });
    if (!existing) {
      const user = await tx.user.create({ data: { id, username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), displayName, createdBy: id, updatedBy: id } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    for (const name of ["打", "码", "个", "包", "捆"]) {
      await tx.unit.upsert({ where: { name }, update: { isActive: true, updatedBy: id }, create: { id: randomUUID(), name, createdBy: id, updatedBy: id } });
    }
    const defaultUnit = await tx.unit.findFirst({ where: { deletedAt: null, isActive: true }, orderBy: { createdAt: "asc" } });
    if (defaultUnit) {
      for (const [index, operationName] of ["大裁", "拉边", "小裁", "验片", "合片", "剪线头", "打顶打带", "打珠尾", "缝伞", "品检", "折伞", "外发加工", "其他", "包装"].entries()) {
        const existingOperation = await tx.operationCatalog.findFirst({ where: { operationName, deletedAt: null } });
        if (!existingOperation) {
          await tx.operationCatalog.create({ data: { id: randomUUID(), operationCode: `OP-${String(index + 1).padStart(3, "0")}`, operationName, defaultUnitId: defaultUnit.id, createdBy: id, updatedBy: id } });
        }
      }
    }
    const employeeType = await tx.dictionaryType.upsert({ where: { key: "employee_type" }, update: { name: "员工类型", updatedBy: id }, create: { id: randomUUID(), key: "employee_type", name: "员工类型", createdBy: id, updatedBy: id } });
    for (const item of [{ key: "workshop", label: "车间员工" }, { key: "non_workshop", label: "非车间员工" }]) {
      await tx.dictionaryItem.upsert({ where: { typeId_key: { typeId: employeeType.id, key: item.key } }, update: { label: item.label, isActive: true, updatedBy: id }, create: { id: randomUUID(), typeId: employeeType.id, key: item.key, label: item.label, createdBy: id, updatedBy: id } });
    }
  });
}

main().finally(() => prisma.$disconnect());
