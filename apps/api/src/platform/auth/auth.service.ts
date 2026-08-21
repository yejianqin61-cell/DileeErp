import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { AuditService } from "../audit/audit.service";

export type CurrentUser = { id: string; username: string; display_name: string };
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
    return { token, user: this.toCurrentUser(user) };
  }

  async currentUser(token?: string): Promise<CurrentUser> {
    if (!token) throw new UnauthorizedException();
    const session = await this.prisma.session.findFirst({ where: { tokenHash: this.hashToken(token), expiresAt: { gt: new Date() }, user: { isActive: true, deletedAt: null } }, include: { user: true } });
    if (!session) throw new UnauthorizedException();
    return this.toCurrentUser(session.user);
  }

  async logout(token?: string) {
    if (!token) return;
    const session = await this.prisma.session.findFirst({ where: { tokenHash: this.hashToken(token) } });
    await this.prisma.session.deleteMany({ where: { tokenHash: this.hashToken(token) } });
    await this.audit.record("auth.logout", "user", session?.userId, session?.userId);
  }

  async createUser(input: { username: string; password: string; displayName: string; roleKeys: string[] }, actorId: string) {
    this.assertPassword(input.password);
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

  private assertLoginAllowed(username: string) {
    const failure = this.loginFailures.get(username);
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
  private toManagedUser(user: { id: string; username: string; displayName: string; isActive: boolean; roles: { role: { key: string } }[] }) { return { ...this.toCurrentUser(user), is_active: user.isActive, role_keys: user.roles.map(({ role }) => role.key) }; }
}
