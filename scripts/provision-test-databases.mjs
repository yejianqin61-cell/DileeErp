// 测试数据库隔离供给。
//
// 为什么需要它（见 docs/test/01-test-master-plan.md §6.3）：
//   集成测试与 E2E 都会写入真实数据库，共用同一个库时必须串行执行。
//   实测表明：不隔离时并行天花板锁死在 27.6 小时，且 Agent 从 4 个加到 16 个收益严格为零。
//   本脚本把"一个库"变成"一个模板库 + N 个 worker 库"，让每个并行执行者独占一个库。
//
// 用法：
//   node scripts/provision-test-databases.mjs                 # 默认 8 个 worker 库
//   node scripts/provision-test-databases.mjs --workers 4
//   node scripts/provision-test-databases.mjs --reset         # 先删后建（schema 变更后使用）
//
// 环境变量：
//   TEST_DATABASE_URL  必填，指向**专用测试库**（库名必须含 test，沿用既有强校验）。
//                      脚本以它为模板库，并据其推导 worker 库名。
//   TEST_DB_WORKERS    可选，等价于 --workers。
//
// 退出码：0 成功；3 环境阻断（未配置测试库）；1 执行失败。
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const reset = args.includes("--reset");
const workers = Number(flag("workers", process.env.TEST_DB_WORKERS ?? 8));

const templateUrl = process.env.TEST_DATABASE_URL;
if (!templateUrl) {
  console.error("TEST_BLOCKED: TEST_DATABASE_URL is required (must point to a dedicated test database)");
  process.exit(3);
}
if (!/test/i.test(templateUrl)) {
  console.error("TEST_BLOCKED: TEST_DATABASE_URL must identify a dedicated test database");
  process.exit(3);
}
if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
  console.error(`Invalid --workers value: ${workers} (expected an integer 1..32)`);
  process.exit(1);
}

/** 解析连接串，返回 { base(不含库名与查询串), database, schema, query }。 */
function parseUrl(raw) {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("TEST_DATABASE_URL must include a database name");
  const schema = url.searchParams.get("schema") ?? "public";
  const query = new URLSearchParams(url.searchParams);
  query.delete("schema");
  return { url, database, schema, query };
}

const template = parseUrl(templateUrl);
// worker 库名：dilee_test -> dilee_test_01 …，避免与模板库冲突且天然含 "test"。
const workerName = (index) => `${template.database}_${String(index).padStart(2, "0")}`;

/** 用同一套凭据构造指向任意库的连接串。 */
function urlFor(database) {
  const clone = new URL(templateUrl);
  clone.pathname = `/${database}`;
  clone.searchParams.set("schema", template.schema);
  return clone.toString();
}

/** 连接维护库（postgres）执行 CREATE/DROP DATABASE —— 这两条语句不能在事务里跑。 */
function adminClient() {
  return new PrismaClient({ datasources: { db: { url: urlFor("postgres") } } });
}

async function databaseExists(admin, name) {
  const rows = await admin.$queryRawUnsafe("SELECT 1 FROM pg_database WHERE datname = $1", name);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 结束目标库上的其它连接。
 * CREATE DATABASE ... TEMPLATE 要求模板库上没有活动连接，否则报
 * "source database is being accessed by other users"。
 */
async function terminateConnections(admin, name) {
  await admin.$queryRawUnsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", name);
}

async function dropIfExists(admin, name) {
  if (!(await databaseExists(admin, name))) return false;
  await terminateConnections(admin, name);
  await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
  return true;
}

function migrate(database) {
  const env = { ...process.env, DATABASE_URL: urlFor(database) };
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed for ${database} (exit ${result.status ?? 1})`);
}

async function main() {
  const admin = adminClient();
  try {
    // 1. 重建模板库并迁移一次。worker 库用它作 TEMPLATE 克隆，避免 63 条迁移重复执行 N 遍。
    if (reset) {
      if (await dropIfExists(admin, template.database)) console.log(`dropped template database ${template.database}`);
    }
    if (!(await databaseExists(admin, template.database))) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${template.database}"`);
      console.log(`created template database ${template.database}`);
    }
    // 迁移前先断开模板库连接，迁移后再断开一次，保证后续能作为 TEMPLATE 使用。
    await terminateConnections(admin, template.database);
    console.log(`migrating template database ${template.database} ...`);
    migrate(template.database);
    await terminateConnections(admin, template.database);

    // 2. 从模板克隆 worker 库。
    const provisioned = [];
    for (let index = 1; index <= workers; index += 1) {
      const name = workerName(index);
      if (reset) await dropIfExists(admin, name);
      if (!(await databaseExists(admin, name))) {
        // 克隆必须在无连接状态下进行；模板库刚被 terminate，此处不再重复。
        await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${template.database}"`);
        console.log(`created worker database ${name} (from template)`);
      } else {
        console.log(`reused existing worker database ${name}`);
      }
      provisioned.push(name);
    }

    console.log("\nprovisioned test databases:");
    console.log(`  template : ${template.database}`);
    for (const name of provisioned) console.log(`  worker   : ${name}`);
    console.log(`\nworker URLs (TEST_DATABASE_URL_N):`);
    provisioned.forEach((name, index) => console.log(`  TEST_DATABASE_URL_${index + 1}=${urlFor(name)}`));
    console.log("\nDone. Run integration/E2E with TEST_DATABASE_URL pointing at the template, or use the worker URLs above for parallel runs.");
  } finally {
    await admin.$disconnect();
  }
}

await main();
