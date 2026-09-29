"use client";

// 返单与总结（2026-09-26）：按**货号**看历次批次与单据。
//
// 与工作台刻意不同（避免两个页面做同一件事）：
//   工作台 `/`      —— 轴是**订单号**，回答「这一单推进到哪一步、卡在哪」；
//   返单与总结 `/reorder` —— 轴是**货号**，回答「这个货做过几次、每次多少、QC 怎么样、要不要返单」，
//                        并且能逐张看到那一批的全部单据。
//
// 三个状态用 **URL 参数**表达（可分享、可回退）：`/reorder` → `?item_no=` → `&order_no=`。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { DocumentGroups, type DocumentGroup } from "../../components/reorder/document-groups";
import { UnassignedPanel } from "../../components/reorder/unassigned-panel";
import { ApiClientError, apiGet } from "../../lib/api-client";

type UnitQuantity = { unit: string; quantity: string };
type CurrencyAmount = { currency: string; amount: string };
type QcSummary = { inspected: string; qualified: string; conditional: string; rejected: string; qualified_rate: string | null };

type ArticleRow = {
  item_no: string;
  item_no_key: string;
  order_count: number;
  order_nos: string[];
  customer_names: string[];
  first_order_date: string | null;
  last_order_date: string | null;
  last_delivery_date: string | null;
  open_order_count: number;
  quantities: UnitQuantity[];
  purchase_amounts: CurrencyAmount[];
  receivable_amounts: CurrencyAmount[];
  qc: QcSummary;
};

type BatchRow = {
  sales_order_id: string;
  order_no: string;
  order_date: string;
  delivery_date: string | null;
  status: string;
  quantity: string;
  unit: string;
  customer: { id: string; name: string | null };
  current_version: number;
  bom_versions: number[];
  purchase_order_count: number;
  production_order_count: number;
  qc_qualified_quantity: string;
  qc_rejected_quantity: string;
  finished_inbound_quantity: string;
  outbound_quantity: string;
  reorder_from_order_no: string | null;
  can_reorder: boolean;
  can_reorder_reason: string | null;
  workbench_href: string;
};

type ArticleDetail = ArticleRow & { customers: Array<{ customer_id: string; name: string | null; order_count: number }>; orders: BatchRow[] };

/** 订单状态中文（本页只用得到这三个 —— 销售单就 draft/confirmed/closed 三态）。 */
const ORDER_STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认", closed: "已关闭" };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
/** 分行展示：数量按单位、金额按币种 —— **永不跨单位/跨币种相加**。 */
const unitText = (rows: UnitQuantity[]) => (rows.length ? rows.map((row) => `${row.quantity}${row.unit ? ` ${row.unit}` : ""}`).join("、") : "-");
const moneyText = (rows: CurrencyAmount[]) => (rows.length ? rows.map((row) => `${row.amount} ${row.currency}`).join("、") : "-");
/** 合格率 `null` → `-`：没有质检事实与「全部不合格」是两回事。 */
const rateText = (rate: string | null) => (rate === null ? "-" : `${(Number(rate) * 100).toFixed(2)}%`);

