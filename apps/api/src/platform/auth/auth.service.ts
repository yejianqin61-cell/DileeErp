import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../database/prisma.service";

export type CurrentUser = { id: string; username: string; display_name: string };

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(username: string, password: string) {
    const user = await this.prisma.user.findFirst({ where: { username, deletedAt: null } });
    if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException("用户名或密码错误");
    const token = randomBytes(32).toString("base64url");
    await this.prisma.session.create({ data: { tokenHash: this.hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12), createdBy: user.id, updatedBy: user.id } });
    return { token, user: this.toCurrentUser(user) };
  }

  async currentUser(token?: string): Promise<CurrentUser> {
    if (!token) throw new UnauthorizedException();
    const session = await this.prisma.session.findFirst({ where: { tokenHash: this.hashToken(token), expiresAt: { gt: new Date() }, user: { isActive: true, deletedAt: null } }, include: { user: true } });
    if (!session) throw new UnauthorizedException();
    return this.toCurrentUser(session.user);
  }

  async logout(token?: string) {
    if (token) await this.prisma.session.deleteMany({ where: { tokenHash: this.hashToken(token) } });
  }

  private hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
  private toCurrentUser(user: { id: string; username: string; displayName: string }): CurrentUser { return { id: user.id, username: user.username, display_name: user.displayName }; }
}
