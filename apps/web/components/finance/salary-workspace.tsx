"use client";

// 工资管理的两个二级页共用这一个工作区组件（由路由决定 mode，不再用查询参数切 tab）：
//   - /finance/salary/ledger   工资台账：可编辑满页表格（mode="ledger"）
//   - /finance/salary/payments 工资付款：当月台账只留「总工资」，付款/冲销在表格行内完成（mode="payments"）
//
// 用户需求（第 3、4 条）在这里落地：
//   - 工资台账：进页面/切月份先自动导入本月全部员工，车间工人的计件/计时工资由生产日报自动汇总进
//     「基本工资」且不可手改，绩效/房补/迟到/旷工/早退逐格可改；
//   - 工资付款：把当月工资台账直接搬过来（类目列全部收掉），一行的付款是一次调用完成的
//     「生成应付 → 建付款草稿 → 核销过账」，冲销把该台账下已过账的付款整体回退；
//   - 两个表格共用「月份 / 部门 / 岗位 / 员工姓名或工号」筛选。
//
// 口径与治理：
//   - 自动导入是幂等的（后端只补建缺失的草稿台账），因此「浏览一下」不会重复写库；
//   - 表格里只有 draft / expired 台账可逐格改：已确认台账要先「回到草稿」（需原因），
//     部分支付/已支付/已关闭只能走工资调整单或付款冲销 —— 这是既有的状态机，不因为「表格能编辑」而放开；
//   - 工资付款只对已确认/部分支付且未付 > 0 的台账开放，其余行只显示不可付款的原因；
//   - 员工姓名/工号是本地过滤（与任务 04 的既有约定一致：输入即响应，不打接口）。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DataTable } from "../data/data-table";
import { ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../ui/toaster";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { PayrollSheet, type PayrollSheetColumn } from "./payroll-sheet";

/** 工作区模式：工资台账 / 工资付款。两个二级页各用一个。 */
export type SalaryMode = "ledger" | "payments";

type Employee = { id: string; employeeNo: string; name: string; employeeType: string; department?: { id: string; name: string } | null; position?: { id: string; name: string } | null };
type Department = { id: string; name: string; code: string };
type Position = { id: string; name: string; code: string; departmentId: string };
type PayrollPayable = { id: string; ledgerId: string; payableNo: string; amount: string; currency: string; status: string };
type SnapshotLine = { report_date?: string; order_no?: string; operation_name?: string; wage_mode?: string; report_count?: number; quantity?: string; duration_hours?: string; amount?: string };
type Ledger = {
  id: string;
  ledgerNo: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  baseSalary: string;
  productionSourceAmount: string;
  overtimeAmount: string;
  attendanceDeduction: string;
  lateDeduction: string;
  absenceDeduction: string;
  earlyLeaveDeduction: string;
  performanceAmount: string;
  allowanceAmount: string;
  housingAllowance: string;
  socialInsurance: string;
  individualTax: string;
  otherAdjustment: string;
  basicSalaryAmount: string;
  otherAdjustmentAmount: string;
  payableAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  status: string;
  remark: string | null;
  sourceSnapshot?: SnapshotLine[];
  adjustments?: Array<{ id: string; adjustmentNo: string; adjustmentType: string; effect: string; amount: string; reason: string; status: string }>;
  allocations?: Array<{ id: string; amount: string; status: string; payment?: { paymentNo: string; status: string; paymentDate: string } | null }>;
  employee: Employee;
};
/** 后端按月导入全部员工的返回：既有覆盖度计数，也有逐人明细，用于「不能漏单」的核对。 */
type ImportResult = {
  month: string;
  period_start: string;
  period_end: string;
  currency: string;
  candidates: number;
  created: number;
  existing: number;
  not_employed: number;
  report_count: number;
  ledgers: Array<{ id: string; ledger_no: string; employee_no: string; employee_name: string; employee_type: string; production_amount: string; report_count: number; day_count: number; order_count: number; operation_count: number }>;
  skipped: Array<{ employee_no: string; employee_name: string; ledger_no: string; status: string; period_start: string; period_end: string }>;
};
const statusLabels: Record<string, string> = { draft: "草稿", confirmed: "已确认", expired: "已过期", partially_paid: "部分支付", paid: "已支付", closed: "已关闭" };
const payableStatusLabels: Record<string, string> = { draft: "应付草稿", confirmed: "应付已确认", partially_paid: "应付部分支付", paid: "应付已支付", reversed: "应付已冲销", voided: "应付已作废" };
const editableStatuses = ["draft", "expired"];
const LOCKED_HINT = "已确认/已付款台账不能直接改：请先「回到草稿」（需填原因），或用工资调整单";
const AUTO_HINT = "由系统按类目自动计算，不可手改";
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> | void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");
const currentMonth = () => new Date().toISOString().slice(0, 7);
/** 金额格式：非负、最多 4 位小数（与后端 Decimal(18,4) 同量纲）。付款金额在本地先校验一次。 */
const MONEY = /^\d+(?:\.\d{1,4})?$/;
/** 金额显示：最多 4 位小数、去掉尾随零（后端返回 Decimal(18,4) 的字符串）。 */
const dec = (value: string | number | undefined) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  const text = number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" || text === "" ? "0" : text;
};

