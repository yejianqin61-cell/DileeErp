/**
 * 「会计科目 → 报表行」的映射（2026-11-11 R-2 / T8）。
 *
 * ## 为什么需要它
 *
 * 三大报表原本靠 `finance-three-statements.ts` 里 63 处 `named()` / `prefixed()` 按**科目名字**
 * 认领科目。名字是财务随时能改的显示文案，所以「改一个名字」=「某张报表的某一格静默变 0」，
 * 而报表依然平、勾稽依然 ✓（诊断 P0-1）。映射落成数据之后，改名不影响落行；
 * 财务新增一个科目也能明确指定它落哪一行，而不是指望它的名字恰好带某个前缀。
 *
 * ## 三个形状必须分清
 *
 * | 形状 | 键 | 谁产生 | 谁消费 |
 * | --- | --- | --- | --- |
 * | `StatementRowClaim` | 分类 + 名称 | 生成器按今天的规则算出来（`initialStatementRowClaims`） | 迁移 SQL |
 * | `StatementRowMapping` | 科目主键 | 迁移落库后的行（`accounting_subject_statement_rows`） | 报表取数 |
 * | `StatementRowIndex` | 科目主键（内存索引） | `buildStatementRowIndex` 由运行时的映射行建 | 口径内核 |
 *
 * 生成时只能拿到常量清单（不知道数据库里的 uuid），所以迁移那一步才按「唯一同名」把
 * (分类, 名称) 解析成 `subject_id`；解析不上的科目**留空**，由表尾的未归位出口点名。
 *
 * ## 为什么认领域是四个而不是三个
 *
 * 资产负债表是**两栏对照表**，行次在左右两侧各自从 1 开始 —— 资产侧行次 1 是「货币资金」，
 * 权益侧行次 1 是「短期借款」。混成一个 `balance-sheet` 值会让 `row_no` 有歧义，
 * 而这个歧义在报表上表现为「金额落到了另一侧」。
 *
 * ## 回退不是退路，是兼容层
 *
 * 映射只对**有映射的科目**说了算；没有映射（历史行、文本键、以及将来财务还没指定落行的科目）
 * 一律回退到名字匹配。两者并存是有意的：`named/prefixed` 的注释里写着「历史行没有主键时仍要靠文本」，
 * 把它们删掉会让回填没覆盖到的历史数据整笔丢钱。
 */

/** 认领域：一张报表的一种「行号空间」。 */
export const STATEMENT_SCOPES = [
  "balance-sheet-assets",
  "balance-sheet-equities",
  "income-statement",
  "cash-flow-statement",
] as const;

export type StatementScope = (typeof STATEMENT_SCOPES)[number];

/** 现金流量表专用方向；其余三张表一律空串（不是 null —— 唯一键要能包含它）。 */
export type StatementFlow = "" | "in" | "out";

/** 生成器算出来的一条「科目 → 行次」，键是**分类 + 名称**（生成时还没有 uuid）。 */
export type StatementRowClaim = {
  scope: StatementScope;
  flow: StatementFlow;
  category: string;
  name: string;
  row: number;
};

/** 落库后的一条映射，键是**科目主键**。 */
export type StatementRowMapping = {
  subjectId: string;
  scope: StatementScope;
  flow: StatementFlow;
  row: number;
};

/**
 * 报表取数用的内存索引：`认领域|方向` → 科目主键 → 行次。
 *
 * 为什么按「认领域 + 方向」分组：现金流量表里同一个科目会同时出现在流入与流出两组
 * （借了短期借款是「取得借款收到的现金」，还它是「偿还债务支付的现金」，科目都是「短期借款」）。
 * 不分方向就会把还款算成借款，金额方向全反。
 */
export type StatementRowIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** 索引键：认领域 + 方向。 */
export function statementRowSlotOf(scope: StatementScope, flow: StatementFlow = ""): string {
  return `${scope}|${flow}`;
}

/** 由运行时的映射行建索引（同一格出现两条是数据库唯一键就该拦住的事，这里后写覆盖前写）。 */
export function buildStatementRowIndex(mappings: readonly StatementRowMapping[]): StatementRowIndex {
  const index = new Map<string, Map<string, number>>();
  for (const mapping of mappings) {
    const slot = statementRowSlotOf(mapping.scope, mapping.flow);
    const bucket = index.get(slot) ?? new Map<string, number>();
    bucket.set(mapping.subjectId, mapping.row);
    index.set(slot, bucket);
  }
  return index;
}

/**
 * 查一个科目在某个认领域里被映射到哪一行；没有映射返回 `null`。
 *
 * `null` 与「行次 0」必须分得开：0 不是合法行次，但把 null 当 0 会让金额落进一个不存在的行。
 */
export function mappedRowOf(
  index: StatementRowIndex | undefined,
  scope: StatementScope,
  flow: StatementFlow,
  subjectId: string | null | undefined,
): number | null {
  if (!index || !subjectId) return null;
  return index.get(statementRowSlotOf(scope, flow))?.get(subjectId) ?? null;
}

/** 库里读出来的一行映射（`accounting_subject_statement_rows` 的原样形状）。 */
export type StatementRowRecord = {
  subjectId: string;
  statement: string;
  flow: string;
  rowNo: number;
};

/**
 * 把库里的裸行转成有类型的映射。
 *
 * 认领域/方向不认识就**抛错**，不静默跳过：那说明表里被写进了一行解释不了的数据，
 * 跳过它等于让这个科目退回按名字认领（改名即丢），而报表照样平 —— 没人能发现。
 * 一行数据坏掉就该立刻停下来修，而不是让报表继续出一张看着没问题的表。
 */
