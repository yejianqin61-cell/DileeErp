// 生成「科目 → 报表行」的初始映射（2026-11-11 R-2 / T8）。
//
// 为什么要有这个脚本，而不是手工抄 122 行 SQL：
//   映射的初始值必须与**今天代码里的规则逐条等价**，否则迁移那天的报表数字会动。
//   规则就是 `finance-three-statements.ts` 里那些 `named()` / `prefixed()`，
//   让脚本去调用它们，比人眼照着抄可靠得多 —— 而且改规则之后重跑一次就能重新生成。
//
// 用法（跑之前先 `npm run build --workspace=@dilee/api`）：
//   node scripts/generate-statement-row-mapping.mjs            # 打印 SQL
//   node scripts/generate-statement-row-mapping.mjs --check    # 只校验，不打印
//
// 输出：一条幂等的 INSERT ... ON CONFLICT DO UPDATE，写进 accounting_subject_statement_rows。
//
// ## 校验口径（这里踩过一次，记下来）
//
// 第一版要求「每个科目在每张表里都被认领」，于是报出 122 条缺口——那是**错的口径**：
// 损益类科目本来就不该出现在资产负债表上，资产类科目也不该出现在利润表上。
// 真正该守的不变量与内核自带的 `checkStatementCoverage` 一致：
//   ① 每个科目**至少被三张表中的某一行**认领（否则它的金额在报表里消失）；
//   ② 同一张表、同一方向里，一个科目不能被两行同时认领（否则金额被算两遍）。
// 单张表的「未认领」是正常的，不是错误。
//
// 退出码：0 通过；1 有科目一条行都没命中，或有科目被两行同时认领。

// 直接从编译产物读：规则只有一份（`finance-three-statements.ts` 的 named()/prefixed()），
// 脚本调它们而不是抄它们。
const distOf = (relative) => new URL(`../apps/api/dist/modules/finance/${relative}`, import.meta.url);

const statements = await import(distOf("finance-three-statements.js"));
const catalog = await import(distOf("accounting-subject-catalog.js"));

const { BALANCE_SHEET_ASSETS, BALANCE_SHEET_EQUITIES, INCOME_STATEMENT, CASH_FLOW_STATEMENT } = statements;
const { ACCOUNTING_SUBJECT_SEEDS } = catalog;

/**
 * 认领域的清单。
 *
 * ⚠️ 资产负债表必须**拆成两侧**：它是两栏对照表，行次在左右两侧各自从 1 开始 ——
 * 资产侧行次 1 是「货币资金」，权益侧行次 1 是「短期借款」。
 * 混成一个 `balance-sheet` 键会让映射里的 `row_no` 有歧义（同一行次指两个不同报表行），
 * 而这个歧义在报表上表现为「金额落到了另一侧」——所以这里按侧拆开。
 */
const SCOPES = [
  { statement: "balance-sheet-assets", rows: BALANCE_SHEET_ASSETS },
  { statement: "balance-sheet-equities", rows: BALANCE_SHEET_EQUITIES },
  { statement: "income-statement", rows: INCOME_STATEMENT },
  { statement: "cash-flow-statement", rows: CASH_FLOW_STATEMENT },
];

/**
 * 一张表里每个 `flow` 分组是独立的认领域：现金流量表同一科目可以同时出现在流入与流出两组，
 * 靠方向区分（见 `StatementRow.flow` 的注释）。其余三张表没有 flow，视为一组。
 */
const groupKeyOf = (row) => row.flow ?? "";

/** 逐条科目 → 每个认领域里被哪一行认领。 */
function buildMapping() {
  const claims = [];   // 每条「科目 × 认领域 × 方向」的唯一归属
  const doubles = [];  // 同一格被多行认领
  /** `${分类}/${名称}` → 是否被任何认领域的行认领过。用来判「一条行都没命中」。 */
  const covered = new Map();

  for (const { statement, rows } of SCOPES) {
    const groups = new Map();
    for (const row of rows) {
      if (!row.match || row.row === null) continue;
      const key = groupKeyOf(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const subject of ACCOUNTING_SUBJECT_SEEDS) {
      for (const [flow, candidates] of groups) {
        const hits = candidates.filter((row) => row.match(subject.category, subject.name));
        if (hits.length === 0) continue; // 单张表没有归属是正常的，不记问题
        if (hits.length > 1) {
          doubles.push({ statement, flow, subject, rows: hits.map((row) => row.row) });
          continue;
        }
        claims.push({ statement, flow, category: subject.category, name: subject.name, row: hits[0].row });
        covered.set(subject.category + "/" + subject.name, true);
      }
    }
  }

  const uncovered = ACCOUNTING_SUBJECT_SEEDS.filter((subject) => !covered.has(subject.category + "/" + subject.name));
  return { claims, doubles, uncovered };
}

const { claims, doubles, uncovered } = buildMapping();

if (doubles.length) {
  console.error(`✖ ${doubles.length} 处「同一张表同一方向」被两行同时认领（金额会被算两遍）：`);
  for (const p of doubles.slice(0, 10)) {
    console.error(`   ${p.statement}/${p.flow || "-"} ${p.subject.category}/${p.subject.name} → 行次 ${p.rows.join("、")}`);
  }
}
if (uncovered.length) {
  console.error(`✖ ${uncovered.length} 条科目在三张表里一条行都没命中（金额会消失）：`);
  for (const subject of uncovered.slice(0, 10)) console.error(`   ${subject.category}/${subject.name}`);
}

const checkOnly = process.argv.includes("--check");
if (doubles.length || uncovered.length) process.exit(1);

const perStatement = {};
for (const claim of claims) perStatement[claim.statement] = (perStatement[claim.statement] ?? 0) + 1;

if (checkOnly) {
  const detail = Object.entries(perStatement).map(([k, v]) => `${k} ${v} 条`).join("、");
  console.log(`✔ 映射可生成：${claims.length} 条（${detail}）。${ACCOUNTING_SUBJECT_SEEDS.length} 个科目全部至少被一行认领，无双重认领。`);
  process.exit(0);
}

const sqlLiteral = (text) => `'${String(text).replaceAll("'", "''")}'`;
const values = claims
  .map((row) => `  (${sqlLiteral(row.statement)}, ${sqlLiteral(row.flow)}, ${sqlLiteral(row.category)}, ${sqlLiteral(row.name)}, ${row.row})`)
  .join(",\n");

console.log(`-- 由 scripts/generate-statement-row-mapping.mjs 生成，勿手工编辑。
-- ${claims.length} 条「科目 → 报表行」映射，来源是 finance-three-statements.ts 的 named()/prefixed() 规则。
-- 键用 (statement, flow, 分类, 名称) 而不是科目主键：生成时只知道常量清单，不知道运行时 id；
-- 落库那一步再按 (分类, 名称) 解析成 subject_id（唯一同名才认，与全站同一条判据）。
INSERT INTO "_statement_row_mapping" ("statement", "flow", "category", "name", "row_no") VALUES
${values}
ON CONFLICT ("statement", "flow", "category", "name") DO UPDATE SET "row_no" = EXCLUDED."row_no";`);
