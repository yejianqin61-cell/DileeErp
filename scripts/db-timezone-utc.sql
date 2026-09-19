-- =============================================================================
-- 数据库会话时区：检测 → 修复 → （可选、需人工确认的）历史数据订正
-- =============================================================================
--
-- 背景（为什么需要这个脚本）
--   全库时间列都是 `TIMESTAMP(3)`（**无时区**），而同一行的两个时间来源不同：
--     * `created_at` —— 由数据库默认 `CURRENT_TIMESTAMP` 写入，落盘的是**数据库会话时区的墙上时间**；
--     * `updated_at` —— 由 Prisma 客户端（`@updatedAt`）写入，落盘的是 **UTC**。
--   会话时区不是 UTC 时，同一行的「创建时间」与「最后修改时间」会差一个时区偏移，
--   而这两个正是「操作人与操作时间」治理要展示的两列。
--
--   线上是哪种必须实测，不能推断：`docker-compose.yml` 的 `postgres:16-alpine` 没有设 `TZ`
--   （容器默认 UTC），但 `deploy-remote.sh` 说明远端主机上**还有一套原生 PostgreSQL**（可能跟随主机时区）。
--
-- 这个脚本**不会**被应用自动执行，也不放进 Prisma 迁移：
--   非 compose 部署里应用账号可能不是库 owner，`ALTER DATABASE ... SET` 需要 owner 权限，
--   放进迁移会让整次发布失败。所以它是运维手工执行的独立脚本。
--
-- 应用侧的对应能力：`GET /api/v1/health` 会报 `timezone` / `timezone_utc` / `beijing_now`，
-- API 启动时也会在会话时区不是 UTC 时打错误日志（含偏移样本）。先看那个，再来跑这个脚本。
--
-- 用法：psql "$DATABASE_URL" -f scripts/db-timezone-utc.sql
-- =============================================================================

\echo '════ 第 1 步：当前时区（修复前） ════'
SELECT current_database() AS database,
       current_setting('TimeZone') AS session_timezone,
       now() AS server_now_utc,
       now() AT TIME ZONE current_setting('TimeZone') AS session_wall_clock;

-- -----------------------------------------------------------------------------
-- 第 2 步：测量**旧偏移**（历史数据订正的依据）
--
-- 取「创建与改动落在同一 5 分钟窗口内」的行——这些行的两个时间本该在几秒内，
-- 若相差接近整小时，那个差值就是写入 `created_at` 时的会话偏移。
-- 只看小时数分布，是因为时区偏移都是整小时（个别地区 30/45 分钟）。
-- -----------------------------------------------------------------------------
\echo '════ 第 2 步：旧偏移分布（只看同一 5 分钟窗口内的行） ════'
SELECT round(extract(epoch FROM (updated_at - created_at)) / 3600.0) AS offset_hours,
       count(*) AS rows,
       min(created_at) AS earliest,
       max(created_at) AS latest
FROM (
  SELECT created_at, updated_at FROM "sales_orders"       WHERE updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'
  UNION ALL
  SELECT created_at, updated_at FROM "purchase_orders"    WHERE updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'
  UNION ALL
  SELECT created_at, updated_at FROM "materials"          WHERE updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'
  UNION ALL
  SELECT created_at, updated_at FROM "customers"          WHERE updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'
  UNION ALL
  SELECT created_at, updated_at FROM "production_orders"  WHERE updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'
) AS probe
GROUP BY 1
ORDER BY 2 DESC;

-- -----------------------------------------------------------------------------
-- 第 3 步：把库级默认时区钉成 UTC
--
-- 效果：**新建连接**的会话时区为 UTC，于是 `CURRENT_TIMESTAMP` 落盘的就是 UTC 墙上时间，
-- 与 Prisma 写的 `updated_at` 同源。已存在的连接不受影响（不需要重启数据库，但应用要重连才生效）。
-- 幂等：重复执行无副作用。纯 PostgreSQL 语义，不改 schema、不加迁移。
-- -----------------------------------------------------------------------------
\echo '════ 第 3 步：把数据库默认时区设为 UTC ════'
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
  RAISE NOTICE '已设置 % 的库级默认时区为 UTC（对新建连接生效）', current_database();
END $$;

-- 复核：当前连接仍是旧时区（GUC 改动只对新会话生效），所以**要重连**再看。
-- 重连后执行：SHOW timezone;  期望输出 UTC
\echo '请重新连接后执行 SHOW timezone; 期望为 UTC'

-- -----------------------------------------------------------------------------
-- 第 4 步：历史数据订正（**默认不执行**，必须先看懂再决定）
--
-- 什么时候需要订正：
--   第 2 步的偏移分布里出现了明显的整小时峰值（例如 offset_hours = 8 且行数很多），
--   说明这些历史行的 `created_at` 是按旧时区落盘的，比真实时刻**早了偏移量那么多**。
--
-- 什么时候**不要**执行：
--   * 第 2 步没有明显的整小时峰值（偏移接近 0）→ 库里本来就是 UTC，订正会把数据改坏；
--   * 库里既有旧时区写的行、也有换成 UTC 之后写的行 → 一刀切会改坏后半批。
--     这种情况必须先确定切换时刻，用下面生成的语句里再加 created_at < '<切换时刻>' 的条件。
--
-- 订正范围只包括**数据库默认值写的列**（`created_at`，以及迁移里用 CURRENT_TIMESTAMP
-- 插入的字典种子行的 `updated_at`）。由应用写的 `updated_at` 已经是 UTC，**不能动**。
--
-- 下面这条 SELECT **只生成语句、不执行任何修改**：把 offset 换成第 2 步测到的值，
-- 逐条复核 SQL，确认后再手工执行；建议先 `BEGIN;`，核对行数后再 `COMMIT;`（或 `ROLLBACK;`）。
-- -----------------------------------------------------------------------------
\echo '════ 第 4 步：历史订正语句（仅生成，不执行；把 8 换成第 2 步测到的偏移） ════'
SELECT format('UPDATE %I.%I SET "created_at" = "created_at" - interval ''8 hours'';',
              table_schema, table_name) AS review_me
FROM information_schema.columns
WHERE column_name = 'created_at'
  AND table_schema = 'public'
  AND data_type LIKE 'timestamp%'
ORDER BY table_name;
