"use client";

// 收/付款单编辑器（财务 2026-09-20 首次要求，2026-09-24 改成**队列**）。
//
// 财务的原话分两轮：
//   - 2026-09-20「她需要在付款界面能导出付款单……允许用户编辑付款单中的一些字段。
//     比如我要付款 100，我可以自己填加行，我可以写付款备注」+「同理，收款单的编辑和导出」；
//   - 2026-09-24「还是不能实现一起付款，只能算是一起确认了，然后还是一个个的改付款单」——
//     当时一次勾选只能出一张单子（跨供应商直接 422），于是她只能一家一家重选、一张一张改。
//
// 所以现在这个组件管的是**一队列单子**（后端按「对方单位 + 币种」拆好的）：
//   - 顶部一行是张数与切换（`第 2 张：绍兴纺织（USD）合计 200`），每张**各自保存**自己的编辑
//     （改一张再切走不会丢）；
//   - 底部四个动作：导出这一张、全部导出（一个工作簿）、**保存这一张**（2026-09-26 用户要的
//     「保存键」）、以及「批量确认未确认的 N 条」（把「一起付款」的另一半接上）。
//
// 「保存」与「导出」的区别（这一轮最容易搞混的一处，值得写在代码里）：
//   - **保存**只把这张单子存下来（`POST/PATCH /finance/slips`），**不改任何账**：不写收支流水、
//     不生成凭证、不动应付/应收状态。它的门槛也低一档 —— 编号、对方单位、借贷平衡都还不要求，
//     财务改到一半就能存下（后端 `validateFinanceSlipShape`）；
//   - **导出**是拿去银行/走签字的那张纸，全套校验都要过（后端 `validateFinanceSlip`）。
//   第三次点保存是**覆盖同一张**（把后端返回的 id 记回队列），否则财务会得到两张一样的单子。
//
// 界面上的取舍：
//   - 单子的内容仍然以**界面提交的为准**（预填只是起点），保存也不回头用系统算的值覆盖它；
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
import { ApiClientError, apiPatch, apiPost } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  emptyFinanceSlipLine,
  financeSlipBatchExportPath,
  financeSlipBatchPayload,
  financeSlipBlockers,
  financeSlipExportPath,
  financeSlipFileName,
  financeSlipPayload,
  financeSlipsFileName,
  financeSlipRecordPath,
  financeSlipSaveBlockers,
  financeSlipSaveBody,
  FINANCE_SLIPS_PATH,
  nextFinanceSlipLineKey,
  slipDifference,
  slipLabels,
  slipLinesFromDraft,
  slipConfirmPendingLabel,
  slipQueueLabel,
  slipTotals,
  SLIP_CNY_EMPTY_HINT,
  type FinanceSlipDraft,
  type FinanceSlipEditorLine,
  type FinanceSlipHeader,
  type FinanceSlipKind,
  type FinanceSlipRecord,
} from "../../lib/finance-slip";

/** 表头里可编辑的字符串字段（`attachment_count` 在输入框里是字符串，提交前才转数字）。 */
type SlipFields = {
  slip_no: string;
  slip_date: string;
  slip_method: string;
  counterparty_name: string;
  our_bank_name: string;
  our_bank_account: string;
  counterparty_bank_name: string;
  counterparty_bank_account: string;
  /** 汇率与折合人民币（用户 2026-09-26）：人民币付款两格都留空。 */
  exchange_rate: string;
  amount_cny: string;
  attachment: string;
  remark: string;
};

/**
 * 队列里一张单子的**可编辑状态**（表头 + 分录行）。
 *
 * `currency` 与 `maker` 不可改，随预填带过来；`id` 有值 = 这张单子已经存过，
 * 保存就是覆盖它（见组件头部第三条）；`sourceEntryIds` 是预填时的勾选，保存时原样回传（只用于追溯）。
 */
type SlipEntry = { fields: SlipFields; lines: FinanceSlipEditorLine[]; currency: string; maker: string; id?: string; sourceEntryIds?: string[] };

