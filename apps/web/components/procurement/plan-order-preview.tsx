"use client";

// 采购计划的「按供应商收束」预览（2026-09-27，口径 6 / 10）。
//
// 用户原话：「然后根据供应商收束下单，下单到采购单模块。」
//
// 与采购单草稿工作区原来那一块（`draft-split-preview`）的差别只有一个：**币种移到组上**。
// 计划里同时有多个供应商的行，而一张采购单只能有一个币种（金额不跨币种合计），
// 所以币种不是计划的属性、而是"这一组（=这一张采购单）"的属性 —— 每组各选一个。
//
// 「未选择供应商」单独一组并标红：它**不能**下单（后端 `collectGroups` 也会拒），
// 但必须看得见 —— 否则用户不知道自己漏了哪几行。
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { currencyOptionsWithCurrent, type CurrencyOption } from "../../lib/currency-catalogue";
import { lineAmountText } from "../../lib/purchase-plan-amount";

export type PlanDraftRow = {
  /** 既有行的 id。空 = 还没保存过的新行（这种行不能直接下单，要先保存）。 */
  id?: string;
  materialId: string;
  materialName: string;
  /** 物料编码。**只用来给"已不在物料池"的那一项拼标签**（见 `plan-detail-sheet.tsx`），不参与提交。 */
  materialCode?: string;
  model: string;
  quantity: string;
  unitId: string;
  unitName: string;
  unitPrice: string;
  /** 这一行单价的币种（默认人民币，下单时按供应商组写回）。组的金额合计要带上它才有意义。 */
  currency: string;
  supplierId: string;
  /** 已下单的行为 true：内容只读、不能删、不参与本次下单。 */
  ordered: boolean;
  /** 已下单行落在哪张采购单上（口径 6：下过的行留在计划里）。 */
  purchaseOrderNo?: string | null;
  bomItemId?: string | null;
  expectedDate: string;
  currentStock?: string;
  supplierAddress?: string | null;
  supplierContact?: string | null;
  extensionData?: Record<string, unknown> | null;
  /**
   * BOM 表上这一行物料的**参考单价**（`GET /purchase-plans/:id` 随行下发；服务端按**物料**匹配 ——
   * BOM 存一次行 ID 全换，不能按行 ID）。
   *
   * 用途只有一个：**单价还是 0 的未下单行，让计划也能拿到 BOM 上那个价**（见 `plan-detail-sheet.tsx`
   * 的 `load()` 与面板说明）。它是"这个部件通常多少钱"的参考，**不是供应商报价**；
   * 计划行的单价仍是唯一真源（下单时写进采购明细，应付 = 入库量 × 采购明细单价）。
   */
  bomReferenceUnitPrice?: string | null;
  bomReferenceCurrency?: string | null;
  /** 当前这一格的价是**从 BOM 参考单价预填来的**（用户一改就清掉，用来标出来源）。 */
  priceFromBom?: boolean;
};

export type PlanGroup = { supplierId: string; supplierName: string; rows: PlanDraftRow[] };

/** 按供应商分组（同一家合成一张单）。组内金额用 `groupAmountText()` 现算 —— 不落一个 `amount` 字段。 */
export function groupPlanRows(rows: PlanDraftRow[], supplierNameOf: (id: string) => string): PlanGroup[] {
  const map = new Map<string, PlanGroup>();
  for (const row of rows) {
    const key = row.supplierId || "";
    const group = map.get(key) ?? { supplierId: key, supplierName: key ? supplierNameOf(key) : "未选择供应商", rows: [] };
    group.rows.push(row);
    map.set(key, group);
  }
  return [...map.values()];
}

/**
 * 这一组的金额合计（2 位小数）。
 *
 * 逐行用 `lineAmountText` 只是为了让**这一组**的数与表里「行总价」那一列**逐行相加看起来一致**
 * ——精度本身是 0.01 级的显示，不是账。真正的合计（4 位、按币种分列）在服务端与明细表下方那一行。
 */
