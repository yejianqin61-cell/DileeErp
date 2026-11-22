/**
 * Prisma 连接池与事务超时的统一口径（2026-11-22）。
 *
 * ## 为什么要有这个文件
 *
 * 生产上出现过两类**真实用户失败**（见 `pm2 logs dilee-api-error`）：
 *
 * 1. **连接池只有 3 个**
 *    ```
 *    Timed out fetching a new connection from the connection pool.
 *    (Current connection pool timeout: 10, connection limit: 3)
 *    ```
 *    打到 `GET /api/v1/order-workbench/orders`、`POST .../issue-preview`、
 *    `GET .../measurements`，用户看到的是 500。
 *
 *    Prisma 的默认 `connection_limit` 是 `物理 CPU 数 × 2 + 1`。这台是 2 vCPU 的机器，
 *    但 Node 在容器/虚拟化环境下上报的物理核数可能是 1，于是算出来只有 **3** —— 工作台
 *    一个页面并发的查询数就超过它，排队超过 10 秒即报「取不到连接」。
 *
 * 2. **交互事务默认 5 秒超时**
 *    ```
 *    Transaction already closed: ... The timeout for this transaction was 5000 ms,
 *    however 5085 / 7373 ms passed since the start of the transaction.
 *    ```
 *    打到 `POST /api/v1/sales-orders`（创建销售单）与 `production/employee-reports/batch`
 *    （日报批量登记，从 11-07 起反复发生）。用户看到的是「创建失败」，但业务其实没写入。
 *
 * 用户 2026-11-22 明确要求：连接池调到 15、事务超时放宽到 20~30 秒。
 *
 * ## 为什么在客户端构造层统一设，而不是逐个改调用点
 *
 * 全仓有 **190 处** `$transaction(` 调用（且**没有任何一处**显式传 `timeout`/`maxWait`）。
 * 逐个加超时既无法穷尽，也会让「默认值」散落在 190 个地方、日后无人能确认到底是多少。
 * Prisma 6 的 `PrismaClient` 构造器接受 `transactionOptions`，在客户端层设一次即可覆盖
 * 全部未显式指定超时的事务。
 *
 * ## 容量前提（已在生产核实）
 *
 * `max_connections = 100`，改动前实际只用了 10 个连接。15（API）+ 5（只读）+ 5（agent 状态）
 * = 25，距上限仍有余量。**不要盲目再调大**：连接是 PostgreSQL 的进程，每个都要内存
 * （这台机 1.7G 内存），把库里堆满连接会换一种方式变慢。
 */

/** 主应用（API）连接池上限。用户指定 15。 */
export const DEFAULT_CONNECTION_LIMIT = 15;

/**
 * Agent 专用连接（业务表只读 / agent 状态表）的池上限。
 *
 * 刻意比主应用小：这两个客户端的查询量是「聊天时一问一次」，不像主应用那样每页面十几条并发。
 * 池给大了反而会把 `max_connections` 的名额占住（每个连接都是数据库侧一个进程、要占内存）。
 */
export const AGENT_CONNECTION_LIMIT = 5;

/**
 * 从池里取连接的等待上限（秒）。
 *
 * Prisma 自己的默认是 10 秒；这里给到 20 秒，配合更大的池，让「瞬间并发」有时间排完队，
 * 而不是把一次正常的批量查询变成 500。注意它与下面的事务超时是两件事：
 * 先要拿到连接（pool_timeout），才谈得上开启事务（transaction timeout）。
 */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

/**
 * 交互事务的执行上限（毫秒）。用户要求 20~30 秒，取中 **25 秒**。
 *
 * 为什么不是「越大越好」：事务超时放宽会延长锁持有时间。25 秒是「够跑完一个批量日报 /
 * 一张带 27 行明细的销售单」又「不至于让一次卡死挂住连接半分钟以上」的折中。
 */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 25_000;

/**
 * 事务排队等待开启的上限（毫秒）。Prisma 默认 2000，太短：并发下会直接抛
 * 「Unable to start a transaction」而不是排队。给到 10 秒。
 */
export const DEFAULT_TRANSACTION_MAX_WAIT_MS = 10_000;

export type PrismaPoolConfig = {
  connectionLimit: number;
  poolTimeoutSeconds: number;
  transactionTimeoutMs: number;
  transactionMaxWaitMs: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  // 负值/0/NaN/小数一律退回默认值：这些值会让 Prisma 在启动时抛错或行为不可预期，
  // 与其让服务起不来，不如用已知安全的默认值并（由调用方）记一条日志。
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 从环境变量读取池配置，未配置时用上面的默认值。 */
export function resolvePoolConfig(env: Record<string, string | undefined>): PrismaPoolConfig {
  return {
    connectionLimit: positiveInt(env.PRISMA_CONNECTION_LIMIT, DEFAULT_CONNECTION_LIMIT),
    poolTimeoutSeconds: positiveInt(env.PRISMA_POOL_TIMEOUT, DEFAULT_POOL_TIMEOUT_SECONDS),
    transactionTimeoutMs: positiveInt(env.PRISMA_TRANSACTION_TIMEOUT_MS, DEFAULT_TRANSACTION_TIMEOUT_MS),
    transactionMaxWaitMs: positiveInt(env.PRISMA_TRANSACTION_MAX_WAIT_MS, DEFAULT_TRANSACTION_MAX_WAIT_MS),
  };
}

/**
 * 把 `connection_limit` / `pool_timeout` 写进连接串。
 *
 * **幂等且不覆盖已有值**：连接串里若已显式写了这两个参数（运维临时调参、或某个账号
 * 需要不同的池），保持原样 —— 代码默认值不该悄悄覆盖显式配置。
 *
 * 非法 URL 直接返回原串（不抛）：连接串由 `.env` 提供、本就可能是本地调试用的简写；
 * 让 Prisma 自己去报那个更准确的错，比在这里抛一个「解析失败」更难排查。
 */
export function withConnectionPoolParams(url: string, config: Pick<PrismaPoolConfig, "connectionLimit" | "poolTimeoutSeconds">): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has("connection_limit")) {
    parsed.searchParams.set("connection_limit", String(config.connectionLimit));
  }
  if (!parsed.searchParams.has("pool_timeout")) {
    parsed.searchParams.set("pool_timeout", String(config.poolTimeoutSeconds));
  }
  return parsed.toString();
}

/** 供 PrismaClient 构造器使用的事务默认值。 */
export function transactionOptions(config: PrismaPoolConfig): { maxWait: number; timeout: number } {
  return { maxWait: config.transactionMaxWaitMs, timeout: config.transactionTimeoutMs };
}

/** 一行可读的启动日志（部署后据此确认生效，不必去猜）。 */
export function describePoolConfig(config: PrismaPoolConfig, label = "数据库连接池"): string {
  return (
    `${label} connection_limit=${config.connectionLimit} pool_timeout=${config.poolTimeoutSeconds}s；` +
    `事务默认 maxWait=${config.transactionMaxWaitMs}ms timeout=${config.transactionTimeoutMs}ms`
  );
}