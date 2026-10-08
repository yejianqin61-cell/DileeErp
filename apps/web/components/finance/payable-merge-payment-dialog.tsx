"use client";

// 「合并付款」弹窗：一次付款核销同一供应商的多条已确认应付（**可跨订单**，本轮用户确认要建）。
//
// 为什么需要它：集中付款单（`finance-slip-editor` 的队列）与行内「付款单」都只是**打印件** ——
// 它们按「收款单位 + 币种」把同一供应商的多条应付合到一张纸上，却从不写核销、不动应付状态、
// 不记银行流水。用户要的是「真的付掉并核销」，所以这一条走的是真单据：
//   POST /finance/supplier-payments            建一张草稿付款单（头：供应商 / 币种 / 金额 / 银行 / 科目）
//   POST /finance/supplier-payments/:id/post   过账并逐条核销（每条应付一行 allocation）
// 第二步才是钱动的地方：后端在同一个事务里写完核销行、刷新每条应付状态，事务外写收支流水
// （含 bankId，即银行余额）—— 见 `supplier-payment.service.ts:82-137`。
//
// ⚠️ **订单号只在所有勾选应付同属一个订单号时才写进付款单**（见 submit 的注释）：
// 后端 `supplier-payment.service.ts:96` 的订单一致性校验只在付款单**自己带 order_no** 时生效，
// 所以「不带 order_no」正是「一次付款核销多个订单的应付」的开关；带错了会把跨订单的核销
// 全部以 ALLOCATION_REFERENCE_MISMATCH 拒掉。
//
// 金额的唯一真源是**每一行的「本次核销金额」**：表头的「本次付款金额」由各行相加得出（只读显示），
// 两者不可能各说各话（反过来的话，用户改了合计却没改行，后端会以 PAYMENT_ALLOCATION_EXCEEDED 拒绝）。
// 相加走「整数分」（`parseSlipAmount` / `formatSlipAmount`，与付款单同一套，见 `lib/finance-slip.ts`）：
// 浮点求和会出现 `0.1 + 0.2 = 0.30000000000000004`，而这里的合计直接决定发出去的付款金额。
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { SearchableSelect } from "../ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { notifyError, notifySuccess } from "../ui/toaster";
import { ApiClientError, apiPost } from "../../lib/api-client";
import { formatBeijingDate } from "../../lib/audit-time";
import { formatSlipAmount, parseSlipAmount } from "../../lib/finance-slip";
import { money } from "./record-detail-dialog";

/** 供应商付款单的资源路径（`api-client` 会自己补 `/api/v1`），建单与过账都用它拼。 */
export const SUPPLIER_PAYMENTS_PATH = "/finance/supplier-payments";

/** 可核销的状态集合：与后端 `supplier-payment.service.ts:97` 的 `["confirmed","partially_paid"]` 一字不差。 */
export const SETTLEABLE_STATUSES = ["confirmed", "partially_paid"] as const;

/** 一条应付在「合并付款」里需要的全部字段（都来自台账列表接口，不必再逐条查详情）。 */
export type MergePayable = {
  id: string;
  payableNo: string;
  orderNo: string | null;
  supplierId: string;
  supplierName: string;
  currency: string;
  amount: string;
  outstanding: string;
};

/**
 * 一条应付能不能进「合并付款」：状态已确认 / 部分付款，且**未核销余额 > 0**。
 *
 * 余额用 `parseSlipAmount` 判定而不是 `Number(...) > 0`：它同时拦掉 "0.0000"、负数、
 * 空值与超过 4 位小数的脏数据（同一套正则与后端 DECIMAL(18,4) 对齐）。
 * 余额为 0（已付清）的条目没有可核销的东西，勾它只会得到一个必然 422 的付款单。
 */
export function isSettleable(entry: { status: string; outstanding_amount?: string | null }): boolean {
  if (!(SETTLEABLE_STATUSES as readonly string[]).includes(entry.status)) return false;
  return parseSlipAmount(entry.outstanding_amount ?? "") !== null;
}

/** 整批的唯一供应商 + 币种：锚点是**本次勾选里的第一条**可核销应付（它决定其余行能不能跟着选）。 */
export type SettleAnchor = { supplierId: string; supplierName: string; currency: string };

export function settleAnchorOf(rows: readonly MergePayable[]): SettleAnchor | null {
  const first = rows[0];
  return first ? { supplierId: first.supplierId, supplierName: first.supplierName, currency: first.currency } : null;
}

/**
 * 为什么某条应付**不能**跟着已选的那批一起核销（返回全部原因，界面按条显示）。
 *
 * 两条都是仓库的不变量，也是后端 `:96` 的显式拒绝条件：
 *   - 金额不跨币种合计：一笔付款一个币种；
 *   - 一张付款单只有一个供应商（`supplier_payments.supplier_id`）。
 * 界面先把不可选的行锁掉（并写出原因），而不是让她勾完再吃一个 422。
 */
