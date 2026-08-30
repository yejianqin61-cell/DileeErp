import { Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { PaginationQueryDto } from "./platform/http/pagination-query.dto";
import { PrismaService } from "./platform/database/prisma.service";
import { buildVersion } from "./build-info";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(@Query() _query: PaginationQueryDto) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { data: { status: "ok", database: "ok", build: buildVersion() }, meta: {} };
    } catch {
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE", message: "数据库不可用", details: [] });
    }
  }
}
