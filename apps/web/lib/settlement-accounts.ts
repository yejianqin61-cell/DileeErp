// 结算账户（老表「结算方式」里的账户文本）——纯数据模块，**不能**放进 "use client" 文件。
//
// 与后端 `apps/api/src/modules/finance/cash-flow-catalog.ts` 的
// `DEFAULT_SETTLEMENT_ACCOUNTS` 是同一份口径的两份副本：两个 workspace 不共享源码，
// 所以标签必须逐字一致。改这里时后端那份要一起改。
//
// 为什么前端也要一份：已有生产库不会因为改代码自动多出字典项（仓库红线不允许新增 migration，
// Agent 也不能直接写生产库）。「财务 → 结算方式」页用这份清单检测缺项，并提供
// 「补齐缺失的内置账户」按钮 —— 走既有字典接口，由管理员显式触发，补的是**缺失项**，
// 不会改动或复活已停用项。

/** 当前内置结算账户（顺序与后端 `DEFAULT_SETTLEMENT_ACCOUNTS` 一致）。 */
export const BUILT_IN_SETTLEMENT_ACCOUNTS = [
  "农业银行5706",
  "中国银行（美元）7624",
  "中国银行-人民币账户",
  "备用金（招商银行账户）",
] as const;

export type SettlementAccountRowLike = { key: string; label: string; isActive: boolean };
export type BuiltInSettlementStatus = {
  label: string;
  /** active = 已添加且启用；inactive = 已添加但停用；missing = 字典里没有这一项。 */
  status: "active" | "inactive" | "missing";
  sortOrder: number;
};

/**
 * 把内置清单与库里的字典项逐个对照。
 *
 * 同时按 `key` 与 `label` 匹配：老数据里 key 与 label 约定相同，但人工改过 label 的行
 * 仍然应该算「已存在」，否则补齐按钮会尝试再建一行同 key 的项（唯一约束会拒绝）。
 */
export function builtInSettlementStatuses(rows: readonly SettlementAccountRowLike[]): BuiltInSettlementStatus[] {
  return BUILT_IN_SETTLEMENT_ACCOUNTS.map((label, index) => {
    const row = rows.find((item) => item.key === label || item.label === label);
    return {
      label,
      status: !row ? "missing" : row.isActive ? "active" : "inactive",
      sortOrder: (index + 1) * 10,
    };
  });
}
