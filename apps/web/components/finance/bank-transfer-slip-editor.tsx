"use client";

// 跨行转账单编辑器 + 打印视图（财务 2026-09-24）。
//
// 财务的原话：「银行账户互转的时候，跨行转账单.html，支持编辑这个样式的表单，并且支持导出打印」。
// 模板在 `example/财务/跨行转账单.html`：标题 + 单据编号 + 三段（付款方 / 收款方 / 转账金额）
// + 金额大写 + 用途附言 + 四个签字格 + 一行注。
//
// 这个组件就照那个文件排版，**每一格都是可编辑的输入框**（而不是「上面一张表单、下面一张预览」）：
// 财务要的是「编辑这个样式的表单」——她填的就是打印出来的东西，两套版式才会出现「屏幕上对的、
// 纸上错的」。输入框样式做成无边框（见 globals.css 的 `.transfer-slip-input`），
// 于是屏幕上它看起来就是一张填空的单子，打印时值落在格子里（`@media print` 只留 `.transfer-slip-sheet`）。
//
// 两条出口：
//   - 「打印 / 另存 PDF」：走浏览器打印（与记账凭证纸同一做法，见 voucher-workspace.tsx）；
//   - 「导出 XLSX」：与收/付款单同一套（服务端渲染，全站导出件都落数值类型）。
//
// ⚠️ 金额大写：界面**不算**中文大写（只有后端一份实现）。预填带上来的是后端算好的；
// 财务一改原币/折合人民币/汇率就由 `clearWordsOnAmountChange` **清空**（留空 = 后端按金额算），
// 她自己写就必须与后端算出来的一致（不一致由后端 422 给出正确写法）。这样纸上永远不会出现
// 一段过期的大写。
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { LoadingState } from "../feedback/states";
import { downloadPost } from "../../lib/download";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  TRANSFER_SLIP_LABELS as labels,
  clearWordsOnAmountChange,
  transferSlipBlockers,
  transferSlipExportPath,
  transferSlipFileName,
  transferSlipPayload,
  type BankTransferSlip,
  type TransferSlipField,
} from "../../lib/bank-transfer-slip";

/** 占位预填（`useState` 的初值，避免用 `null` 把每格都变成可空判断）：真正的值在打开时铺进来。 */
const EMPTY: BankTransferSlip = {
  transfer_id: "", document_no: "", payer_name: "", payer_account: "", payer_bank: "",
  payee_name: "", payee_account: "", payee_bank: "", payee_bank_no: "",
  transfer_date: "", currency: "", exchange_rate: "", amount_original: "", amount_cny: "",
  amount_in_words: "", remark: "", maker: "", reviewer: "", cashier: "", approver: "",
};

