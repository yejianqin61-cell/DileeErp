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

export type PlanDraftRow = {
  /** 既有行的 id。空 = 还没保存过的新行（这种行不能直接下单，要先保存）。 */
  id?: string;
  materialId: string;
  materialName: string;
  model: string;
  quantity: string;
  unitId: string;
  unitName: string;
  unitPrice: string;
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
};

export type PlanGroup = { supplierId: string; supplierName: string; rows: PlanDraftRow[]; amount: number };

/** 按供应商分组（同一家合成一张单）。金额只在本组内累加 —— 不跨币种、也不跨供应商。 */
export function groupPlanRows(rows: PlanDraftRow[], supplierNameOf: (id: string) => string): PlanGroup[] {
  const map = new Map<string, PlanGroup>();
  for (const row of rows) {
    const key = row.supplierId || "";
    const group = map.get(key) ?? { supplierId: key, supplierName: key ? supplierNameOf(key) : "未选择供应商", rows: [], amount: 0 };
    group.rows.push(row);
    group.amount += Number(row.quantity || 0) * Number(row.unitPrice || 0);
    map.set(key, group);
  }
  return [...map.values()];
}

export function PlanOrderPreview({ groups, currencies, currencyOf, onCurrencyChange, onOrder, busy }: {
  groups: PlanGroup[];
  currencies: CurrencyOption[];
  currencyOf: (supplierId: string) => string;
  onCurrencyChange: (supplierId: string, currency: string) => void;
  onOrder: () => void;
  busy: boolean;
}) {
  const assigned = groups.filter((group) => group.supplierId);
  const unassigned = groups.find((group) => !group.supplierId);
  return (
    <div className="panel panel-body" data-testid="plan-split-preview">
      <p className="panel-note">
        {assigned.length ? `按供应商收束（同供应商合并成一张采购单，共 ${assigned.length} 张）：` : "按供应商收束：勾选的行里还没有任何一行选了供应商。"}
      </p>
      <ul className="draft-split-list">
        {assigned.map((group) => (
          <li key={group.supplierId} data-testid={`plan-group-${group.supplierId}`}>
            <span>{group.supplierName} · {group.rows.length} 行 · 金额合计 {group.amount.toFixed(2)}</span>
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
        <Button size="sm" data-testid="plan-order" disabled={busy || !assigned.length || Boolean(unassigned)} onClick={onOrder}>
          收束下单{assigned.length > 1 ? `（${assigned.length} 张）` : ""}
        </Button>
      </div>
    </div>
  );
}
