"use client";

// 建账期初余额（财务 2026-09-24：「1,3,4 都要」的第 ③ 件；挂在会计科目页）。
//
// 这一页回答一个问题：**报表的起点是多少？** 银行账户档案里只有货币资金的期初余额，其它科目没有 ——
// 只把货币资金期初加进资产侧，资产负债表的「资产总计 = 负债和所有者权益总计」就永远差一个期初余额
// （报表会在表尾说明这条差额，但那是说明不是解决）。财务在这里录一次全科目的期初（试算平衡的借/贷两侧），
// 报表的勾稽才真正为 0。
//
// 四条界面约定：
//   1. **整批保存**：这张表就是「我现在的期初」，保存时整批发出去（服务层整批替换）；
//      逐行增删会让「删掉一行」变成额外的删除动作，而财务的心智里没有这一步；
//   2. 金额只填正数，符号由「借/贷」决定（与凭证分录同一约定）；
//   3. 借贷不平**不拦**，但合计与差额实时显示 —— 报表会因为不平而不平，这是财务的决策依据；
//   4. 科目下拉带搜索（与全站会计科目下拉同一组件）：科目表一百二十多条，普通下拉只能靠滚。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../lib/api-client";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, type AccountingSubject } from "../../lib/accounting-subjects";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  OPENING_BALANCES_PATH,
  emptyOpeningRow,
  nextOpeningRowKey,
  openingBlockers,
  openingPayload,
  openingRowsFromApi,
  openingTotals,
  subjectKeyOf,
  type OpeningBalanceRow,
  type OpeningEditorRow,
} from "../../lib/opening-balance";

type OpeningResponse = {
  as_of_date: string | null;
  currency: string;
  rows: OpeningBalanceRow[];
  totals: { debit: string; credit: string; difference: string; balanced: boolean };
};

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export default function OpeningBalancePanel() {
  const [rows, setRows] = useState<OpeningEditorRow[]>([]);
  const [subjects, setSubjects] = useState<AccountingSubject[]>([]);
  const [asOfDate, setAsOfDate] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [opening, subjectResult] = await Promise.all([
        apiGet<OpeningResponse>(OPENING_BALANCES_PATH),
        // 科目下拉要停用的：历史期初可能挂在已停用科目上，显示不出来财务会以为账丢了。
        apiGet<AccountingSubject[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`),
      ]);
      setSubjects(subjectResult.data);
      setCurrency(opening.data.currency);
      // 还没录过：给一个空表 + 今天的建账日期（财务第一件事就是填日期再录）。
      setAsOfDate(opening.data.as_of_date ?? new Date().toISOString().slice(0, 10));
      setRows(opening.data.rows.length ? openingRowsFromApi(opening.data.rows) : [emptyOpeningRow(), emptyOpeningRow()]);
    } catch (cause) {
      setError(messageOf(cause, "期初余额加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const subjectOptions = useMemo(
    () => subjects.filter((subject) => subject.isActive !== false).map((subject) => ({ value: subjectKeyOf(subject), label: subjectOptionLabel(subject) })),
    [subjects],
  );
  const totals = useMemo(() => openingTotals(rows), [rows]);
  const patch = (index: number, next: Partial<OpeningEditorRow>) => setRows((current) => current.map((row, position) => position === index ? { ...row, ...next } : row));

  async function save() {
    const blockers = openingBlockers(rows, asOfDate);
    if (blockers.length) { setProblem(blockers.join("；")); return; }
    setSaving(true);
    setProblem("");
    try {
      await apiRequest(OPENING_BALANCES_PATH, { method: "PUT", body: JSON.stringify(openingPayload(asOfDate, currency, rows)) });
      notifySuccess(`建账期初余额已保存（${totals.balanced ? "借贷平衡" : `借贷不平，差额 ${totals.difference}`}）`);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "期初余额保存失败");
      setProblem(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel"><LoadingState label="正在加载建账期初余额" /></section>;

  return <section className="panel" data-testid="opening-balance-panel">
    <div className="panel-heading">
      <h2>建账期初余额</h2>
      <span className="panel-note">三大报表的起点：录完这里，资产负债表的「资产总计 = 负债和所有者权益总计」才会真正相等</span>
    </div>
    <div className="panel-body">
      {error && <p className="status-error" role="alert" data-testid="opening-balance-load-error">{error}</p>}
      <div className="filter-bar">
        <label>建账日期<Input data-testid="opening-balance-date" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} disabled={saving} /></label>
        <label>币种<Input data-testid="opening-balance-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} disabled={saving} /></label>
      </div>

      <div className="voucher-editor-row voucher-editor-row-head">
        <span>会计科目</span><span>方向</span><span>期初金额</span><span>备注</span><span />
      </div>
      {rows.map((row, index) => <div className="voucher-editor-row" key={row.key} data-testid={`opening-balance-row-${index}`}>
        <SearchableSelect
          testId={`opening-balance-subject-${index}`}
          value={row.subjectKey}
          options={subjectOptions}
          label={`第 ${index + 1} 行会计科目`}
          placeholder="搜索并选择科目"
          disabled={saving}
          onChange={(value) => {
            const subject = subjectOptions.find((option) => option.value === value);
            patch(index, { subjectKey: value, subjectLabel: subject ? subject.label : value });
          }}
        />
        <Select value={row.direction} onValueChange={(value) => patch(index, { direction: value === "credit" ? "credit" : "debit" })} disabled={saving}>
          <SelectTrigger data-testid={`opening-balance-direction-${index}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="debit">借</SelectItem>
            <SelectItem value="credit">贷</SelectItem>
          </SelectContent>
        </Select>
        <Input data-testid={`opening-balance-amount-${index}`} value={row.amount} onChange={(event) => patch(index, { amount: event.target.value })} disabled={saving} placeholder="0.00（只填正数）" inputMode="decimal" />
        <Input data-testid={`opening-balance-remark-${index}`} value={row.remark} onChange={(event) => patch(index, { remark: event.target.value })} disabled={saving} />
        <Button size="sm" variant="ghost" data-testid={`opening-balance-remove-${index}`} disabled={saving || rows.length <= 1} onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>删除</Button>
      </div>)}
      <div className="action-row">
        <Button size="sm" variant="secondary" data-testid="opening-balance-add" disabled={saving} onClick={() => setRows((current) => [...current, emptyOpeningRow(nextOpeningRowKey())])}>新增行</Button>
        <span className="panel-note" data-testid="opening-balance-totals">
          借方合计 {totals.debit}　贷方合计 {totals.credit}　差额 {totals.difference}{totals.balanced ? "（借贷平衡）" : ""}
        </span>
        <Button size="sm" data-testid="opening-balance-save" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存期初余额"}</Button>
      </div>
      {problem && <p className="status-error" role="alert" data-testid="opening-balance-error">{problem}</p>}
    </div>
  </section>;
}
