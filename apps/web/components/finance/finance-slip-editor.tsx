"use client";

// 收/付款单编辑器（财务 2026-09-20）。
//
// 财务的原话：「她需要在付款界面能导出付款单……允许用户编辑付款单中的一些字段。
// 比如我要付款 100，我可以自己填加行，我可以写付款备注」，随后补一句「同理，收款单的编辑和导出」。
//
// 所以这一块不套通用表单弹窗（那个加不了行、也改不了金额），自己成组件，形状照财务给的模板：
//   表头四行（单据编号 / 日期 / 结算方式 / 对方单位 / 开户银行 / 银行账号 / 附单据张数 / 制单人）
//   + 一张六列的分录表（摘要 / 总账科目 / 明细科目 / 借方金额 / 贷方金额 / 备注）
//   + 金额（大写、后端算）+ 备注 + 两行签字栏。
// 付款单与收款单共用它，用词由 `slipLabels(kind)` 给（收款单上对方是「付款单位」、签字栏是「交款人」）。
//
// 界面上的取舍：
//   - **不改系统里的任何数据**：单子是一张打印件，不是系统单据。预填来自后端
//     (`/finance/{payment,receipt}-slips/draft`，详见 lib/finance-slip.ts 顶部），改完直接出 xlsx；
//   - 底部实时显示借/贷合计与差额，**借贷不平就禁用导出**并把原因写出来（后端还会再校验一次）；
//   - testid 前缀按种类取（`payment-slip-editor` / `receipt-slip-editor`）：两种单据在同一个页面上
//     可能同时存在，用同一套 testid 会让「点的是哪一张」在测试里说不清。
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { LoadingState } from "../feedback/states";
import { downloadPost } from "../../lib/download";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  emptyFinanceSlipLine,
  financeSlipBlockers,
  financeSlipExportPath,
  financeSlipFileName,
  financeSlipPayload,
  nextFinanceSlipLineKey,
  slipDifference,
  slipLabels,
  slipLinesFromDraft,
  slipTotals,
  type FinanceSlipDraft,
  type FinanceSlipEditorLine,
  type FinanceSlipKind,
} from "../../lib/finance-slip";

/** 表头里可编辑的字符串字段（`attachment_count` 在输入框里是字符串，提交前才转数字）。 */
type SlipFields = {
  slip_no: string;
  slip_date: string;
  slip_method: string;
  counterparty_name: string;
  bank_name: string;
  bank_account: string;
  attachment: string;
  remark: string;
};

/** 占位预填（`useState` 的初值，避免用 `null` 把每个字段都变成可空判断）：真正的值在打开时铺进来。 */
const EMPTY_DRAFT: FinanceSlipDraft = {
  kind: "payment", slip_no: "", slip_date: "", slip_method: "银行转账", counterparty_name: "", bank_name: "", bank_account: "",
  attachment_count: 1, remark: "", maker: "", lines: [],
};

const fieldsOf = (draft: FinanceSlipDraft): SlipFields => ({
  slip_no: draft.slip_no,
  slip_date: draft.slip_date,
  slip_method: draft.slip_method,
  counterparty_name: draft.counterparty_name,
  bank_name: draft.bank_name,
  bank_account: draft.bank_account,
  attachment: String(draft.attachment_count),
  remark: draft.remark,
});

