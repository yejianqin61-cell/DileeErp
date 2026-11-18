import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { IsIn, IsUUID } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as User } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { TaskRemindersService } from "./task-reminders.service";

const SOURCE_TYPES = [
  "purchase_plan",
  "purchase_order",
  "incoming_inspection",
  "raw_material_inbound_notice",
  "raw_material_movement",
  "finished_goods_inspection_submission",
] as const;
const TASK_TYPES = ["unordered", "arrival", "inspection", "inbound_notice", "outbound", "finished_goods_qc"] as const;

class CompleteTaskDto {
  @IsIn(SOURCE_TYPES) source_type!: (typeof SOURCE_TYPES)[number];
  @IsUUID() source_id!: string;
  @IsIn(TASK_TYPES) task_type!: (typeof TASK_TYPES)[number];
}

@Controller("task-reminders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class TaskRemindersController {
  constructor(private readonly service: TaskRemindersService) {}

  @Get() async list() {
    const result = await this.service.list();
    return { data: result.data, meta: result.meta };
  }

  /** 收起状态只要计数：首页默认不加载完整列表。 */
  @Get("summary") async summary() {
    const result = await this.service.summary();
    return { data: result.data, meta: result.meta };
  }

  @Post("complete") async complete(@Body() body: CompleteTaskDto, @CurrentUser() user: User) {
    return { data: await this.service.complete(body, user), meta: {} };
  }
}
