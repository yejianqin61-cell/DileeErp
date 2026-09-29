import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { ReorderService } from "./reorder.service";

/**
 * 「返单与总结」的只读查询 DTO。
 *
 * 三档开关写 `"true"` / `"false"` 字符串而不是布尔（与工作台的 `has_blockers` 一致）：
 * query 参数本来就是字符串，让它自己转布尔只会在 `?include_closed=0` 这类写法上出歧义。
 */
class ArticleQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() customer_id?: string;
  /** 默认 `true`：已关闭订单**纳入**统计（返单看的是历史经营事实）。 */
  @IsOptional() @IsIn(["true", "false"]) include_closed?: string;
  /** 默认 `false`：软删订单默认排除。 */
  @IsOptional() @IsIn(["true", "false"]) include_deleted?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page_size = 20;
}

class UnassignedQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() customer_id?: string;
  @IsOptional() @IsIn(["true", "false"]) include_closed?: string;
  @IsOptional() @IsIn(["true", "false"]) include_deleted?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page_size = 20;
}

class ArticleDetailQueryDto {
  @IsOptional() @IsIn(["true", "false"]) include_closed?: string;
  @IsOptional() @IsIn(["true", "false"]) include_deleted?: string;
}

@Controller("reorder")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class ReorderController {
  constructor(private readonly service: ReorderService) {}

  /** 货号清单：一行一个货号。`meta.total` 是**归并后的货号数**，不是销售单数。 */
  @Get("articles") async articles(@Query() query: ArticleQueryDto) {
    const result = await this.service.listArticles(query);
    return { data: result.data, meta: { page: result.page, page_size: result.page_size, total: result.total } };
  }

  /** 待补货号的历史销售单（不是货号组）：补录待办表用。 */
  @Get("unassigned-orders") async unassignedOrders(@Query() query: UnassignedQueryDto) {
    const result = await this.service.listUnassignedOrders(query);
    return { data: result.data, meta: { page: result.page, page_size: result.page_size, total: result.total } };
  }

  /**
   * 货号详情：该货号的**每一批**（销售单）与跨批汇总。
   *
   * 路径参数是**货号本身**（不是 id）：业务手上有的就是这个编码，而它可能含空格与中文，
   * 客户端要 `encodeURIComponent`。查不到给 404 `ARTICLE_NOT_FOUND`
   * （与工作台 `ORDER_NOT_FOUND` 同一形状；**只选一种**，前端不必写两套分支）。
   */
  @Get("articles/:item_no") async article(@Param("item_no") itemNo: string, @Query() query: ArticleDetailQueryDto) {
    return { data: await this.service.articleDetail(itemNo, query), meta: {} };
  }
}
