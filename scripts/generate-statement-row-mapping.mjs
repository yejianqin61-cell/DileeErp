// 生成「科目 → 报表行」的初始映射（2026-11-11 R-2 / T8）。
//
// 为什么要有这个脚本，而不是手工抄 122 行 SQL：
//   映射的初始值必须与**今天代码里的规则逐条等价**，否则迁移那天的报表数字会动。
//   规则就是 `finance-three-statements.ts` 里那些 `named()` / `prefixed()`，
//   让脚本去调用它们，比人眼照着抄可靠得多 —— 而且改规则之后重跑一次就能重新生成。
//
// 用法（跑之前先 `npm run build --workspace=@dilee/api`）：
//   node scripts/generate-statement-row-mapping.mjs                        # 打印临时表 SQL
//   node scripts/generate-statement-row-mapping.mjs --check                # 只校验，不打印
//   node scripts/generate-statement-row-mapping.mjs --migration --out f.sql # 生成迁移（建表 + 回填）
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
// 单张表的「未认领」是正常的，不是错误。这两条现在由内核的 `initialStatementRowClaims`
// 一并算出来（`doubles` / `uncovered`），脚本只负责把结果打出来并决定退出码。
//
// 退出码：0 通过；1 有科目一条行都没命中，或有科目被两行同时认领。

// 直接从编译产物读：规则只有一份（`finance-three-statements.ts` 的 named()/prefixed()），
// 脚本调它们而不是抄它们。
import { writeFileSync } from "node:fs";

const distOf = (relative) => new URL(`../apps/api/dist/modules/finance/${relative}`, import.meta.url);

const statements = await import(distOf("finance-three-statements.js"));
const catalog = await import(distOf("accounting-subject-catalog.js"));

const { initialStatementRowClaimsOf } = statements;
const { ACCOUNTING_SUBJECT_SEEDS } = catalog;

/**
 * 逐条「科目 → 每个认领域里被哪一行认领」由**内核**算，脚本不再自己抄一遍。
 *
 * 这一版之前这里有一份 `buildMapping()`，把四个认领域、按 flow 分组、双重认领判定全抄了一遍 ——
 * 于是同一套规则有了两份实现，改一边忘一边就会生成一份与报表判定不一致的迁移，而报表照样平。
 * 现在规则只在内核里（`initialStatementRowClaimsOf` / `STATEMENT_SCOPE_ROWS`），
 * 脚本只负责把它落成 SQL；守卫测试 `报表行映射：迁移文件里的回填值与内核算出的认领逐条一致`
 * 会顺手盯住「迁移文件有没有落后于规则」。
 *
 * 认领域的四个（含资产负债表按两侧拆开、现金流量表按流向分组）也定义在内核里，理由见那段注释。
 */
const { claims: flatClaims, doubles, uncovered } = initialStatementRowClaimsOf(ACCOUNTING_SUBJECT_SEEDS);

/** 内核用 `scope` 命名认领域，SQL 列名沿用 `statement`（表结构里就是这么叫的）。 */
const claims = flatClaims.map((claim) => ({
  statement: claim.scope,
  flow: claim.flow,
  category: claim.category,
  name: claim.name,
  row: claim.row,
}));

