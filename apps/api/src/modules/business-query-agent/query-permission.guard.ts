import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { resolveAccessLevel, type AgentAccessLevel } from "./access-level";
import { AGENT_ROLE_READER } from "./agent-tokens";

/** 通过 QueryPermissionGuard 后挂在请求上的主体：API 层每次都重查角色得出档位。 */
export type AgentPrincipal = { user: CurrentUser; accessLevel: AgentAccessLevel };
export type AgentAuthenticatedRequest = Request & { currentUser?: CurrentUser; agentPrincipal?: AgentPrincipal };

/**
 * 角色读取的最小接口。实现只做一件事：按 userId 读**当前有效**的角色 key。
 *
 * 模块设计的过滤条件在此处统一执行（不许调用方自己拼 where，否则软删/停用口径会漂移）：
 * `users.is_active = true`、用户未软删、`roles.deleted_at IS NULL`；只取 role.key，
 * 不读密码哈希。T-3 的只读 client 会注入这里 —— 角色重查也走只读连接。
 */
export interface AgentRoleReader {
  readActiveRoleKeys(userId: string): Promise<string[]>;
}

/**
 * 业务查询的 API 层权限守卫。必须与 AuthenticationGuard 组合使用
 * （`@UseGuards(AuthenticationGuard, QueryPermissionGuard)`）：前者验 Cookie 登录，
 * 后者在此之上判数据档位 —— 两档权限不复用 `@RequireAnyModules(...)`，
 * 那套模块授权在四类角色上等同管理员，判不了数据可见性。
 */
@Injectable()
export class QueryPermissionGuard implements CanActivate {
  // roleReader 是接口不是类，Nest 解析不了它的 token：用 AGENT_ROLE_READER 显式注入
  // （BusinessQueryAgentModule 提供的实现走只读连接）。
  constructor(@Inject(AGENT_ROLE_READER) private readonly roleReader: AgentRoleReader) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentAuthenticatedRequest>();
    const user = request.currentUser;
    if (!user) throw new UnauthorizedException();
    // 每个请求都重查：角色在会话期间可能被管理员改掉，缓存会把降权拖到下一次登录。
    const roleKeys = await this.roleReader.readActiveRoleKeys(user.id);
    const level = resolveAccessLevel(roleKeys);
    if (level === "denied") {
      throw new ForbiddenException({ code: "AGENT_ACCESS_DENIED", message: "当前账号没有可用角色，无法使用业务查询", details: [] });
    }
    request.agentPrincipal = { user, accessLevel: level };
    return true;
  }
}
