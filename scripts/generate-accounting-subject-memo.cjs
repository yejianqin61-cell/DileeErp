// 一次性生成器：把 37 条对照表从常量文件导出成 memo markdown（不手抄）。
const path = require("path");
const fs = require("fs");

const source = fs.readFileSync(path.join(process.cwd(), "apps", "api", "src", "modules", "finance", "accounting-subject-catalog.ts"), "utf8");

function literalArray(name) {
  const start = source.indexOf(`export const ${name}`);
  const assign = source.indexOf("=", start);
  const open = source.indexOf("[", assign);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(name);
}

// eslint-disable-next-line no-new-func
const legacy = new Function(`return ${literalArray("LEGACY_CASH_FLOW_ITEM_SUBJECTS")}`)();
// eslint-disable-next-line no-new-func
const subjects = new Function(`return ${literalArray("ACCOUNTING_SUBJECTS")}`)();

const subjectKeys = new Set(subjects.map((s) => `${s.category}/${s.name}`));
const missing = legacy.filter((l) => !subjectKeys.has(`${l.category}/${l.name}`));
if (missing.length) throw new Error("对照表里有科目表里不存在的科目：" + JSON.stringify(missing));

const counts = new Map();
for (const l of legacy) counts.set(`${l.category}/${l.name}`, (counts.get(`${l.category}/${l.name}`) ?? 0) + 1);

const rows = legacy.map((l, index) => {
  const merged = counts.get(`${l.category}/${l.name}`) > 1;
  return `| ${index + 1} | ${l.legacyKey} | ${l.category} | ${l.name} | ${merged ? "**合并组**" : ""} | ${l.note ?? ""} |`;
});

const memo = `# 收支项目并入会计科目 · 37 条对照表（2026-09-17）

> 状态：**已实现，请财务过目**。这份表是迁移 \`20260917120000_accounting_subjects\` 会实际执行的
> 改指依据，逐字来自 \`apps/api/src/modules/finance/accounting-subject-catalog.ts\`（本文件由脚本生成，不手抄）。
>
> 用户 2026-09-17 选定：「**彻底合并**：37 个旧项目并入 121 条科目，历史数据改指」。
> 也就是说：**下面每一行的旧项目名从此在系统里不再出现**，历史流水、已确认单据上原来挂的那个项目，
> 会显示成右边那个会计科目。金额、日期、对方、单据号一个都不变，只有分类改名。
>
> 背景与口径见 \`docs/design/accounting-subject-chart-2026-09-17.md\`。

## 怎么读这张表

- **分类 / 项目** = 该旧项目归属的会计科目（分类 = 科目类别，项目 = 科目名称），取自
  \`example/财务/科目表(2).xls\`。
- 「**合并组**」= 两条旧项目并到了同一个科目，因此它们的历史流水在合并后会显示成同一个科目名。
- 「需要确认」列是**判断有余地**的条目：老名与科目名不是同义，是按语义最近邻挑的默认值。
- **这些默认值随时能改**：财务在「财务 → 收支管理 → 会计科目」页上改科目的分类或名称即可，
  **不需要动任何历史单据**（历史单据存的是科目主键，展示时按主键取当前的名字）。
  如果某一条应该拆成两个科目（例如「差旅费」里既有销售差旅也有管理差旅），
  就在会计科目页上新增一个科目，再把对应的流水逐条改过去（流水支持「更正」）。

## 37 条对照表

| # | 旧项目（收支汇总表原文） | 分类 | 项目（会计科目） | 合并组 | 需要确认 |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

合计：37 条旧项目 → **${new Set(legacy.map((l) => `${l.category}/${l.name}`)).size} 个不同科目**。

## 迁移对这些数据做了什么（可追溯性）

迁移会写一条审计事件 \`accounting_subject.merge_legacy_cash_flow_items\`，payload 里带
\`reason\`（合并原因）、\`source\`（科目表文件名）与上面这张完整映射表，操作人与时间由审计表自带。
旧的 \`cash_flow_item\` 字典项只是**软删**（\`deleted_at\`），行还在库里，随时查得到「当初是什么项目」。

## 需要财务回答的三件事

1. 上表「需要确认」那 12 条，默认归属对不对？特别是：
   - **原材料 成本 → 主营业务成本**（而不是资产类「原材料」）
   - **机器折旧费用 → 累计折旧**（资产类贷方科目，不是费用科目 —— 科目表里没有"折旧费"这个费用科目）
   - **人 工费 → 基本生产成本**（还是「临时工资」？）
   - **国家退税 → 营业外收入**（还是「应交税费-进项税」？）
2. 合并组的合并是否符合预期（尤其是「银行费用利息」并入「银行手续费」——利息与手续费性质不同）。
3. 科目表里那 121 条是否**全部**作为可选项？本期做法是全部启用（含"银行存款 刘总转入"这类
   明细科目）。如果某些科目不希望出现在收支流水的科目下拉里，请指出，我们改成默认停用。
`;

fs.writeFileSync(path.join(process.cwd(), "docs", "memo", "0917-收支项目并入会计科目对照表.md"), memo, "utf8");
console.log(`legacy=${legacy.length} distinct=${new Set(legacy.map((l) => `${l.category}/${l.name}`)).size}`);
