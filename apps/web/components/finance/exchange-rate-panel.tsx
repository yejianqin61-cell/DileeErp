"use client";

// 期末汇率（财务 2026-09-24：「1,3,4 都要」的第 ④ 件；挂在会计科目页，紧随建账期初余额）。
//
// 这一页回答一个问题：**外币的钱折成人民币是多少？** 凭证上有币种却没有汇率，而三大报表是人民币报表 ——
// 没有这张表，报表只能「按币种分列 + 表尾写不跨币种相加」，财务拿到的不是一张能对外报的表。
//
// 四条界面约定：
//   1. **按期间 YYYY-MM 整批保存**：这张表就是「这个月的汇率」，保存时整批发出去（服务层整批替换）；
//   2. 本币 CNY 不录（对自身恒为 1），界面直接挡住并说明原因；
//   3. 汇率最多 8 位小数（比金额多：汇率是乘数，精度不够的偏差会被报表当成「汇率变动」）；
//   4. 明确告诉财务**回退**规则：本期没维护时报表用「不晚于它的最近一个月」折算并在表尾写明。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  EXCHANGE_RATES_PATH,
  emptyRateRow,
  nextRateRowKey,
  rateBlockers,
  rateFallbackNote,
  ratePayload,
  rateRowsFromApi,
  rateSummary,
  RATE_CURRENCY_SUGGESTIONS,
  type ExchangeEditorRow,
  type ExchangeRateRow,
} from "../../lib/exchange-rate";

type RatesResponse = { period: string; rows: ExchangeRateRow[]; periods: string[] };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export default function ExchangeRatePanel() {
  const [rows, setRows] = useState<ExchangeEditorRow[]>([]);
  const [period, setPeriod] = useState("");
  const [maintained, setMaintained] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [problem, setProblem] = useState("");

  const load = useCallback(async (wanted?: string) => {
    setLoading(true);
    setError("");
    try {
      const query = wanted ? `?period=${encodeURIComponent(wanted)}` : "";
      const result = await apiGet<RatesResponse>(`${EXCHANGE_RATES_PATH}${query}`);
      setPeriod(result.data.period);
      setMaintained(result.data.periods ?? []);
      setRows(result.data.rows?.length ? rateRowsFromApi(result.data.rows) : [emptyRateRow(), emptyRateRow()]);
    } catch (cause) {
      setError(messageOf(cause, "期末汇率加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => rateSummary(rows), [rows]);
  const note = useMemo(() => rateFallbackNote(period, maintained), [period, maintained]);
  const patch = (index: number, next: Partial<ExchangeEditorRow>) => setRows((current) => current.map((row, position) => position === index ? { ...row, ...next } : row));

  async function save() {
    const blockers = rateBlockers(rows, period);
    if (blockers.length) { setProblem(blockers.join("；")); return; }
    setSaving(true);
    setProblem("");
    try {
      await apiRequest(EXCHANGE_RATES_PATH, { method: "PUT", body: JSON.stringify(ratePayload(period, rows)) });
      notifySuccess(`${period} 的期末汇率已保存（${summary.count} 个币种）`);
      await load(period);
    } catch (cause) {
      const message = messageOf(cause, "期末汇率保存失败");
      setProblem(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel"><LoadingState label="正在加载期末汇率" /></section>;

  return <section className="panel" data-testid="exchange-rate-panel">
    <div className="panel-heading">
      <h2>期末汇率</h2>
      <span className="panel-note">1 外币 = ? 人民币（按月维护）。三大报表按它把外币凭证折成人民币，折算差额进现金流量表行次 32</span>
    </div>
    <div className="panel-body">
      {error && <p className="status-error" role="alert" data-testid="exchange-rate-load-error">{error}</p>}
      <div className="filter-bar">
        <label>汇率期间<Input data-testid="exchange-rate-period" type="month" value={period} onChange={(event) => void load(event.target.value)} disabled={saving} /></label>
        {maintained.length > 0 && <span className="panel-note" data-testid="exchange-rate-periods">已维护：{maintained.join("、")}</span>}
      </div>
      {note && <p className="panel-note" data-testid="exchange-rate-note">{note}</p>}

      <div className="voucher-editor-row voucher-editor-row-head">
        <span>币种</span><span>1 外币 = ? 人民币</span><span>备注</span><span />
      </div>
      {rows.map((row, index) => <div className="voucher-editor-row" key={row.key} data-testid={`exchange-rate-row-${index}`}>
        <Input
          data-testid={`exchange-rate-currency-${index}`}
          value={row.currency}
          list="exchange-rate-currency-options"
          placeholder={RATE_CURRENCY_SUGGESTIONS.slice(0, 3).join(" / ")}
          disabled={saving}
          onChange={(event) => patch(index, { currency: event.target.value.toUpperCase() })}
        />
        <Input data-testid={`exchange-rate-rate-${index}`} value={row.rate} onChange={(event) => patch(index, { rate: event.target.value })} disabled={saving} placeholder="7.1234（只填正数，最多 8 位小数）" inputMode="decimal" />
        <Input data-testid={`exchange-rate-remark-${index}`} value={row.remark} onChange={(event) => patch(index, { remark: event.target.value })} disabled={saving} />
        <Button size="sm" variant="ghost" data-testid={`exchange-rate-remove-${index}`} disabled={saving || rows.length <= 1} onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>删除</Button>
      </div>)}
      <datalist id="exchange-rate-currency-options">
        {RATE_CURRENCY_SUGGESTIONS.map((code) => <option key={code} value={code} />)}
      </datalist>
      <div className="action-row">
        <Button size="sm" variant="secondary" data-testid="exchange-rate-add" disabled={saving} onClick={() => setRows((current) => [...current, emptyRateRow(nextRateRowKey())])}>新增行</Button>
        <span className="panel-note" data-testid="exchange-rate-summary">
          本期 {summary.count} 个币种{summary.invalid ? `，另有 ${summary.invalid} 行汇率写错了` : ""}
        </span>
        <Button size="sm" data-testid="exchange-rate-save" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存期末汇率"}</Button>
      </div>
      {problem && <p className="status-error" role="alert" data-testid="exchange-rate-error">{problem}</p>}
    </div>
  </section>;
}
