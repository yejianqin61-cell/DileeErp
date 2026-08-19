import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, CurrentUser } from "../auth/auth.service";

export type AuthenticatedRequest = Request & { currentUser?: CurrentUser };

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.currentUser = await this.auth.currentUser(request.cookies?.dilee_session);
    return true;
  }
}
