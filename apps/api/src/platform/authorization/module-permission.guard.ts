import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../database/prisma.service";
import { REQUIRED_MODULES } from "./require-modules.decorator";
import { REQUIRED_ANY_MODULES } from "./require-any-modules.decorator";
import type { AuthenticatedRequest } from "./authentication.guard";
import { MODULE_KEYS, type ModuleKey } from "./module-key";
import { REQUIRE_ADMINISTRATOR } from "./require-administrator.decorator";

/**
 * 「管理员级」= 角色 key 是 administrator，**或者该角色已被授予全部模块**。
 *
 * 为什么把"全模块授权"也算管理员级（2026-09-19 权限规范）：
 *   用户拍板的模型是「所有角色都有等同于管理员的实际权限」，落地方式是给四个表面角色
 *   （老板/财务/人事/其他）**各授予全部 6 个模块**——数据层放行、守卫代码不动。
 *   但 `@RequireAdministrator()` 是**代码级**判定（原来是硬编码 `key === "administrator"`），
 *   数据放行碰不到它，于是财务导出那几个接口会把新角色挡在门外，与"实际权限等同管理员"矛盾。
 *   所以这里补一条：已授予全部模块的角色，与 administrator 同等看待。
 *
 * 这样"实际权限"这件事就只有一个真相：`role_permissions` 里有没有全部模块。
 * 将来要真收紧，删掉某个角色的模块授权行即可——它自动同时失去模块访问权与"管理员级"身份。
 */
function isAdministratorEquivalent(role: { key: string; permissions: { moduleKey: string }[] }): boolean {
  if (role.key === "administrator") return true;
  const granted = new Set(role.permissions.map((permission) => permission.moduleKey));
  return MODULE_KEYS.every((module) => granted.has(module));
}

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
    const isAdministrator = roles.some(({ role }) => isAdministratorEquivalent(role));
    if (isAdministrator) return true;
    if (requiresAdministrator) throw new ForbiddenException("需要管理员权限");
    const permissions = new Set(roles.flatMap(({ role }) => role.permissions.map((permission) => permission.moduleKey)));
    if (modules?.length && !modules.every((module) => permissions.has(module))) throw new ForbiddenException("无模块访问权限");
    if (anyModules?.length && !anyModules.some((module) => permissions.has(module))) throw new ForbiddenException("无模块访问权限");
    return true;
  }
}

export { isAdministratorEquivalent };
