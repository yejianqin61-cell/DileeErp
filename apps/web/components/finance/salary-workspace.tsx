"use client";

// 工资管理（/finance/salary?tab=ledger|payments）：两个满页表格 + 一条共用筛选条。
//
// 用户需求（第 3、4 条）在这里落地：
//   - 工资台账是**可编辑**满页表格：进页面/切月份先自动导入本月全部员工，车间工人的计件/计时工资
//     由生产日报自动汇总进「基本工资」且不可手改，绩效/房补/迟到/旷工/早退逐格可改；
//   - 工资付款也是满页表格，同样支持「月份 / 部门 / 岗位 / 员工姓名或工号」筛选。
//
// 口径与治理：
//   - 自动导入是幂等的（后端只补建缺失的草稿台账），因此「浏览一下」不会重复写库；
//   - 表格里只有 draft / expired 台账可逐格改：已确认台账要先「回到草稿」（需原因），
//     部分支付/已支付/已关闭只能走工资调整单或付款冲销 —— 这是既有的状态机，不因为「表格能编辑」而放开；
//   - 员工姓名/工号是本地过滤（与任务 04 的既有约定一致：输入即响应，不打接口）。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DataTable, statusCell } from "../data/data-table";
import { ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../ui/toaster";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { FinanceTabs } from "./finance-tabs";
import { PayrollSheet, type PayrollSheetColumn } from "./payroll-sheet";
import { SALARY_TABS, type SalaryTabKey } from "../../lib/finance-sections";

type Employee = { id: string; employeeNo: string; name: string; employeeType: string; department?: { id: string; name: string } | null; position?: { id: string; name: string } | null };
type Department = { id: string; name: string; code: string };
type Position = { id: string; name: string; code: string; departmentId: string };
type PayrollPayable = { id: string; ledgerId: string; payableNo: string; amount: string; currency: string; status: string };
type Allocation = { id: string; amount: string; status: string; ledger?: { ledgerNo: string; periodStart: string; periodEnd: string; employee?: Employee | null } | null };
type Payment = { id: string; paymentNo: string; paymentDate: string; amount: string; currency: string; status: string; paymentMethod?: string; allocations?: Allocation[] };
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

export default function SalaryWorkspace({ tab, testId = "page-finance-salary", initialMonth = "", initialDepartmentId = "", initialPositionId = "" }: {
  tab: SalaryTabKey;
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
  const [payments, setPayments] = useState<Payment[]>([]);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  // ready = 本月导入已完成：列表必须等它，否则会在导入写库之前把空表读回来。
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<Ledger | null>(null);
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
      // 四张清单一次拉齐：付款 tab 的「核销过账」要用台账选项，台账 tab 的操作列要用工资应付，
      // 分 tab 按需拉取会让另一张表在切回来之前一直缺数据。
      const [ledgerResult, paymentResult, payableResult, employeeResult] = await Promise.all([
        apiGet<Ledger[]>(`/hr/payroll-ledgers${suffix}`),
        apiGet<Payment[]>(`/hr/salary-payments${suffix}`),
        apiGet<PayrollPayable[]>("/hr/payroll-payables"),
        apiGet<Employee[]>("/production/employees"),
      ]);
      setLedgers(ledgerResult.data);
      setPayments(paymentResult.data);
      setPayables(payableResult.data);
      setEmployees(employeeResult.data);
    } catch (cause) {
      setError(messageOf(cause, "工资数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [departmentId, month, positionId, ready, tab]);

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
  function createSalaryPayment() {
    setDialog({ title: "新建工资付款", fields: [{ name: "amount", label: "付款金额", type: "number", required: true }, { name: "payment_date", label: "付款日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) }, { name: "payment_method", label: "付款方式", required: true, defaultValue: "银行转账" }, { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") }], submit: (values) => submitDialog(apiPost("/hr/salary-payments", { amount: values.amount, payment_date: values.payment_date, currency: values.currency, payment_method: values.payment_method }), "工资付款草稿已创建") });
  }
  function postSalaryPayment(payment: Payment) {
    const options = ledgers.filter((ledger) => ["confirmed", "partially_paid"].includes(ledger.status) && Number(ledger.outstandingAmount) > 0).map((ledger) => ({ value: ledger.id, label: `${ledger.employee.employeeNo} / ${ledger.employee.name} / 未付 ${ledger.outstandingAmount} ${ledger.currency}` }));
    setDialog({ title: `工资付款核销：${payment.paymentNo}`, fields: [{ name: "ledger_id", label: "工资台账", type: "select", required: true, options }, { name: "amount", label: "本次核销金额", type: "number", required: true, defaultValue: payment.amount }], submit: (values) => values.ledger_id ? submitDialog(apiPost(`/hr/salary-payments/${payment.id}/post`, { allocations: [{ ledger_id: values.ledger_id, amount: values.amount }] }), "工资付款已过账") : undefined });
  }
  function reverseSalaryPayment(payment: Payment) {
    setDialog({ title: `冲销工资付款：${payment.paymentNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => submitDialog(apiPost(`/hr/salary-payments/${payment.id}/reverse`, values), "工资付款已冲销") });
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

  const paymentColumns: ColumnDef<Payment>[] = [
    { accessorKey: "paymentNo", header: "支付单号" },
    { id: "date", header: "付款日期", cell: ({ row }) => day(row.original.paymentDate) },
    { id: "employees", header: "核销员工", cell: ({ row }) => employeesOf(row.original) || "未核销" },
    { id: "departments", header: "部门", cell: ({ row }) => departmentsOf(row.original) || "-" },
    { id: "positions", header: "岗位", cell: ({ row }) => positionsOf(row.original) || "-" },
    { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { accessorKey: "status", header: "状态", cell: statusCell<Payment>() },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{row.original.status === "draft" && <Button size="sm" variant="secondary" onClick={() => postSalaryPayment(row.original)}>核销过账</Button>}{row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseSalaryPayment(row.original)}>冲销</Button>}</div> },
  ];

  const allocationEmployees = (payment: Payment) => (payment.allocations ?? []).map((item) => item.ledger?.employee).filter((item): item is Employee => Boolean(item));
  const employeesOf = (payment: Payment) => [...new Set(allocationEmployees(payment).map((employee) => `${employee.employeeNo} / ${employee.name}`))].join("、");
  const departmentsOf = (payment: Payment) => [...new Set(allocationEmployees(payment).map((employee) => employee.department?.name ?? "-"))].join("、");
  const positionsOf = (payment: Payment) => [...new Set(allocationEmployees(payment).map((employee) => employee.position?.name ?? "-"))].join("、");
  /** 付款单可以跨员工核销，筛选按「核销到的员工」命中（与后端 where 语义一致）。 */
  const visiblePayments = useMemo(() => {
    const text = employeeQuery.trim().toLowerCase();
    if (!text) return payments;
    return payments.filter((payment) => allocationEmployees(payment).some((employee) => `${employee.name} ${employee.employeeNo}`.toLowerCase().includes(text)));
  }, [employeeQuery, payments]);

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

  if (loading) return <div className="page-root" data-testid={importing ? "salary-importing" : undefined}><PageHeader title="工资管理" /><LoadingState /></div>;

  const tabQuery: Record<string, string> = {};
  if (month) tabQuery.month = month;
  if (departmentId) tabQuery.department_id = departmentId;
  if (positionId) tabQuery.position_id = positionId;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="工资管理" description="满页表格：按月自动导入全部员工，车间工人的计件/计时工资由生产日报自动汇总进「基本工资」，其余类目逐格可改。">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
      <Button variant="secondary" data-testid="salary-import-button" onClick={() => void runImport(true)}>重新导入本月员工</Button>
      <Button variant="secondary" data-testid="salary-refresh-button" onClick={() => void load()}>刷新</Button>
      {tab === "ledger" ? <Button data-testid="salary-create-ledger" onClick={openCreate}>新建工资台账</Button> : null}
      {tab === "payments" ? <Button data-testid="salary-create-payment" onClick={createSalaryPayment}>新建工资付款</Button> : null}
    </PageHeader>
    <FinanceTabs basePath="/finance/salary" tabs={SALARY_TABS} active={tab} query={tabQuery} />
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
      <section className="panel panel-body">
        <div className="filter-bar">
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
        </div>
        <p className="panel-note">
          月份、部门、岗位由服务端筛选（切部门会自动清空岗位）；员工姓名/工号是本地过滤。
          已付和未付按有效已过账工资付款实时计算；未付为 0 时不应再次发放，已过期台账需重新结算或使用工资调整单。
        </p>
        <p className="panel-note" data-testid="salary-import-summary">
          {importing ? "正在导入本月员工…" : importError ? `本月导入失败：${importError}` : importResult
            ? `本月在册 ${importResult.candidates} 人：本次新建 ${importResult.created} 条、已有 ${importResult.existing} 条、该月不在职 ${importResult.not_employed} 人；本次导入涉及生产日报 ${importResult.report_count} 条。`
            : "本月尚未导入。"}
        </p>
      </section>
      {tab === "ledger" ? <section className="panel" data-testid="salary-ledger-panel">
        <div className="panel-heading"><h2>工资台账</h2><span className="panel-note">共 {visibleLedgers.length} 条；逐格可改，「基本工资」对车间工人只读</span></div>
        <div className="panel-body"><PayrollSheet columns={sheetColumns} rows={visibleLedgers} onCommit={commitCell} rowTestId={(row) => `payroll-row-${row.id}`} /></div>
      </section> : null}
      {tab === "payments" ? <section className="panel" data-testid="salary-payment-panel">
        <div className="panel-heading"><h2>工资付款</h2><span className="panel-note">共 {visiblePayments.length} 条；按付款月份与核销员工的部门/岗位筛选</span></div>
        <div className="panel-body"><DataTable columns={paymentColumns} data={visiblePayments} pageSize={50} empty={<p className="panel-note" data-testid="salary-payment-empty">本期没有工资付款</p>} /></div>
      </section> : null}
    </>}
  </div>;
}