/** 占位预填（`useState` 的初值，避免用 `null` 把每个字段都变成可空判断）：真正的值在打开时铺进来。 */
const EMPTY_ENTRY: SlipEntry = {
  fields: { slip_no: "", slip_date: "", slip_method: "银行转账", counterparty_name: "", our_bank_name: "", our_bank_account: "", counterparty_bank_name: "", counterparty_bank_account: "", exchange_rate: "", amount_cny: "", attachment: "1", remark: "" },
  lines: [],
  currency: "",
  maker: "",
};

const entryOf = (draft: FinanceSlipDraft): SlipEntry => ({
  fields: {
    slip_no: draft.slip_no,
    slip_date: draft.slip_date,
    slip_method: draft.slip_method,
    counterparty_name: draft.counterparty_name,
    our_bank_name: draft.our_bank_name,
    our_bank_account: draft.our_bank_account,
    counterparty_bank_name: draft.counterparty_bank_name,
    counterparty_bank_account: draft.counterparty_bank_account,
    exchange_rate: draft.exchange_rate ?? "",
    amount_cny: draft.amount_cny ?? "",
    attachment: String(draft.attachment_count),
    remark: draft.remark,
  },
  lines: slipLinesFromDraft(draft.lines),
  currency: draft.currency,
  maker: draft.maker,
  // 存档信息跟着走：打开一张已保存的单子再点保存，必须覆盖它而不是再建一张。
  ...(draft.id ? { id: draft.id } : {}),
  ...(draft.source_entry_ids?.length ? { sourceEntryIds: draft.source_entry_ids } : {}),
});

