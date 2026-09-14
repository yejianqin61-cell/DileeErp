// 原料仓储情况的模糊搜索（纯函数，无副作用、无 React 依赖）。
//
// 为什么单独成模块：搜索匹配规则（拆词、忽略大小写与空白、多字段 OR、词与词 AND）是
// 用户能直接感知的行为，放在页面里就只能靠渲染测试间接覆盖；抽成纯函数后
// `lib/material-search.test.mjs` 可以直接推演边界（空查询、多词、空白、非字符串字段）。
//
// 规则：
//   - 查询按空白拆成多个词，**所有词**都必须出现在该行的任一字段里（AND 语义），
//     因此「涤纶 150D」能同时收窄物料与规格；
//   - 大小写不敏感；词内部与字段内部的空白都会被忽略，
//     因此「150 D」也能匹配到「150D」；
//   - 空查询（或只有空白）视为不过滤，返回 true。

/** 归一化：小写 + 去掉所有空白。 */
function normalize(value: string | number | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}

/**
 * 模糊匹配：把 `fields` 拼成一段可搜索文本，再要求查询里的每个词都出现。
 * `fields` 里的 null / undefined 视为空串，不参与匹配也不报错（后端可选字段很常见）。
 */
export function fuzzyMatch(query: string | null | undefined, fields: Array<string | number | null | undefined>): boolean {
  const tokens = String(query ?? "").trim().toLowerCase().split(/\s+/).map(normalize).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = fields.map(normalize).join(" ");
  return tokens.every((token) => haystack.includes(token));
}
