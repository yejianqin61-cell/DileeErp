export const MODULE_KEYS = ["production", "procurement", "finance", "warehouse", "hr", "customers"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
