export const MODULE_KEYS = ["sales", "procurement", "production", "warehouse", "finance", "hr"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
