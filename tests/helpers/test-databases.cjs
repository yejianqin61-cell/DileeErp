// 并行测试的数据库寻址契约。
//
// 单一 TEST_DATABASE_URL 只能支撑串行执行：集成测试与 E2E 都写入真实库，
// 共用一库时唯一约束、order_no 前缀与清理顺序都会互相干扰。
// 本模块让每个并行执行者按索引取到**独占**的库，从而解除
// docs/test/01-test-master-plan.md §6.3 描述的并行瓶颈。
//
// 寻址优先级：
//   1. TEST_DATABASE_URL_<N>（由 scripts/provision-test-databases.mjs 打印，CI 显式注入）
//   2. 由 TEST_DATABASE_URL 推导出的 <dbname>_<NN> 形式 worker 库
//   3. 回退到 TEST_DATABASE_URL 本身（串行场景，单库）
//
// 库名必须含 test —— 沿用 tests/helpers/test-context.cjs 的强校验，禁止误连生产库。

const WORKER_URL_PATTERN = /^TEST_DATABASE_URL_(\d+)$/;

/** 读取显式注入的 worker URL 表，例如 TEST_DATABASE_URL_1 / TEST_DATABASE_URL_2。 */
function explicitWorkerUrls() {
  const found = new Map();
  for (const [key, value] of Object.entries(process.env)) {
    const match = WORKER_URL_PATTERN.exec(key);
    if (match && value) found.set(Number(match[1]), value);
  }
  return found;
}

/** 由单一连接串推导 worker 库连接串：库名追加 _NN（与 provision 脚本的命名保持一致）。 */
function deriveWorkerUrl(base, index) {
  const url = new URL(base);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must include a database name");
  url.pathname = `/${database}_${String(index).padStart(2, "0")}`;
  return url.toString();
}

function assertIsTestDatabase(url, label) {
  if (!url) throw new Error(`TEST_BLOCKED: ${label} is not set`);
  if (!/test/i.test(url)) throw new Error(`TEST_BLOCKED: ${label} must identify a dedicated test database`);
  return url;
}

/**
 * 取第 index 个（1 起）并行执行者的测试库连接串。
 * 未配置任何隔离变量时回退到 TEST_DATABASE_URL，行为与改造前完全一致。
 */
function testDatabaseUrlFor(index) {
  const explicit = explicitWorkerUrls();
  if (explicit.has(index)) return assertIsTestDatabase(explicit.get(index), `TEST_DATABASE_URL_${index}`);

  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL is required; DATABASE_URL is never used by tests");
  assertIsTestDatabase(base, "TEST_DATABASE_URL");

  // 只声明了一个 worker 时不做推导，避免生成并不存在的库名。
  if (explicit.size === 0) return base;
  return assertIsTestDatabase(deriveWorkerUrl(base, index), `derived worker database for index ${index}`);
}

/** 当前可用的并行度：显式 worker URL 数量，未配置时为 1（串行）。 */
function availableTestDatabases() {
  const explicit = explicitWorkerUrls();
  return Math.max(1, explicit.size);
}

module.exports = { assertIsTestDatabase, availableTestDatabases, deriveWorkerUrl, testDatabaseUrlFor };