export function groupAmountText(group: PlanGroup): string {
  const total = group.rows.reduce((sum, row) => sum + Number(lineAmountText(row.quantity, row.unitPrice)), 0);
  return total.toFixed(2);
}

export function PlanOrderPreview({ groups, currencies, currencyOf, onCurrencyChange, onOrder, busy, heldBackRowNos = [], selectedRowCount = 0 }: {
  /** **只含有单价的行**：0 价的行不下单（2026-10-11 用户口径），由调用方先过滤掉（见 `plan-detail-sheet.tsx`）。 */
  groups: PlanGroup[];
  currencies: CurrencyOption[];
  currencyOf: (supplierId: string) => string;
  onCurrencyChange: (supplierId: string, currency: string) => void;
  onOrder: () => void;
  busy: boolean;
  /** 勾了但**没单价**、因此本次不下单的行号（从 1 数）：要在这里看得见，否则采购不知道自己漏了什么。 */
  heldBackRowNos?: number[];
  /** 勾选的行数（含 0 价那些）：只用来判断"按钮该不该可点"，见下面的注释。 */
  selectedRowCount?: number;
}) {
  const assigned = groups.filter((group) => group.supplierId);
  const unassigned = groups.find((group) => !group.supplierId);
  /**
   * 按钮什么时候灰掉，三种情况要分清楚：
   *   1. 一行都没勾 → 灰（没什么可下的）；
   *   2. 勾了但**都没价** → **不灰**：要让人点下去、然后收到「这几行还没填单价」。
   *      灰着而页面上没有任何解释，采购员只会以为系统坏了（2026-10-09「我真没看到哪里可以手填单价的」同类坑）；
   *   3. 勾了、有价、但**有价的行还没选供应商** → 灰（一个供应商一张单，收了也没落脚处，预览里已经标红说明）。
   */
  const disabled = busy || selectedRowCount === 0 || (!groups.length && !heldBackRowNos.length) || Boolean(unassigned);
  return (
    <div className="panel panel-body" data-testid="plan-split-preview">
      <p className="panel-note">
        {assigned.length ? `按供应商收束（同供应商合并成一张采购单，共 ${assigned.length} 张）：` : "按供应商收束：勾选的行里还没有任何一行选了供应商。"}
      </p>
      {heldBackRowNos.length ? (
        <p className="panel-note status-warning" data-testid="plan-held-back-note">
          第 {heldBackRowNos.join("、")} 行还没填单价，**本次不会下单**（留在计划里，补价后再下一波）。
        </p>
      ) : null}
      <ul className="draft-split-list">
        {assigned.map((group) => (
          <li key={group.supplierId} data-testid={`plan-group-${group.supplierId}`}>
            {/* 金额带上**这一组的币种**（就在右边选）：一个没有币种的数看起来是对的，而它可能是错的。 */}
            <span>{group.supplierName} · {group.rows.length} 行 · 金额合计 {groupAmountText(group)} {currencyOf(group.supplierId)}</span>
            {/* 币种是"一张采购单"的属性，而一张采购单=一个供应商 —— 所以在这里选，不在计划头上选。 */}
            <Select value={currencyOf(group.supplierId)} onValueChange={(value) => onCurrencyChange(group.supplierId, value)}>
              <SelectTrigger className="plan-group-currency" aria-label={`${group.supplierName}的币种`}><SelectValue /></SelectTrigger>
              <SelectContent>{currencyOptionsWithCurrent(currencies, currencyOf(group.supplierId)).map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </li>
        ))}
      </ul>
      {unassigned ? (
        <p className="panel-note status-danger" data-testid="plan-unassigned-note">
          有 {unassigned.rows.length} 行还没选供应商，**不能下单**：一个供应商一张单，没收束的行没有落脚处。请先在上面把供应商补齐。
        </p>
      ) : null}
      <div className="page-actions">
        <Button size="sm" data-testid="plan-order" disabled={disabled} onClick={onOrder}>
          收束下单{assigned.length > 1 ? `（${assigned.length} 张）` : ""}
        </Button>
      </div>
    </div>
  );
}
