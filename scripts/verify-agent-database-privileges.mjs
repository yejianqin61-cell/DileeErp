import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

const BUSINESS_READ = 'SELECT 1 AS "ok" FROM "sales_orders" LIMIT 1';
const BUSINESS_ZERO_WRITE = 'UPDATE "sales_orders" SET "updated_at" = "updated_at" WHERE FALSE';
const STATE_READ = 'SELECT 1 AS "ok" FROM "agent_sessions" LIMIT 1';
const STATE_ZERO_WRITE = 'UPDATE "agent_sessions" SET "updated_at" = "updated_at" WHERE FALSE';

function isPermissionDenied(error) {
  return /permission denied|insufficient privilege|not authorized/i.test(String(error));
}

/**
 * 发布前最小权限证明：所有写探针都带 WHERE FALSE，数据库仍会校验 UPDATE 权限，
 * 但不会修改任何行。调用者负责创建和关闭两个 Prisma client，便于无数据库单测。
 */
export async function verifyAgentDatabasePrivileges({ readClient, stateClient }) {
  const passed = [];
  const allow = async (label, operation) => { await operation(); passed.push(label); };
  const deny = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      if (isPermissionDenied(error)) { passed.push(label); return; }
      throw error;
    }
    throw new Error(`${label}: database permission was unexpectedly granted`);
  };

  await allow("read business", () => readClient.$queryRawUnsafe(BUSINESS_READ));
  await deny("deny business write", () => readClient.$executeRawUnsafe(BUSINESS_ZERO_WRITE));
  await allow("read agent state", () => stateClient.$queryRawUnsafe(STATE_READ));
  await allow("write agent state", () => stateClient.$executeRawUnsafe(STATE_ZERO_WRITE));
  await deny("deny business read", () => stateClient.$queryRawUnsafe(BUSINESS_READ));
  return passed;
}

async function main() {
  const required = ["AGENT_READ_DATABASE_URL", "AGENT_STATE_DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`TEST_BLOCKED: missing ${missing.join(", ")}`);
  const readClient = new PrismaClient({ datasources: { db: { url: process.env.AGENT_READ_DATABASE_URL } } });
  const stateClient = new PrismaClient({ datasources: { db: { url: process.env.AGENT_STATE_DATABASE_URL } } });
  try {
    const passed = await verifyAgentDatabasePrivileges({ readClient, stateClient });
    console.log(`AGENT_DATABASE_PRIVILEGE_OK ${passed.join(", ")}`);
  } finally {
    await Promise.allSettled([readClient.$disconnect(), stateClient.$disconnect()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
