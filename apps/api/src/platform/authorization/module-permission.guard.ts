import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../database/prisma.service";
import { REQUIRED_MODULES } from "./require-modules.decorator";
import { REQUIRED_ANY_MODULES } from "./require-any-modules.decorator";
import type { AuthenticatedRequest } from "./authentication.guard";
import type { ModuleKey } from "./module-key";
import { REQUIRE_ADMINISTRATOR } from "./require-administrator.decorator";

@Injectable()
export class ModulePermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext) {
    const modules = this.reflector.getAllAndOverride<ModuleKey[]>(REQUIRED_MODULES, [context.getHandler(), context.getClass()]);
    const anyModules = this.reflector.getAllAndOverride<ModuleKey[]>(REQUIRED_ANY_MODULES, [context.getHandler(), context.getClass()]);
    const requiresAdministrator = this.reflector.getAllAndOverride<boolean>(REQUIRE_ADMINISTRATOR, [context.getHandler(), context.getClass()]);
    if (!modules?.length && !anyModules?.length && !requiresAdministrator) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.currentUser?.id;
    if (!userId) throw new ForbiddenException();
    const roles = await this.prisma.userRole.findMany({ where: { userId, role: { deletedAt: null } }, include: { role: { include: { permissions: true } } } });
    const isAdministrator = roles.some(({ role }) => role.key === "administrator");
    if (isAdministrator) return true;
    if (requiresAdministrator) throw new ForbiddenException("需要管理员权限");
    const permissions = new Set(roles.flatMap(({ role }) => role.permissions.map((permission) => permission.moduleKey)));
    if (modules?.length && !modules.every((module) => permissions.has(module))) throw new ForbiddenException("无模块访问权限");
    if (anyModules?.length && !anyModules.some((module) => permissions.has(module))) throw new ForbiddenException("无模块访问权限");
    return true;
  }
}
