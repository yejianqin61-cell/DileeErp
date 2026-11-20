/**
 * 领料单 / 补料单「规格型号」列的纸面口径（纯函数）。
 *
 * 用户需求（T-0023）：修改 ERP 领料单打印模板，规格型号一栏简化输出，只显示简要内容，
 * 多余的备注、冗余参数不打印出来，内容超出时自动截断，不要换行。
 *
 * 前端打印件（`apps/web/lib/material-slip-print.ts` 的 `materialSlipSpecification`）与本文件
 * 必须保持同一口径：纸面打印和 xlsx 导出是同一张单据，两边格子对不上，仓库与车间对料时就会各说各话。
 * 改这里时请同步改前端那份，并跑 `material-slip-export.test.cjs` 与 `material-slip-print.test.mjs`。
 */

/** 纸面「规格型号」列最多保留的字数（含末尾省略号）。列宽按样例 xlsx 的 18 号字宽给。 */
export const MATERIAL_SLIP_SPECIFICATION_MAX_LENGTH = 18;

const SPECIFICATION_LABEL_PREFIX = /^\s*(?:规格型号|规格|型号)\s*[:：]\s*/u;
const SPECIFICATION_REMARK_BRACKET = /[（(【\[][^）)】\]]*(?:备注|说明|附注)\s*(?:[:：]\s*|\s+|(?=[）)】\]]))[^）)】\]]*[）)】\]]/gu;
const SPECIFICATION_REMARK_SUFFIX = /[（(【\[]?\s*(?:备注|说明|附注)(?:\s*[:：]\s*|\s+|(?=[）)】\]])|$)[\s\S]*$/u;
const SPECIFICATION_SEGMENT_SEPARATOR = /\s*[;；|]\s*/u;
const SPECIFICATION_TRAILING_SEPARATOR = /[\s，,、;；:：/|（(【\[]+$/u;

/**
 * 压平换行与连续空白 → 去掉重复的列头前缀 → 去掉备注段 → 去重重复参数 → 截断。
 * 返回空串表示该格没有可打印内容（调用方按模板留空，不另造「-」）。
 */
export function materialSlipSpecification(value: string | null | undefined, maxLength = MATERIAL_SLIP_SPECIFICATION_MAX_LENGTH): string {
  let text = String(value ?? "").replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  text = text.replace(SPECIFICATION_LABEL_PREFIX, "");
  text = text.replace(SPECIFICATION_REMARK_BRACKET, " ");
  text = text.replace(SPECIFICATION_REMARK_SUFFIX, "");
  const seen = new Set<string>();
  const segments = text.split(SPECIFICATION_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => {
      const key = segment.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  text = segments.join("；").replace(SPECIFICATION_TRAILING_SEPARATOR, "").trim();
  if (!text) return "";
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  const keep = Math.max(1, maxLength - 1);
  // 截断点可能正好落在一个空格/分隔符上：先清掉再补省略号，避免纸上出现「加厚款 …」。
  const truncated = characters.slice(0, keep).join("").replace(SPECIFICATION_TRAILING_SEPARATOR, "").trim();
  return `${truncated || characters.slice(0, keep).join("")}…`;
}