/** 表格里可编辑的类目 → 后端字段名（键必须与 PayrollSheet 的列 key 一致）。 */
const CATEGORY_FIELDS: Record<string, string> = { baseSalary: "base_salary", performance: "performance_amount", housing: "housing_allowance", late: "late_deduction", absence: "absence_deduction", earlyLeave: "early_leave_deduction" };
const CATEGORY_LABELS: Record<string, string> = { baseSalary: "基本工资", performance: "绩效", housing: "房补", late: "迟到扣款", absence: "旷工扣款", earlyLeave: "早退扣款" };

export default function SalaryWorkspace({ mode, testId = mode === "payments" ? "page-finance-salary-payments" : "page-finance-salary-ledger", initialMonth = "", initialDepartmentId = "", initialPositionId = "" }: {
  /** ledger = 工资台账（可编辑满页表格）；payments = 工资付款（当月台账只留「总工资」+ 行内付款/冲销）。 */
  mode: SalaryMode;
  testId?: string;
  initialMonth?: string;
  initialDepartmentId?: string;
  initialPositionId?: string;
}) {
  const [month, setMonth] = useState(initialMonth || currentMonth());
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [positionId, setPositionId] = useState(initialPositionId);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [payables, setPayables] = useState<PayrollPayable[]>([]);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  // 工资付款表格：每行一个金额输入（默认等于该行未付），付款日期与付款方式在表格上方统一给。
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState("银行转账");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  // ready = 本月导入已完成：列表必须等它，否则会在导入写库之前把空表读回来。
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<Ledger | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Ledger | null>(null);
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };

  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);
  // 部门/岗位是静态主数据，只在挂载时拉一次；岗位按所选部门收窄。
  useEffect(() => {
    let cancelled = false;
    void Promise.all([apiGet<Department[]>("/production/departments"), apiGet<Position[]>(departmentId ? `/production/positions?department_id=${departmentId}` : "/production/positions")])
      .then(([d, p]) => { if (!cancelled) { setDepartments(d.data); setPositions(p.data); } })
      .catch(() => { if (!cancelled) { setDepartments([]); setPositions([]); } });
    return () => { cancelled = true; };
  }, [departmentId]);

  /**
   * 「每个月自动先导入全部员工」：进入页面与切换月份都会先跑一次幂等导入。
   *
   * 不带部门/岗位条件：导入的是**全部**在册员工（用户要求），部门/岗位只用来筛选要看的那部分。
   * 幂等由后端保证：已存在的台账一行都不动，所以重复浏览同一月份不会重复写库。
   */
  const runImport = useCallback(async (silent = false) => {
    setImporting(true);
    setReady(false);
    setImportError("");
    try {
      const result = await apiPost<ImportResult>("/hr/payroll-ledgers/import-month", { month });
      setImportResult(result.data);
      if (result.data.created && !silent) notifySuccess(`已自动导入本月 ${result.data.created} 名员工的工资台账`);
    } catch (cause) {
      setImportError(messageOf(cause, "自动导入本月员工失败"));
    } finally {
      setImporting(false);
      setReady(true);
    }
  }, [month]);

  useEffect(() => { void runImport(); }, [runImport]);

  const load = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (month) params.set("month", month);
      if (departmentId) params.set("department_id", departmentId);
      if (positionId) params.set("position_id", positionId);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      // 工资付款页只用台账列表（当月台账搬过去当付款行，核销明细已经 include 在里面）；
      // 工资应付与员工清单只有工资台账页用得上，不为另一页白拉。
      const [ledgerResult, payableResult, employeeResult] = await Promise.all([
        apiGet<Ledger[]>(`/hr/payroll-ledgers${suffix}`),
        mode === "ledger" ? apiGet<PayrollPayable[]>("/hr/payroll-payables") : Promise.resolve({ data: [] as PayrollPayable[] }),
        mode === "ledger" ? apiGet<Employee[]>("/production/employees") : Promise.resolve({ data: [] as Employee[] }),
      ]);
      setLedgers(ledgerResult.data);
      setPayables(payableResult.data);
      setEmployees(employeeResult.data);
    } catch (cause) {
      setError(messageOf(cause, "工资数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [departmentId, mode, month, positionId, ready]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: Promise<unknown>, success: string) {
    setError("");
    try {
      await action;
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  /**
   * 弹窗里的动作：失败必须把错误**抛回去**，ActionDialog 才会留在弹窗里把原因显示出来。
   * 吞掉异常会让弹窗静默关闭，用户只看到「什么都没发生」（这一条踩过一次）。
   */
  async function submitDialog(action: Promise<unknown>, success: string) {
    try {
      await action;
      notifySuccess(success);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "操作失败");
      notifyError(message);
      throw new Error(message);
    }
  }

  /** 表格逐格保存：成功刷新（金额与应发都要重算），失败把原因抛回表格标红。 */
  async function commitCell(ledger: Ledger, key: string, value: string) {
    const field = CATEGORY_FIELDS[key];
    if (!field) throw new Error(`未知的工资类目：${key}`);
    try {
      await apiPatch(`/hr/payroll-ledgers/${ledger.id}`, { [field]: value });
      notifySuccess(`${ledger.employee.name} 的${CATEGORY_LABELS[key]}已更新为 ${value}`);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "保存失败");
      notifyError(message);
      throw new Error(message);
    }
  }

  function openCreate() {
    setDialog({
      title: "新建工资台账",
      fields: [
        { name: "employee_name", label: "员工姓名", type: "select", required: true, options: employees.map((item) => ({ value: item.name, label: `${item.employeeNo} / ${item.name} / ${item.employeeType === "workshop" ? "车间" : "非车间"}` })) },
        { name: "period_start", label: "周期开始", type: "date", required: true, defaultValue: month ? `${month}-01` : "" },
        { name: "period_end", label: "周期结束", type: "date", required: true, defaultValue: month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : "" },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        { name: "base_salary", label: "基本工资（车间工人由生产日报自动汇总，不要在此填写）", type: "number", defaultValue: "0" },
        { name: "performance_amount", label: "绩效", type: "number", defaultValue: "0" },
        { name: "housing_allowance", label: "房补", type: "number", defaultValue: "0" },
        { name: "late_deduction", label: "迟到扣款", type: "number", defaultValue: "0" },
        { name: "absence_deduction", label: "旷工扣款", type: "number", defaultValue: "0" },
        { name: "early_leave_deduction", label: "早退扣款", type: "number", defaultValue: "0" },
        { name: "overtime_amount", label: "加班工资（历史类目）", type: "number", defaultValue: "0" },
        { name: "attendance_deduction", label: "考勤扣款（历史类目）", type: "number", defaultValue: "0" },
        { name: "allowance_amount", label: "补贴金额（历史类目）", type: "number", defaultValue: "0" },
        { name: "social_insurance", label: "社保", type: "number", defaultValue: "0" },
        { name: "individual_tax", label: "个税", type: "number", defaultValue: "0" },
        { name: "other_adjustment", label: "其他调整", type: "number", defaultValue: "0" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (values) => submitDialog(apiPost("/hr/payroll-ledgers/generate", { ...values }), "工资台账已创建"),
    });
  }

  function editLedger(ledger: Ledger) {
    setDialog({
      title: `编辑工资台账：${ledger.ledgerNo}`,
      fields: [
        { name: "employee_id", label: "员工", type: "select", required: true, defaultValue: ledger.employeeId, options: employees.map((item) => ({ value: item.id, label: `${item.employeeNo} / ${item.name}` })) },
        { name: "period_start", label: "周期开始", type: "date", required: true, defaultValue: ledger.periodStart.slice(0, 10) },
        { name: "period_end", label: "周期结束", type: "date", required: true, defaultValue: ledger.periodEnd.slice(0, 10) },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, ledger.currency), defaultValue: ledger.currency },
        { name: "base_salary", label: "基本工资（车间工人由生产日报自动汇总）", type: "number", defaultValue: ledger.baseSalary },
        { name: "performance_amount", label: "绩效", type: "number", defaultValue: ledger.performanceAmount },
        { name: "housing_allowance", label: "房补", type: "number", defaultValue: ledger.housingAllowance },
        { name: "late_deduction", label: "迟到扣款", type: "number", defaultValue: ledger.lateDeduction },
        { name: "absence_deduction", label: "旷工扣款", type: "number", defaultValue: ledger.absenceDeduction },
        { name: "early_leave_deduction", label: "早退扣款", type: "number", defaultValue: ledger.earlyLeaveDeduction },
        { name: "overtime_amount", label: "加班工资（历史类目）", type: "number", defaultValue: ledger.overtimeAmount },
        { name: "attendance_deduction", label: "考勤扣款（历史类目）", type: "number", defaultValue: ledger.attendanceDeduction },
        { name: "allowance_amount", label: "补贴金额（历史类目）", type: "number", defaultValue: ledger.allowanceAmount },
        { name: "social_insurance", label: "社保", type: "number", defaultValue: ledger.socialInsurance },
        { name: "individual_tax", label: "个税", type: "number", defaultValue: ledger.individualTax },
        { name: "other_adjustment", label: "其他调整", type: "number", defaultValue: ledger.otherAdjustment },
        { name: "remark", label: "备注", type: "textarea", defaultValue: ledger.remark ?? "" },
        ...(ledger.status === "confirmed" ? [{ name: "reason", label: "修改原因", type: "textarea", required: true } as ActionField] : []),
      ],
      submit: (values) => submitDialog(apiPatch(`/hr/payroll-ledgers/${ledger.id}`, { ...values }), "工资台账已更新（已回到草稿）"),
    });
  }

  function reopenLedger(ledger: Ledger) {
    setDialog({ title: `工资台账回退草稿：${ledger.ledgerNo}`, fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (values) => submitDialog(apiPost(`/hr/payroll-ledgers/${ledger.id}/reopen`, values), "工资台账已回到草稿") });
  }

  /**
   * 工资付款表格的行内付款：一次调用完成「生成应付 → 建付款 → 核销过账」。
   *
   * 金额先在前端做同口径校验（与后端一致的未付上限），把最常见的输错挡在本地，
   * 后端仍会再校验一次（前端校验不是门禁）。
   */
  async function payLedgerRow(ledger: Ledger) {
    const raw = (amounts[ledger.id] ?? dec(ledger.outstandingAmount)).trim();
    const value = raw === "" ? "0" : raw;
    const available = Number(ledger.outstandingAmount);
    if (!MONEY.test(value) || Number(value) <= 0) { notifyError("付款金额必须是不小于 0 的数字，最多 4 位小数"); return; }
    if (Number(value) > available) { notifyError(`付款金额不能超过未付 ${dec(ledger.outstandingAmount)}`); return; }
    if (paying) return;
    setPaying(ledger.id);
    try {
      await apiPost(`/hr/payroll-ledgers/${ledger.id}/pay`, { amount: value, payment_date: paymentDate, payment_method: paymentMethod });
      notifySuccess(`${ledger.employee.name} 已付款 ${value}`);
      setAmounts((current) => { const next = { ...current }; delete next[ledger.id]; return next; });
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "付款失败"));
    } finally {
      setPaying("");
    }
  }

  /** 行内冲销：把该台账下所有已过账的工资付款整体冲销（原因必填，服务端强制）。 */
  function openUnpay(ledger: Ledger, posted: Array<{ amount: string; payment?: { paymentNo: string } | null }>) {
    const total = posted.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(4);
    setDialog({
      title: `冲销工资付款：${ledger.employee.employeeNo} / ${ledger.employee.name}`,
      fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }],
      submit: (values) => submitDialog(apiPost(`/hr/payroll-ledgers/${ledger.id}/unpay`, values), `${ledger.employee.name} 的 ${posted.length} 张工资付款已冲销（合计 ${total}）`),
    });
  }

  const payableByLedger = useMemo(() => new Map(payables.map((item) => [item.ledgerId, item])), [payables]);

  const actionColumns = (ledger: Ledger) => {
    const payable = payableByLedger.get(ledger.id);
    return <div className="action-row" onClick={(event) => event.stopPropagation()} data-testid={`salary-actions-${ledger.id}`}>
      <Button size="sm" variant="secondary" onClick={() => setDetail(ledger)}>详情</Button>
      {ledger.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/confirm`), "工资台账已确认")}>确认</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button><Button size="sm" variant="destructive" onClick={() => void run(apiRequest(`/hr/payroll-ledgers/${ledger.id}`, { method: "DELETE" }), "工资台账已删除")}>删除</Button></>}
      {["confirmed", "expired"].includes(ledger.status) && <><Button size="sm" variant="secondary" onClick={() => reopenLedger(ledger)}>回到草稿</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button></>}
      {ledger.status === "confirmed" && !payable && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/payable`, {}), "工资应付已生成")}>生成应付</Button>}
      {payable?.status === "draft" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-payables/${payable.id}/confirm`), "工资应付已确认")}>确认应付</Button>}
      {payable && <span data-testid={`salary-payable-status-${ledger.id}`}>{payableStatusLabels[payable.status] ?? payable.status}</span>}
      {ledger.status === "paid" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/close`), "工资台账已关闭")}>关闭</Button>}
    </div>;
  };

  /**
   * 工资台账列：六个可编辑类目 + 基本工资（车间只读）+ 两个自动列。
   *
   * 可编辑的两条硬规则：
   *   1. 车间工人的「基本工资」= 生产日报自动汇总，不可手改（用户明确要求）；
   *   2. 只有 draft / expired 台账可改，其余状态走回退或调整单（既有状态机）。
   */
  const sheetColumns: PayrollSheetColumn<Ledger>[] = [
    { key: "employeeNo", header: "工号", text: (row) => row.employee.employeeNo },
    { key: "name", header: "姓名", text: (row) => row.employee.name },
    { key: "department", header: "部门", text: (row) => row.employee.department?.name ?? "-" },
    { key: "position", header: "岗位", text: (row) => row.employee.position?.name ?? "-" },
    { key: "employeeType", header: "类型", text: (row) => (row.employee.employeeType === "workshop" ? "车间" : "非车间") },
    { key: "period", header: "周期", text: (row) => `${day(row.periodStart)} 至 ${day(row.periodEnd)}` },
    // 工资一律人民币核算（币种在生成/编辑台账时选定，默认 CNY）；这里只是把它展示出来，
    // 免得跟其它财务单据（可多币种）混在一起时看不出金额单位。
    { key: "currency", header: "币种", text: (row) => row.currency || "CNY", readOnlyHint: () => "工资统一以人民币（CNY）核算；生成或编辑台账时的币种字段与此一致" },
    {
      key: "baseSalary", header: "基本工资", numeric: true, total: true,
      text: (row) => dec(row.basicSalaryAmount),
      edit: (row) => (row.employee.employeeType !== "workshop" && editableStatuses.includes(row.status) ? "money" : undefined),
      readOnlyHint: (row) => (row.employee.employeeType === "workshop" ? "车间工人的基本工资由生产日报自动汇总（计件/计时），不能手工修改" : editableStatuses.includes(row.status) ? undefined : LOCKED_HINT),
    },
    { key: "performance", header: "绩效", numeric: true, total: true, text: (row) => dec(row.performanceAmount), edit: (row) => (editableStatuses.includes(row.status) ? "money" : undefined), readOnlyHint: (row) => (editableStatuses.includes(row.status) ? undefined : LOCKED_HINT) },
    { key: "housing", header: "房补", numeric: true, total: true, text: (row) => dec(row.housingAllowance), edit: (row) => (editableStatuses.includes(row.status) ? "money" : undefined), readOnlyHint: (row) => (editableStatuses.includes(row.status) ? undefined : LOCKED_HINT) },
    { key: "late", header: "迟到扣款", numeric: true, total: true, text: (row) => dec(row.lateDeduction), edit: (row) => (editableStatuses.includes(row.status) ? "money" : undefined), readOnlyHint: (row) => (editableStatuses.includes(row.status) ? undefined : LOCKED_HINT) },
    { key: "absence", header: "旷工扣款", numeric: true, total: true, text: (row) => dec(row.absenceDeduction), edit: (row) => (editableStatuses.includes(row.status) ? "money" : undefined), readOnlyHint: (row) => (editableStatuses.includes(row.status) ? undefined : LOCKED_HINT) },
    { key: "earlyLeave", header: "早退扣款", numeric: true, total: true, text: (row) => dec(row.earlyLeaveDeduction), edit: (row) => (editableStatuses.includes(row.status) ? "money" : undefined), readOnlyHint: (row) => (editableStatuses.includes(row.status) ? undefined : LOCKED_HINT) },
    { key: "other", header: "其他增减", numeric: true, total: true, text: (row) => dec(row.otherAdjustmentAmount), readOnlyHint: () => "加班/考勤扣款/补贴/社保/个税/其他调整与已过账工资调整的净额，详情里可逐项查看" },
    { key: "payable", header: "应发", numeric: true, total: true, text: (row) => dec(row.payableAmount), readOnlyHint: () => AUTO_HINT },
    { key: "paid", header: "已付", numeric: true, total: true, text: (row) => dec(row.paidAmount), readOnlyHint: () => "有效核销且工资付款已过账的金额合计" },
    { key: "outstanding", header: "未付", numeric: true, total: true, text: (row) => dec(row.outstandingAmount), readOnlyHint: () => AUTO_HINT },
    { key: "status", header: "状态", text: (row) => statusLabels[row.status] ?? row.status },
    { key: "actions", header: "操作", render: (row) => actionColumns(row) },
  ];

  /**
   * 工资付款列：就是把当月工资台账搬过来，但**类目明细全部收掉、只留「总工资」**，
   * 再加上付款需要的已付/未付与行内操作（用户需求：工资付款操作都在表格中完成）。
   */
  const paymentColumns: PayrollSheetColumn<Ledger>[] = [
    { key: "employeeNo", header: "工号", text: (row) => row.employee.employeeNo },
    { key: "name", header: "姓名", text: (row) => row.employee.name },
    { key: "department", header: "部门", text: (row) => row.employee.department?.name ?? "-" },
    { key: "position", header: "岗位", text: (row) => row.employee.position?.name ?? "-" },
    { key: "total", header: "总工资", numeric: true, total: true, text: (row) => dec(row.payableAmount), readOnlyHint: () => "本月工资台账的应发合计（基本工资/绩效/房补/扣款等明细见「工资台账」页）" },
    { key: "paid", header: "已付", numeric: true, total: true, text: (row) => dec(row.paidAmount), readOnlyHint: () => "有效核销且工资付款已过账的金额合计" },
    { key: "outstanding", header: "未付", numeric: true, total: true, text: (row) => dec(row.outstandingAmount), readOnlyHint: () => "总工资 − 已付" },
    { key: "status", header: "状态", text: (row) => statusLabels[row.status] ?? row.status },
    { key: "currency", header: "币种", text: (row) => row.currency },
    { key: "actions", header: "付款操作", render: (row) => payActions(row) },
  ];

  /** 该台账下已过账的付款核销（决定「已付」与能不能冲销）。 */
  const postedAllocations = (ledger: Ledger) => (ledger.allocations ?? []).filter((item) => item.status === "active" && item.payment?.status === "posted");
  /** 不可付款时的原因说明：这些行仍然显示（当月台账全都在），但只给说明不给输入框。 */
  const payableHint = (ledger: Ledger) => {
    if (ledger.status === "draft") return "待确认：请先到「工资台账」确认本月台账";
    if (ledger.status === "expired") return "台账已过期：请先重新结算并确认";
    if (Number(ledger.outstandingAmount) <= 0) return "已付清";
    if (ledger.status === "paid" || ledger.status === "closed") return "已结清";
    return "不可付款";
  };

  const payActions = (ledger: Ledger) => {
    const posted = postedAllocations(ledger);
    const canPay = ["confirmed", "partially_paid"].includes(ledger.status) && Number(ledger.outstandingAmount) > 0;
    return <div className="action-row" data-testid={`salary-pay-actions-${ledger.id}`} onClick={(event) => event.stopPropagation()}>
      {canPay ? <>
        <input
          className="payroll-sheet-input salary-pay-input"
          data-testid={`salary-pay-amount-${ledger.id}`}
          aria-label={`付款金额（${ledger.employee.name}）`}
          inputMode="decimal"
          value={amounts[ledger.id] ?? dec(ledger.outstandingAmount)}
          onChange={(event) => setAmounts((current) => ({ ...current, [ledger.id]: event.target.value }))}
        />
        <Button size="sm" data-testid={`salary-pay-button-${ledger.id}`} disabled={paying === ledger.id} onClick={() => void payLedgerRow(ledger)}>{paying === ledger.id ? "付款中…" : "付款"}</Button>
      </> : <span className="panel-note" data-testid={`salary-pay-hint-${ledger.id}`}>{payableHint(ledger)}</span>}
      {posted.length ? <Button size="sm" variant="destructive" data-testid={`salary-unpay-button-${ledger.id}`} onClick={() => openUnpay(ledger, posted)}>冲销</Button> : null}
    </div>;
  };

  const visibleLedgers = useMemo(() => {
    const text = employeeQuery.trim().toLowerCase();
    if (!text) return ledgers;
    return ledgers.filter((item) => `${item.employee.name} ${item.employee.employeeNo}`.toLowerCase().includes(text));
  }, [employeeQuery, ledgers]);

  const detailFields: DetailField[] = detail ? [
    { label: "台账编号", value: detail.ledgerNo }, { label: "状态", value: statusLabels[detail.status] ?? detail.status },
    { label: "员工", value: `${detail.employee.employeeNo} / ${detail.employee.name}` },
    { label: "部门", value: detail.employee.department?.name }, { label: "岗位", value: detail.employee.position?.name },
    { label: "员工类型", value: detail.employee.employeeType === "workshop" ? "车间" : "非车间" },
    { label: "周期", value: `${day(detail.periodStart)} 至 ${day(detail.periodEnd)}` }, { label: "币种", value: detail.currency },
    { label: "基本工资", value: dec(detail.basicSalaryAmount) }, { label: "其中生产工资（自动）", value: dec(detail.productionSourceAmount) },
    { label: "绩效", value: dec(detail.performanceAmount) }, { label: "房补", value: dec(detail.housingAllowance) },
    { label: "迟到扣款", value: dec(detail.lateDeduction) }, { label: "旷工扣款", value: dec(detail.absenceDeduction) },
    { label: "早退扣款", value: dec(detail.earlyLeaveDeduction) },
    { label: "其他增减", value: dec(detail.otherAdjustmentAmount) },
    { label: "加班工资（历史）", value: dec(detail.overtimeAmount) }, { label: "考勤扣款（历史）", value: dec(detail.attendanceDeduction) },
    { label: "补贴金额（历史）", value: dec(detail.allowanceAmount) }, { label: "社保", value: dec(detail.socialInsurance) },
    { label: "个税", value: dec(detail.individualTax) }, { label: "其他调整", value: dec(detail.otherAdjustment) },
    { label: "应发", value: money(detail.payableAmount, detail.currency) }, { label: "已付", value: money(detail.paidAmount, detail.currency) },
    { label: "未付", value: money(detail.outstandingAmount, detail.currency) },
    { label: "备注", value: detail.remark, wide: true },
  ] : [];
  const snapshot = detail?.sourceSnapshot ?? [];
  const snapshotDays = new Set(snapshot.map((line) => line.report_date ?? "")).size;
  const snapshotOrders = new Set(snapshot.map((line) => line.order_no ?? "")).size;
  const snapshotOperations = new Set(snapshot.map((line) => `${line.order_no ?? ""}|${line.operation_name ?? ""}`)).size;
  const snapshotReports = snapshot.reduce((sum, line) => sum + (line.report_count ?? 1), 0);

  if (loading) return <div className="page-root page-floating" data-testid={importing ? "salary-importing" : undefined}>
    <div className="floating-window">
      <header className="floating-window-toolbar"><h1 className="floating-window-title">{mode === "ledger" ? "工资台账" : "工资付款"}</h1></header>
      <LoadingState />
    </div>
  </div>;

  // 悬浮居中窗口：工资台账与工资付款都是内容区里居中一张**大卡片**（宽度上限 1600px，
  // 高度按「视口 − 顶栏 − 留白」），卡片里只有一条工具条 + 筛选条 + 表格，纵向滚动交给表格。
  // 用户先要求全屏，随后改口「算了……做成悬浮居中窗口页面吧，版面大一点。不追求全屏了」。
  return <div className="page-root page-floating" data-testid={testId}>
    <div className="floating-window" data-testid="salary-floating-window">
    <header className="floating-window-toolbar">
      <h1 className="floating-window-title">{mode === "ledger" ? "工资台账" : "工资付款"}</h1>
      <span className="panel-note floating-window-meta">{month} · 币种 人民币（CNY） · 共 {visibleLedgers.length} 条{mode === "ledger" ? "（逐格可改，车间「基本工资」只读）" : "（本表＝当月台账只留总工资）"}</span>
      <span className="panel-note floating-window-meta" data-testid="salary-import-summary">
        {importing ? "正在导入本月员工…" : importError ? `本月导入失败：${importError}` : importResult
          ? `本月在册 ${importResult.candidates} 人：新建 ${importResult.created} 条、已有 ${importResult.existing} 条、不在职 ${importResult.not_employed} 人、涉及生产日报 ${importResult.report_count} 条。`
          : "本月尚未导入。"}
      </span>
      <div className="page-actions">
        <Button asChild variant="ghost" size="sm"><Link href="/finance/salary">← 工资管理</Link></Button>
        <Button variant="secondary" size="sm" data-testid="salary-import-button" onClick={() => void runImport(true)}>重新导入本月员工</Button>
        <Button variant="secondary" size="sm" data-testid="salary-refresh-button" onClick={() => void load()}>刷新</Button>
        {mode === "ledger" ? <Button size="sm" data-testid="salary-create-ledger" onClick={openCreate}>新建工资台账</Button> : null}
      </div>
    </header>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    <RecordDetailDialog
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
      title={`工资台账 ${detail?.ledgerNo ?? ""}`}
      description="双击台账行打开的详情：展示全部类目金额与来源/核销明细。"
      fields={detailFields}
      sections={detail ? [
        {
          title: `生产日报来源（${snapshot.length} 行 / ${snapshotReports} 条日报）`,
          note: `逐「日期 × 生产单 × 工序 × 计薪方式」列出，覆盖 ${snapshotDays} 天 / ${snapshotOrders} 张生产单 / ${snapshotOperations} 道工序；仅车间员工的日报自动汇总到这里，其他类目为人工填写。`,
          content: snapshot.length
            ? <DataTable pageSize={10} columns={[{ accessorKey: "report_date", header: "日期" }, { accessorKey: "order_no", header: "订单号" }, { accessorKey: "operation_name", header: "工序" }, { accessorKey: "wage_mode", header: "计薪方式" }, { id: "report_count", header: "日报条数", cell: ({ row }) => String(row.original.report_count ?? 1) }, { accessorKey: "quantity", header: "件数" }, { accessorKey: "duration_hours", header: "时长（小时）" }, { accessorKey: "amount", header: "金额" }] as ColumnDef<SnapshotLine>[]} data={snapshot} />
            : <p className="panel-note">没有自动生产来源（非车间员工或该期间无日报）</p>,
        },
        { title: `工资调整（${detail.adjustments?.length ?? 0} 条）`, note: "只有已过账的调整参与应发计算。", content: detail.adjustments?.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "adjustmentNo", header: "调整单号" }, { accessorKey: "adjustmentType", header: "类型" }, { id: "effect", header: "方向", cell: ({ row }) => row.original.effect === "increase" ? "增加" : "减少" }, { accessorKey: "amount", header: "金额" }, { accessorKey: "reason", header: "原因" }, { accessorKey: "status", header: "状态" }] as ColumnDef<NonNullable<Ledger["adjustments"]>[number]>[]} data={detail.adjustments} /> : <p className="panel-note">暂无调整记录</p> },
        { title: `工资付款核销（${detail.allocations?.length ?? 0} 条）`, content: detail.allocations?.length
          ? <DataTable pageSize={10} columns={[{ id: "payment", header: "付款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "付款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "状态", cell: ({ row }) => row.original.payment?.status ?? "-" }, { accessorKey: "amount", header: "核销金额" }] as ColumnDef<NonNullable<Ledger["allocations"]>[number]>[]} data={detail.allocations} /> : <p className="panel-note">暂无工资付款核销</p> },
      ] : []}
      actions={detail ? actionColumns(detail) : null}
    />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      {/* 筛选条留在表格上方一行；原来的两段说明挪到 title（满屏页不能靠文字占掉半屏）。 */}
      <div className="filter-bar floating-window-filters" title="月份、部门、岗位由服务端筛选（切部门会自动清空岗位）；员工姓名/工号是本地过滤。已付/未付按有效已过账的工资付款实时计算。">
        <label>月份<Input data-testid="salary-month-filter" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <label>部门
          <Select value={departmentId || "__all"} onValueChange={(value) => { setDepartmentId(value === "__all" ? "" : value); setPositionId(""); }}>
            <SelectTrigger data-testid="salary-department-filter"><SelectValue placeholder="全部部门" /></SelectTrigger>
            <SelectContent><SelectItem value="__all">全部部门</SelectItem>{departments.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <label>岗位
          <Select value={positionId || "__all"} onValueChange={(value) => setPositionId(value === "__all" ? "" : value)}>
            <SelectTrigger data-testid="salary-position-filter"><SelectValue placeholder="全部岗位" /></SelectTrigger>
            <SelectContent><SelectItem value="__all">全部岗位</SelectItem>{positions.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <label>员工姓名/工号<Input data-testid="salary-employee-filter" value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="本地过滤" /></label>
        {/* 付款日期与付款方式对整页生效（行内只填金额），省掉每行一个弹窗 */}
        {mode === "payments" ? <>
          <label>付款日期<Input data-testid="salary-payment-date" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
          <label>付款方式<Input data-testid="salary-payment-method" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} placeholder="银行转账" /></label>
        </> : null}
      </div>
      {mode === "ledger" ? <section className="panel floating-window-table" data-testid="salary-ledger-panel">
        <div className="panel-heading"><h2>工资台账</h2><span className="panel-note">共 {visibleLedgers.length} 条；逐格可改，「基本工资」对车间工人只读</span></div>
        <div className="panel-body"><PayrollSheet columns={sheetColumns} rows={visibleLedgers} onCommit={commitCell} rowTestId={(row) => `payroll-row-${row.id}`} /></div>
      </section> : null}
      {mode === "payments" ? <section className="panel floating-window-table" data-testid="salary-payment-panel">
        <div className="panel-heading"><h2>工资付款</h2><span className="panel-note">共 {visibleLedgers.length} 条；本表＝当月工资台账只留「总工资」</span></div>
        <div className="panel-body">
          <PayrollSheet
            columns={paymentColumns}
            rows={visibleLedgers}
            rowTestId={(row) => `payroll-pay-row-${row.id}`}
            hint={<span>付款金额默认等于该行未付，改完点「付款」即可（一次完成：生成工资应付 → 建付款单 → 核销过账）。已付过的行可「冲销」把该台账下的付款整体回退（需填原因）。付款日期与方式在上方统一设置。</span>}
            empty={<p className="panel-note" data-testid="salary-payment-empty">本月没有工资台账，无法付款：请先到「工资台账」页导入并确认本月台账。</p>}
          />
        </div>
      </section> : null}
    </>}
    </div>
  </div>;
}
