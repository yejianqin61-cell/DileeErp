import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PaginationQueryDto } from "../../platform/http/pagination-query.dto";
import { CustomersService } from "./customers.service";

class CustomerDto {
  @IsString() @MaxLength(80) customer_code!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) country_region?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(200) payment_terms?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class UpdateCustomerDto {
  @IsOptional() @IsString() @MaxLength(80) customer_code?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(100) country_region?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(200) payment_terms?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class ActiveDto { @IsBoolean() is_active!: boolean; }
class ContactDto {
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(100) position?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}
class UpdateContactDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) position?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

@Controller("customers")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}
  @Get() async list(@Query() query: PaginationQueryDto) { const result = await this.customers.list(query.page, query.page_size, query.search); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Post() async create(@Body() body: CustomerDto, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.create(body, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.customers.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateCustomerDto, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.update(id, body, user), meta: {} }; }
  @Patch(":id/active") async setActive(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.setActive(id, body.is_active, user), meta: {} }; }
  @Delete(":id") async delete(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.delete(id, user), meta: {} }; }
  @Post(":id/contacts") async createContact(@Param("id") id: string, @Body() body: ContactDto, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.createContact(id, body, user), meta: {} }; }
  @Patch(":id/contacts/:contactId") async updateContact(@Param("id") id: string, @Param("contactId") contactId: string, @Body() body: UpdateContactDto, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.updateContact(id, contactId, body, user), meta: {} }; }
  @Delete(":id/contacts/:contactId") async deleteContact(@Param("id") id: string, @Param("contactId") contactId: string, @CurrentUser() user: CurrentUserType) { return { data: await this.customers.deleteContact(id, contactId, user), meta: {} }; }
}
