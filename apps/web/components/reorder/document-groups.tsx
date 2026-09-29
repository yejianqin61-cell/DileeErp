"use client";

import Link from "next/link";
import { cn } from "../../lib/utils";

/**
 * 单据分组的跳转映射（T11）。
 *
 * **跳转是展示层的事**：API 只给稳定的 `document_type` 与 `source_id`，路径在这里集中一处维护
 * —— 把路径写进接口就意味着改一次前端路由要动后端。
 *
 * 关于"点过去会不会落在筛选态"：目前真正读查询参数的只有
 * `/production`、`/qc`、`/qc/finished-goods`、`/qc/incoming`（`receipt_id`）、
 * `/warehouse/raw-material-storage`（`notice_id`）。采购页的 `?order_no=` 由 T13 补上，
 * 财务侧仍是未筛选 —— 所以按钮文案写「打开模块页」，**不承诺它会筛选**
 * （单据本身已经在本页列全了，跳转只是加速）。
 */
export type DocumentRow = {
  document_no: string | null;
  date: string | null;
  date_source: "business" | "created_at" | "none";
  quantity: string | null;
  unit: string | null;
  status: string;
  status_label: string;
  source_id: string;
  extra: Record<string, unknown>;
};

export type DocumentGroup = { document_type: string; label: string; documents: DocumentRow[] };

/**
 * 跳转映射。类型上**显式允许 undefined**：`Record<string, fn>` 会让 TS 认为"任何键都能取到函数"，
 * 于是 `route ? … : …` 被判定为恒真（TS2774）—— 而真实情况是新加一个分组类型时可能还没写路由。
 */
export const DOCUMENT_ROUTES: Readonly<Record<string, ((document: DocumentRow, orderNo: string) => string) | undefined>> = {
  bom: () => "/procurement/boms",
  purchase_order: (_document, orderNo) => `/procurement/orders?order_no=${encodeURIComponent(orderNo)}`,
  purchase_receipt: (_document, orderNo) => `/procurement/orders?order_no=${encodeURIComponent(orderNo)}`,
  // 来料质检带 receipt_id：那是它唯一能定位到"哪一批"的参数（质检记录本身没有单号）。
  incoming_inspection: (document) => (typeof document.extra.receipt_id === "string" ? `/qc/incoming?receipt_id=${encodeURIComponent(document.extra.receipt_id)}` : "/qc/incoming"),
  raw_material_inbound: () => "/warehouse/raw-material-storage",
  production_order: (_document, orderNo) => `/production?order_no=${encodeURIComponent(orderNo)}`,
  material_movement: () => "/production/material-issues",
  operation_daily_report: (_document, orderNo) => `/production?order_no=${encodeURIComponent(orderNo)}`,
  finished_submission: (_document, orderNo) => `/qc/finished-goods?order_no=${encodeURIComponent(orderNo)}`,
  finished_qc: (_document, orderNo) => `/qc/finished-goods?order_no=${encodeURIComponent(orderNo)}`,
  finished_inbound_notice: () => "/warehouse/finished-goods-storage",
  finished_inbound: () => "/warehouse/finished-goods-storage",
  finished_defective: (_document, orderNo) => `/qc?order_no=${encodeURIComponent(orderNo)}`,
  finished_outbound: () => "/warehouse/finished-goods-storage",
  receivable: () => "/finance/receivable",
  payable_source: () => "/finance/payable",
  supplier_payable: () => "/finance/payable",
};

/** 日期显示：`created_at` 的回落要**说出来**，否则会被当成真实业务日期（月末对账差一天差两个月）。 */
export function documentDateText(document: DocumentRow): string {
  if (!document.date) return "-";
  const date = document.date.slice(0, 10);
  return document.date_source === "created_at" ? `${date}（登记时间）` : date;
}

export function DocumentGroups({ groups, orderNo }: { groups: DocumentGroup[]; orderNo: string }) {
  return (
    <div className="document-groups" data-testid="document-groups">
      {groups.map((group) => {
        const route = DOCUMENT_ROUTES[group.document_type];
        return (
          <section className="panel" key={group.document_type} data-testid={`document-group-${group.document_type}`}>
            <div className="panel-heading">
              <h3>{group.label}（{group.documents.length}）</h3>
              {route && group.documents.length > 0 ? <span className="panel-note">可打开对应模块页</span> : null}
            </div>
            <div className="panel-body">
              {group.documents.length === 0 ? (
                // 「空组」与「没有这个模块」是两条不同的信息：老板要问的正是"当时有没有做 QC"。
                <p className="panel-note" data-testid={`document-empty-${group.document_type}`}>未建立</p>
              ) : (
                <div className="table-wrap">
                  <table className="ui-table">
                    <thead>
                      <tr>
                        <th className="ui-table-head">单号</th>
                        <th className="ui-table-head">日期</th>
                        <th className="ui-table-head">数量</th>
                        <th className="ui-table-head">状态</th>
                        <th className="ui-table-head">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.documents.map((document) => (
                        <tr key={document.source_id}>
                          <td>{document.document_no ?? "-"}</td>
                          <td className={cn(document.date_source === "created_at" && "panel-note")}>{documentDateText(document)}</td>
                          <td>{document.quantity === null ? "-" : `${document.quantity}${document.unit ? ` ${document.unit}` : ""}`}</td>
                          <td>{document.status_label || "-"}</td>
                          <td>
                            {route ? (
                              // testid 用**分组**的类型：`document` 是单据行，它身上没有 document_type
                              // （第一版写成 `document.document_type`，于是 testid 变成 document-link-undefined
                              //  —— 测试直接把它抓出来了）。
                              <Link href={route(document, orderNo)} data-testid={`document-link-${group.document_type}`}>
                                打开模块页
                              </Link>
                            ) : (
                              <span className="panel-note">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
