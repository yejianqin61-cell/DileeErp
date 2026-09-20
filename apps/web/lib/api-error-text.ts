// 把后端失败信封翻译成「一句能照着改的话」。
//
// 为什么需要（2026-09-20 现场问题）：后端 DTO 校验失败时回的是
// `{ code: "VALIDATION_ERROR", message: "请求参数校验失败", details: [{ field, rule, message }] }`，
// 而页面普遍只取 `cause.message` 去显示 —— 于是不管错在哪一格，用户看到的**永远**是同一句
// 「请求参数校验失败」，没有任何可操作信息。details 一直都在，只是被丢掉了。
//
// 这里只做两件事，不碰请求逻辑：
//   1. `details` 里逐条带 `message` 的项拼成「字段：原因」；`message` 不是字符串的项（业务异常
//      里的结构化数据，例如 `{ available: "3" }`）一律跳过 —— 那些不是给人读的句子；
//   2. 字段路径做一次人话化：`spec_details[0].quantity` → 「数量」。
//      表里没有的键**原样显示**：宁可让用户看到 `fabric_usage_canopy`，也不要吞掉这条错误。
//
// ⚠️ 本文件刻意**不 import `api-client.ts`**：lib 下的纯函数要能被 `node --test lib/**/*.test.mjs`
// 直接跑（类型擦除不加扩展名解析），而跨文件 import 会让它加载不到（仓库里
// `currency-catalogue.ts` 那类带相对 import 的模块就没有 .test.mjs）。识别失败信封改用结构判断，
// 判据是「Error 且有 details 键」—— 只有 ApiClientError 长这样，裸 Error（网络中断）没有 details。

/** 字段名（或叶子字段名）→ 界面上的中文名。表里没有的键原样显示。 */
export type FieldLabels = Record<string, string>;

/** 失败信封的**结构**形状（不依赖具体类，见文件头说明）。 */
type FailureLike = { message: string; details: unknown };

/**
 * 认出一个「带信封的失败」：`ApiClientError` 一定满足，裸 `Error` / `TypeError`（网络中断、
 * 超时被包成的一般错误）一定不满足 —— 后者没有 `details`，会走 fallback。
 */
function asFailure(cause: unknown): FailureLike | null {
  if (!cause || typeof cause !== "object") return null;
  const candidate = cause as { message?: unknown; details?: unknown };
  if (typeof candidate.message !== "string" || !("details" in candidate)) return null;
  return { message: candidate.message, details: candidate.details };
}

/** details 里只认「有字符串 message」的项，其余（结构化业务数据、空白串）全部跳过。 */
function readableMessages(details: unknown): Array<{ field: string; message: string }> {
  if (!Array.isArray(details)) return [];
  const result: Array<{ field: string; message: string }> = [];
  for (const item of details) {
    if (!item || typeof item !== "object") continue;
    const { field, message } = item as { field?: unknown; message?: unknown };
    if (typeof message !== "string" || !message.trim()) continue;
    result.push({ field: typeof field === "string" ? field : "", message });
  }
  return result;
}

/**
 * 字段路径 → 人话。取不到就回原路径。
 *
 * `spec_details[0].quantity` 这种路径：先整体查一次（调用方可能直接登记了完整路径），
 * 再去掉数组下标、取最后一段（`quantity`）查一次。
 */
export function fieldLabel(field: string, labels: FieldLabels = {}): string {
  if (!field) return "";
  if (labels[field]) return labels[field];
  const leaf = field.replace(/\[\d+\]/g, "").split(".").pop() ?? field;
  return labels[leaf] ?? field;
}

/**
 * 逐条可读的校验原因（没有可读的 details 时返回空数组）。
 *
 * 带 field 的项拼成「字段：原因」，不带的直接用原因 —— 后者是 ApiExceptionFilter 对
 * 「message 是数组」的老形态做的兜底（`{ message }`），同样值得显示。
 */
export function validationDetailLines(details: unknown, labels: FieldLabels = {}): string[] {
  return readableMessages(details).map(({ field, message }) => {
    const label = fieldLabel(field, labels);
    return label ? `${label}：${message}` : message;
  });
}

/**
 * 失败原因的人话版：`message` 后面接上逐条字段级原因。
 *
 * 非信封错误（网络中断、超时抛出的一般 Error）走 fallback —— 那些没有 details 可读。
 */
export function apiErrorText(cause: unknown, fallback: string, labels: FieldLabels = {}): string {
  const failure = asFailure(cause);
  if (!failure) return fallback;
  const lines = validationDetailLines(failure.details, labels);
  return lines.length ? `${failure.message}：${lines.join("；")}` : failure.message;
}
