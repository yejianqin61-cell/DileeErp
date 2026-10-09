// 采购计划的「填单价」口径（2026-10-09）。
//
// 用户原话：「我还是希望在采购计划中前端也能允许填写价格。也可以选择导入BOM的对应的物料的价格。」
// 追问他"导入范围怎么定"，他选的是：**只填还没填（0 价）的未下单行**。
//
// 为什么把这几件小事从组件里挪出来做纯函数：它们决定"哪些格子会被写成什么价"。
// 页面组件里量不到"哪一行**没**被碰"（表有十几列、行还多，一眼看不出漏了谁），
// 而"没被碰"恰恰是这次的验收点本身 —— 覆盖掉采购员手打过、或已经发给供应商的价，是这一轮最怕的错。
// 所以逐条写成用例（lib/purchase-plan-price-entry.test.mjs）。
//
// 与 `plan-detail-sheet.tsx` 里"打开计划时自动预填 BOM 参考单价"（2026-10-08 第二轮）是同一套判断
// （未下单 + 单价 0 + BOM 上参考价 > 0），差别只在触发方式（自动 vs 手动点按钮）——
// 两条路必须给出同一个结果，所以共用同一份预填规则。
//
// 刻意**不 import** `purchase-plan-amount.ts` 的 `DEFAULT_PLAN_CURRENCY`：这个模块被
// `lib/*.test.mjs` 用 `node --test` 直接 import，而 Node 的 ESM 解析不认无扩展名的相对路径
// （Next/webpack 认）。币种缺省留给调用方（那一边本来就已经有这个常量）——
// 本模块只回答"哪一格写什么价"，不回答"没写币种时算什么"。

/**
 * `"10.0000"` → `"10"`、`"12.5000"` → `"12.5"`（界面上那一格给人看/给人改的形式）。
 *
 * ⚠️ 只在**小数点之后**剥零。原来那一版是本文件之外的 `String(value).replace(/0+$/, "")`，
 * 那个写法把 `"10"`（没有小数点）剥成 `"1"` —— 接口一律给 4 位小数，所以一直没暴露，
 * 但它是个"看着一样、错得很安静"的写法。非「整数.小数」形状（空串、用户刚敲的 `-`）原样返回。
 */
export function trimPlanNumber(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^-?\d+\.\d+$/.test(text)) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/** 填单价时要看的这一行的形状（组件里的 `PlanDraftRow` 满足它）。 */
export type PriceRowRef = {
  unitPrice: string;
  ordered?: boolean;
  /** BOM 表上这个物料的参考单价（`null` = BOM 上也没填）。 */
  bomReferenceUnitPrice?: string | null;
  bomReferenceUnitCurrency?: string | null;
};

/** 还没填单价（0 或空）的行号（从 0 数），给「还有 N 行待填」与下单确认用。 */
export function pendingPriceIndexes(rows: readonly PriceRowRef[]): number[] {
  return rows.flatMap((row, index) => (Number(row.unitPrice) > 0 ? [] : [index]));
}

/** 刚取回来的详情行（只关心参考单价这两个字段）。 */
export type BomReferenceItem = { id: string; bomReferenceUnitPrice?: string | null; bomReferenceUnitCurrency?: string | null };

/**
 * 把**刚取回来**的 BOM 参考价并到草稿行上（按行的 `id` 对）。
 *
 * 为什么"导入"按钮要先重新取一次详情：参考价可能是这份计划打开之后才填进 BOM 的
 * （采购员去 BOM 表补了价再回来点按钮）—— 只拿内存里那份数据，这个按钮等于什么都没做。
 * 合并时**只并参考单价两个字段**：数量、单价、供应商、预计到货一律不动
 * （那些是用户在这一屏里改过的东西；这个按钮是"导入参考价"，不是"重新加载"）。
 */
export function mergeBomReferences<Row extends { id?: string | null }>(
  rows: readonly Row[],
  fresh: readonly BomReferenceItem[],
): Array<Row & { bomReferenceUnitPrice: string | null; bomReferenceUnitCurrency: string | null }> {
  const byId = new Map(fresh.map((item) => [item.id, item]));
  return rows.map((row) => {
    const item = row.id ? byId.get(row.id) : undefined;
    return {
      ...row,
      bomReferenceUnitPrice: item?.bomReferenceUnitPrice ?? null,
      bomReferenceUnitCurrency: item?.bomReferenceUnitCurrency ?? null,
    };
  });
}

export type PriceImportPatch = {
  index: number;
  unitPrice: string;
  /**
   * BOM 上那笔参考价的币种；BOM 上没写币种时给 `null` = "这一行原来是什么币种就是什么"
   * （缺省由调用方补，见文件头「刻意不 import」那条注释）。
   */
  currency?: string | null;
};

export type PriceImportOutcome = {
  /** 真正要写进界面的格子（**只有这些**会被改）。 */
  patches: PriceImportPatch[];
  /** 填上的行数（= patches.length，单独放一个字段是为了文案读起来直观）。 */
  filled: number;
  /** BOM 上也没有参考价、只能手填的行数。 */
  noReference: number;
  /** 已经填过价（不动）的行数。 */
  hasPrice: number;
  /** 已下单（不动）的行数。 */
  ordered: number;
};

/**
 * 按 BOM 参考单价导入：**只填还没填（0 价）的未下单行**。
 *
 * 三条边界都要留着，缺一条就会吃掉别人的输入或改到已经发出去的单：
 *   ① 手填过的价（> 0）不覆盖 —— 那才是"跟供应商谈定了什么"；
 *   ② 已下单的行不导入 —— 它那一格已经是采购单上的价（要改得先退回计划，或走「补价」那条路）；
 *   ③ BOM 上没有参考价的行保持空白，并在结果里报出来 —— 否则用户以为"导过了"。
 */
export function importBomPrices(rows: readonly PriceRowRef[]): PriceImportOutcome {
  const outcome: PriceImportOutcome = { patches: [], filled: 0, noReference: 0, hasPrice: 0, ordered: 0 };
  rows.forEach((row, index) => {
    if (row.ordered) { outcome.ordered += 1; return; }
    if (Number(row.unitPrice) > 0) { outcome.hasPrice += 1; return; }
    const reference = Number(row.bomReferenceUnitPrice ?? "");
    if (!(reference > 0)) { outcome.noReference += 1; return; }
    outcome.patches.push({ index, unitPrice: trimPlanNumber(row.bomReferenceUnitPrice), currency: row.bomReferenceUnitCurrency ?? null });
    outcome.filled += 1;
  });
  return outcome;
}

/**
 * 导入之后那一句结果：**"没填上的"也要说**（否则用户以为都导过了，回头在"为什么不能下单"上耗时间）。
 * 一行都没动时给一句明确的话，而不是空字符串。
 */
export function priceImportSummary(outcome: PriceImportOutcome): string {
  if (outcome.filled === 0 && outcome.noReference === 0) return "没有需要导入的行：这些行的单价都已经填好了";
  const parts = [`已按 BOM 参考单价填了 ${outcome.filled} 行`];
  if (outcome.noReference > 0) parts.push(`${outcome.noReference} 行 BOM 上也没有参考价（请手填）`);
  if (outcome.hasPrice > 0) parts.push(`${outcome.hasPrice} 行已经填过价（不动）`);
  if (outcome.ordered > 0) parts.push(`${outcome.ordered} 行已下单（不动）`);
  return parts.join("；");
}