export default function BankTransferSlipEditor({ open, onOpenChange, slip: draft, loading, error }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 后端预填的单子；为 null 时（还没取到 / 取失败）只显示加载或错误。 */
  slip: BankTransferSlip | null;
  loading: boolean;
  /** 预填失败的原因（后端 404 / 422 的说明）。 */
  error: string;
}) {
  const [slip, setSlip] = useState<BankTransferSlip>(EMPTY);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState("");

  // 每次**打开**从预填结果重新铺一遍：预填每次请求都是新对象，而它只在打开那一刻变。
  useEffect(() => {
    if (!open || !draft) return;
    setSlip(draft);
    setProblem("");
  }, [open, draft]);

  const blockers = useMemo(() => transferSlipBlockers(slip), [slip]);
  const update = (field: TransferSlipField | "document_no", value: string) => setSlip((current) => ({ ...current, [field]: value }));
  /** 金额类字段的改动要连带清空大写（见文件头的说明）。 */
  const updateAmount = (field: "amount_original" | "amount_cny" | "exchange_rate", value: string) =>
    setSlip((current) => clearWordsOnAmountChange(current, { [field]: value }));

  async function exportSlip() {
    if (blockers.length) { setProblem(blockers.join("；")); return; }
    setExporting(true);
    setProblem("");
    try {
      // 大写留空时后端按折合人民币（或人民币那条腿）重算，所以这里提交的空串是「让系统算」的意思。
      await downloadPost(transferSlipExportPath(), transferSlipPayload(slip), transferSlipFileName(slip.document_no));
      notifySuccess(`已导出跨行转账单 ${slip.document_no.trim()}`);
      onOpenChange(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "跨行转账单导出失败";
      setProblem(message);
      notifyError(message);
    } finally {
      setExporting(false);
    }
  }

  /**
   * 一格可编辑的输入框。
   *
   * 用原生 `<input>` 而不是 ui/input：后者的边框与高度是为表单页设计的，塞进这张纸上会
   * 变成一排方框（屏幕上就不再是「一张单子」了），打印出来也会多出一堆线框。
   */
  const cell = (field: TransferSlipField, options: { type?: string; placeholder?: string } = {}) =>
    <input
      className="transfer-slip-input"
      data-testid={`transfer-slip-field-${field}`}
      type={options.type ?? "text"}
      value={slip[field]}
      placeholder={options.placeholder}
      onChange={(event) => update(field, event.target.value)}
    />;

  return <Dialog open={open} onOpenChange={(next) => { if (!exporting) onOpenChange(next); }}>
    <DialogContent className="transfer-slip-dialog" data-testid="transfer-slip-editor">
      <DialogHeader><DialogTitle>{labels.title}{slip.document_no.trim() ? ` ${slip.document_no.trim()}` : ""}</DialogTitle></DialogHeader>
      <DialogBody>
        {loading ? <LoadingState label="正在按互转单预填跨行转账单" /> : !draft ? <p className="status-error" role="alert" data-testid="transfer-slip-draft-error">{error || "预填失败"}</p> : <>
          <div className="transfer-slip-sheet" data-testid="transfer-slip-sheet">
            <h2 className="transfer-slip-title">{labels.title}</h2>
            <div className="transfer-slip-no">
              {labels.document_no}：
              <input className="transfer-slip-input" data-testid="transfer-slip-field-document_no" value={slip.document_no} onChange={(event) => update("document_no", event.target.value)} />
            </div>

            <table className="transfer-slip-table">
              <tbody>
                <tr className="transfer-slip-section"><td colSpan={4}>{labels.payerSection}</td></tr>
                <tr>
                  <td className="transfer-slip-label">{labels.payer_name}</td>
                  <td colSpan={3}>{cell("payer_name")}</td>
                </tr>
                <tr>
                  <td className="transfer-slip-label">{labels.payer_account}</td>
                  <td>{cell("payer_account")}</td>
                  <td className="transfer-slip-label">{labels.payer_bank}</td>
                  <td>{cell("payer_bank")}</td>
                </tr>

                <tr className="transfer-slip-section"><td colSpan={4}>{labels.payeeSection}</td></tr>
                <tr>
                  <td className="transfer-slip-label">{labels.payee_name}</td>
                  <td colSpan={3}>{cell("payee_name")}</td>
                </tr>
                <tr>
                  <td className="transfer-slip-label">{labels.payee_account}</td>
                  <td>{cell("payee_account")}</td>
                  <td className="transfer-slip-label">{labels.payee_bank}</td>
                  <td>{cell("payee_bank")}</td>
                </tr>
                <tr>
                  {/* 联行号目前在银行账户档案里没有存档（模板上有这一格），所以预填留空、由财务填。 */}
                  <td className="transfer-slip-label">{labels.payee_bank_no}</td>
                  <td>{cell("payee_bank_no")}</td>
                  <td className="transfer-slip-label">{labels.transfer_date}</td>
                  <td>{cell("transfer_date", { type: "date" })}</td>
                </tr>

                <tr className="transfer-slip-section"><td colSpan={4}>{labels.amountSection}</td></tr>
                <tr>
                  <td className="transfer-slip-label">{labels.currency}</td>
                  <td>{cell("currency")}</td>
                  <td className="transfer-slip-label">{labels.exchange_rate}</td>
                  <td>{cell("exchange_rate", { placeholder: "人民币转账可留空" })}</td>
                </tr>
                <tr>
                  <td className="transfer-slip-label">{labels.amount_original}</td>
                  <td className="transfer-slip-amount">
                    <input className="transfer-slip-input" inputMode="decimal" data-testid="transfer-slip-field-amount_original" value={slip.amount_original} onChange={(event) => updateAmount("amount_original", event.target.value)} />
                  </td>
                  <td className="transfer-slip-label">{labels.amount_cny}</td>
                  <td className="transfer-slip-amount">
                    <input className="transfer-slip-input" inputMode="decimal" data-testid="transfer-slip-field-amount_cny" value={slip.amount_cny} onChange={(event) => updateAmount("amount_cny", event.target.value)} />
                  </td>
                </tr>
                <tr className="transfer-slip-cap">
                  <td className="transfer-slip-label">{labels.amount_in_words}</td>
                  {/* 留空 = 导出时按金额算（界面不算中文大写，只有后端一份实现）。 */}
                  <td colSpan={3}>{cell("amount_in_words", { placeholder: "留空则导出时按金额自动计算" })}</td>
                </tr>
                <tr className="transfer-slip-cap">
                  <td className="transfer-slip-label">{labels.remark}</td>
                  <td colSpan={3}>{cell("remark")}</td>
                </tr>
              </tbody>
            </table>

            <table className="transfer-slip-sign">
              <tbody>
                <tr>
                  {(["maker", "reviewer", "cashier", "approver"] as const).map((field) => <td key={field}>
                    <span className="transfer-slip-sign-label">{labels[field]}：</span>{cell(field)}
                  </td>)}
                </tr>
              </tbody>
            </table>

            <p className="transfer-slip-note">{labels.note}</p>
          </div>
          {/* 下面这两行在打印时看不见（@media print 只留 .transfer-slip-sheet），只在屏幕上拦人。 */}
          {blockers.length > 0 && <p className="panel-note" data-testid="transfer-slip-blockers">{blockers.join("；")}</p>}
          {problem && <p className="status-error" role="alert" data-testid="transfer-slip-error">{problem}</p>}
        </>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid="transfer-slip-cancel" disabled={exporting} onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="secondary" data-testid="transfer-slip-print" disabled={exporting || !draft} onClick={() => window.print()}>打印 / 另存 PDF</Button>
        <Button data-testid="transfer-slip-export" disabled={exporting || !draft || blockers.length > 0} onClick={() => void exportSlip()}>{exporting ? "导出中…" : "导出 XLSX"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
