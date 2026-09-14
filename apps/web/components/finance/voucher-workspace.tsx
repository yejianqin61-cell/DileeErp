"use client";

// 凭证管理（占位）。
//
// 产品口径：「针对应收、应付所有已经确认的条目生成单据」——本期只做入口与预览，
// 不生成任何单据、不写任何数据（docs/design/finance-module-improvement-spec-2026-09-02.md
// 明确把会计总账/凭证/科目列为 V1 不做）。
// 预览数据直接取两边的已确认列表口径，不新增后端接口，避免占位页提前固化凭证模型。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../layout/app-shell";
import { Button } from "../ui/button";
import { ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet } from "../../lib/api-client";
import { notifyError } from "../ui/toaster";

type ReceivableLite = { id: string; sourceNo: string; status: string; amount: string; currency: string };
type PayableLite = { id: string; payableNo: string; status: string; amount: string; currency: string };

/** 已确认（含部分收付与已收付清）：这些才是将来要生成凭证的条目。 */
const CONFIRMED_STATUSES = ["confirmed", "partially_paid", "paid"];
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function VoucherWorkspace({ testId = "page-finance-voucher" }: { testId?: string }) {
  const [receivables, setReceivables] = useState<ReceivableLite[]>([]);
  const [payables, setPayables] = useState<PayableLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [r, p] = await Promise.all([
        apiGet<ReceivableLite[]>("/finance/receivable-sources"),
        apiGet<PayableLite[]>("/finance/payable-entries"),
      ]);
      setReceivables(r.data.filter((item) => CONFIRMED_STATUSES.includes(item.status)));
      setPayables(p.data.filter((item) => CONFIRMED_STATUSES.includes(item.status)));
    } catch (cause) {
      setError(messageOf(cause, "凭证预览数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sum = (rows: Array<{ amount: string }>) => rows.reduce((total, row) => total + Number(row.amount ?? 0), 0).toFixed(2);

  if (loading) return <><PageHeader title="凭证管理" /><LoadingState /></>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="凭证管理" description="针对已确认的应收、应付条目生成单据。本期为占位，不生成任何单据。">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel panel-body">
        <p className="panel-note" role="status">建设中：凭证单据编号规则、会计科目与期间结账尚未定义，因此这里只做预览，不提供任何写操作。</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>待生成凭证的已确认应收</h2><span className="panel-note">共 {receivables.length} 条 / 合计 {sum(receivables)}</span></div>
        <div className="panel-body"><p className="panel-note" data-testid="voucher-receivable-preview">{receivables.length === 0 ? "暂无已确认应收" : `已确认应收 ${receivables.length} 条，合计 ${sum(receivables)}`}</p></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>待生成凭证的已确认应付</h2><span className="panel-note">共 {payables.length} 条 / 合计 {sum(payables)}</span></div>
        <div className="panel-body"><p className="panel-note" data-testid="voucher-payable-preview">{payables.length === 0 ? "暂无已确认应付" : `已确认应付 ${payables.length} 条，合计 ${sum(payables)}`}</p></div>
      </section>
      <section className="panel panel-body">
        <div className="page-actions">
          <Button disabled onClick={() => notifyError("凭证管理建设中，暂不支持生成单据")}>生成单据（建设中）</Button>
        </div>
      </section>
    </>}
  </div>;
}
