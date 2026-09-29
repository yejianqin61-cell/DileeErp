import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { ReorderExportService } from "./reorder-export.service";
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

/** 单据清单：`order_no` **必填**（不给会一次吐出该货号全部批次的单据）。 */
class DocumentsQueryDto {
  @IsNotEmpty() @IsString() @MaxLength(100) order_no!: string;
}

/** 时间线：`order_no` 可选（给 = 只看这一批；不给 = 整个货号合并）。 */
class TimelineQueryDto {
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
}

@Controller("reorder")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class ReorderController {
  // 参数名不能叫 `export`（保留字，TS1359）；这个类名也是全站唯一一个 import 之后必须改名的。
  constructor(private readonly service: ReorderService, private readonly exportService: ReorderExportService) {}

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

  /**
   * 一批的全部单据（17 组）。老板原话的落点：「查看当时该批货号的采购，生产，QC 的所有表单，信息」。
   * `order_no` 必填；该单不属于这个货号时 404 `ORDER_NOT_IN_ARTICLE`。
   */
  @Get("articles/:item_no/documents") async documents(@Param("item_no") itemNo: string, @Query() query: DocumentsQueryDto) {
    return { data: await this.service.orderDocuments(itemNo, query.order_no), meta: {} };
  }

  /** 审计时间线：给 `order_no` 只看这一批，不给则整个货号合并（超过 200 条回报 `truncated`）。 */
  @Get("articles/:item_no/timeline") async timeline(@Param("item_no") itemNo: string, @Query() query: TimelineQueryDto) {
    return { data: await this.service.articleTimeline(itemNo, query.order_no), meta: {} };
  }

  /**
   * 货号总结表（T14）：一张 xlsx，口径与页面**完全一致**（复用同一个 `articleDetail`）。
   * 路径是三段，不会被 `articles/:item_no` 吃掉（Nest 按声明顺序匹配，但更长的静态后缀也是独立路由）。
   */
  @Get("articles/:item_no/summary.xlsx") async summarySheet(@Param("item_no") itemNo: string, @Res() response: Response) {
    const { buffer, fileName } = await this.exportService.articleSummary(itemNo);
    response.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // 文件名含中文：走 RFC 5987 的 filename*，否则某些浏览器会拿到乱码名。
    response.setHeader("content-disposition", `attachment; filename="summary.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.send(buffer);
  }
}