if (doubles.length) {
  console.error(`✖ ${doubles.length} 处「同一张表同一方向」被两行同时认领（金额会被算两遍）：`);
  for (const line of doubles.slice(0, 10)) console.error(`   ${line}`);
}
if (uncovered.length) {
  console.error(`✖ ${uncovered.length} 条科目在三张表里一条行都没命中（金额会消失）：`);
  for (const line of uncovered.slice(0, 10)) console.error(`   ${line}`);
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

/**
 * 输出：默认打到 stdout；给了 `--out <path>` 就**自己写文件**。
 *
 * 为什么不靠 shell 重定向：PowerShell 的管道会把 `console.log` 的整段输出当**一个字符串**处理，
 * 重定向后内部换行会被吃掉，生成出一份单行的 SQL（第一次就这么踩的）。
 * 由 node 直接写盘，结果与平台无关。
 */
const outPath = (() => {
  const at = process.argv.indexOf("--out");
  return at >= 0 ? process.argv[at + 1] : null;
})();
function emit(text) {
  if (!outPath) { console.log(text); return; }
  writeFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  console.error(`✔ 已写入 ${outPath}`);
}

/**
 * `--migration`：输出一份**可直接落库的迁移**（建表 + 回填），而不是中间的临时表数据。
 *
 * 为什么迁移也由脚本生成：回填的 234 行必须与内核判定逐条等价，人眼抄一遍就是多出第二份会漂移的清单。
 * 而 VALUES 里的键是 (分类, 名称) —— 生成时只知道常量，不知道运行时 id ——
 * 所以迁移在 SQL 里再按「唯一同名」解析成 subject_id，与全站同一条判据。
 */
if (process.argv.includes("--migration")) {
  emit(`-- 会计科目 → 报表行 映射（2026-11-11 R-2 / T8）
--
-- 由 scripts/generate-statement-row-mapping.mjs --migration 生成，勿手工编辑。
-- 重跑生成要先把 @dilee/api 构建过（脚本调的是编译产物里的判定函数）。
--
-- 一件事：把「哪个科目进哪张报表的哪一行」从代码里的字符串比对（63 处 named()/prefixed()）
-- 搬成一张数据表。名字是财务随时能改的显示文案，所以改名 = 该行静默变 0（诊断 P0-1）；
-- 映射落成数据之后，改名不影响落行。
--
-- ${claims.length} 条映射，来源就是今天的规则，因此落库当天三张报表的数字一格都不动。
-- 认领域四个而不是三个：资产负债表是两栏对照表，行次左右各自从 1 开始，
-- 混成一个值会让 row_no 有歧义（资产侧行次 1 = 货币资金，权益侧行次 1 = 短期借款）。

CREATE TABLE "accounting_subject_statement_rows" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "subject_id" UUID         NOT NULL,
  "statement"  VARCHAR(40)  NOT NULL,
  "flow"       VARCHAR(10)  NOT NULL DEFAULT '',
  "row_no"     INTEGER      NOT NULL,
  CONSTRAINT "accounting_subject_statement_rows_pkey" PRIMARY KEY ("id")
);

-- Cascade：映射是科目的派生数据，科目被物理清理时跟着走；正常路径只停用不删除。
ALTER TABLE "accounting_subject_statement_rows"
  ADD CONSTRAINT "accounting_subject_statement_rows_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 一个科目在一个认领域里只能落一行：两行认领同一科目 = 金额算两遍。
CREATE UNIQUE INDEX "accounting_subject_statement_rows_subject_id_statement_flow_key"
  ON "accounting_subject_statement_rows"("subject_id", "statement", "flow");
CREATE INDEX "accounting_subject_statement_rows_statement_flow_row_no_idx"
  ON "accounting_subject_statement_rows"("statement", "flow", "row_no");

-- ---------- 回填 ----------
-- 判据与全站一致：**唯一同名才认**。同名跨分类（科目表允许 @@unique([category,name]) 而非全局唯一）
-- 无法从名字判出是哪一个，必须留空 —— 宁可让这个科目暂时没有映射，也不能把它归到猜出来的那一行。
WITH generated ("statement", "flow", "category", "name", "row_no") AS (VALUES
${values}
),
resolved AS (
  SELECT g."statement", g."flow", g."row_no",
         max(s."id"::text)::uuid AS subject_id
  FROM generated g
  JOIN "accounting_subjects" s
    ON s."deleted_at" IS NULL
   AND s."category" = g."category"
   AND s."name" = g."name"
  GROUP BY g."statement", g."flow", g."row_no", g."category", g."name"
  HAVING count(*) = 1
)
INSERT INTO "accounting_subject_statement_rows" ("id", "subject_id", "statement", "flow", "row_no")
SELECT gen_random_uuid(), r.subject_id, r."statement", r."flow", r."row_no"
FROM resolved r
ON CONFLICT ("subject_id", "statement", "flow") DO UPDATE SET "row_no" = EXCLUDED."row_no";

-- ---------- 回滚 ----------
-- DROP TABLE "accounting_subject_statement_rows";`);
  process.exit(0);
}

console.log(`-- 由 scripts/generate-statement-row-mapping.mjs 生成，勿手工编辑。
-- ${claims.length} 条「科目 → 报表行」映射，来源是 finance-three-statements.ts 的 named()/prefixed() 规则。
-- 键用 (statement, flow, 分类, 名称) 而不是科目主键：生成时只知道常量清单，不知道运行时 id；
-- 落库那一步再按 (分类, 名称) 解析成 subject_id（唯一同名才认，与全站同一条判据）。
INSERT INTO "_statement_row_mapping" ("statement", "flow", "category", "name", "row_no") VALUES
${values}
ON CONFLICT ("statement", "flow", "category", "name") DO UPDATE SET "row_no" = EXCLUDED."row_no";`);