export function settleLockReasons(anchor: SettleAnchor, row: { supplierId: string; currency: string }): string[] {
  const reasons: string[] = [];
  if (row.currency !== anchor.currency) reasons.push(`不能与已选的 ${anchor.currency} 应付合并在一次付款里（金额不跨币种合计）`);
  if (row.supplierId !== anchor.supplierId) reasons.push(`不能与已选的「${anchor.supplierName}」合并在一次付款里（一张付款单只对一个供应商）`);
  return reasons;
}

/** 本次付款金额 = 各行「本次核销金额」之和（唯一真源；行金额非法时该行按 0 计，合计只用于显示）。 */
export function settleTotal(rows: readonly MergePayable[], amounts: Record<string, string>): string {
  let units = 0n;
  for (const row of rows) units += parseSlipAmount(amounts[row.id] ?? "") ?? 0n;
  return formatSlipAmount(units);
}

/** 这一批的未核销余额合计（台账工具条上的提示用；同样走整数分，不在别处再写一套浮点求和）。 */
export function settleOutstandingTotal(rows: readonly MergePayable[]): string {
  let units = 0n;
  for (const row of rows) units += parseSlipAmount(row.outstanding) ?? 0n;
  return formatSlipAmount(units);
}

type Option = { value: string; label: string };

