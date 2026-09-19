import type { ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { formatBeijingShort, type Instant } from "../../lib/audit-time";

/**
 * 全站统一的「操作人」两列。
 *
 * 为什么要做成工厂而不是各页手写：全站有 72 处 `<DataTable>`、61 个列定义，
 * 逐页加两列 = 50 多处改动，列名、时间格式、空值兜底、字段名容错会立刻各写各的。
 * 收在这里以后要改（比如改成「创建人 / 创建时间 / 最后修改人 / 最后修改时间」四列）只改一处。
 *
 * 用户 2026-09-16 定的口径：
 *   - 两列：**创建人 / 最后修改人**（不是一列，也不是「本次动作执行人」）；
 *   - 时间固定**北京时间、到分**（`formatBeijingShort`：同年省略年份）；
 *   - 姓名取不到（历史行的 created_by 指向已删用户）显示 `—`，**绝不显示 UUID**。
 */

/**
 * 接口返回的审计字段。两种命名都要认：
 *   - 服务端 join 出来的计算字段是 snake_case（`created_by_name`）；
 *   - Prisma 整行透传的是 camelCase（`createdAt` / `updatedAt`）；
 *   - 报表类接口手工挑过的是 snake_case（`updated_at`）。
 * 三种在现有接口里同时存在，所以这里做兼容而不是逼后端统一（那会牵动几十处 select）。
 */
export type AuditRow = {
  created_by_name?: string | null;
  updated_by_name?: string | null;
  createdAt?: Instant;
  updatedAt?: Instant;
  created_at?: Instant;
  updated_at?: Instant;
};

const firstInstant = (...values: Instant[]): Instant => values.find((value) => value !== null && value !== undefined && value !== "") ?? null;
const textOrDash = (value: string | null | undefined): string => (value && value.trim() ? value : "—");

/** 单元格内容：姓名 + 次行小字时间。两行合一列，避免财务/生产那些本来就很宽的表再横向滚动。 */
export function auditActorCell(name: string | null | undefined, at: Instant): ReactNode {
  const time = formatBeijingShort(at);
  return (
    <div className="audit-actor-cell">
      <span className="audit-actor-name">{textOrDash(name)}</span>
      {time ? <span className="audit-actor-time">{time}</span> : null}
    </div>
  );
}

/** 创建人列（姓名 + 创建时间）。 */
export function createdByColumn<T extends AuditRow>(): ColumnDef<T, unknown> {
  return {
    id: "created_by_name",
    header: "创建人",
    cell: ({ row }) => auditActorCell(row.original.created_by_name, firstInstant(row.original.createdAt, row.original.created_at))
  };
}

/** 最后修改人列（姓名 + 最后修改时间）。 */
export function updatedByColumn<T extends AuditRow>(): ColumnDef<T, unknown> {
  return {
    id: "updated_by_name",
    header: "最后修改人",
    cell: ({ row }) => auditActorCell(row.original.updated_by_name, firstInstant(row.original.updatedAt, row.original.updated_at))
  };
}

/**
 * 追加两列，放在调用方原有列的**后面**。
 * 用法：`columns={[...业务列, ...auditColumns<Row>()]}`（用展开而不是 `auditColumns` 包住全表，
 * 这样「操作」列该在最后还是在中间，由各页自己决定）。
 */
export function auditColumns<T extends AuditRow>(): ColumnDef<T, unknown>[] {
  return [createdByColumn<T>(), updatedByColumn<T>()];
}

export type AuditDetailField = { label: string; value: string };

/**
 * 详情区用的四行具名字段（详情空间足够，不挤成一格）。
 * 接进各页已有的 `{ label, value }` 数组即可：`...auditDetailFields(row)`。
 */
export function auditDetailFields(row: AuditRow): AuditDetailField[] {
  return [
    { label: "创建人", value: textOrDash(row.created_by_name) },
    { label: "创建时间", value: formatBeijingShort(firstInstant(row.createdAt, row.created_at)) || "—" },
    { label: "最后修改人", value: textOrDash(row.updated_by_name) },
    { label: "最后修改时间", value: formatBeijingShort(firstInstant(row.updatedAt, row.updated_at)) || "—" }
  ];
}
