"use client";

// 记账凭证的**分录编辑器**（财务 2026-09-20）。
//
// 原来的「编辑」是一个通用表单弹窗，只能改已有两行的科目（还是手打文本）与金额 ——
// 财务那句「现在自动生成的不能改、。这是什么意思？」说的就是它：工资计提是
// 「借 应付职工薪酬（应发）；贷 其他应付款（社保个人）+ 应交税费（个税）+ 银行存款（实发）」，
// 四行、一借三贷，弹窗里既加不了行也改不了方向，等于录不进来。
//
// 所以这一块不套通用表单，自己成组件：
//   - 逐行编辑：方向 / 科目（**带搜索框**的科目下拉）/ 摘要 / 金额 / 删除；
//   - 增行、套模板（工资计提、原材料采购）；
//   - 底部实时显示借/贷合计与差额，**不平或金额非法时保存按钮直接禁用**，
//     并把三种原因分开说（还没填完 / 科目没填 / 借贷不平）—— 后端仍然会再校验一次，
//     前端这道只是为了不让财务走到「点了保存才被告知不平」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  DIRECTION_OPTIONS,
  applyVoucherTemplate,
  emptyVoucherLine,
  formatCents,
  linesFromVoucher,
  nextLineKey,
  parseCents,
  voucherLinePayload,
  voucherLineTotals,
  type EditorSubject,
  type VoucherEditorLine,
  type VoucherTemplate,
} from "../../lib/voucher-lines";

