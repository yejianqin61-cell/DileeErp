import { Body, Controller, Get, Header, HttpCode, Patch, Post, Req, Res } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(100) username!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}

class UpdateProfileDto {
  @IsString() @MinLength(1) @MaxLength(100) display_name!: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(200) current_password!: string;
  @IsString() @MinLength(10) @MaxLength(200) new_password!: string;
}

/**
 * 会话与"我自己的账号"。这里**不加 ModulePermissionGuard**：登录/登出/看自己是谁/改自己姓名密码
 * 是会话本身的能力，不属于任何业务模块，挂模块守卫只会让没模块权限的人连密码都改不了。
 * 账号**管理**（建号/停用/重置他人密码/改角色）在 AdminUsersController。
 */
@Controller("auth")
export class AuthController {
  private readonly secureCookie = process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false");
  constructor(private readonly auth: AuthService) {}
  @Post("login") @Header("Cache-Control", "no-store, no-cache, must-revalidate") async login(@Body() payload: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(payload.username, payload.password);
    response.cookie("dilee_session", result.token, { httpOnly: true, sameSite: "lax", secure: this.secureCookie, maxAge: 1000 * 60 * 60 * 12, path: "/" });
    return { data: { user: result.user }, meta: {} };
  }
  /** 前端每次进入应用都会调它：登录态 + 角色 + 表面权限范围（菜单过滤与门禁页都靠它）。 */
  @Get("me") @Header("Cache-Control", "no-store, no-cache, must-revalidate") async me(@Req() request: Request) { return { data: await this.auth.profile(request.cookies?.dilee_session), meta: {} }; }
  @Patch("me") @Header("Cache-Control", "no-store, no-cache, must-revalidate") async updateProfile(@Body() body: UpdateProfileDto, @Req() request: Request) {
    const current = await this.auth.currentUser(request.cookies?.dilee_session);
    return { data: await this.auth.updateOwnDisplayName(current.id, body.display_name), meta: {} };
  }
  @Post("password") @HttpCode(204) async changePassword(@Body() body: ChangePasswordDto, @Req() request: Request) {
    const current = await this.auth.currentUser(request.cookies?.dilee_session);
    await this.auth.changeOwnPassword(current.id, body.current_password, body.new_password, request.cookies?.dilee_session);
  }
  @Post("logout") @HttpCode(204) async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.cookies?.dilee_session); response.clearCookie("dilee_session", { httpOnly: true, sameSite: "lax", secure: this.secureCookie, path: "/" });
  }
}
