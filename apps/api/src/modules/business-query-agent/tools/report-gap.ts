import { UnprocessableEntityException } from "@nestjs/common";

export const GAP_MISSING = ["group_by", "filter", "metric", "time_series", "object"] as const;
export const GAP_MISSING_PARAMS = ["q", "status", "customer_q", "product_q", "from", "to"] as const;

export type GapDeclaration = {
  nearest_operation: string;
  missing: (typeof GAP_MISSING)[number];
  missing_detail: string;
  missing_param?: (typeof GAP_MISSING_PARAMS)[number];
  needed_fields: string[];
};

const KNOWN_KEYS = ["operation", "nearest_operation", "missing", "missing_detail", "missing_param", "needed_fields"];
const MAX_DETAIL = 200;
const MAX_FIELDS = 20;
const MAX_FIELD = 100;

function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: "AGENT_GAP_ARGUMENT_INVALID", message, details: [] });
}

function text(value: unknown, key: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) invalid(`缺少必填字段 ${key}`);
  return trimmed;
}

function oneOf<T extends string>(value: unknown, key: string, values: readonly T[]): T {
  if (!values.includes(value as T)) invalid(`${key} 取值不合法，可用：${values.join("、")}`);
  return value as T;
}

function neededFields(value: unknown): string[] {
  if (value === undefined) return [];
  const valid = Array.isArray(value) && value.length <= MAX_FIELDS && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_FIELD);
  if (!valid) invalid(`needed_fields 必须是至多 ${MAX_FIELDS} 项的字符串数组，每项 1–${MAX_FIELD} 字`);
  return value as string[];
}

export function parseGapDeclaration(args: Record<string, unknown> | undefined, question: string): GapDeclaration {
  const raw = args ?? {};
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) invalid(`不接受字段：${unknown.join("、")}`);
  const nearest = text(raw.nearest_operation, "nearest_operation");
  if (raw.missing === undefined) invalid("缺少必填字段 missing");
  const missing = oneOf(raw.missing, "missing", GAP_MISSING);
  const detail = text(raw.missing_detail, "missing_detail");
  if (detail.length > MAX_DETAIL) invalid(`missing_detail 至多 ${MAX_DETAIL} 字`);
  const original = question.trim();
  if (original && detail.includes(original)) invalid("missing_detail 只写缺口短语，不要照抄用户原话");
  const param = raw.missing_param === undefined ? undefined : oneOf(raw.missing_param, "missing_param", GAP_MISSING_PARAMS);
  return {
    nearest_operation: nearest,
    missing,
    missing_detail: detail,
    ...(param ? { missing_param: param } : {}),
    needed_fields: neededFields(raw.needed_fields),
  };
}