/** 编辑器需要的凭证形状（详情接口已经给了这些字段）。 */
export type EditableVoucher = {
  id: string;
  voucherNo: string;
  currency: string;
  summary: string;
  remark: string | null;
  lines: Array<{ direction: string; subjectKey: string; subjectLabel: string; summary: string; amount: string; bank?: { id: string } | null }>;
};

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export default function VoucherLineEditor({ open, onOpenChange, voucher, subjects, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 被编辑的草稿凭证；为 null 时（详情还没加载完）不渲染内容。 */
  voucher: EditableVoucher | null;
  /** 全量启用的会计科目（下拉选项）。 */
  subjects: EditorSubject[];
  onSaved: () => void;
}) {
  const [lines, setLines] = useState<VoucherEditorLine[]>([]);
  const [summary, setSummary] = useState("");
  const [remark, setRemark] = useState("");
  const [templates, setTemplates] = useState<VoucherTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const subjectOptions = useMemo(() => subjects.map((subject) => ({ value: subject.id, label: `${subject.category} / ${subject.name}` })), [subjects]);

  /**
   * 每次**打开**都从凭证重新铺一遍状态。
   *
   * 依赖里放 `open` 与 `voucher?.id` 而不是 `voucher`：凭证对象每次重取都是新引用，
   * 用它会在一保存完（父组件重拉列表）就把用户正在编辑的内容冲掉。
   */
  const reset = useCallback(() => {
    if (!voucher) return;
    setLines(linesFromVoucher(voucher.lines, subjects));
    setSummary(voucher.summary);
    setRemark(voucher.remark ?? "");
    setError("");
  }, [voucher?.id, subjects]);

  useEffect(() => { if (open) reset(); }, [open, reset]);

  // 模板从后端取：它是会计口径（与科目表同源），而且「资金行用哪张卡」只有后端知道。
  useEffect(() => {
    if (!open || !voucher) return;
    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError("");
    apiGet<VoucherTemplate[]>(`/finance/vouchers/${voucher.id}/templates`)
      .then((result) => { if (!cancelled) setTemplates(result.data); })
      .catch((cause) => { if (!cancelled) setTemplatesError(messageOf(cause, "模板加载失败")); })
      .finally(() => { if (!cancelled) setTemplatesLoading(false); });
    return () => { cancelled = true; };
  }, [open, voucher?.id]);

  const totals = useMemo(() => voucherLineTotals(lines), [lines]);
  /** 借贷差额（绝对值）。合计相等时为 0。 */
  const difference = useMemo(() => {
    const debit = lines.reduce((sum, line) => sum + (line.direction === "debit" ? parseCents(line.amount) ?? 0n : 0n), 0n);
    const credit = lines.reduce((sum, line) => sum + (line.direction === "credit" ? parseCents(line.amount) ?? 0n : 0n), 0n);
    return formatCents(debit > credit ? debit - credit : credit - debit);
  }, [lines]);

  const patch = (index: number, next: Partial<VoucherEditorLine>) => setLines((current) => current.map((line, position) => position === index ? { ...line, ...next } : line));
  const addLine = () => setLines((current) => [...current, emptyVoucherLine(nextLineKey())]);
  const removeLine = (index: number) => setLines((current) => current.filter((_, position) => position !== index));
  const applyTemplate = (template: VoucherTemplate) => setLines(applyVoucherTemplate(template, lines.find((line) => line.bankId) ?? null));

  async function save() {
    if (!voucher) return;
    // 三种原因分开说：合成一句「请检查分录」会让财务在四行金额里逐个试。
    if (totals.invalid) { setError("每行金额都必须是大于零的数字（最多 4 位小数）"); return; }
    if (totals.subjectMissing) { setError("每一行都必须选择会计科目"); return; }
    if (!totals.debit || !totals.credit) { setError("凭证至少需要一条借方与一条贷方分录"); return; }
    if (!totals.balanced) { setError(`借贷不平衡：借方 ${totals.debit} / 贷方 ${totals.credit}（差额 ${difference}）`); return; }
    setSaving(true);
    setError("");
    try {
      await apiPatch(`/finance/vouchers/${voucher.id}`, {
        summary: summary.trim() || undefined,
        remark: remark.trim(),
        lines: voucherLinePayload(lines, subjects),
      });
      notifySuccess(`凭证 ${voucher.voucherNo} 的分录已更新`);
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      const message = messageOf(cause, "凭证保存失败");
      setError(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
    <DialogContent className="voucher-editor-dialog" data-testid="voucher-line-editor">
      <DialogHeader><DialogTitle>编辑凭证 {voucher?.voucherNo ?? ""} 的分录</DialogTitle></DialogHeader>
      <DialogBody>
        {!voucher ? <LoadingState /> : <>
          <div className="filter-bar">
            <label>摘要<Input data-testid="voucher-editor-summary" value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
            <label>模板
              {/* 模板**替换**全部分录，所以文案里写明，避免「我只是想加两行，怎么原来的没了」。 */}
              <span className="voucher-template-bar" data-testid="voucher-editor-templates">
                {templatesLoading && <span className="panel-note">模板加载中…</span>}
                {templatesError && <span className="panel-note status-error">{templatesError}</span>}
                {!templatesLoading && !templatesError && templates.map((template) => <Button key={template.key} size="sm" variant="secondary" title={`${template.description}（会覆盖现有分录）`} data-testid={`voucher-template-${template.key}`} disabled={saving} onClick={() => applyTemplate(template)}>套用「{template.name}」</Button>)}
              </span>
            </label>
          </div>
          <p className="panel-note">套用模板会覆盖下面现有分录；金额留空由你填写（系统不按税率自动拆进项税：取得普票不抵扣、优惠税率时会被自动填错）。</p>

          <div className="voucher-editor-row voucher-editor-row-head">
            <span>方向</span><span>会计科目</span><span>摘要</span><span>金额</span><span />
          </div>
          {lines.map((line, index) => <div className="voucher-editor-row" key={line.key} data-testid={`voucher-editor-row-${index}`}>
            <Select value={line.direction} onValueChange={(value) => patch(index, { direction: value as VoucherEditorLine["direction"] })} disabled={saving}>
              <SelectTrigger data-testid={`voucher-editor-direction-${index}`}><SelectValue /></SelectTrigger>
              <SelectContent>{DIRECTION_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            <SearchableSelect
              testId={`voucher-editor-subject-${index}`}
              value={line.subject}
              options={subjectOptions}
              label={`第 ${index + 1} 行会计科目`}
              placeholder="搜索并选择科目"
              disabled={saving}
              onChange={(value) => patch(index, { subject: value })}
            />
            <Input data-testid={`voucher-editor-line-summary-${index}`} value={line.summary} onChange={(event) => patch(index, { summary: event.target.value })} disabled={saving} placeholder="该行摘要" />
            <Input data-testid={`voucher-editor-amount-${index}`} value={line.amount} onChange={(event) => patch(index, { amount: event.target.value })} disabled={saving} placeholder="0.00" inputMode="decimal" />
            <Button size="sm" variant="ghost" data-testid={`voucher-editor-remove-${index}`} disabled={saving || lines.length <= 1} onClick={() => removeLine(index)}>删除</Button>
          </div>)}
          <div className="action-row">
            <Button size="sm" variant="secondary" data-testid="voucher-editor-add" disabled={saving} onClick={addLine}>新增分录</Button>
            <span className="panel-note" data-testid="voucher-editor-totals">
              借方合计 {totals.debit}　贷方合计 {totals.credit}　差额 {difference}
            </span>
          </div>

          <label className="ui-form-item">备注<Textarea data-testid="voucher-editor-remark" value={remark} onChange={(event) => setRemark(event.target.value)} disabled={saving} /></label>
          {error && <p className="status-error" role="alert" data-testid="voucher-editor-error">{error}</p>}
        </>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid="voucher-editor-cancel" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
        <Button data-testid="voucher-editor-save" disabled={saving || !voucher || !totals.balanced} onClick={() => void save()}>{saving ? "保存中…" : "保存分录"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
