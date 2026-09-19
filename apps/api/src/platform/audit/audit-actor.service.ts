import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/** `attach`/`attachAll` 补出来的两个字段；前端「创建人」「最后修改人」两列就读它们。 */
export type AuditActorNames = {
  created_by_name: string | null;
  updated_by_name: string | null;
};

type ActorRow = { createdBy?: string | null; updatedBy?: string | null };

/**
 * 纯函数：把「id → 姓名」映射贴到一行上。
 *
 * 单独抽出来（不放进 service）是为了能被单元测试直接钉住最重要的一条约定：
 * **取不到姓名时补 `null`，绝不回落到 id 本身** —— 否则界面就会出现
 * 「制单：6f3a1c8e-…」这种 UUID（全站现在就有两处在这么干，见盘点 5.3）。
 */
export function withActorNames<T extends ActorRow>(row: T, names: Map<string, string>): T & AuditActorNames {
  const nameOf = (id: string | null | undefined): string | null => (id ? names.get(id) ?? null : null);
  return { ...row, created_by_name: nameOf(row.createdBy), updated_by_name: nameOf(row.updatedBy) };
}

/**
 * 全站统一的「操作人姓名」解析。
 *
 * 为什么必须由服务端来解析：前端**没有**任何 id→姓名的通道
 * （`/auth/me` 只返回自己，`admin/users` 只写不读列表，见盘点 4.3），
 * 所以接口不下发姓名，界面就只能显示 UUID。
 *
 * **性能约定：一次 `IN` 查询解决整页，禁止在循环里逐行查。**
 * 现存的反例是领料/补料单的批量导出（`material-slip-export.service.ts` 对每张单据单独 `findFirst`），
 * 导出上百张时会打出上百次查询。
 */
@Injectable()
export class AuditActorService {
  constructor(private readonly prisma: PrismaService) {}

  /** 批量取姓名。去重、剔除空值；返回的 Map 缺键即「查无此人」（已删用户等）。 */
  async namesOf(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  /** 给一行补两个姓名。 */
  async attach<T extends ActorRow>(row: T): Promise<T & AuditActorNames> {
    return withActorNames(row, await this.namesOf([row.createdBy, row.updatedBy]));
  }

  /**
   * 给一页数据补两个姓名（**一次**查询）。
   *
   * 返回值保持数组顺序与长度不变——调用方常常已经把行按下标对上别的数据了，
   * 这里绝不能过滤掉任何一行。
   */
  async attachAll<T extends ActorRow>(rows: T[]): Promise<(T & AuditActorNames)[]> {
    if (!rows.length) return [];
    const names = await this.namesOf(rows.flatMap((row) => [row.createdBy, row.updatedBy]));
    return rows.map((row) => withActorNames(row, names));
  }

  /**
   * 审计事件时间线用的：给 `AuditEvent` 行补 `actor_name`。
   *
   * 现存的 4 个 `:id/audit-events` 端点把 `actorId` 原样返回（是 UUID），
   * 接了界面也没法看，所以一并提供解析。
   */
  async attachActorToEvents<T extends { actorId?: string | null }>(rows: T[]): Promise<(T & { actor_name: string | null })[]> {
    if (!rows.length) return [];
    const names = await this.namesOf(rows.map((row) => row.actorId));
    return rows.map((row) => ({ ...row, actor_name: row.actorId ? names.get(row.actorId) ?? null : null }));
  }
}
