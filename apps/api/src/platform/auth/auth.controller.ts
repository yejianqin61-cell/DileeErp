import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(100) username!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post("login") async login(@Body() payload: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(payload.username, payload.password);
    response.cookie("dilee_session", result.token, { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000 * 60 * 60 * 12 });
    return { data: { user: result.user }, meta: {} };
  }
  @Get("me") async me(@Req() request: Request) { return { data: await this.auth.currentUser(request.cookies?.dilee_session), meta: {} }; }
  @Post("logout") @HttpCode(204) async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.cookies?.dilee_session); response.clearCookie("dilee_session");
  }
}
