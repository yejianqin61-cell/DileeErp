import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import type { Response } from "express";
import { IsArray, IsDateString, IsDecimal, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PaginationQueryDto } from "../../platform/http/pagination-query.dto";
import { EmptyStringToUndefined } from "../../platform/http/empty-string-to-undefined.decorator";
import { SalesOrdersService } from "./sales-orders.service";
import { SalesOrderExportService } from "./sales-order-export.service";
import { FinishedGoodsOutboundNoticeService } from "./finished-goods-outbound-notice.service";

/** 金额类字段的非负校验：class-validator 的 @Min 对字符串不生效（会直接判不通过），这里用十进制正则。 */
const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/** 结算方式固定枚举（前端下拉同源展示中文）。 */
export const SETTLEMENT_METHODS = ["tt", "letter_of_credit", "cash", "monthly", "other"] as const;

/** 细分明细行（一张通用表 + 分组名）。 */
class SpecDetailDto {
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(100) group_name!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) color?: string;
  @IsOptional() @IsString() @MaxLength(100) barcode?: string;
  // 数量留空时前端可能提交 "null"/""：先归一成 undefined，否则 @IsOptional() 不跳过空串 → 400。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "明细数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity?: string;
  @IsOptional() @IsString() @MaxLength(30) unit?: string;
  @IsOptional() @IsInt() sort_order?: number;
}

/**
 * 下单口径细化的固定字段（2026-09-16，按 example/销售单 的工艺单模板，两样本并集）。
 *
 * 抽成基类是因为创建与更新两边**这 37 个字段完全一样**（都是可选），抄两遍必然漏一处。
 * 这里**故意不加 `EmptyStringToUndefined`**：空串的语义是「清除这一格」（服务层的 `specScalars`
 * 把 "" 落成 NULL），而 `EmptyStringToUndefined` 会把它变成 undefined 也就是「不动」——
 * 两者写反的后果正好相反（「删了没保存上」 vs 「只改一格结果把别的清空了」）。
 */