export function toStatementRowMappings(rows: readonly StatementRowRecord[]): StatementRowMapping[] {
  return rows.map((row) => {
    if (!STATEMENT_SCOPES.includes(row.statement as StatementScope)) {
      throw new Error(`报表行映射的认领域不认识：「${row.statement}」（科目 ${row.subjectId} 行次 ${row.rowNo}）`);
    }
    const flow = row.flow ?? "";
    if (flow !== "" && flow !== "in" && flow !== "out") {
      throw new Error(`报表行映射的方向不认识：「${row.flow}」（科目 ${row.subjectId} 行次 ${row.rowNo}）`);
    }
    return { subjectId: row.subjectId, scope: row.statement as StatementScope, flow: flow as StatementFlow, row: row.rowNo };
  });
}

/** 生成器看到的「一行报表」：只要它声明了认领规则与行次就够了（不依赖内核的类型）。 */
export type RowClaimCandidate = {
  row: number | null;
  flow?: "in" | "out";
  match?: (category: string, name: string) => boolean;
};

/** 生成器看到的「一个认领域」。 */
export type ScopeClaimSource = {
  scope: StatementScope;
  rows: readonly RowClaimCandidate[];
};

/** 一条科目都没被任何行认领 / 一个科目被两行同时认领时的报告（生成器与守卫测试共用）。 */
export type InitialClaimReport = {
  claims: StatementRowClaim[];
  /** 三张表里一条行都没命中的科目 —— 它的金额会凭空消失。 */
  uncovered: string[];
  /** 同一「认领域 + 方向」里被两行同时认领 —— 金额会被算两遍。 */
  doubles: string[];
};

/**
 * 按**今天的规则**（行定义里的 `match`）算出初始映射。
 *
 * 为什么由代码生成而不是手抄 234 行 SQL：初始映射必须与内核判定**逐条等价**，
 * 否则迁移那天三张报表的数字会动。让生成器去调同一批 `match` 函数，比人眼抄一遍可靠，
 * 改规则之后重跑一次也就自动跟上了（守卫测试会盯住「迁移文件与规则有没有漂移」）。
 *
 * 口径与内核自带的覆盖度检查一致：
 *   ① 每个科目至少被三张表中的某一行认领（否则金额消失）；
 *   ② 同一张表、同一方向里，一个科目不能被两行同时认领（否则算两遍）。
 * 单张表里没有归属是**正常的**（损益类本来就不进资产负债表），不记问题。
 */
export function initialStatementRowClaims(
  sources: readonly ScopeClaimSource[],
  seeds: readonly { category: string; name: string }[],
): InitialClaimReport {
  const claims: StatementRowClaim[] = [];
  const uncoveredSubjects = new Set(seeds.map((seed) => `${seed.category}/${seed.name}`));
  const doubles: string[] = [];

  for (const { scope, rows } of sources) {
    const groups = new Map<StatementFlow, RowClaimCandidate[]>();
    for (const row of rows) {
      if (!row.match || row.row === null) continue;
      const flow: StatementFlow = row.flow ?? "";
      groups.set(flow, [...(groups.get(flow) ?? []), row]);
    }
    for (const seed of seeds) {
      for (const [flow, candidates] of groups) {
        const hits = candidates.filter((row) => row.match?.(seed.category, seed.name));
        if (hits.length === 0) continue;
        if (hits.length > 1) {
          doubles.push(`${scope}/${flow || "-"} ${seed.category}/${seed.name} → 行次 ${hits.map((row) => row.row).join("、")}`);
          continue;
        }
        claims.push({ scope, flow, category: seed.category, name: seed.name, row: hits[0].row as number });
        uncoveredSubjects.delete(`${seed.category}/${seed.name}`);
      }
    }
  }

  return { claims, uncovered: [...uncoveredSubjects].sort(), doubles: doubles.sort() };
}

/** 映射覆盖度：谁没有映射、谁被映射了两次（同一格）。 */
export type MappingCoverage = {
  /** 一条映射都没有的科目 —— 它的金额只能靠名字匹配兜，改名就丢。 */
  unmapped: string[];
  /** 同一个科目在同一个「认领域 + 方向」里被映射到两行 —— 金额会被算两遍。 */
  doubleMapped: string[];
};

/**
 * 覆盖度检查（运行时守卫与守卫测试共用）。
 *
 * `subjects` 传**库里的全部科目**（不是 122 条常量）：财务在运行时新增的第 123 个科目
 * 才是这套机制真正要保护的对象，而常量守卫看不见它。
 */
export function checkMappingCoverage(
  subjects: readonly { id: string; category: string; name: string }[],
  mappings: readonly StatementRowMapping[],
): MappingCoverage {
  const slots = new Map<string, Set<number>>();
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const slot = `${statementRowSlotOf(mapping.scope, mapping.flow)}|${mapping.subjectId}`;
    slots.set(slot, (slots.get(slot) ?? new Set<number>()).add(mapping.row));
    seen.add(mapping.subjectId);
  }
  return {
    unmapped: subjects
      .filter((subject) => !seen.has(subject.id))
      .map((subject) => `${subject.category}/${subject.name}`)
      .sort(),
    doubleMapped: [...slots.entries()]
      .filter(([, rows]) => rows.size > 1)
      .map(([slot, rows]) => `${slot} → 行次 ${[...rows].join("、")}`)
      .sort(),
  };
}