export default function FinanceSlipEditor({ kind, open, onOpenChange, draft, loading, error }: {
  kind: FinanceSlipKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 后端预填的单子；为 null 时（还没取到 / 取失败）只显示加载或错误。 */
  draft: FinanceSlipDraft | null;
  loading: boolean;
  /** 预填失败的原因（后端 422 的说明，例如「一张付款单只能有一个收款单位」）。 */
  error: string;
}) {
  const labels = slipLabels(kind);
  const testId = `${kind}-slip-editor`;
  const [fields, setFields] = useState<SlipFields>(() => fieldsOf(EMPTY_DRAFT));
  const [lines, setLines] = useState<FinanceSlipEditorLine[]>([]);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState("");

  /**
   * 每次**打开**都从预填结果重新铺一遍状态。
   *
   * 依赖里放 `open` 与 `draft`：预填结果每次请求都是新对象，而它只在打开那一刻变 ——
   * 不能依赖父组件每次渲染都新建的东西，否则财务正在改的金额会被冲掉。
   */
  useEffect(() => {
    if (!open || !draft) return;
    setFields(fieldsOf(draft));
    setLines(slipLinesFromDraft(draft.lines));
    setProblem("");
  }, [open, draft]);

  const header = useMemo(() => ({
    slip_no: fields.slip_no,
    slip_date: fields.slip_date,
    slip_method: fields.slip_method,
    counterparty_name: fields.counterparty_name,
    bank_name: fields.bank_name,
    bank_account: fields.bank_account,
    // 空 / 非数字 / 负数都交给同一套校验去说（`Number("")` 是 0，会被误当成「0 张」，所以空串单独给 -1）。
    attachment_count: fields.attachment.trim() === "" ? -1 : Number(fields.attachment),
    remark: fields.remark,
    maker: draft?.maker ?? "",
  }), [fields, draft?.maker]);

  const totals = useMemo(() => slipTotals(lines), [lines]);
  const blockers = useMemo(() => financeSlipBlockers(kind, header, lines), [kind, header, lines]);
  const patch = (index: number, next: Partial<FinanceSlipEditorLine>) => setLines((current) => current.map((line, position) => position === index ? { ...line, ...next } : line));
  const addLine = () => setLines((current) => [...current, emptyFinanceSlipLine(nextFinanceSlipLineKey())]);
  const removeLine = (index: number) => setLines((current) => current.filter((_, position) => position !== index));

  async function exportSlip() {
    if (blockers.length) { setProblem(blockers.join("；")); return; }
    setExporting(true);
    setProblem("");
    try {
      await downloadPost(financeSlipExportPath(kind), financeSlipPayload(kind, header, lines), financeSlipFileName(kind, fields.slip_no));
      notifySuccess(`已导出${labels.name} ${fields.slip_no.trim()}`);
      onOpenChange(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `${labels.name}导出失败`;
      setProblem(message);
      notifyError(message);
    } finally {
      setExporting(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!exporting) onOpenChange(next); }}>
    <DialogContent className="payment-slip-editor-dialog" data-testid={testId}>
      <DialogHeader><DialogTitle>{labels.name}{fields.slip_no.trim() ? ` ${fields.slip_no.trim()}` : ""}</DialogTitle></DialogHeader>
      <DialogBody>
        {loading ? <LoadingState label={`正在按条目预填${labels.name}`} /> : !draft ? <p className="status-error" role="alert" data-testid={`${testId}-draft-error`}>{error || "预填失败"}</p> : <>
          <div className="payment-slip-editor-head">
            <label className="ui-form-item">单据编号<Input data-testid={`${testId}-slip-no`} value={fields.slip_no} onChange={(event) => setFields({ ...fields, slip_no: event.target.value })} /></label>
            <label className="ui-form-item">{labels.date}<Input data-testid={`${testId}-date`} type="date" value={fields.slip_date} onChange={(event) => setFields({ ...fields, slip_date: event.target.value })} /></label>
            <label className="ui-form-item">{labels.method}<Input data-testid={`${testId}-method`} value={fields.slip_method} onChange={(event) => setFields({ ...fields, slip_method: event.target.value })} /></label>
            <label className="ui-form-item">{labels.counterparty}<Input data-testid={`${testId}-counterparty`} value={fields.counterparty_name} onChange={(event) => setFields({ ...fields, counterparty_name: event.target.value })} /></label>
            <label className="ui-form-item">开户银行<Input data-testid={`${testId}-bank-name`} value={fields.bank_name} onChange={(event) => setFields({ ...fields, bank_name: event.target.value })} /></label>
            <label className="ui-form-item">银行账号<Input data-testid={`${testId}-bank-account`} value={fields.bank_account} onChange={(event) => setFields({ ...fields, bank_account: event.target.value })} /></label>
            <label className="ui-form-item">附单据（张）<Input data-testid={`${testId}-attachment`} inputMode="numeric" value={fields.attachment} onChange={(event) => setFields({ ...fields, attachment: event.target.value })} /></label>
            <label className="ui-form-item">{labels.maker}<Input data-testid={`${testId}-maker`} value={header.maker} readOnly /></label>
          </div>

          <div className="payment-slip-editor-row payment-slip-editor-row-head">
            <span>{labels.summary}</span><span>{labels.generalSubject}</span><span>{labels.detailSubject}</span><span>{labels.debit}</span><span>{labels.credit}</span><span>{labels.remarkColumn}</span><span />
          </div>
          {lines.map((line, index) => <div className="payment-slip-editor-row" key={line.key} data-testid={`${testId}-row-${index}`}>
            <Input data-testid={`${testId}-summary-${index}`} value={line.summary} onChange={(event) => patch(index, { summary: event.target.value })} placeholder="如：支付富雨鑫材料款" />
            <Input data-testid={`${testId}-general-${index}`} value={line.general_subject} onChange={(event) => patch(index, { general_subject: event.target.value })} placeholder="如：原材料" />
            <Input data-testid={`${testId}-detail-${index}`} value={line.detail_subject} onChange={(event) => patch(index, { detail_subject: event.target.value })} placeholder="如：中国农业银行" />
            <Input data-testid={`${testId}-debit-${index}`} value={line.debit} onChange={(event) => patch(index, { debit: event.target.value })} placeholder="0.00" inputMode="decimal" />
            <Input data-testid={`${testId}-credit-${index}`} value={line.credit} onChange={(event) => patch(index, { credit: event.target.value })} placeholder="0.00" inputMode="decimal" />
            <Input data-testid={`${testId}-line-remark-${index}`} value={line.remark} onChange={(event) => patch(index, { remark: event.target.value })} />
            <Button size="sm" variant="ghost" data-testid={`${testId}-remove-${index}`} disabled={exporting || lines.length <= 1} onClick={() => removeLine(index)}>删除</Button>
          </div>)}
          <div className="action-row">
            <Button size="sm" variant="secondary" data-testid={`${testId}-add`} disabled={exporting} onClick={addLine}>新增行</Button>
            <span className="panel-note" data-testid={`${testId}-totals`}>
              借方合计 {totals.debit}　贷方合计 {totals.credit}　差额 {slipDifference(totals)}
            </span>
          </div>

          <label className="ui-form-item">{labels.remark}<Textarea data-testid={`${testId}-remark`} value={fields.remark} onChange={(event) => setFields({ ...fields, remark: event.target.value })} placeholder="如：本次先付 100，余款月结" /></label>
          {/* 不能导出时**必须把原因写在界面上**：按钮是禁用的，点不动，所以提示不能只在点击后出现。 */}
          {blockers.length > 0 && <p className="panel-note" data-testid={`${testId}-blockers`}>{blockers.join("；")}</p>}
          {/* 提交后才发现的问题（例如后端判定某行金额非法）单独红字显示。 */}
          {problem && <p className="status-error" role="alert" data-testid={`${testId}-error`}>{problem}</p>}
        </>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid={`${testId}-cancel`} disabled={exporting} onClick={() => onOpenChange(false)}>取消</Button>
        <Button data-testid={`${testId}-export`} disabled={exporting || !draft || blockers.length > 0} onClick={() => void exportSlip()}>{exporting ? "导出中…" : `导出${labels.name}`}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
