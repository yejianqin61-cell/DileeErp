import { Controller, Get, Query } from "@nestjs/common";
import { PaginationQueryDto } from "./platform/http/pagination-query.dto";

@Controller("health")
export class HealthController {
  @Get()
  check(@Query() _query: PaginationQueryDto) {
    return { data: { status: "ok" }, meta: {} };
  }
}
