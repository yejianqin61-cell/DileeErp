import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  isSurfaceRoleKey,
  surfaceScopeOf,
  surfaceSectionsOf,
  type SurfaceScope,
  type SurfaceSection,
} from "../authorization/surface-scope";

export type CurrentUser = { id: string; username: string; display_name: string };

/**
 * 会话用户 + 表面权限。前端拿到它就能：过滤菜单、就地拦越权页面、在账号中心显示自己的权限范围。
 *
 * 为什么把 `surface_sections`（精确的栏目集合）也发出去，而不是只发一个范围名：
 * 一个账号理论上可以挂多个表面角色（"人事＋其他"的可见范围是并集），一个范围名表达不了，
 * 而栏目集合永远是精确的。`surface_scope` 只是给人看的一句话标签。
 */
export type SessionProfile = CurrentUser & {
  role_keys: string[];
  surface_roles: string[];
  surface_scope: SurfaceScope;
  surface_sections: SurfaceSection[];
  /** 实际权限（后端接口）：把角色身上的模块授权原样报出来，界面就不必"声称"而是"显示"它。 */
  module_keys: string[];
};
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BLOCK_MS = 60_000;
const PASSWORD_MIN_LENGTH = 10;

@Injectable()
export class AuthService {
  private readonly loginFailures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async login(username: string, password: string) {
    this.assertLoginAllowed(username);
    const user = await this.prisma.user.findFirst({ where: { username, deletedAt: null } });
    if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, password))) {
      this.recordLoginFailure(username);
      throw new UnauthorizedException("用户名或密码错误");
    }
    this.loginFailures.delete(username);
    const token = randomBytes(32).toString("base64url");
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { userId: user.id } }),
      this.prisma.session.create({ data: { tokenHash: this.hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS), createdBy: user.id, updatedBy: user.id } }),
    ]);
    await this.audit.record("auth.login", "user", user.id, user.id);
    return { token, user: await this.withSurfaceProfile(this.toCurrentUser(user)) };
  }

  async currentUser(token?: string): Promise<CurrentUser> {
    if (!token) throw new UnauthorizedException();
    const session = await this.prisma.session.findFirst({ where: { tokenHash: this.hashToken(token), expiresAt: { gt: new Date() }, user: { isActive: true, deletedAt: null } }, include: { user: true } });
    if (!session) throw new UnauthorizedException();
    return this.toCurrentUser(session.user);
  }

  /** `/auth/me`：会话用户 + 表面权限。 */
  async profile(token?: string): Promise<SessionProfile> {
    return this.withSurfaceProfile(await this.currentUser(token));
  }

  /**
   * 自助改姓名。用户拍板"用户要能够设置自己的姓名"——所以这是本人的操作，不需要管理员。
   * 顺带把 `updated_by` 写成自己：姓名是本人在改，审计里就该是他。
   */
  async updateOwnDisplayName(userId: string, displayName: string): Promise<CurrentUser> {
    const name = displayName.trim();
    if (!name) throw new BadRequestException({ code: "DISPLAY_NAME_REQUIRED", message: "姓名不能为空", details: [] });
    if (name.length > 100) throw new BadRequestException({ code: "DISPLAY_NAME_TOO_LONG", message: "姓名不能超过 100 个字", details: [] });
    const user = await this.prisma.user.update({ where: { id: userId }, data: { displayName: name, updatedBy: userId } });
    await this.audit.record("user.profile_updated", "user", userId, userId, { display_name: name });
    return this.toCurrentUser(user);
  }

  /**
   * 自助改密码。**必须验旧密码**：会话可能是别人正开着的机器，改密码这种操作不能只凭会话。
   * 改完只保留当前会话、踢掉其它设备的会话——"改密码"最常见的动机就是怀疑账号在别处被用着。
   */
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string, currentToken?: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new UnauthorizedException();
    if (!(await argon2.verify(user.passwordHash, currentPassword))) {
      // 用 400 而不是 401：前端的会话过期处理会把 401 当成"登录态失效"直接踢回登录页，
      // 而"旧密码打错了"只是这一次输入的问题，不该把人踢出去。
      throw new BadRequestException({ code: "CURRENT_PASSWORD_INVALID", message: "当前密码不正确", details: [] });
    }
    this.assertPassword(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(newPassword), updatedBy: userId } });
    await this.prisma.session.deleteMany({ where: { userId, ...(currentToken ? { tokenHash: { not: this.hashToken(currentToken) } } : {}) } });
    await this.audit.record("user.password_changed", "user", userId, userId);
  }

  /** 账号管理中心的列表：只列未软删的账号，带角色与表面权限范围。 */
  async listUsers() {
    const users = await this.prisma.user.findMany({ where: { deletedAt: null }, include: { roles: { include: { role: true } } }, orderBy: { username: "asc" } });
    return users.map((user) => this.toManagedProfile(user));
  }

  private async withSurfaceProfile(user: CurrentUser): Promise<SessionProfile> {
    const roles = await this.prisma.userRole.findMany({ where: { userId: user.id, role: { deletedAt: null } }, include: { role: { include: { permissions: true } } } });
    const roleKeys = roles.map(({ role }) => role.key).sort();
    return {
      ...user,
      role_keys: roleKeys,
      surface_roles: roleKeys.filter(isSurfaceRoleKey),
      surface_scope: surfaceScopeOf(roleKeys),
      surface_sections: surfaceSectionsOf(roleKeys),
      module_keys: [...new Set(roles.flatMap(({ role }) => role.permissions.map((permission) => permission.moduleKey)))].sort(),
    };
  }

  private toManagedProfile(user: { id: string; username: string; displayName: string; isActive: boolean; createdAt: Date; roles: { role: { key: string } }[] }) {
    const roleKeys = user.roles.map(({ role }) => role.key).sort();
    return {
      ...this.toCurrentUser(user),
      is_active: user.isActive,
      created_at: user.createdAt,
      role_keys: roleKeys,
      surface_roles: roleKeys.filter(isSurfaceRoleKey),
      surface_scope: surfaceScopeOf(roleKeys),
    };
  }

  async logout(token?: string) {
    if (!token) return;
    const session = await this.prisma.session.findFirst({ where: { tokenHash: this.hashToken(token) } });
    await this.prisma.session.deleteMany({ where: { tokenHash: this.hashToken(token) } });
    await this.audit.record("auth.logout", "user", session?.userId, session?.userId);
  }

  async createUser(input: { username: string; password: string; displayName: string; roleKeys: string[] }, actorId: string) {
    this.assertPassword(input.password);
    this.assertRolesPresent(input.roleKeys);
    const roles = await this.findRoles(input.roleKeys);
    try {
      const user = await this.prisma.user.create({
        data: {
          id: randomUUID(), username: input.username, passwordHash: await this.hashPassword(input.password), displayName: input.displayName,
          createdBy: actorId, updatedBy: actorId, roles: { create: roles.map((role) => ({ roleId: role.id })) },
        },
        include: { roles: { include: { role: true } } },
      });
      await this.audit.record("user.create", "user", actorId, user.id, { username: user.username, role_keys: input.roleKeys });
      return this.toManagedUser(user);
    } catch (error) {
      if (this.isUniqueError(error)) throw new ConflictException({ code: "USERNAME_CONFLICT", message: "用户名已存在", details: [] });
      throw error;
    }
  }

  async setUserActive(userId: string, isActive: boolean, actorId: string) {
    if (userId === actorId && !isActive) throw new ConflictException({ code: "SELF_DEACTIVATION_FORBIDDEN", message: "不能停用当前管理员账号", details: [] });
    if (!isActive) await this.assertOwnerRemains(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { isActive, updatedBy: actorId }, include: { roles: { include: { role: true } } } }).catch(() => { throw new NotFoundException({ code: "USER_NOT_FOUND", message: "用户不存在", details: [] }); });
    if (!isActive) await this.prisma.session.deleteMany({ where: { userId } });
    await this.audit.record(isActive ? "user.activate" : "user.deactivate", "user", actorId, userId);
    return this.toManagedUser(user);
  }

  async resetPassword(userId: string, password: string, actorId: string) {
    this.assertPassword(password);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(password), updatedBy: actorId }, include: { roles: { include: { role: true } } } }).catch(() => { throw new NotFoundException({ code: "USER_NOT_FOUND", message: "用户不存在", details: [] }); });
    await this.prisma.session.deleteMany({ where: { userId } });
    await this.audit.record("user.password_reset", "user", actorId, userId);
    return this.toManagedUser(user);
  }

  async setRoles(userId: string, roleKeys: string[], actorId: string) {
    // 防自锁①：不能改自己的角色。否则一个老板可以把自己降成"其他"，从此进不了账号管理中心。
    if (userId === actorId) throw new ConflictException({ code: "SELF_ROLE_CHANGE_FORBIDDEN", message: "不能修改自己的角色（避免把自己降权后没人能进账号管理中心）", details: [] });
    this.assertRolesPresent(roleKeys);
    // 防自锁②：系统里必须留下至少一个启用中的老板。
    if (!roleKeys.includes("laoban")) await this.assertOwnerRemains(userId);
    const roles = await this.findRoles(roleKeys);
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findUnique({ where: { id: userId } });
      if (!exists) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "用户不存在", details: [] });
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: roles.map((role) => ({ userId, roleId: role.id })) });
      return tx.user.update({ where: { id: userId }, data: { updatedBy: actorId }, include: { roles: { include: { role: true } } } });
    });
    await this.prisma.session.deleteMany({ where: { userId } });
    await this.audit.record("user.roles_changed", "user", actorId, userId, { role_keys: roleKeys });
    return this.toManagedUser(user);
  }

  private assertRolesPresent(roleKeys: string[]) {
    if (!roleKeys.length) throw new BadRequestException({ code: "ROLE_REQUIRED", message: "账号必须至少有一个角色", details: [] });
  }

  /**
   * 防自锁②：系统必须保留至少一个**启用中**的老板账号。
   *
   * 目标账号本来就不是老板时直接放行（这个约束只关心"最后那个老板"）。
   * 角色字典里还没有 laoban 时也放行——那是迁移还没跑的环境，不该因此拦住账号维护。
   */
  private async assertOwnerRemains(targetUserId: string) {
    const ownerRole = await this.prisma.role.findFirst({ where: { key: "laoban", deletedAt: null } });
    if (!ownerRole) return;
    const targetIsOwner = await this.prisma.userRole.findFirst({ where: { userId: targetUserId, roleId: ownerRole.id } });
    if (!targetIsOwner) return;
    const remaining = await this.prisma.user.count({ where: { id: { not: targetUserId }, deletedAt: null, isActive: true, roles: { some: { roleId: ownerRole.id } } } });
    if (remaining === 0) throw new ConflictException({ code: "LAST_OWNER_REQUIRED", message: "系统必须保留至少一个启用中的「老板」账号：请先给另一个账号分配老板角色，再改这个", details: [] });
  }

  private assertLoginAllowed(username: string) {    const failure = this.loginFailures.get(username);
    if (failure && failure.blockedUntil > Date.now()) throw new UnauthorizedException("登录失败次数过多，请稍后重试");
  }

  private recordLoginFailure(username: string) {
    const failure = this.loginFailures.get(username) ?? { count: 0, blockedUntil: 0 };
    failure.count += 1;
    if (failure.count >= LOGIN_FAILURE_LIMIT) { failure.count = 0; failure.blockedUntil = Date.now() + LOGIN_BLOCK_MS; }
    this.loginFailures.set(username, failure);
  }

  private async findRoles(roleKeys: string[]) {
    const uniqueKeys = [...new Set(roleKeys)];
    const roles = await this.prisma.role.findMany({ where: { key: { in: uniqueKeys }, deletedAt: null } });
    if (roles.length !== uniqueKeys.length) throw new NotFoundException({ code: "ROLE_NOT_FOUND", message: "角色不存在或已停用", details: [] });
    return roles;
  }
  private async hashPassword(password: string) { return argon2.hash(password, { type: argon2.argon2id }); }
  private assertPassword(password: string) {
    if (password.length < PASSWORD_MIN_LENGTH || password.trim() !== password || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new ConflictException({ code: "WEAK_PASSWORD", message: `密码至少 ${PASSWORD_MIN_LENGTH} 位且必须同时包含字母和数字`, details: [] });
  }
  private isUniqueError(error: unknown) { return error && typeof error === "object" && "code" in error && error.code === "P2002"; }
  private hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
  private toCurrentUser(user: { id: string; username: string; displayName: string }): CurrentUser { return { id: user.id, username: user.username, display_name: user.displayName }; }
  private toManagedUser(user: { id: string; username: string; displayName: string; isActive: boolean; createdAt: Date; roles: { role: { key: string } }[] }) { return this.toManagedProfile(user); }
}
