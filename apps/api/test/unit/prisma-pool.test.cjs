// Prisma 连接池与事务超时口径的守卫测试（2026-11-22）。
//
// 为什么需要它：这两个数字是**生产事故的直接修复**（连接池 3 → 15、事务 5s → 25s），
// 但它们是"配置"，改错了不会让任何业务用例变红 —— 只会在生产上重新出现
// 「Timed out fetching a new connection」和「Transaction already closed」。
// 所以把口径钉在这里：
//   · 默认值必须是用户确认过的数字；
//   · 连接串改写必须幂等、且不覆盖运维显式配置；
//   · 非法环境变量不能让服务起不来（退回默认值）；
//   · 三个 PrismaClient 都真的用上了这套参数（漏一个就等于那个客户端还是旧口径）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  DEFAULT_TRANSACTION_MAX_WAIT_MS,
  AGENT_CONNECTION_LIMIT,
  resolvePoolConfig,
  withConnectionPoolParams,
  transactionOptions,
  describePoolConfig,
} = require("../../dist/platform/database/prisma-pool.js");

const SRC = join(__dirname, "../../src");

test("默认值就是生产确认过的数字：池 15、取连接等待 20s、事务 25s、开事务等待 10s", () => {
  assert.equal(DEFAULT_CONNECTION_LIMIT, 15);
  assert.equal(DEFAULT_POOL_TIMEOUT_SECONDS, 20);
  assert.equal(DEFAULT_TRANSACTION_TIMEOUT_MS, 25000);
  assert.equal(DEFAULT_TRANSACTION_MAX_WAIT_MS, 10000);
  // 用户要求「20~30 秒」，25 必须落在这个区间
  assert.ok(DEFAULT_TRANSACTION_TIMEOUT_MS >= 20000 && DEFAULT_TRANSACTION_TIMEOUT_MS <= 30000);
  // agent 专用池要比主应用小（避免占满 max_connections）
  assert.ok(AGENT_CONNECTION_LIMIT < DEFAULT_CONNECTION_LIMIT);
});

test("没有环境变量时用默认值", () => {
  const config = resolvePoolConfig({});
  assert.equal(config.connectionLimit, 15);
  assert.equal(config.poolTimeoutSeconds, 20);
  assert.equal(config.transactionTimeoutMs, 25000);
  assert.equal(config.transactionMaxWaitMs, 10000);
});

test("环境变量可以覆盖（运维临时调参不必改代码）", () => {
  const config = resolvePoolConfig({
    PRISMA_CONNECTION_LIMIT: "30",
    PRISMA_POOL_TIMEOUT: "45",
    PRISMA_TRANSACTION_TIMEOUT_MS: "60000",
    PRISMA_TRANSACTION_MAX_WAIT_MS: "20000",
  });
  assert.equal(config.connectionLimit, 30);
  assert.equal(config.poolTimeoutSeconds, 45);
  assert.equal(config.transactionTimeoutMs, 60000);
  assert.equal(config.transactionMaxWaitMs, 20000);
});

test("非法环境变量退回默认值，不让服务起不来", () => {
  for (const bad of ["abc", "0", "-5", "1.5", "", "   "]) {
    const config = resolvePoolConfig({ PRISMA_CONNECTION_LIMIT: bad, PRISMA_TRANSACTION_TIMEOUT_MS: bad });
    assert.equal(config.connectionLimit, 15, `connectionLimit 遇到 ${JSON.stringify(bad)} 应退回默认值`);
    assert.equal(config.transactionTimeoutMs, 25000, `timeout 遇到 ${JSON.stringify(bad)} 应退回默认值`);
  }
});

test("连接串：写入 connection_limit 与 pool_timeout，并保留原有参数", () => {
  const url = "postgresql://dilee:secret@127.0.0.1:15432/dilee_erp?schema=public";
  const out = withConnectionPoolParams(url, { connectionLimit: 15, poolTimeoutSeconds: 20 });
  const parsed = new URL(out);
  assert.equal(parsed.searchParams.get("connection_limit"), "15");
  assert.equal(parsed.searchParams.get("pool_timeout"), "20");
  // 原有参数、库名、端口、账号都不能被动到
  assert.equal(parsed.searchParams.get("schema"), "public");
  assert.equal(parsed.pathname, "/dilee_erp");
  assert.equal(parsed.port, "15432");
  assert.equal(parsed.username, "dilee");
  assert.equal(parsed.password, "secret");
});

test("连接串：幂等（跑两次结果一致，不留重复参数）", () => {
  const url = "postgresql://dilee:pw@127.0.0.1:15432/dilee_erp?schema=public";
  const once = withConnectionPoolParams(url, { connectionLimit: 15, poolTimeoutSeconds: 20 });
  const twice = withConnectionPoolParams(once, { connectionLimit: 15, poolTimeoutSeconds: 20 });
  assert.equal(twice, once);
  assert.equal(new URL(twice).searchParams.getAll("connection_limit").length, 1);
});

test("连接串：**不覆盖**运维显式写的值（代码默认不该压过显式配置）", () => {
  const url = "postgresql://dilee:pw@127.0.0.1:15432/dilee_erp?connection_limit=40&pool_timeout=60";
  const out = withConnectionPoolParams(url, { connectionLimit: 15, poolTimeoutSeconds: 20 });
  const parsed = new URL(out);
  assert.equal(parsed.searchParams.get("connection_limit"), "40");
  assert.equal(parsed.searchParams.get("pool_timeout"), "60");
});

test("连接串：非法 URL 原样返回，不抛错（让 Prisma 报更准确的错）", () => {
  assert.equal(withConnectionPoolParams("not-a-url", { connectionLimit: 15, poolTimeoutSeconds: 20 }), "not-a-url");
  assert.equal(withConnectionPoolParams("", { connectionLimit: 15, poolTimeoutSeconds: 20 }), "");
});

test("事务选项映射正确（maxWait 与 timeout 不能接反）", () => {
  const options = transactionOptions(resolvePoolConfig({}));
  assert.deepEqual(options, { maxWait: 10000, timeout: 25000 });
});

test("启动日志能明确看出池与事务的生效值（部署后据此确认）", () => {
  const text = describePoolConfig(resolvePoolConfig({}));
  assert.match(text, /connection_limit=15/);
  assert.match(text, /pool_timeout=20s/);
  assert.match(text, /timeout=25000ms/);
});

test("三个 PrismaClient 都必须接上这套参数（漏一个就等于那个客户端还是旧口径）", () => {
  const files = [
    join(SRC, "platform/database/prisma.service.ts"),
    join(SRC, "modules/business-query-agent/query-read-client.ts"),
    join(SRC, "modules/business-query-agent/agent-state-client.ts"),
  ];
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    assert.match(code, /withConnectionPoolParams/, `${file} 必须用 withConnectionPoolParams 改写连接串`);
    assert.match(code, /transactionOptions/, `${file} 必须设置 transactionOptions`);
  }
  // 主应用必须用 15；agent 客户端必须用更小的 AGENT_CONNECTION_LIMIT
  assert.match(readFileSync(files[0], "utf8"), /resolvePoolConfig[\s\S]*withConnectionPoolParams/);
  assert.match(readFileSync(files[1], "utf8"), /AGENT_CONNECTION_LIMIT/);
  assert.match(readFileSync(files[2], "utf8"), /AGENT_CONNECTION_LIMIT/);
});

test("主应用启动日志会把生效值打出来（否则部署后无法确认）", () => {
  const code = readFileSync(join(SRC, "platform/database/prisma.service.ts"), "utf8");
  assert.match(code, /describePoolConfig/, "PrismaService 必须记录池配置日志");
});