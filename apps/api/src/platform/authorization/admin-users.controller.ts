import { Body, Controller, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { IsArray, IsBoolean, IsString, MaxLength, MinLength } from "class-validator";
import { AuthService } from "../auth/auth.service";
import { AuthenticatedRequest, AuthenticationGuard } from "./authentication.guard";
import { ModulePermissionGuard } from "./module-permission.guard";
import { RequireAdministrator } from "./require-administrator.decorator";

class CreateUserDto {
  @IsString() @MinLength(1) @MaxLength(100) username!: string;
  @IsString() @MinLength(10) @MaxLength(200) password!: string;
  @IsString() @MinLength(1) @MaxLength(100) display_name!: string;
  @IsArray() @IsString({ each: true }) role_keys!: string[];
}
class SetActiveDto { @IsBoolean() is_active!: boolean; }
class ResetPasswordDto { @IsString() @MinLength(10) @MaxLength(200) password!: string; }
class SetRolesDto { @IsArray() @IsString({ each: true }) role_keys!: string[]; }

@Controller("admin/users")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAdministrator()
export class AdminUsersController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  create(@Body() body: CreateUserDto, @Req() request: AuthenticatedRequest) { return this.auth.createUser({ username: body.username, password: body.password, displayName: body.display_name, roleKeys: body.role_keys }, request.currentUser!.id); }

  @Patch(":id/active")
  setActive(@Param("id") id: string, @Body() body: SetActiveDto, @Req() request: AuthenticatedRequest) { return this.auth.setUserActive(id, body.is_active, request.currentUser!.id); }

  @Post(":id/reset-password")
  resetPassword(@Param("id") id: string, @Body() body: ResetPasswordDto, @Req() request: AuthenticatedRequest) { return this.auth.resetPassword(id, body.password, request.currentUser!.id); }

  @Post(":id/roles")
  setRoles(@Param("id") id: string, @Body() body: SetRolesDto, @Req() request: AuthenticatedRequest) { return this.auth.setRoles(id, body.role_keys, request.currentUser!.id); }
}