export class SalesOrderSpecDto {
  // 表头补充
  @IsOptional() @IsString() @MaxLength(100) factory?: string;
  @IsOptional() @IsString() @MaxLength(100) completion_remark?: string;
  @IsOptional() @IsString() @MaxLength(2000) attention_note?: string;
  @IsOptional() @IsString() @MaxLength(2000) shipping_mark_front?: string;
  @IsOptional() @IsString() @MaxLength(2000) shipping_mark_side?: string;
  // 布量（伞面 / 伞带 / 木耳 / 天布 / 布套）
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_canopy?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_strap?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_wood_ear?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_top?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_bag?: string;
  // 材料明细（两样本并集 18 项）
  @IsOptional() @IsString() @MaxLength(1000) rib_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) canopy_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) handle_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) handle_strap_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) tail_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) runner_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_fastener_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) inner_label_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) woven_label_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) hang_tag_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) opp_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) bag_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) packaging_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) top_fabric_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) wood_ear_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) keychain_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) printing_spec?: string;
  // 工艺要求（两样本并集 9 项）
  @IsOptional() @IsString() @MaxLength(1000) sample_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) cutting_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) edge_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) joining_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) top_stitch_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) sewing_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) hang_tag_note?: string;
  @IsOptional() @IsString() @MaxLength(1000) qc_requirement?: string;
  /** 细分明细：传了就整块替换（空数组 = 清空），没传 = 不动。 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SpecDetailDto) spec_details?: SpecDetailDto[];
}

// 导出以便契约测试直接用真实 ValidationPipe 校验前端请求体。
export class SalesOrderDto extends SalesOrderSpecDto {
  // 必填字段先归一空串再校验："" / "   " 会变成 undefined，被 @IsNotEmpty() 拦下（旧行为会写入空订单号/空币种）。
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(100) order_no!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() customer_id!: string;
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsDateString() order_date!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(200) product_name!: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @Matches(NON_NEGATIVE_DECIMAL, { message: "数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(30) unit!: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(10) currency!: string;
  // 单价/金额/税率留空时前端会提交 ""：先归一成 undefined，否则 @IsOptional() 不跳过空串 → 400。
  // 金额一律不允许负数（负应收会被原样带进财务应收来源）。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() tax_rate?: string;
  // 结算口径：结算币价 / 应收金额 / 结算方式 / 本币金额。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() settlement_unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() receivable_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsIn(SETTLEMENT_METHODS) settlement_method?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() local_currency_amount?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}
export class UpdateSalesOrderDto extends SalesOrderSpecDto {
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsOptional() @IsDateString() order_date?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(200) product_name?: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(30) unit?: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() tax_rate?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() settlement_unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() receivable_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsIn(SETTLEMENT_METHODS) settlement_method?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() local_currency_amount?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class SalesOrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() status?: string;
}
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
// 销售「通知仓库出库」：不传 production_order_id 时对该订单所有可出库的生产单各建一张整批通知；
// 传 notice_quantity 时只通知这一部分（分批通知），此时必须同时指定 production_order_id。
// 导出以便单元测试直接用真实 ValidationPipe 校验（分级通知数量是本轮新增的入口）。
export class OutboundNoticeDto {
  @IsOptional() @IsUUID() production_order_id?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "通知数量必须是不小于 0 的十进制数" }) @IsDecimal() notice_quantity?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsString() @MaxLength(160) idempotency_key?: string;
}

@Controller("sales-orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService, private readonly outboundNotices: FinishedGoodsOutboundNoticeService, private readonly productionSheetExport: SalesOrderExportService) {}
  @Get() async list(@Query() query: SalesOrderQueryDto) { const result = await this.orders.list(query.page, query.page_size, query.search, query.status); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Post() async create(@Body() body: SalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  // 销售模块的成品出库总览（全部成品数 / 已出库数 / 未出库数，按产品+单位分行）。
  // 必须声明在 @Get(":id") 之前：Nest 按声明顺序匹配，否则 "finished-goods-summary"
  // 会被当成销售单 ID 去查库（与「其他应付导入模板」被 :id 吃掉是同一类问题）。
  @Get("finished-goods-summary") async finishedGoodsSummary() { return { data: await this.outboundNotices.overview(), meta: {} }; }
  /**
   * 工艺单导出（2026-09-16）：按 example/销售单 的模板版式，图片格留空。
   *
   * **不额外要求管理员**（与采购单/领料单导出的 `@RequireAdministrator()` 不同）：工艺单是销售
   * 每天要打给工厂的单据，只有管理员能打等于把这个功能锁死。权限沿用类级的 `sales` 模块要求。
   * 路径是两段（`:id/production-sheet.xlsx`），不会被单段的 `@Get(":id")` 吃掉。
   */
  @Get(":id/production-sheet.xlsx") async productionSheet(@Param("id") id: string, @Res() response: Response) {
    const { buffer, orderNo } = await this.productionSheetExport.exportOrder(id);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`迪礼ERP-工艺单-${orderNo}.xlsx`)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(buffer);
  }
  @Get(":id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.orders.impactPreview(id), meta: {} }; }
  // 成品入库/出库情况 + 出库通知（销售页「打开销售订单能看到成品入库情况」）。
  @Get(":id/finished-goods") async finishedGoods(@Param("id") id: string) { return { data: await this.outboundNotices.summary(id), meta: {} }; }
  @Post(":id/outbound-notices") async notifyOutbound(@Param("id") id: string, @Body() body: OutboundNoticeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.createNotices(id, body, user), meta: {} }; }
  @Post(":id/outbound-notices/:noticeId/cancel") async cancelOutboundNotice(@Param("id") id: string, @Param("noticeId") noticeId: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.cancelNotice(id, noticeId, body.reason, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateSalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  @Post(":id/confirm") async confirm(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.confirm(id, user), meta: {} }; }
  @Post(":id/revert-draft") async revertDraft(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertToDraft(id, body.reason, user), meta: {} }; }
  @Post(":id/close") async close(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.close(id, user), meta: {} }; }
}
