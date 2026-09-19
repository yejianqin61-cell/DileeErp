// 一次性生成器：把 example/财务/科目表(2).xls 的 121 条科目灌进 TS 常量文件。
// 目的：绝不手抄 —— 科目名称里有「销售- 办产地证」「管理 -财产保险」这类原表手误空格，
// 手抄一定会漂移，而它是全站报表口径的唯一来源。
const path = require("path");
const fs = require("fs");
const XLSX = require(path.join(process.cwd(), "node_modules", "xlsx"));

const wb = XLSX.readFile(path.join(process.cwd(), "example", "财务", "科目表(2).xls"));
const ws = wb.Sheets[wb.SheetNames[0]];
const range = XLSX.utils.decode_range(ws["!ref"]);

const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

const rows = [];
for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
  const get = (c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? norm(cell.w ?? cell.v) : "";
  };
  const category = get(0);
  const name = get(1);
  const direction = get(3);
  if (!category || !name) continue;
  rows.push({ category, name, direction });
}

const categories = [...new Set(rows.map((row) => row.category))];
const lines = [];
lines.push("/**");
lines.push(" * 会计科目表（全站财务口径的唯一来源）。");
lines.push(" *");
lines.push(" * 需求来源：用户 2026-09-17 交付的 `example/财务/科目表(2).xls`（sheet `Capacity report`，A1:H122）。");
lines.push(" * 用户口径原文：「那个编码的可以不管，分类就对应的是科目类别，项目就对应的是科目名称」。");
lines.push(" * 因此本表**只保留两级**：`category`（分类 = 科目类别）与 `name`（项目 = 科目名称）；");
lines.push(" * 老表的「科目代码」整列不采纳 —— 它自带 1001→100201→222101001 三层结构，与用户要的两级口径冲突。");
lines.push(" *");
lines.push(" * 为什么单独成模块：迁移 SQL、`prisma/seed.ts`、迁移守卫测试与「旧收支项目并入」映射必须用**同一份清单**，");
lines.push(" * 否则「老库升级」与「新库初始化」会种出不同的科目表（收支项目字典当年就踩过这个坑）。");
lines.push(" *");
lines.push(" * `balanceDirection`（余额方向，借/贷）照抄老表：本期不参与任何计算，但凭证/账簿将来要用它判断");
lines.push(" * 科目的自然余额方向，现在丢掉以后就得再问一次财务。");
lines.push(" */");
lines.push("");
lines.push("export type AccountingSubjectSeed = {");
lines.push("  category: string;");
lines.push("  name: string;");
lines.push("  /** 余额方向：借 / 贷（老表 D 列原文）。 */");
lines.push("  balanceDirection: string;");
lines.push("  sortOrder: number;");
lines.push("};");
lines.push("");
lines.push("/** 五类科目类别（老表 A 列出现过的全部取值，按老表首次出现顺序）。 */");
lines.push("export const ACCOUNTING_SUBJECT_CATEGORIES = [");
for (const category of categories) lines.push(`  ${JSON.stringify(category)},`);
lines.push("] as const;");
lines.push("");
lines.push("/** 科目表全部科目（老表行序即 sortOrder，间隔 10 便于插行）。 */");
lines.push("export const ACCOUNTING_SUBJECTS: readonly AccountingSubjectSeed[] = [");
for (const [index, row] of rows.entries()) {
  lines.push(`  { category: ${JSON.stringify(row.category)}, name: ${JSON.stringify(row.name)}, balanceDirection: ${JSON.stringify(row.direction)}, sortOrder: ${(index + 1) * 10} },`);
}
lines.push("];");
lines.push("");
lines.push("/** 科目在代码里的稳定标识：`分类/名称`（老表没有唯一编码，两段拼起来才是唯一的）。 */");
lines.push("export function accountingSubjectKey(category: string, name: string): string {");
lines.push("  return `${category}/${name}`;");
lines.push("}");
lines.push("");
lines.push("");

const target = path.join(process.cwd(), "apps", "api", "src", "modules", "finance", "accounting-subject-catalog.ts");
// 文件里手写的部分（旧项目并入映射、自动归类候选链）从标记处开始，重跑生成器时**整段保留**，
// 否则一次「按科目表重新生成」就会把手写的映射抹掉，而那正是全站口径对应的依据。
const MARKER = "/* ------------------------------------------------------------------ 旧「收支项目」并入 */";
const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
const markerAt = existing.indexOf(MARKER);
const tail = markerAt >= 0 ? existing.slice(markerAt) : "";
if (!tail) console.warn("警告：没有找到手写段落标记，本次只写生成部分（请确认 accounting-subject-catalog.ts 的内容）");
fs.writeFileSync(target, `${lines.join("\n")}${tail}`, "utf8");
console.log(`rows=${rows.length} categories=${JSON.stringify(categories.map((c) => [c, rows.filter((r) => r.category === c).length]))}`);
console.log(`written ${target} (手写段落 ${tail ? "已保留" : "缺失"})`);
