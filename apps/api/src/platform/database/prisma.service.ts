import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * 启动自检：数据库会话时区是不是 UTC。
 *
 * 为什么要在启动时查这个（而不是等业务发现时间不对）：
 *   全库时间列是 `TIMESTAMP(3)`（无时区），而同一行的两个时间来源不同 ——
 *   `created_at` 由数据库默认 `CURRENT_TIMESTAMP` 写（**按会话时区**落盘），
 *   `updated_at` 由 Prisma 客户端写（**UTC** 落盘）。
 *   会话时区若不是 UTC，同一行的「创建时间」与「最后修改时间」会差一个时区偏移，
 *   而这正是全站要展示的两列（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 第一节）。
 *
 * 部署上两边都可能：`docker-compose.yml` 的 `postgres:16-alpine` 没设 `TZ`（容器默认 UTC），
 * 但 `deploy-remote.sh` 说明远端主机上还有一套**原生 PostgreSQL**。所以不能靠推断，必须实测。
 *
 * 处置原则：**只报告，不阻断启动、不自动改数据**。
 *   自动订正（把历史 created_at 减 8 小时）在「本来就没偏」的库上会把数据改坏，
 *   所以订正脚本带前置校验、由人确认后执行（scripts/db-timezone-utc.sql）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.reportTimeZone();
  }

  async onModuleDestroy() { await this.$disconnect(); }

  private async reportTimeZone() {
    try {
      const [setting] = await this.$queryRaw<{ timezone: string }[]>`SELECT current_setting('TimeZone') AS timezone`;
      const timezone = setting?.timezone ?? "unknown";
      if (this.isUtc(timezone)) {
        this.logger.log(`数据库会话时区 = ${timezone}（UTC）：created_at 与 updated_at 同源，操作时间可信`);
        return;
      }
      const skew = await this.timestampSkew();
      this.logger.error(
        `数据库会话时区 = ${timezone}，不是 UTC：created_at（数据库按会话时区写）与 updated_at（Prisma 按 UTC 写）` +
        `会差一个时区偏移，操作时间展示会偏。修复：ALTER DATABASE <db> SET timezone TO 'UTC';（对新建连接生效）；` +
        `历史数据是否需要订正见 scripts/db-timezone-utc.sql。` +
        `偏移样本 ${skew.suspicious}/${skew.samples}（创建与改动落在同一 5 分钟窗口内、却相差超过 60 秒的行数）`
      );
    } catch (error) {
      // 数据库暂时不可用（比如健康检查还没通过）不应该让 API 起不来，这里只提示。
      this.logger.error(`数据库会话时区自检失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isUtc(timezone: string) {
    const normalized = timezone.trim().toLowerCase();
    return normalized === "utc" || normalized === "etc/utc" || normalized === "gmt";
  }

  /** 探针只看这几张建得早、写入频繁的核心表；表名是常量白名单，不接受外部输入。 */
  private static readonly SKEW_PROBE_TABLES = ["sales_orders", "purchase_orders", "materials", "customers", "production_orders"] as const;

  /**
   * 偏移探针：取「创建后 5 分钟内又被写过」的行（近似「建完没大改」），
   * 这些行的两个时间本该在几秒内；若相差超过 60 秒，说明两个时钟不同源。
   *
   * 为什么这样取样：拿「建了很久之后才被改」的行去比，得到的是业务耗时（几小时到几个月都正常），
   * 分不清是时区偏移还是业务间隔。所以只看小时间窗内的行。
   *
   * 用 `$queryRawUnsafe` 而不是 `$queryRaw`：Prisma 的 `${}` 是**参数占位符**，
   * 表名进不去 SQL 文本（会变成 `FROM $1` 直接报语法错），标识符只能拼字符串 —— 因此这里用白名单常量拼。
   */
  private async timestampSkew(): Promise<{ samples: number; suspicious: number }> {
    const window = `updated_at BETWEEN created_at - interval '5 minutes' AND created_at + interval '5 minutes'`;
    const sql = `SELECT count(*) AS samples, count(*) FILTER (WHERE abs(extract(epoch FROM (updated_at - created_at))) > 60) AS suspicious FROM (${PrismaService.SKEW_PROBE_TABLES
      .map((table) => `SELECT created_at, updated_at FROM "${table}" WHERE ${window}`)
      .join(" UNION ALL ")}) AS probe`;
    try {
      const [row] = await this.$queryRawUnsafe<{ samples: bigint; suspicious: bigint }[]>(sql);
      return { samples: Number(row?.samples ?? 0), suspicious: Number(row?.suspicious ?? 0) };
    } catch {
      // 早期环境可能还没有这些表；探针失败不影响主流程。
      return { samples: 0, suspicious: 0 };
    }
  }
}
