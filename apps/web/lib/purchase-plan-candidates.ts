// 「为什么选不到这张 BOM」的展示规则（2026-11-12）。
//
// 用户原话：「采购计划有时候无法选中需要建立采购计划的BOM表」。
// 审计（`docs/audit/procurement-audit-2026-11-12.md` §1.1 A7）：候选接口把不可建的 BOM
// 静默滤掉，界面上只剩一个空下拉 —— 用户看不到任何原因。
//
// 后端现在把被拦下的那半边放在响应信封的 `meta.blocked`，这里负责把它变成**能读的两三行**：
//   · 最多三条（弹窗不是报表；`ActionDialog` 的 info 字段一多就把表单挤出屏幕）；
//   · 先说「已有计划」这一类：它带编号、有明确出口（去那份计划里加一行），
//     对一个正卡住的采购员来说比"销售单还没确认"更有行动价值；
//   · 一行一条，不拼成一段 —— 一条原因太长时拼起来会读不出是哪张单。

/** 一条被拦下的 BOM（`meta.blocked` 里的一项，字段与后端一致）。 */
export type BlockedCandidate = {
  bomId: string;
  orderNo: string;
  bomVersion?: number | null;
  itemNo?: string | null;
  customerName?: string | null;
  itemCount?: number;
  reasons: Array<{ code: string; message: string }>;
  existingPlan?: { id: string; planNo: string; status: string; statusLabel?: string } | null;
};

/** 往弹窗里摆的条数上限（多出来的不展示，也不假装没有）。 */
export const BLOCKED_CANDIDATE_LIMIT = 3;

/** 原因码的排序权重：`PLAN_ALREADY_EXISTS` 最可操作，排最前。 */
const REASON_WEIGHT: Record<string, number> = { PLAN_ALREADY_EXISTS: 0, SALES_ORDER_NOT_CONFIRMED: 1, SALES_ORDER_DELETED: 2 };

function weightOf(entry: BlockedCandidate) {
  return Math.min(...entry.reasons.map((reason) => REASON_WEIGHT[reason.code] ?? 9), 9);
}

/**
 * 从响应信封的 `meta` 里取出被拦下的清单。
 *
 * 形状不认识时返回空数组而不是抛错：这是**解释性**内容，缺了只会少一句话，
 * 不该让整个新建流程打不开（老后端不给 `meta.blocked`，那时页面照旧工作）。
 */
export function blockedCandidatesFromMeta(meta: unknown): BlockedCandidate[] {
  if (!meta || typeof meta !== "object") return [];
  const blocked = (meta as { blocked?: unknown }).blocked;
  if (!Array.isArray(blocked)) return [];
  return blocked
    .filter((entry): entry is BlockedCandidate => Boolean(entry) && typeof entry === "object" && Array.isArray((entry as BlockedCandidate).reasons) && (entry as BlockedCandidate).reasons.length > 0)
    .slice()
    .sort((left, right) => weightOf(left) - weightOf(right));
}

/**
 * 把一条被拦下的 BOM 折成一行给人看的字：`DL260011-1 / 27621 — 原因`。
 *
 * 只带**人能认的编号**（销售单号、货号、计划号），绝不带 UUID ——
 * 全站治理要消灭的正是「制单：6f3a1c8e-…」那种显示。
 */
export function blockedCandidateLabel(entry: BlockedCandidate): string {
  const who = [entry.orderNo, entry.itemNo].filter((part): part is string => Boolean(part && String(part).trim()));
  // 多条原因时只取第一条：它们本来就互斥（销售单没了 / 已有计划 / 还没确认）。
  const reason = entry.reasons[0]?.message ?? "不能建计划";
  return `${who.length ? `${who.join(" / ")} — ` : ""}${reason}`;
}

/**
 * 新建弹窗里要摆出去的原因行（已有上限）。
 *
 * 返回 `{ label, shown, total }`：`total > shown` 时界面要说明"还有 N 条没列出来"，
 * 否则用户会以为被拦的只有这三张 —— 而这正是"规则不明确"的另一种形态。
 */
export function blockedCandidateNotes(entries: readonly BlockedCandidate[]) {
  const shown = entries.slice(0, BLOCKED_CANDIDATE_LIMIT).map((entry) => blockedCandidateLabel(entry));
  return { notes: shown, shown: shown.length, total: entries.length };
}

/**
 * 下拉的占位符：分清「能建的都建过了」与「一张都还没有」。
 *
 * 两者在界面上是**同一个空下拉**，但该说的话完全不同：前者要去已有计划里补行，
 * 后者要先去建 BOM。原来只有一句「没有可建计划的 BOM」，把两种情况混成一句。
 */
export function candidatePlaceholder(candidateCount: number, blockedCount: number): string {
  if (candidateCount > 0) return "选一张还没有计划的 BOM";
  if (blockedCount > 0) return "没有可建计划的 BOM（下面写了原因）";
  return "没有可建计划的 BOM";
}
