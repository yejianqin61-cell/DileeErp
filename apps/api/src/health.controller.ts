import { Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { PaginationQueryDto } from "./platform/http/pagination-query.dto";
import { PrismaService } from "./platform/database/prisma.service";
import { buildVersion } from "./build-info";
import { BEIJING_TIME_ZONE, beijingDateTime } from "./platform/time/beijing-time";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `timezone` 是给运维看的自检项，不是业务数据：
   * 全库时间列是 `TIMESTAMP(3)`（无时区），`created_at` 按**数据库会话时区**落盘、
   * `updated_at` 按 **UTC** 落盘（Prisma 客户端写）。会话时区不是 UTC 时，
   * 同一行的「创建时间」与「最后修改时间」会差一个时区偏移。
   * 这里把它暴露出来，工厂里打开这个地址就能确认要不要执行
   * `ALTER DATABASE <db> SET timezone TO 'UTC';`（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 第一节）。
   *
   * `beijing_now` 是同一个口径的当前时间（固定 Asia/Shanghai），方便一眼比对。
   */
  @Get()
  async check(@Query() _query: PaginationQueryDto) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const [setting] = await this.prisma.$queryRaw<{ timezone: string }[]>`SELECT current_setting('TimeZone') AS timezone`;
      const timezone = setting?.timezone ?? "unknown";
      return {
        data: {
          status: "ok",
          database: "ok",
          build: buildVersion(),
          timezone,
          timezone_utc: ["utc", "etc/utc", "gmt"].includes(timezone.trim().toLowerCase()),
          display_timezone: BEIJING_TIME_ZONE,
          beijing_now: beijingDateTime(new Date(), { seconds: true })
        },
        meta: {}
      };
    } catch {
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE", message: "数据库不可用", details: [] });
    }
  }
}