type Props = {
  open: boolean;
  /** 已选的可核销应付（同一供应商 + 同一币种由页面保证：冲突的勾选框会被锁掉）。 */
  rows: MergePayable[];
  /** 可选的支付银行账户（页面已加载的启用账户，`bankField` 同一份数据）。 */
  banks: Option[];
  /** 可选的会计科目（留空 = 后端按金额最大的应付来源自动归类）。 */
  subjects: Option[];
  onOpenChange: (open: boolean) => void;
  /** 核销成功后的收尾：页面负责刷新台账与汇总提示（弹窗只管这张付款单本身）。 */
  onSettled: (summary: { count: number; amount: string; currency: string; orderNo: string | null }) => void | Promise<void>;
};

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
/** 幂等键：一次弹窗**一个**（与工资、领料那些批量入口同一约定），重试命中同一张草稿。 */
const newIdempotencyKey = () => `web-supplier-payment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function PayableMergePaymentDialog({ open, rows, banks, subjects, onOpenChange, onSettled }: Props) {
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("银行转账");
  const [bankId, setBankId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [remark, setRemark] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 过账失败时留下的那句话：草稿单号 + 怎么继续。必须留在界面上，不能只闪一条 toast。 */
  const [draftNotice, setDraftNotice] = useState("");
  /**
   * 过账失败后**已经建出来的那张草稿**的金额。草稿金额不会因为重试而改变（幂等键固定，
   * 重试只会复用同一张），所以重试时核销合计一旦超过它就会一直失败 —— 这个上限要显式拦一次，
   * 否则用户会陷在「改了金额 → 一直报核销超过付款金额」的死循环里。
   */
  const [draftTotal, setDraftTotal] = useState<string | null>(null);
  const idempotencyKey = useRef("");

  const orderNos = useMemo(() => [...new Set(rows.map((row) => row.orderNo).filter((value): value is string => Boolean(value)))], [rows]);
  // 只有**恰好一个**订单号时才把它写进付款单；跨订单（0 个或多个）一律不写，后端因此按每条应付
  // 自己的订单号核销（注释见文件头与 submit）。
  const sharedOrderNo = orderNos.length === 1 ? orderNos[0] : null;
  const currency = rows[0]?.currency ?? "";
  const supplier = rows[0]?.supplierName ?? "";
  const total = settleTotal(rows, amounts);

  // 每次打开都是**新的一次付款**：日期回今天（北京时间）、银行回第一个启用账户、金额回各行全额、
  // 幂等键换一个。跟着 rows/banks 一起监听是刻意的：勾选变了，这张单子本来就不再是同一张。
  useEffect(() => {
    if (!open) return;
    setPaymentDate(formatBeijingDate(new Date()));
    setPaymentMethod("银行转账");
    setBankId(banks[0]?.value ?? "");
    setSubjectId("");
    setRemark("");
    setError("");
    setDraftNotice("");
    setDraftTotal(null);
    setBusy(false);
    setAmounts(Object.fromEntries(rows.map((row) => [row.id, row.outstanding])));
    idempotencyKey.current = newIdempotencyKey();
  }, [open, rows, banks]);

  /**
   * 点不动提交的那些原因（**全部**列出来，不是第一个）。
   *
   * 禁用的按钮点不动，所以原因必须事先写在界面上（与付款单编辑器同一条教训）：
   * 「金额超过未核销余额」这种事在后端是 422 PAYABLE_ALLOCATION_EXCEEDED，
   * 让财务先看见比让她点了才知道好。
   */
  const blockers = useMemo(() => {
    const problems: string[] = [];
    if (!rows.length) problems.push("没有已选的可核销应付");
    if (new Set(rows.map((row) => row.currency)).size > 1) problems.push("勾选的应付跨币种：一笔付款只能一个币种，请分开付");
    if (new Set(rows.map((row) => row.supplierId)).size > 1) problems.push("勾选的应付跨供应商：一笔付款只能一个供应商，请分开付");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) problems.push("请选择付款日期");
    if (!paymentMethod.trim()) problems.push("请填写付款方式");
    // 支付银行必填：过账会把 bankId 写进收支流水，没有它的付款不动任何银行账户余额
    // （`supplier-payment.service.ts:127-129`），财务对不出账。
    if (!bankId) problems.push("请选择支付银行账户（没有账户的付款不会体现在任何银行余额里）");
    for (const row of rows) {
      const units = parseSlipAmount(amounts[row.id] ?? "");
      if (units === null) { problems.push(`${row.payableNo} 的本次核销金额必须是大于零的数字（最多 4 位小数）`); continue; }
      const outstanding = parseSlipAmount(row.outstanding);
      if (outstanding !== null && units > outstanding) problems.push(`${row.payableNo} 的本次核销金额不能超过未核销余额 ${row.outstanding}`);
    }
    const totalUnits = parseSlipAmount(total);
    if (totalUnits === null) problems.push("本次付款金额必须大于零");
    // 已经有草稿（上一次过账失败）时，合计不能再超过草稿金额：重试复用同一张草稿，改大只会一直失败。
    const draftUnits = draftTotal ? parseSlipAmount(draftTotal) : null;
    if (totalUnits !== null && draftUnits !== null && totalUnits > draftUnits) problems.push(`本次核销合计不能超过已创建的草稿付款单金额 ${draftTotal} ${currency}（重试复用同一张草稿，只能改小）`);
    return problems;
  }, [rows, amounts, paymentDate, paymentMethod, bankId, total, draftTotal, currency]);

  /** 把每一行改回「该行全额未核销余额」（改坏了几行之后一键还原，不必逐格回忆原值）。 */
  function resetAmounts() { setAmounts(Object.fromEntries(rows.map((row) => [row.id, row.outstanding]))); }

  async function submit() {
    if (blockers.length || busy) return;
    setBusy(true);
    setError("");
    setDraftNotice("");
    // 发出去的行金额一律归一化成十进制字符串（与合计同一套解析/格式化，避免空格与多余尾零）。
    const allocations = rows.map((row) => ({ payable_entry_id: row.id, amount: formatSlipAmount(parseSlipAmount(amounts[row.id] ?? "") ?? 0n) }));
    // 建单：金额就是各行之和的合计（唯一真源），币种/供应商来自这一批本身。
    const createBody: Record<string, unknown> = {
      supplier_id: rows[0].supplierId,
      payment_date: paymentDate,
      amount: total,
      currency,
      payment_method: paymentMethod.trim(),
      bank_id: bankId,
      idempotency_key: idempotencyKey.current,
    };
    // 跨订单时必须**省略** order_no（后端只校验付款单自带的那个订单号）；
    // 同订单时带上它，付款单与订单对得上，orderSummary 之类的按订单汇总也看得到这笔付款。
    if (sharedOrderNo) createBody.order_no = sharedOrderNo;
    // 会计科目在建单时就落库（`create` 会校验它存在且启用），过账时后端优先用它
    // （`post` 的 subjectId 是「临时覆盖」入口）—— 两处都送只会多一个能对不上的地方。
    if (subjectId) createBody.subject_id = subjectId;
    if (remark.trim()) createBody.remark = remark.trim();

    let created: { id: string; paymentNo: string };
    try {
      created = (await apiPost<{ id: string; paymentNo: string }>(SUPPLIER_PAYMENTS_PATH, createBody)).data;
    } catch (cause) {
      // 建单失败（含「已存在同样草稿」）时**什么都没发生**：留在弹窗里说清原因，不发第二步。
      const message = messageOf(cause, "付款单创建失败");
      setError(message);
      notifyError(message);
      setBusy(false);
      return;
    }
    try {
      await apiPost(`${SUPPLIER_PAYMENTS_PATH}/${created.id}/post`, { allocations });
    } catch (cause) {
      // 过账失败但**草稿已经建出来了**：必须点名它是哪张、怎么继续，否则财务以为这笔没发生过，
      // 而库里躺着一张她不知道的草稿付款单。幂等键是这次弹窗固定的，所以再点一次提交会
      // 命中同一张草稿（create 的 idempotency_key 重放，见 `supplier-payment.service.ts:56-61`），
      // 不会撞上「重复草稿」守卫、也不会多建一张。
      const message = `已创建草稿付款单 ${created.paymentNo}（合计 ${total} ${currency}），但核销未完成：${messageOf(cause, "核销失败")}。草稿不动任何金额与状态；在本弹窗再次提交会复用这张草稿继续核销（不会重复建单，核销合计也不能超过草稿金额）。若台账上这些应付已经显示核销完成，说明上一次提交其实成功了，刷新即可。`;
      setDraftNotice(message);
      setDraftTotal(total);
      notifyError(message);
      setBusy(false);
      return;
    }
    notifySuccess(`已付款并核销 ${rows.length} 条应付（${total} ${currency}）`);
    onOpenChange(false);
    await onSettled({ count: rows.length, amount: total, currency, orderNo: sharedOrderNo });
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent data-testid="payable-merge-dialog">
      <DialogHeader><DialogTitle>合并付款：{supplier} / {currency}，{rows.length} 条应付</DialogTitle></DialogHeader>
      <DialogBody>
        {/* 一句话说清这次要发生什么（数据，不是说明文）：涉及哪几个订单、为什么行与合计只有一个真源。 */}
        <p className="panel-note" data-testid="payable-merge-scope">
          本次付款 {total} {currency}，一次核销 {rows.length} 条已确认应付；涉及订单 {orderNos.length ? orderNos.join("、") : "无"}{sharedOrderNo ? "" : "（跨订单：付款单不写订单号，逐条按应付自己的订单号核销）"}
        </p>
        <p className="panel-note">合并付款只对同一供应商 + 同一币种开放；本次核销金额默认该行未核销余额，可改小做部分付款，合计随各行自动变。</p>
        <div className="filter-bar">
          <label>付款日期<Input type="date" data-testid="payable-merge-date" value={paymentDate} disabled={busy} onChange={(event) => setPaymentDate(event.target.value)} /></label>
          <label>付款方式<Input data-testid="payable-merge-method" value={paymentMethod} disabled={busy} placeholder="银行转账" onChange={(event) => setPaymentMethod(event.target.value)} /></label>
          <label>支付银行账户
            <Select value={bankId} onValueChange={setBankId} disabled={busy}>
              <SelectTrigger data-testid="payable-merge-bank"><SelectValue placeholder={banks.length ? "请选择支付银行账户" : "先在【财务 → 银行账户】建一个账户"} /></SelectTrigger>
              <SelectContent>{banks.map((bank) => <SelectItem key={bank.value} value={bank.value}>{bank.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>会计科目（可选）
            <SearchableSelect testId="payable-merge-subject" value={subjectId} options={[{ value: "", label: "（不指定：按金额最大的应付来源自动归类）" }, ...subjects]} label="会计科目" disabled={busy} onChange={setSubjectId} />
          </label>
        </div>
        <label className="ui-form-item">备注<Textarea data-testid="payable-merge-remark" value={remark} disabled={busy} onChange={(event) => setRemark(event.target.value)} /></label>
        <div data-testid="payable-merge-rows">
          <table className="data-table">
            <thead><tr><th>订单号</th><th>供应商</th><th>币种</th><th>应付金额</th><th>未核销余额</th><th>本次核销金额</th></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.id} data-testid={`payable-merge-row-${row.id}`}>
                <td>{row.orderNo ?? "无"}</td>
                <td>{row.supplierName}</td>
                <td>{row.currency}</td>
                <td>{money(row.amount, row.currency)}</td>
                <td>{money(row.outstanding, row.currency)}</td>
                <td><Input inputMode="decimal" aria-label={`${row.payableNo} 本次核销金额`} data-testid={`payable-merge-amount-${row.id}`} value={amounts[row.id] ?? ""} disabled={busy} onChange={(event) => setAmounts((current) => ({ ...current, [row.id]: event.target.value }))} /></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="action-row">
          {/* 合计是**派生值**（只读）：它是各行相加的结果，改任何一行这里跟着变 —— 两者不会各说各话。 */}
          <span className="panel-note" data-testid="payable-merge-total">本次付款金额 {total} {currency}（= 各行「本次核销金额」合计，改某一行这里跟着变）</span>
          <Button size="sm" variant="ghost" data-testid="payable-merge-reset" disabled={busy} onClick={resetAmounts}>按未核销余额重填</Button>
        </div>
        {blockers.length ? <ul className="panel-note status-error" data-testid="payable-merge-blockers">{blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {error ? <p className="status-error" data-testid="payable-merge-error">{error}</p> : null}
        {draftNotice ? <p className="status-error" data-testid="payable-merge-draft-notice">{draftNotice}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid="payable-merge-cancel" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button data-testid="payable-merge-submit" disabled={busy || blockers.length > 0} onClick={() => void submit()}>{busy ? "提交中…" : "付款并核销"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
