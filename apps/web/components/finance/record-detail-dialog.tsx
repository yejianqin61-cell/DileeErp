"use client";

// 财务条目详情弹窗：双击任意列表行后弹出的居中悬浮页。
//
// 为什么单独成组件：应收/应付两个工作区、6 类财务对象（应收来源、应收对账、收款、
// 应付来源、应付条目、应付对账）都要「展示所有相关字段 + 操作」，字段集不同但版式与
// 交互必须一致，否则同一个系统里会出现 6 种详情弹窗。
//
// 约定：
//   - 打开时由调用方拉取详情接口（列表接口给不出全部字段），加载态/错误态就地呈现；
//   - `fields` 展示所有标量字段，`sections` 展示明细表（核销记录、来源追踪等）；
//   - `actions` 是详情里可执行的操作按钮，与列表行的操作共用同一批回调。
import type { ReactNode } from "react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { ErrorState, LoadingState } from "../feedback/states";

export type DetailField = { label: string; value: ReactNode; wide?: boolean };
export type DetailSection = { title: string; note?: string; content: ReactNode };

export function RecordDetailDialog({ open, onOpenChange, title, description, fields, sections = [], actions, loading = false, error = "", onRetry, testId = "finance-record-detail" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  fields: DetailField[];
  sections?: DetailSection[];
  actions?: ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="record-detail-dialog" data-testid={testId}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <DialogBody>
        {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={onRetry ?? (() => undefined)} /> : <>
          <dl className="detail-grid" data-testid={`${testId}-fields`}>
            {fields.map((field) => <div className={field.wide ? "detail-item detail-item-wide" : "detail-item"} key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value === null || field.value === undefined || field.value === "" ? "-" : field.value}</dd>
            </div>)}
          </dl>
          {sections.map((section) => <section className="detail-section" key={section.title}>
            <h3>{section.title}</h3>
            {section.note ? <p className="panel-note">{section.note}</p> : null}
            {section.content}
          </section>)}
        </>}
      </DialogBody>
      {actions ? <DialogFooter><div className="action-row">{actions}</div></DialogFooter> : null}
    </DialogContent>
  </Dialog>;
}

/**
 * 金额 + 币种，null/空值统一显示 "-"，避免出现 "null USD"。
 *
 * 金额与币种之间用**不换行空格**（U+00A0）：财务表格为了让长文本换行而放开了单元格换行
 * （见 globals.css 的 `.finance-page .data-table td`），普通空格会让「500.0000」与「USD」
 * 被拆到两行；不换行空格让金额整体换行，数字永远不会被折断。
 */
export function money(amount: string | number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined || amount === "") return "-";
  return currency ? `${amount}\u00a0${currency}` : String(amount);
}