export default function FinanceSlipEditor({ kind, open, onOpenChange, drafts, loading, error, pendingCount = 0, onConfirmPending, onSaved }: {
  kind: FinanceSlipKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 后端预填的单子队列（一张或多张）；为 null 时（还没取到 / 取失败）只显示加载或错误。 */
  drafts: FinanceSlipDraft[] | null;
  loading: boolean;
  /** 预填失败的原因（后端 422 的说明）。 */
  error: string;
  /** 勾选里**还没确认**的条数（钱还没出账）：大于 0 时在底部给一条「批量确认」的出路。 */
  pendingCount?: number;
  /** 点「批量确认」时回调（父组件负责关掉队列、打开确认弹窗，用的是同一批勾选）。 */
  onConfirmPending?: () => void;
  /** 保存成功后的回调（父组件刷新「已保存的单据」列表；不传就只是弹个成功提示）。 */
  onSaved?: (slip: FinanceSlipRecord) => void;
}) {
  const labels = slipLabels(kind);
  const testId = `${kind}-slip-editor`;
  const [queue, setQueue] = useState<SlipEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [exporting, setExporting] = useState<"one" | "all" | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  /**
   * 每次**打开**都从预填结果重新铺一遍状态。
   *
   * 依赖里放 `open` 与 `drafts`：预填结果每次请求都是新对象，而它只在打开那一刻变 ——
   * 不能依赖父组件每次渲染都新建的东西，否则财务正在改的金额会被冲掉。
   */
  useEffect(() => {
    if (!open || !drafts) return;
    setQueue(drafts.map(entryOf));
    setIndex(0);
    setProblem("");
  }, [open, drafts]);

  const current = queue[index] ?? EMPTY_ENTRY;
  const { fields, lines } = current;

  const header = useMemo<FinanceSlipHeader>(() => ({
    slip_no: fields.slip_no,
    slip_date: fields.slip_date,
    slip_method: fields.slip_method,
    counterparty_name: fields.counterparty_name,
    our_bank_name: fields.our_bank_name,
    our_bank_account: fields.our_bank_account,
    counterparty_bank_name: fields.counterparty_bank_name,
    counterparty_bank_account: fields.counterparty_bank_account,
    currency: current.currency,
    exchange_rate: fields.exchange_rate,
    amount_cny: fields.amount_cny,
    // 空 / 非数字 / 负数都交给同一套校验去说（`Number("")` 是 0，会被误当成「0 张」，所以空串单独给 -1）。
    attachment_count: fields.attachment.trim() === "" ? -1 : Number(fields.attachment),
    remark: fields.remark,
    maker: current.maker,
  }), [fields, current.currency, current.maker]);

  const totals = useMemo(() => slipTotals(lines), [lines]);
  const blockers = useMemo(() => financeSlipBlockers(kind, header, lines), [kind, header, lines]);
  /**
   * 保存的阻断原因（比导出少三件：编号、对方单位、借贷平衡）。
   *
   * 为什么不直接复用 `blockers`：那会让「改到一半存不下来」，而这一轮做保存键的原因正是
   * 「一次十几张单子，改到第五张被叫走」。后端的分层是同一件事（`validateFinanceSlipShape`）。
   */
  const saveBlockers = useMemo(() => financeSlipSaveBlockers(kind, header, lines), [kind, header, lines]);
  /**
   * 全部导出的**整队列**阻断原因：任何一张不过关就整批不出。
   *
   * 为什么不是「跳过有问题的那张、导出其余的」：一次集中付款少出一张单子，财务到银行才会发现，
   * 那时她只能凭记忆回想少的是哪一家。宁可一次把问题全部列出来（带上「第几张」）。
   */
  const queueBlockers = useMemo(() => queue.flatMap((entry, position) => {
    const entryHeader: FinanceSlipHeader = { ...entryHeaderOf(entry), maker: entry.maker };
    return financeSlipBlockers(kind, entryHeader, entry.lines).map((blocker) => `第 ${position + 1} 张：${blocker}`);
  }), [kind, queue]);

  /** 改当前这张的表头字段（其它张原样不动：队列里每张的编辑互不影响）。 */
  const patchFields = (next: Partial<SlipFields>) => setQueue((all) => all.map((entry, position) => position === index ? { ...entry, fields: { ...entry.fields, ...next } } : entry));
  const patchLine = (lineIndex: number, next: Partial<FinanceSlipEditorLine>) => setQueue((all) => all.map((entry, position) => position === index ? { ...entry, lines: entry.lines.map((line, at) => at === lineIndex ? { ...line, ...next } : line) } : entry));
  const addLine = () => setQueue((all) => all.map((entry, position) => position === index ? { ...entry, lines: [...entry.lines, emptyFinanceSlipLine(nextFinanceSlipLineKey())] } : entry));
  const removeLine = (lineIndex: number) => setQueue((all) => all.map((entry, position) => position === index ? { ...entry, lines: entry.lines.filter((_, at) => at !== lineIndex) } : entry));

  /**
   * 保存**当前这一张**（用户 2026-09-26 要的「保存键」）。
   *
   * 三个要点：
   *   1. 已有 `id` 的走 `PATCH`（覆盖），没有的走 `POST`（新建）—— 否则点两次保存会得到两张一样的单子；
   *   2. 保存成功后把返回的 `id` **记回队列里的那一条**：第二次保存才是覆盖，而不是又建一张；
   *   3. 失败原因写进 `problem`（红字）并弹提示：预填失败与保存失败是两件事，不能只留一个状态位。
   */
  async function saveCurrent() {
    if (saveBlockers.length) { setProblem(saveBlockers.join("；")); return; }
    setSaving(true);
    setProblem("");
    try {
      const body = financeSlipSaveBody(kind, header, lines, current.sourceEntryIds);
      const result = current.id
        ? await apiPatch<{ slip: FinanceSlipRecord }>(financeSlipRecordPath(current.id), body)
        : await apiPost<{ slip: FinanceSlipRecord }>(FINANCE_SLIPS_PATH, body);
      const saved = result.data.slip;
      setQueue((all) => all.map((entry, position) => position === index ? { ...entry, id: saved.id } : entry));
      notifySuccess(`已保存${labels.name} ${saved.slip_no || "未编号"}`);
      onSaved?.(saved);
    } catch (cause) {
      const message = cause instanceof ApiClientError ? cause.message : `${labels.name}保存失败`;
      setProblem(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  /** 导出队列里的**一张**（银行要一张一张给，这条路必须留着）。 */
  async function exportOne() {
    if (blockers.length) { setProblem(blockers.join("；")); return; }
    setExporting("one");
    setProblem("");
    try {
      await downloadPost(financeSlipExportPath(kind), financeSlipPayload(kind, header, lines), financeSlipFileName(kind, fields.slip_no));
      notifySuccess(`已导出${labels.name} ${fields.slip_no.trim()}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `${labels.name}导出失败`;
      setProblem(message);
      notifyError(message);
    } finally {
      setExporting(null);
    }
  }

  /** 导出队列里的**全部张**（一个工作簿，一张单子一个工作表 —— 逐张下载会被浏览器拦掉）。 */
  async function exportAll() {
    if (queueBlockers.length) { setProblem(queueBlockers.join("；")); return; }
    setExporting("all");
    setProblem("");
    try {
      const body = financeSlipBatchPayload(kind, queue.map((entry) => ({
        header: { ...entryHeaderOf(entry), maker: entry.maker },
        lines: entry.lines,
      })));
      await downloadPost(financeSlipBatchExportPath(kind), body, financeSlipsFileName(kind, queue.length));
      notifySuccess(`已导出 ${queue.length} 张${labels.name}`);
      onOpenChange(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `${labels.name}导出失败`;
      setProblem(message);
      notifyError(message);
    } finally {
      setExporting(null);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!exporting) onOpenChange(next); }}>
    <DialogContent className="payment-slip-editor-dialog" data-testid={testId}>
      <DialogHeader><DialogTitle>{labels.name}{queue.length > 1 ? `（共 ${queue.length} 张）` : ""}{fields.slip_no.trim() ? ` ${fields.slip_no.trim()}` : ""}</DialogTitle></DialogHeader>
      <DialogBody>
        {loading ? <LoadingState label={`正在按条目预填${labels.name}`} /> : !drafts?.length ? <p className="status-error" role="alert" data-testid={`${testId}-draft-error`}>{error || "预填失败"}</p> : <>
          {/* 队列切换条：只在真的拆成多张时出现（一张单子时多一行按钮只是噪音）。 */}
          {queue.length > 1 && <div className="payment-slip-editor-queue" data-testid={`${testId}-queue`}>
            {queue.map((entry, position) => <Button
              key={position}
              size="sm"
              variant={position === index ? "default" : "secondary"}
              data-testid={`${testId}-queue-${position}`}
              disabled={Boolean(exporting)}
              onClick={() => { setIndex(position); setProblem(""); }}
            >{slipQueueLabel(position, entry.fields.counterparty_name, entry.currency, slipTotals(entry.lines).debit)}</Button>)}
          </div>}
          <div className="payment-slip-editor-head">
            <label className="ui-form-item">单据编号<Input data-testid={`${testId}-slip-no`} value={fields.slip_no} onChange={(event) => patchFields({ slip_no: event.target.value })} /></label>
            <label className="ui-form-item">{labels.date}<Input data-testid={`${testId}-date`} type="date" value={fields.slip_date} onChange={(event) => patchFields({ slip_date: event.target.value })} /></label>
            <label className="ui-form-item">{labels.method}<Input data-testid={`${testId}-method`} value={fields.slip_method} onChange={(event) => patchFields({ slip_method: event.target.value })} /></label>
            <label className="ui-form-item">{labels.counterparty}<Input data-testid={`${testId}-counterparty`} value={fields.counterparty_name} onChange={(event) => patchFields({ counterparty_name: event.target.value })} /></label>
            {/* 我方与对方各两格（用户 2026-09-24）。我方通常已由确认流水预填，改的是「这次走哪张卡」；
                对方的开户行/账号模板上本来就要填，但系统里没有可靠来源，所以默认空着让财务照回单抄。 */}
            <label className="ui-form-item">{labels.ourBankName}<Input data-testid={`${testId}-our-bank-name`} value={fields.our_bank_name} onChange={(event) => patchFields({ our_bank_name: event.target.value })} /></label>
            <label className="ui-form-item">{labels.ourBankAccount}<Input data-testid={`${testId}-our-bank-account`} value={fields.our_bank_account} onChange={(event) => patchFields({ our_bank_account: event.target.value })} /></label>
            <label className="ui-form-item">{labels.counterpartyBankName}<Input data-testid={`${testId}-counterparty-bank-name`} value={fields.counterparty_bank_name} onChange={(event) => patchFields({ counterparty_bank_name: event.target.value })} /></label>
            <label className="ui-form-item">{labels.counterpartyBankAccount}<Input data-testid={`${testId}-counterparty-bank-account`} value={fields.counterparty_bank_account} onChange={(event) => patchFields({ counterparty_bank_account: event.target.value })} /></label>
            {/* 币种只读：它来自预填（勾选的条目是哪个币种就是哪个），手工改成别的会让单子与账对不上。
                汇率与折合人民币是**手填**的两格（用户 2026-09-26：「付款单要有填写汇率的地方」）：
                人民币付款两格都留空；系统不替财务按「合计 × 汇率」折算（见 lib 里的 SLIP_CNY_EMPTY_HINT）。 */}
            <label className="ui-form-item">{labels.currency}<Input data-testid={`${testId}-currency`} value={header.currency} readOnly /></label>
            <label className="ui-form-item">{labels.exchangeRate}<Input data-testid={`${testId}-exchange-rate`} value={fields.exchange_rate} onChange={(event) => patchFields({ exchange_rate: event.target.value })} inputMode="decimal" placeholder="人民币付款可留空" /></label>
            <label className="ui-form-item">{labels.amountCny}<Input data-testid={`${testId}-amount-cny`} value={fields.amount_cny} onChange={(event) => patchFields({ amount_cny: event.target.value })} inputMode="decimal" placeholder="人民币付款可留空" /></label>
            <label className="ui-form-item">附单据（张）<Input data-testid={`${testId}-attachment`} inputMode="numeric" value={fields.attachment} onChange={(event) => patchFields({ attachment: event.target.value })} /></label>
            <label className="ui-form-item">{labels.maker}<Input data-testid={`${testId}-maker`} value={header.maker} readOnly /></label>
          </div>

          <div className="payment-slip-editor-row payment-slip-editor-row-head">
            <span>{labels.summary}</span><span>{labels.generalSubject}</span><span>{labels.detailSubject}</span><span>{labels.debit}</span><span>{labels.credit}</span><span>{labels.remarkColumn}</span><span />
          </div>
          {lines.map((line, lineIndex) => <div className="payment-slip-editor-row" key={line.key} data-testid={`${testId}-row-${lineIndex}`}>
            <Input data-testid={`${testId}-summary-${lineIndex}`} value={line.summary} onChange={(event) => patchLine(lineIndex, { summary: event.target.value })} placeholder="如：支付富雨鑫材料款" />
            <Input data-testid={`${testId}-general-${lineIndex}`} value={line.general_subject} onChange={(event) => patchLine(lineIndex, { general_subject: event.target.value })} placeholder="如：原材料" />
            <Input data-testid={`${testId}-detail-${lineIndex}`} value={line.detail_subject} onChange={(event) => patchLine(lineIndex, { detail_subject: event.target.value })} placeholder="如：中国农业银行" />
            <Input data-testid={`${testId}-debit-${lineIndex}`} value={line.debit} onChange={(event) => patchLine(lineIndex, { debit: event.target.value })} placeholder="0.00" inputMode="decimal" />
            <Input data-testid={`${testId}-credit-${lineIndex}`} value={line.credit} onChange={(event) => patchLine(lineIndex, { credit: event.target.value })} placeholder="0.00" inputMode="decimal" />
            <Input data-testid={`${testId}-line-remark-${lineIndex}`} value={line.remark} onChange={(event) => patchLine(lineIndex, { remark: event.target.value })} />
            <Button size="sm" variant="ghost" data-testid={`${testId}-remove-${lineIndex}`} disabled={Boolean(exporting) || lines.length <= 1} onClick={() => removeLine(lineIndex)}>删除</Button>
          </div>)}
          <div className="action-row">
            <Button size="sm" variant="secondary" data-testid={`${testId}-add`} disabled={Boolean(exporting)} onClick={addLine}>新增行</Button>
            <span className="panel-note" data-testid={`${testId}-totals`}>
              借方合计 {totals.debit}　贷方合计 {totals.credit}　差额 {slipDifference(totals)}
            </span>
          </div>

          <label className="ui-form-item">{labels.remark}<Textarea data-testid={`${testId}-remark`} value={fields.remark} onChange={(event) => patchFields({ remark: event.target.value })} placeholder="如：本次先付 100，余款月结" /></label>
          {/* 「填了汇率、折合人民币空着」时把口径说明白：这两格看起来是一对（跨行转账单上就是一对），
              不说的话财务会以为系统替她算过了 —— 导出后才发现那一格是空的。 */}
          {fields.exchange_rate.trim() && !fields.amount_cny.trim() && <p className="panel-note" data-testid={`${testId}-cny-hint`}>{SLIP_CNY_EMPTY_HINT}</p>}
          {/* 不能导出时**必须把原因写在界面上**：按钮是禁用的，点不动，所以提示不能只在点击后出现。 */}
          {blockers.length > 0 && <p className="panel-note" data-testid={`${testId}-blockers`}>{blockers.join("；")}</p>}
          {/* 保存的门槛低一档，所以它自己的原因单独一条（不然「保存能点、导出不能点」会被看成 bug）。 */}
          {saveBlockers.length > 0 && <p className="panel-note" data-testid={`${testId}-save-blockers`}>{`暂时不能保存：${saveBlockers.join("；")}`}</p>}
          {/* 提交后才发现的问题（例如后端判定某行金额非法）单独红字显示。 */}
          {problem && <p className="status-error" role="alert" data-testid={`${testId}-error`}>{problem}</p>}
        </>}
      </DialogBody>
      <DialogFooter>
        {/* 「一起付款」的另一半：勾选的条目里还有没确认的，就在这一处直接去确认（钱才真的出账）。
            父组件用同一批勾选打开确认弹窗，所以这里只报个数并回调，不自己发请求。 */}
        {pendingCount > 0 && onConfirmPending && <Button variant="secondary" data-testid={`${testId}-confirm-pending`} disabled={Boolean(exporting) || saving} onClick={onConfirmPending}>{slipConfirmPendingLabel(kind, pendingCount)}</Button>}
        <Button variant="secondary" data-testid={`${testId}-cancel`} disabled={Boolean(exporting) || saving} onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="secondary" data-testid={`${testId}-save`} disabled={Boolean(exporting) || saving || !drafts?.length || saveBlockers.length > 0} onClick={() => void saveCurrent()}>{saving ? "保存中…" : current.id ? "保存修改" : "保存这一张"}</Button>
        <Button variant="secondary" data-testid={`${testId}-export`} disabled={Boolean(exporting) || saving || !drafts?.length || blockers.length > 0} onClick={() => void exportOne()}>{exporting === "one" ? "导出中…" : `导出这一张`}</Button>
        <Button data-testid={`${testId}-export-all`} disabled={Boolean(exporting) || saving || !drafts?.length || queueBlockers.length > 0} onClick={() => void exportAll()}>{exporting === "all" ? "导出中…" : `全部导出（${queue.length} 张）`}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** 队列里某一张的表头（不含 `maker`：它与编辑无关，由预填带过来）。 */
function entryHeaderOf(entry: SlipEntry): Omit<FinanceSlipHeader, "maker"> {
  return {
    slip_no: entry.fields.slip_no,
    slip_date: entry.fields.slip_date,
    slip_method: entry.fields.slip_method,
    counterparty_name: entry.fields.counterparty_name,
    our_bank_name: entry.fields.our_bank_name,
    our_bank_account: entry.fields.our_bank_account,
    counterparty_bank_name: entry.fields.counterparty_bank_name,
    counterparty_bank_account: entry.fields.counterparty_bank_account,
    currency: entry.currency,
    exchange_rate: entry.fields.exchange_rate,
    amount_cny: entry.fields.amount_cny,
    attachment_count: entry.fields.attachment.trim() === "" ? -1 : Number(entry.fields.attachment),
    remark: entry.fields.remark,
  };
}
