import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Matches, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../auth/auth.service";
import { AuthenticationGuard } from "../authorization/authentication.guard";
import { ModulePermissionGuard } from "../authorization/module-permission.guard";
import { RequireModules } from "../authorization/require-modules.decorator";
import { FormsService } from "./forms.service";

class FormFieldDto {
  @Matches(/^[a-z][a-z0-9_]{0,79}$/) field_key!: string;
  @IsString() label!: string;
  @IsString() field_type!: string;
  @IsOptional() @IsBoolean() is_required?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}
class FormDefinitionDto {
  @Matches(/^[a-z][a-z0-9_]{0,79}$/) form_key!: string;
  @IsString() name!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FormFieldDto) fields?: FormFieldDto[];
}

@Controller("form-definitions")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class FormsController {
  constructor(private readonly forms: FormsService) {}
  @Get() async list(@Query("form_key") formKey?: string) { return { data: await this.forms.list(formKey), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.forms.get(id), meta: {} }; }
  @Post() async create(@Body() body: FormDefinitionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.forms.create(body, user), meta: {} }; }
  @Post(":id/publish") async publish(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.forms.publish(id, user), meta: {} }; }
}
