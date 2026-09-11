import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { SupplierPayableService } from "./supplier-payable.service";

class PayableEntryDto {
  @IsIn(["raw_material_inbound", "purchase_receipt", "outsource_receipt"]) source_type!: "raw_material_inbound" | "purchase_receipt" | "outsource_receipt";
  @IsUUID() source_id!: string;
  @IsOptional() @IsString() amount?: string;
  @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string;
  @IsOptional() @IsDateString() confirmation_date?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

/**
 * 采购侧的“通知财务付款”入口。
 *
 * 为什么单独一个 controller：ModulePermissionGuard 先取 handler 元数据、取不到再回退类级，
 * 然后**先**校验类级 @RequireModules、**再**校验 @RequireAnyModules。因此把 @RequireAnyModules
 * 挂在 FinanceController（类级 @RequireModules("finance")）的方法上不会放宽任何权限 ——
 * 采购用户仍会被类级 finance 拦成 403。这里用只声明 ANY 的独立 controller，
 * 只放开「查应付台账 + 由来源生成应付」两个动作，其余财务接口仍然只对 finance 开放。
 */
@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("finance", "procurement")
export class PayableNotificationController {
  constructor(private readonly payable: SupplierPayableService) {}

  @Get("payable-entries")
  async list(@Query("order_no") orderNo?: string, @Query("supplier_id") supplierId?: string, @Query("status") status?: string) {
    return { data: await this.payable.list(orderNo, supplierId, status), meta: {} };
  }

  @Post("payable-entries/from-source")
  async createFromSource(@Body() body: PayableEntryDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.payable.createFromSource(body, user), meta: {} };
  }
}
