import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { map, mergeMap, type Observable } from "rxjs";
import { AuditActorService } from "./audit-actor.service";
import { withActorNames } from "./audit-actor.service";

/**
 * 全站统一：给响应里的业务行补上「创建人 / 最后修改人」的**姓名**。
 *
 * 为什么放在响应出口而不是逐个 service 里加：
 *   1. 全站有 47 个 service 文件、上百个列表/详情端点。逐个改必然漏，而且每加一处就
 *      要改一处单元测试的构造桩（实测：只改采购两个 service 就打断 20 个既有用例）；
 *   2. 名字是**展示层**的东西，不是业务规则。放在出口，业务 service 完全不用知道「界面要显示谁」；
 *   3. 一页一次 `IN` 查询：无论一页有多少行、每行两个 id，都只发一次用户表查询。
 *
 * 约定（与前端 `components/data/audit-columns.tsx` 对齐）：
 *   - 只认 Prisma 行的 `createdBy` / `updatedBy`（有值、是字符串才算候选行）；
 *   - 补出 `created_by_name` / `updated_by_name`，**查无此人补 `null`，绝不回落到 UUID**
 *     （否则界面就会出现凭证纸上那种「制单：6f3a1c8e-…」）；
 *   - 已经带 `created_by_name` 键的行跳过（幂等：万一拦截器顺序变化被跑两次也不会重复查库）；
 *   - 只处理顶层行，不递归进 include 出来的子对象（子行的 created_by 与父行同源，展示层不需要）；
 *   - **任何异常都不影响接口**：补名字失败就原样返回，宁可少两列也不能让业务请求失败。
 *
 * 与 `ResponseEnvelopeInterceptor` 的顺序无关：本拦截器同时认「已包信封」与「裸返回值」两种形态
 * （信封判定要求同时有 `data` 与 `meta`，避免把恰好叫 data 的业务字段误当信封）。
 */
@Injectable()
export class AuditActorInterceptor implements NestInterceptor {
  constructor(private readonly actors: AuditActorService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(mergeMap((value: unknown) => this.enrich(value)));
  }

  /** 供单元测试直接调用（不必搭一个 Http 上下文）。 */
  async enrich(value: unknown): Promise<unknown> {
    try {
      if (isEnvelope(value)) return { ...value, data: await this.enrichRows(value.data) };
      return await this.enrichRows(value);
    } catch {
      // 补名字是锦上添花：失败绝不能连累业务响应。
      return value;
    }
  }

  private async enrichRows(data: unknown): Promise<unknown> {
    if (Array.isArray(data)) {
      const candidates = data.filter(isActorRow);
      if (!candidates.length) return data;
      const names = await this.actors.namesOf(candidates.flatMap((row) => [row.createdBy, row.updatedBy]));
      return data.map((row) => (isActorRow(row) ? withActorNames(row, names) : row));
    }
    if (isActorRow(data)) {
      const names = await this.actors.namesOf([data.createdBy, data.updatedBy]);
      return withActorNames(data, names);
    }
    return data;
  }
}

type ActorRow = { createdBy?: string | null; updatedBy?: string | null };

/** 信封 = 同时有 `data` 与 `meta`（ResponseEnvelopeInterceptor 的产物）。 */
function isEnvelope(value: unknown): value is { data: unknown } {
  if (!isPlainObject(value)) return false;
  return "data" in value && "meta" in value && isPlainObject((value as { meta: unknown }).meta);
}

/** 候选行：普通对象、有 id 形态的操作人字段、且还没补过名字（幂等）。 */
function isActorRow(value: unknown): value is ActorRow {
  if (!isPlainObject(value)) return false;
  const row = value as Record<string, unknown>;
  if (!("createdBy" in row) && !("updatedBy" in row)) return false;
  if ("created_by_name" in row) return false;
  return typeof row.createdBy === "string" || typeof row.updatedBy === "string";
}

/**
 * 只认真实普通对象：排除 null、数组、Date、Buffer/TypedArray（Excel 导出走的是二进制），
 * 否则 `"createdBy" in value` 这类判断会在奇怪的对象上产生意外行为。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value instanceof Date || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export { isActorRow, isEnvelope };
export const AUDIT_NAME_FIELDS = ["created_by_name", "updated_by_name"] as const;