export default function ReorderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [itemNo, setItemNo] = useState(searchParams.get("item_no") ?? "");
  const [orderNo, setOrderNo] = useState(searchParams.get("order_no") ?? "");
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [groups, setGroups] = useState<DocumentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  /** 待补录面板是否展开（历史单补货号的入口；默认收起，平时不该占版面）。 */
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  /** 单据清单的错误**单独一份**：混进 detailError 会让它在详情成功时无处显示（第一版就是这样，测试抓出来了）。 */
  const [documentsError, setDocumentsError] = useState("");

  /** 搜索防抖：每敲一个字都发一次请求的话，每次请求都要跑一遍聚合。 */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void apiGet<ArticleRow[]>(`/reorder/articles?page_size=50${debouncedQuery.trim() ? `&q=${encodeURIComponent(debouncedQuery.trim())}` : ""}`)
      .then((result) => { if (!cancelled) { setArticles(Array.isArray(result.data) ? result.data : []); setTotal(Number(result.meta?.total ?? result.data?.length ?? 0)); } })
      .catch((cause) => { if (!cancelled) setError(messageOf(cause, "货号清单加载失败")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  useEffect(() => {
    if (!itemNo) { setDetail(null); setDetailError(""); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    void apiGet<ArticleDetail>(`/reorder/articles/${encodeURIComponent(itemNo)}`)
      .then((result) => { if (!cancelled) setDetail(result.data); })
      .catch((cause) => {
        if (cancelled) return;
        // 失败要清掉上一批的数据：留着旧的会让人以为"这个货号就是这些批次"。
        setDetail(null);
        setDetailError(messageOf(cause, "货号详情加载失败"));
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [itemNo]);

  useEffect(() => {
    if (!itemNo || !orderNo) { setGroups([]); return; }
    let cancelled = false;
    setDocumentsLoading(true);
    setDocumentsError("");
    // 换批次时先清空：上一批的单据留在屏幕上比"加载中"更危险。
    setGroups([]);
    void apiGet<{ groups: DocumentGroup[] }>(`/reorder/articles/${encodeURIComponent(itemNo)}/documents?order_no=${encodeURIComponent(orderNo)}`)
      .then((result) => { if (!cancelled) setGroups(Array.isArray(result.data?.groups) ? result.data.groups : []); })
      .catch((cause) => { if (!cancelled) { setGroups([]); setDocumentsError(messageOf(cause, "单据清单加载失败")); } })
      .finally(() => { if (!cancelled) setDocumentsLoading(false); });
    return () => { cancelled = true; };
  }, [itemNo, orderNo]);

  /** 选中货号：**清掉批次**（否则会停留在上一个货号的某一批上）。 */
  const selectArticle = useCallback((next: string) => {
    setItemNo(next);
    setOrderNo("");
    router.push(next ? `/reorder?item_no=${encodeURIComponent(next)}` : "/reorder");
  }, [router]);

  const selectOrder = useCallback((next: string) => {
    setOrderNo(next);
    router.push(`/reorder?item_no=${encodeURIComponent(itemNo)}&order_no=${encodeURIComponent(next)}`);
  }, [itemNo, router]);

  if (loading && !articles.length && !itemNo) return <div className="page-root" data-testid="page-reorder"><PageHeader title="返单与总结" breadcrumb={["返单与总结"]} /><LoadingState label="正在加载货号清单" /></div>;

  return (
    <div className="page-root" data-testid="page-reorder">
      <PageHeader title="返单与总结" description="按货号查看历次批次与那一批的采购、生产、质检全部单据">
        <Button variant="secondary" data-testid="reorder-toggle-unassigned" onClick={() => setShowUnassigned((current) => !current)}>{showUnassigned ? "收起未填货号" : "未填货号（补录）"}</Button>
        <Button variant="secondary" onClick={() => selectArticle(itemNo)}>刷新</Button>
      </PageHeader>
      {showUnassigned ? <UnassignedPanel /> : null}
      {error ? <section className="panel"><ErrorState message={error} onRetry={() => setDebouncedQuery(query)} /></section> : null}

      <section className="panel">
        <div className="panel-heading">
          <h2>货号</h2>
          <span className="panel-note" data-testid="reorder-count">共 {total} 个货号，当前列出 {articles.length} 条</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索货号
              <Input data-testid="reorder-q" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="货号（大小写与空格不影响匹配）" />
            </label>
          </div>
          {loading ? <LoadingState label="正在加载货号清单" /> : articles.length === 0 ? (
            <EmptyState title="暂无可查的货号" description="销售单填了货号之后，这里会出现按货号归并的历次批次。" />
          ) : (
            <div className="table-wrap">
              <table className="ui-table" data-testid="reorder-article-table">
                <thead>
                  <tr>
                    <th className="ui-table-head">货号</th>
                    <th className="ui-table-head">订单数</th>
                    <th className="ui-table-head">累计数量</th>
                    <th className="ui-table-head">最近下单</th>
                    <th className="ui-table-head">最近交期</th>
                    <th className="ui-table-head">客户</th>
                    <th className="ui-table-head">QC 合格率</th>
                  </tr>
                </thead>
                <tbody>
                  {articles.map((article) => (
                    <tr key={article.item_no_key}>
                      <td>
                        <Button variant="link" data-testid={`reorder-article-${article.item_no_key}`} onClick={() => selectArticle(article.item_no)}>{article.item_no}</Button>
                      </td>
                      <td>{article.order_count}{article.open_order_count ? `（在制 ${article.open_order_count}）` : ""}</td>
                      <td>{unitText(article.quantities)}</td>
                      <td>{article.last_order_date ? article.last_order_date.slice(0, 10) : "-"}</td>
                      <td>{article.last_delivery_date ? article.last_delivery_date.slice(0, 10) : "-"}</td>
                      <td>{article.customer_names.join("、") || "-"}</td>
                      <td>{rateText(article.qc.qualified_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {itemNo ? (
        <section className="panel" data-testid="reorder-detail">
          <div className="panel-heading">
            <h2>货号 {detail?.item_no ?? itemNo}</h2>
            <Button variant="ghost" onClick={() => selectArticle("")}>返回货号列表</Button>
          </div>
          <div className="panel-body">
            {detailLoading ? <LoadingState label="正在加载货号详情" /> : detailError && !detail ? <ErrorState message={detailError} onRetry={() => selectArticle(itemNo)} /> : detail ? (
              <>
                <div className="detail-list" data-testid="reorder-summary">
                  <p>批次：{detail.order_count}（在制 {detail.open_order_count}）</p>
                  <p>累计数量：{unitText(detail.quantities)}</p>
                  <p>采购金额：{moneyText(detail.purchase_amounts)}</p>
                  <p>应收金额：{moneyText(detail.receivable_amounts)}</p>
                  <p>QC：受检 {detail.qc.inspected} / 合格 {detail.qc.qualified} / 不合格 {detail.qc.rejected}（合格率 {rateText(detail.qc.qualified_rate)}）</p>
                  <p>客户：{detail.customers.map((customer) => `${customer.name ?? "-"}×${customer.order_count}`).join("、") || "-"}</p>
                </div>

                <h3>历次批次</h3>
                <div className="table-wrap">
                  <table className="ui-table" data-testid="reorder-batch-table">
                    <thead>
                      <tr>
                        <th className="ui-table-head">订单号</th>
                        <th className="ui-table-head">下单日</th>
                        <th className="ui-table-head">交期</th>
                        <th className="ui-table-head">数量</th>
                        <th className="ui-table-head">状态</th>
                        <th className="ui-table-head">QC 合格 / 不合格</th>
                        <th className="ui-table-head">已出库</th>
                        <th className="ui-table-head">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.orders.map((batch) => (
                        <tr key={batch.sales_order_id}>
                          <td>{batch.order_no}{batch.reorder_from_order_no ? <small className="panel-note">（由 {batch.reorder_from_order_no} 返单）</small> : null}</td>
                          <td>{batch.order_date.slice(0, 10)}</td>
                          <td>{batch.delivery_date ? batch.delivery_date.slice(0, 10) : "-"}</td>
                          <td>{batch.quantity} {batch.unit}</td>
                          <td>{ORDER_STATUS_LABELS[batch.status] ?? batch.status}</td>
                          <td>{batch.qc_qualified_quantity} / {batch.qc_rejected_quantity}</td>
                          <td>{batch.outbound_quantity}</td>
                          <td>
                            <div className="action-row">
                              <Button size="sm" variant="secondary" data-testid={`reorder-documents-${batch.order_no}`} onClick={() => selectOrder(batch.order_no)}>查看单据</Button>
                              {/* 「能不能返单」由**服务端**判定：前端自己拼条件会出现「按钮亮着、点了 422」。 */}
                              <Button
                                size="sm"
                                data-testid={`reorder-repeat-${batch.order_no}`}
                                disabled={!batch.can_reorder}
                                title={batch.can_reorder_reason ?? "以这一批的工艺口径新建一张销售单"}
                                onClick={() => router.push(`/sales/orders/new?reorder_from_order_no=${encodeURIComponent(batch.order_no)}`)}
                              >
                                以此返单
                              </Button>
                              <Button size="sm" variant="ghost" asChild><Link href={batch.workbench_href}>看全链路</Link></Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {detail.orders.some((batch) => !batch.can_reorder) ? (
                  <p className="panel-note" data-testid="reorder-repeat-hint">草稿单或没有货号的批次不能作为返单来源（按钮上写着原因）。</p>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {itemNo && orderNo ? (
        <section className="panel" data-testid="reorder-documents">
          <div className="panel-heading">
            <h2>{orderNo} 的全部单据</h2>
            <span className="panel-note">按模块分组；空组说明当时没有这一环</span>
          </div>
          <div className="panel-body">
            {documentsLoading ? <LoadingState label="正在加载单据清单" /> : documentsError ? <ErrorState message={documentsError} onRetry={() => selectOrder(orderNo)} /> : <DocumentGroups groups={groups} orderNo={orderNo} />}
          </div>
        </section>
      ) : null}
      <p className="panel-note" data-testid="reorder-last-refresh">数据为只读汇总；要看推进状态与阻塞请到工作台。</p>
    </div>
  );
}
