// app/hr/page.tsx 的**行为**测试 —— 「数据加载与渲染」这一半。
//
// 分工：本文件只覆盖读路径 —— 首屏 7 个 GET 与加载门禁、员工目录/考勤绩效两个区块的列表渲染
//   （含自定义 cell 的字段拼接、状态中文化、日期截断）、空态、搜索与筛选（含筛选后的条数总计）、
//   加载失败与重试、权限失败时页面的表现。
//   写路径（新建/编辑/离职、ActionDialog 提交体、PATCH vs POST 契约、防重复提交）由
//   hr-page-actions.test.tsx 覆盖，本文件刻意不点任何写操作按钮。
//
// 纪律（照 finance-page.test.tsx 的规范）：真实渲染页面组件 + 真实事件 + 真实 fetch 桩；
//   不 vi.mock 子组件、不 readFileSync、不正则匹配源码、不断言 className；
//   只断言 DOM 可见文本/可见性与 stubApi 记录到的 method + 完整 URL。
//
// 页面契约（读 apps/web/app/hr/page.tsx 得出，测试按运行时结果钉住）：
//   - 首屏 Promise.all 的 7 个 GET：:139-147；`if (loading)` 提前 return 的加载门禁：:888-894
//   - 员工目录列（部门/岗位拼接、ISO 日期截断、displayStatus 中文化、仅在职行有「离职」）：:725-774
//   - 考勤与绩效合并成一张表（employeeId → 姓名的跨接口映射、考勤/绩效分支、日期与周期格式）：:775-801
//   - 筛选（工号+姓名小写包含 + 状态/部门/岗位/类型精确相等）：:703-724
//   - 空态文案：:1049「暂无匹配员工」、:1061「暂无考勤或绩效记录」
//   - 错误态（ErrorState + 重新加载）：:955-959
//   - 薪资台账/工资支付的 state、列定义与对话框构造函数：:119-120、:629-700、:802-873（见文末 KNOWN_DEFECT）
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HrPage from "../app/hr/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 页面 useEffect 里 Promise.all 的 7 个 GET + 首屏一次性的主数据 2 个 GET（前缀 /api/v1 由 api-client 拼）。 */
const EP = {
  // 员工目录带 include_deleted=true：已删除的员工要能被「已删除」筛选看到并恢复
  employees: "/api/v1/production/employees?include_deleted=true",
  departments: "/api/v1/production/departments",
  positions: "/api/v1/production/positions",
  attendance: "/api/v1/hr/attendance-records",
  performance: "/api/v1/hr/performance-records",
  ledgers: "/api/v1/hr/payroll-ledgers",
  salaryPayments: "/api/v1/hr/salary-payments",
  // 薪资台账/工资支付的币种下拉来自可配置字典（lib/currency-options.ts），随首屏一起拉取。
  currencies: "/api/v1/dictionaries/currency/items",
  // 工资支付的「发放银行」来自银行账户池（财务 → 银行账户），同样随首屏拉一次。
  banks: "/api/v1/finance/banks",
} as const;
/** Promise.all 里的一批业务列表：重试会整批重拉。 */
const BUSINESS_LISTS = [EP.employees, EP.departments, EP.positions, EP.attendance, EP.performance, EP.ledgers, EP.salaryPayments];
/** 首屏只拉一次的静态主数据（重试不重拉）：币种字典、银行账户池。 */
const STATIC_MASTER_DATA = [EP.currencies, EP.banks];
const ALL_LISTS = [...BUSINESS_LISTS, ...STATIC_MASTER_DATA];

type Handler = (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;

/**
 * 桩：7 个 GET 各回自己那一份数据（默认空数组），extra 优先执行（用于注入 403 或把某个请求挂起）。
 * 未打桩的 URL 一律 404 —— 这样"把某个请求路径改错"会在测试里直接暴露成错误态，
 * 而不是静默回空数组、伪装成"页面空表"。
 */
function stubHr(data: Partial<Record<keyof typeof EP, unknown>> = {}, extra?: Handler) {
  return stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    for (const [key, path] of Object.entries(EP) as Array<[keyof typeof EP, string]>) {
      if (url === path) return apiOk(data[key] ?? []);
    }
    return apiErr(404, "NOT_FOUND", `测试未打桩的请求：${call.method} ${url}`);
  });
}

/** 渲染人事页（连带 Toaster：写路径的结果只经 toast 呈现，与 actions 文件保持同一套装置）。 */
function renderHr() {
  return render(
    <>
      <HrPage />
      <Toaster />
    </>
  );
}

/** 渲染并等到首屏加载结束（页面根出现）；返回 fetch 调用记录供 URL / 次数断言。 */
async function openHr(data: Partial<Record<keyof typeof EP, unknown>> = {}, extra?: Handler) {
  const calls = stubHr(data, extra);
  renderHr();
  await screen.findByTestId("page-hr");
  return calls;
}

/** 取某个面板（section）的作用域：两个区块各有一张 DataTable，跨表断言会串。 */
function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

/** queryAllByTestId：0 行时 getAllByTestId 会抛错，取不到"零行"这个事实。 */
function rowsIn(title: string) {
  return panel(title).queryAllByTestId("data-table-row");
}

function rowFor(title: string, text: string) {
  const row = rowsIn(title).find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`「${title}」里未找到包含「${text}」的行`);
  return row;
}

function cellText(row: HTMLElement, index: number) {
  return within(row).getAllByRole("cell")[index]?.textContent?.trim() ?? "";
}

/** 点开某个筛选下拉并选中一项（Radix Select）。 */
async function pickOption(trigger: HTMLElement, optionName: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

/** 第 index 个筛选下拉（0 状态 / 1 部门 / 2 岗位 / 3 员工类型，DOM 顺序即渲染顺序）。 */
function filterAt(index: number) {
  const combos = screen.getAllByRole("combobox");
  if (!combos[index]) throw new Error(`只有 ${combos.length} 个下拉，取不到第 ${index} 个`);
  return combos[index];
}

/** 可手动放行的 Promise，用来把页面稳定停在"数据未返回"的加载态上。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// —— 假数据：形状对齐后端 DTO（listEmployees / listDepartments / listPositions / 考勤 / 绩效）——
// 员工口径 = 《在职员工花名册》；age/tenureYears/contractStatus 等派生列由后端算好后随行返回。

type Employee = {
  id: string;
  employeeNo: string;
  name: string;
  employeeType: string;
  employmentStatus: string;
  hiredOn?: string;
  leftOn?: string;
  /** 有值 = 已逻辑删除（从列表消失，可在「已删除」筛选里恢复） */
  deletedAt?: string | null;
  department?: { id: string; name: string };
  position?: { id: string; name: string };
  gender?: string;
  birthDate?: string;
  age?: number | null;
  education?: string;
  tenureYears?: number | null;
  phone?: string;
  /** 劳动合同 + 劳务合同合并后的档位：正常 / 即将过期 / 已过期 */
  contractSituation?: string;
  /** 生日所在自然月 == 当月（后端派生） */
  birthdayThisMonth?: boolean | null;
};

const employees: Employee[] = [
  // 在职 + 部门/职务齐全 + 花名册字段与派生列都有值
  { id: "emp-1", employeeNo: "E01", name: "张三", employeeType: "workshop", employmentStatus: "active", hiredOn: "2026-01-05T00:00:00.000Z", department: { id: "dept-1", name: "生产部" }, position: { id: "pos-1", name: "缝纫工" }, gender: "男", birthDate: "1990-05-20T00:00:00.000Z", age: 36, education: "初中", tenureYears: 0, phone: "138 0000 0000", contractSituation: "正常", birthdayThisMonth: false },
  // 已离职 + 关联字段整体缺失 + 只有离职日期；派生列后端没给（null）→ 列表回落 "-"
  { id: "emp-2", employeeNo: "E02", name: "李四", employeeType: "non_workshop", employmentStatus: "left", leftOn: "2026-03-01T00:00:00.000Z", age: null, tenureYears: null },
  // 停用 + 有部门无职务 + 合同已过期 + 本月生日
  { id: "emp-3", employeeNo: "E03", name: "王五", employeeType: "workshop", employmentStatus: "inactive", department: { id: "dept-1", name: "生产部" }, gender: "女", age: 38, education: "大专", phone: "139 0000 0000", contractSituation: "已过期", birthdayThisMonth: true },
];

/** 被逻辑删除的员工：接口返回它，但默认列表必须把它挡在外面。 */
const deletedEmployee: Employee = { id: "emp-9", employeeNo: "E09", name: "赵六", employeeType: "non_workshop", employmentStatus: "left", deletedAt: "2026-09-16T02:00:00.000Z", department: { id: "dept-1", name: "生产部" }, position: { id: "pos-1", name: "缝纫工" }, age: null, tenureYears: null };

const departments = [
  { id: "dept-1", code: "D01", name: "生产部", isActive: true },
  { id: "dept-2", code: "D02", name: "质检部", isActive: true },
  { id: "dept-3", code: "D03", name: "已停用部", isActive: false },
];
const positions = [
  { id: "pos-1", code: "P01", name: "缝纫工", isActive: true },
  { id: "pos-2", code: "P02", name: "巡检员", isActive: true },
  { id: "pos-3", code: "P03", name: "旧岗位", isActive: false },
];

const attendanceRecords = [
  // 考勤：日期 + 上下班时间都齐全
  { id: "att-1", employeeId: "emp-1", attendanceDate: "2026-02-10T00:00:00.000Z", attendanceType: "出勤", workStartTime: "09:00", workEndTime: "18:00" },
  // 员工已不在员工列表里（跨接口映射只能回落 id）
  { id: "att-2", employeeId: "emp-9", attendanceDate: "2026-02-11T00:00:00.000Z", attendanceType: "事假" },
];
const performanceRecords = [
  // 绩效：周期 + 等级/评分
  { id: "perf-1", employeeId: "emp-2", periodStart: "2026-02-01T00:00:00.000Z", periodEnd: "2026-02-28T00:00:00.000Z", grade: "A", score: "95" },
  // 后端未给等级（grade 缺失时的拼接分支）
  { id: "perf-2", employeeId: "emp-3", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T00:00:00.000Z", score: "88" },
];

/** 25 个员工：只有 E25 是「非车间 + 离职 + 质检部」，其余都是「车间 + 在职 + 生产部」。 */
const bulkEmployees: Employee[] = Array.from({ length: 25 }, (_, index) => {
  const no = index + 1;
  const last = no === 25;
  return {
    id: `emp-${no}`,
    employeeNo: `E${String(no).padStart(2, "0")}`,
    name: `员工${String(no).padStart(2, "0")}`,
    employeeType: last ? "non_workshop" : "workshop",
    employmentStatus: last ? "left" : "active",
    hiredOn: "2026-01-05T00:00:00.000Z",
    department: last ? { id: "dept-2", name: "质检部" } : { id: "dept-1", name: "生产部" },
    position: last ? { id: "pos-2", name: "巡检员" } : { id: "pos-1", name: "缝纫工" },
  };
});

describe("人事页 · 加载门禁与首屏请求契约", () => {
  it("数据未返回时只有加载态（无页面根、无操作入口）；完成后页面根出现，7 个业务接口 + 币种字典各被 GET 一次", async () => {
    const gate = deferred<Response>();
    const calls = stubHr({}, (url) => (url === EP.employees ? gate.promise : undefined));

    renderHr();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    // 加载态提前 return：页面根、两个区块、页头操作入口都还不存在
    expect(screen.queryByTestId("page-hr")).toBeNull();
    expect(screen.queryByRole("heading", { name: "员工目录" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "考勤与绩效" })).toBeNull();
    for (const name of ["新建员工", "登记考勤", "登记绩效", "导出员工名单", "批量导入员工"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // 加载态保留页头，用户知道自己在人事页
    expect(screen.getByRole("heading", { name: "人事" })).toBeVisible();

    gate.resolve(apiOk(employees));

    expect(await screen.findByTestId("page-hr")).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId("loading-state")).toBeNull());

    // 请求契约：不多不少 7 个业务 GET + 1 个币种字典 GET，路径与 method 全对（任一路径写错都会红）
    await waitFor(() => expect(calls).toHaveLength(ALL_LISTS.length));
    expect(calls.map((call) => `${call.method} ${call.url}`).sort()).toEqual(ALL_LISTS.map((path) => `GET ${path}`).sort());

    // 数据到位 + 入口出现（本用例只在闸门里喂了员工目录，考勤/绩效仍为空，因此只断言区块出现）
    expect(rowsIn("员工目录")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "考勤与绩效" })).toBeVisible();
    expect(rowsIn("考勤与绩效")).toHaveLength(0);
    for (const name of ["新建员工", "登记考勤", "登记绩效", "导出员工名单", "下载导入模板", "批量导入员工"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getByRole("link", { name: "部门池" })).toBeVisible();
    expect(screen.getByRole("link", { name: "岗位池" })).toBeVisible();
  });
});

describe("人事页 · 员工目录列表渲染", () => {
  it("按花名册口径渲染：工号/姓名/部门职务拼接/性别/出生日期/年龄/学历/入职日期/工龄/联系方式/合同情况/类型/状态/离职日期，缺数据回落 -", async () => {
    await openHr({ employees });

    const directory = panel("员工目录");
    expect(directory.getAllByTestId("data-table-row")).toHaveLength(3);
    // 表头文案（列结构与业务含义的一部分）：劳动合同与劳务合同已合并成一列「合同情况」
    for (const header of ["工号", "姓名", "部门/职务", "性别", "出生日期", "年龄", "学历", "入职日期", "工龄", "联系方式", "合同情况", "类型", "状态", "离职日期", "操作"]) {
      expect(directory.getByRole("columnheader", { name: header })).toBeVisible();
    }
    // 合并之后不该再出现原来那两列
    expect(directory.queryByRole("columnheader", { name: "合同到期" })).toBeNull();
    expect(directory.queryByRole("columnheader", { name: "劳务合同到期" })).toBeNull();

    const zhang = rowFor("员工目录", "E01");
    expect(cellText(zhang, 0)).toBe("E01");
    expect(cellText(zhang, 1)).toBe("张三");
    // 自定义 cell：部门名与职务名用 " / " 拼接
    expect(cellText(zhang, 2)).toBe("生产部 / 缝纫工");
    expect(cellText(zhang, 3)).toBe("男");
    // 自定义 cell：完整 ISO 时间被截断成日期
    expect(cellText(zhang, 4)).toBe("1990-05-20");
    // 后端算好的派生列原样展示
    expect(cellText(zhang, 5)).toBe("36");
    expect(cellText(zhang, 6)).toBe("初中");
    expect(cellText(zhang, 7)).toBe("2026-01-05");
    expect(cellText(zhang, 8)).toBe("0");
    expect(cellText(zhang, 9)).toBe("138 0000 0000");
    expect(cellText(zhang, 10)).toBe("正常");
    expect(cellText(zhang, 11)).toBe("workshop");
    // 自定义 cell 走 displayStatus：active → 在职
    expect(cellText(zhang, 12)).toBe("在职");
    // 未离职 → 离职日期回落 "-"
    expect(cellText(zhang, 13)).toBe("-");

    const li = rowFor("员工目录", "E02");
    // department / position 关联整体缺失 → "- / -"
    expect(cellText(li, 2)).toBe("- / -");
    // 花名册字段与派生列都缺 → "-"（不能渲染成 null / undefined / NaN）
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(cellText(li, index)).toBe("-");
    }
    expect(cellText(li, 12)).toBe("已离职");
    expect(cellText(li, 13)).toBe("2026-03-01");

    const wang = rowFor("员工目录", "E03");
    // 只有部门、没有职务 → 后半段回落 "-"
    expect(cellText(wang, 2)).toBe("生产部 / -");
    // 合并后的档位：劳务合同即将过期、劳动合同已过期 → 取最紧急的「已过期」
    expect(cellText(wang, 10)).toBe("已过期");
    expect(cellText(wang, 12)).toBe("停用");
    // 没有入职日期 → 工龄 "-"，而年龄仍按出生日期算出来
    expect(cellText(wang, 8)).toBe("-");
    expect(cellText(wang, 5)).toBe("38");
  });

  it("行内操作按状态出现：在册行有「编辑 + 离职 + 删除」，已离职/停用行只有「编辑 + 删除」，已删除行只有「恢复」", async () => {
    await openHr({ employees });

    const active = rowFor("员工目录", "E01");
    expect(within(active).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "离职" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "删除" })).toBeVisible();

    const left = rowFor("员工目录", "E02");
    expect(within(left).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(left).queryByRole("button", { name: "离职" })).toBeNull();
    expect(within(left).getByRole("button", { name: "删除" })).toBeVisible();

    const inactive = rowFor("员工目录", "E03");
    expect(within(inactive).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(inactive).queryByRole("button", { name: "离职" })).toBeNull();
  });
});

describe("人事页 · 考勤与绩效合并列表", () => {
  it("两个接口的记录合并成一张表：类型分支、employeeId → 姓名映射、日期与周期格式、结果拼接", async () => {
    await openHr({ employees, attendance: attendanceRecords, performance: performanceRecords });

    const table = panel("考勤与绩效");
    // 2 条考勤 + 2 条绩效合并，不再区分来源表
    expect(table.getAllByTestId("data-table-row")).toHaveLength(4);
    for (const header of ["类型", "员工", "日期/周期", "结果"]) {
      expect(table.getByRole("columnheader", { name: header })).toBeVisible();
    }

    const attendance = rowFor("考勤与绩效", "2026-02-10");
    expect(cellText(attendance, 0)).toBe("考勤");
    // employeeId 通过员工目录的数据映射成姓名（跨接口拼装）
    expect(cellText(attendance, 1)).toBe("张三");
    expect(cellText(attendance, 2)).toBe("2026-02-10 09:00-18:00");
    expect(cellText(attendance, 3)).toBe("出勤");

    const performance = rowFor("考勤与绩效", "2026-02-01");
    expect(cellText(performance, 0)).toBe("绩效");
    expect(cellText(performance, 1)).toBe("李四");
    expect(cellText(performance, 2)).toBe("2026-02-01 至 2026-02-28");
    expect(cellText(performance, 3)).toBe("A 95");

    // 员工已不在员工列表 → 员工列回落 employeeId 本身，而不是 undefined/空
    const orphan = rowFor("考勤与绩效", "2026-02-11");
    expect(cellText(orphan, 1)).toBe("emp-9");

    // 绩效缺 grade → 只拼 "- 88"（等级位留空号）
    const noGrade = rowFor("考勤与绩效", "2026-03-01");
    expect(cellText(noGrade, 3)).toBe("- 88");
  });

  it("员工目录为空、考勤绩效都为空时各自回落空态，不渲染空表格", async () => {
    await openHr();

    expect(panel("员工目录").getByTestId("empty-state")).toHaveTextContent("暂无匹配员工");
    expect(panel("考勤与绩效").getByTestId("empty-state")).toHaveTextContent("暂无考勤或绩效记录");
    // 两张表都没有 data-table（空态与表格互斥）
    expect(screen.queryAllByTestId("data-table")).toHaveLength(0);
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });
});

describe("人事页 · 搜索与筛选", () => {
  it("搜索框按「工号 + 姓名」大小写不敏感过滤，清空恢复全部，无匹配回落空态", async () => {
    await openHr({ employees });
    const search = screen.getByPlaceholderText("搜索工号或姓名");

    // 工号小写命中（大小写不敏感）
    await userEvent.type(search, "e01");
    await waitFor(() => expect(rowsIn("员工目录")).toHaveLength(1));
    expect(rowFor("员工目录", "E01")).toBeVisible();
    expect(screen.queryByText("E02")).toBeNull();

    // 姓名命中
    await userEvent.clear(search);
    await userEvent.type(search, "李");
    await waitFor(() => expect(rowsIn("员工目录")).toHaveLength(1));
    expect(rowFor("员工目录", "E02")).toBeVisible();

    // 清空恢复全部
    await userEvent.clear(search);
    await waitFor(() => expect(rowsIn("员工目录")).toHaveLength(3));

    // 无匹配 → 空态
    await userEvent.type(search, "查无此人");
    await waitFor(() => expect(rowsIn("员工目录")).toHaveLength(0));
    expect(panel("员工目录").getByTestId("empty-state")).toHaveTextContent("暂无匹配员工");
  });

  it("五个筛选下拉的选项池：部门/岗位只列启用项，员工类型固定为车间/非车间，生日含本月生日", async () => {
    await openHr({ employees, departments, positions });

    // 状态 / 部门 / 岗位 / 员工类型 / 生日
    expect(screen.getAllByRole("combobox")).toHaveLength(5);

    // 部门：来自 /production/departments，且 isActive=false 的部门不进筛选池
    await userEvent.click(filterAt(1));
    expect(await screen.findByRole("option", { name: "全部部门" })).toBeVisible();
    expect(screen.getByRole("option", { name: "生产部" })).toBeVisible();
    expect(screen.getByRole("option", { name: "质检部" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "已停用部" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "全部部门" }));

    // 岗位：来自 /production/positions，同样过滤停用项
    await userEvent.click(filterAt(2));
    expect(await screen.findByRole("option", { name: "全部岗位" })).toBeVisible();
    expect(screen.getByRole("option", { name: "缝纫工" })).toBeVisible();
    expect(screen.getByRole("option", { name: "巡检员" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "旧岗位" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "全部岗位" }));

    // 员工类型：不来自后端，恒为车间/非车间两条（选项文案是中文，值是 workshop/non_workshop）
    await userEvent.click(filterAt(3));
    expect(await screen.findByRole("option", { name: "全部类型" })).toBeVisible();
    expect(screen.getByRole("option", { name: "车间" })).toBeVisible();
    expect(screen.getByRole("option", { name: "非车间" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "workshop" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "全部类型" }));

    // 状态
    await userEvent.click(filterAt(0));
    for (const name of ["全部状态", "在职", "离职", "停用", "已删除"]) {
      expect(await screen.findByRole("option", { name })).toBeVisible();
    }
    await userEvent.click(screen.getByRole("option", { name: "全部状态" }));

    // 生日：只有全部生日 / 本月生日（不看后端，靠派生列 birthdayThisMonth 判断）
    await userEvent.click(filterAt(4));
    expect(await screen.findByRole("option", { name: "全部生日" })).toBeVisible();
    expect(screen.getByRole("option", { name: "本月生日" })).toBeVisible();
  });

  it("本月生日筛选只留下生日在当前月的员工，清空后恢复全部", async () => {
    await openHr({ employees });

    const directory = panel("员工目录");
    expect(directory.getAllByTestId("data-table-row")).toHaveLength(3);

    await pickOption(filterAt(4), "本月生日");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(1));
    // 只有王五的 birthdayThisMonth 为 true
    expect(rowFor("员工目录", "E03")).toBeVisible();
    expect(screen.queryByText("张三")).toBeNull();
    expect(screen.queryByText("李四")).toBeNull();

    await pickOption(filterAt(4), "全部生日");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(3));
  });

  it("本月生日不看有没有出生日期可比：后端没给 birthdayThisMonth 的行不会被误纳进来", async () => {
    // 李四没有 birthDate（后端派生为 null）——null 不等于 true，所以不该被纳入本月生日
    await openHr({ employees: [employees[1] as Employee] });
    await pickOption(filterAt(4), "本月生日");
    await waitFor(() => expect(rowsIn("员工目录")).toHaveLength(0));
    expect(panel("员工目录").getByTestId("empty-state")).toHaveTextContent("暂无匹配员工");
  });

  it("筛选按后端原始字段精确收敛行数与「共 N 条」总计（状态/部门/员工类型各自生效）", async () => {
    await openHr({ employees: bulkEmployees, departments, positions });

    const directory = panel("员工目录");
    // 默认 pageSize=20：25 条 → 第一页 20 行 + 总计文案
    expect(directory.getAllByTestId("data-table-row")).toHaveLength(20);
    expect(directory.getByText(/共 25 条/)).toHaveTextContent("第 1 / 2 页，共 25 条");

    // 状态=在职 → 24 条（离职的 E25 被筛掉）
    await pickOption(filterAt(0), "在职");
    await waitFor(() => expect(directory.getByText(/共 24 条/)).toHaveTextContent("第 1 / 2 页，共 24 条"));
    expect(screen.queryByText("员工25")).toBeNull();

    // 状态=离职 → 只剩 1 行，页码条随页数收敛而消失
    await pickOption(filterAt(0), "离职");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(1));
    expect(rowFor("员工目录", "E25")).toBeVisible();
    expect(directory.queryByText(/共 \d+ 条/)).toBeNull();

    // 回到全部状态，改按部门筛：值比的是 department.id，不是部门名
    await pickOption(filterAt(0), "全部状态");
    await waitFor(() => expect(directory.getByText(/共 25 条/)).toBeVisible());
    await pickOption(filterAt(1), "质检部");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(1));
    expect(rowFor("员工目录", "E25")).toBeVisible();

    // 部门重置后按员工类型筛：选项文案是「车间」，比较的却是后端原始值 workshop
    await pickOption(filterAt(1), "全部部门");
    await waitFor(() => expect(directory.getByText(/共 25 条/)).toBeVisible());
    await pickOption(filterAt(3), "车间");
    await waitFor(() => expect(directory.getByText(/共 24 条/)).toHaveTextContent("第 1 / 2 页，共 24 条"));
    expect(screen.queryByText("员工25")).toBeNull();

    await pickOption(filterAt(3), "非车间");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(1));
    expect(rowFor("员工目录", "E25")).toBeVisible();
  });
});

describe("人事页 · 删除与恢复员工（逻辑删除）", () => {
  it("已删除的员工默认不出现在列表里，只有筛「已删除」才看得到，且状态列显示「已删除」", async () => {
    await openHr({ employees: [...employees, deletedEmployee] });

    const directory = panel("员工目录");
    // 默认（全部状态）把已删除的员工挡在外面：接口给了 4 行，列表只有 3 行
    expect(directory.getAllByTestId("data-table-row")).toHaveLength(3);
    expect(screen.queryByText("赵六")).toBeNull();

    await pickOption(filterAt(0), "已删除");
    await waitFor(() => expect(directory.getAllByTestId("data-table-row")).toHaveLength(1));
    const deletedRow = rowFor("员工目录", "E09");
    expect(cellText(deletedRow, 1)).toBe("赵六");
    // 状态列是「已删除」而不是它的在职状态（离职）
    expect(cellText(deletedRow, 12)).toBe("已删除");
    // 已删除行只留「恢复」，没有编辑/离职/删除
    expect(within(deletedRow).getByRole("button", { name: "恢复" })).toBeVisible();
    expect(within(deletedRow).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(deletedRow).queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("删除要先确认：确认后 DELETE 到员工自己的地址并重新拉取列表", async () => {
    // stubHr 对未打桩的 URL 一律 404，所以写端点要显式放行（否则删除失败、列表不会刷新）
    const calls = await openHr({ employees }, (url, call) =>
      url === "/api/v1/production/employees/emp-1" && call.method === "DELETE" ? apiOk({}) : undefined
    );

    await userEvent.click(within(rowFor("员工目录", "E01")).getByRole("button", { name: "删除" }));

    // 确认弹窗：说明这是逻辑删除且可恢复，而不是直接发请求
    expect(await screen.findByText("删除员工")).toBeVisible();
    expect(screen.getByText(/逻辑删除/)).toBeVisible();
    expect(callsTo(calls, "/api/v1/production/employees/emp-1")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/production/employees/emp-1")).toHaveLength(1));
    const deleted = callsTo(calls, "/api/v1/production/employees/emp-1")[0];
    expect(deleted.method).toBe("DELETE");
    // DELETE 不带请求体（桩把「没传 body」记成 null）
    expect(deleted.body ?? null).toBeNull();
    // 删除后整页重新拉取员工目录（include_deleted=true）
    await waitFor(() => expect(callsTo(calls, EP.employees).length).toBeGreaterThanOrEqual(2));
  });

  it("取消确认不会发任何写请求", async () => {
    const calls = await openHr({ employees });

    await userEvent.click(within(rowFor("员工目录", "E02")).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除员工")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByText("删除员工")).toBeNull());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("恢复：已删除行点「恢复」→ POST /restore 并重新拉取列表", async () => {
    const calls = await openHr({ employees: [...employees, deletedEmployee] }, (url, call) =>
      url === "/api/v1/production/employees/emp-9/restore" && call.method === "POST" ? apiOk({}) : undefined
    );
    await pickOption(filterAt(0), "已删除");
    await waitFor(() => expect(panel("员工目录").getAllByTestId("data-table-row")).toHaveLength(1));

    await userEvent.click(within(rowFor("员工目录", "E09")).getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/production/employees/emp-9/restore")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/production/employees/emp-9/restore")[0].method).toBe("POST");
    // 恢复后整页重新拉取（员工目录第 2 次 GET）
    await waitFor(() => expect(callsTo(calls, EP.employees).length).toBeGreaterThanOrEqual(2));
    // 恢复不需要确认弹窗，也不会误发 DELETE
    expect(screen.queryByText("删除员工")).toBeNull();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("删除失败时把后端文案通过 toast 暴露出来，列表不变", async () => {
    const calls = await openHr({ employees }, (url, call) =>
      url === "/api/v1/production/employees/emp-1" && call.method === "DELETE"
        ? apiErr(409, "EMPLOYEE_IN_USE", "该员工仍被在途业务引用")
        : undefined
    );

    await userEvent.click(within(rowFor("员工目录", "E01")).getByRole("button", { name: "删除" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/production/employees/emp-1")).toHaveLength(1));
    // 失败不刷新列表，行还在（toast 由 Toaster 呈现）
    expect(rowFor("员工目录", "E01")).toBeVisible();
  });
});

describe("人事页 · 新建员工时身份证号自动解析", () => {
  /** 打开「新建员工」对话框。 */
  async function openCreateEmployee(data: Parameters<typeof openHr>[0] = { employees, departments, positions }) {
    await openHr(data);
    await userEvent.click(screen.getByRole("button", { name: "新建员工" }));
    await screen.findByTestId("action-dialog");
  }
  const fieldValue = (name: string) => (screen.getByTestId(`action-field-${name}`) as HTMLInputElement).value;

  it("身份证号填完 → 出生日期、性别、家庭住址的省市县前缀自动带出（详细住址仍留给人填）", async () => {
    await openCreateEmployee();

    await userEvent.type(screen.getByTestId("action-field-id_card_no"), "350430198405204527");

    expect(fieldValue("birth_date")).toBe("1984-05-20");
    // 家庭住址只补到区县 + 一个空格，镇/村/门牌由操作员接着输
    expect(fieldValue("home_address")).toBe("福建省三明市建宁县 ");
    // 性别是下拉：自动选中「女」
    expect(screen.getByTestId("action-field-gender")).toHaveTextContent("女");
  });

  it("老区划代码（413028 = 原信阳地区罗山县）同样解析出当时的省市县", async () => {
    await openCreateEmployee();
    await userEvent.type(screen.getByTestId("action-field-id_card_no"), "413028196510110959");
    expect(fieldValue("home_address")).toBe("河南省信阳地区罗山县 ");
    expect(fieldValue("birth_date")).toBe("1965-10-11");
  });

  it("操作员已经手填过的字段不会被覆盖", async () => {
    await openCreateEmployee();

    // 先手填出生日期与住址，再填身份证
    await userEvent.type(screen.getByTestId("action-field-birth_date"), "1965-01-02");
    await userEvent.type(screen.getByTestId("action-field-home_address"), "同安区新民镇柑岭村");
    await userEvent.type(screen.getByTestId("action-field-id_card_no"), "350430198405204527");

    // 手填过的两个字段都不能被覆盖
    expect(fieldValue("birth_date")).toBe("1965-01-02");
    expect(fieldValue("home_address")).toBe("同安区新民镇柑岭村");
    // 没手填过的性别照旧自动带出
    expect(screen.getByTestId("action-field-gender")).toHaveTextContent("女");
  });

  it("身份证没填完或校验位不对时一个字段都不动", async () => {
    await openCreateEmployee();

    await userEvent.type(screen.getByTestId("action-field-id_card_no"), "350430198405204521");
    expect(fieldValue("birth_date")).toBe("");
    expect(fieldValue("home_address")).toBe("");
    expect(screen.getByTestId("action-field-gender")).not.toHaveTextContent("女");
    expect(screen.getByTestId("action-field-gender")).not.toHaveTextContent("男");
  });
});

describe("人事页 · 失败态与权限", () => {
  it("加载失败：错误态呈现后端文案、两条列表都没有数据行；「重新加载」后恢复渲染", async () => {
    let failing = true;
    const calls = await openHr({ employees, attendance: attendanceRecords, performance: performanceRecords }, (url) => {
      if (url === EP.employees && failing) {
        failing = false;
        return apiErr(403, "FORBIDDEN", "无权访问员工档案");
      }
      return undefined;
    });

    // 服务端 message 原样呈现，而不是笼统兜底文案
    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权访问员工档案");
    // 失败后页面外壳照常渲染（不是白屏），筛选入口也在
    expect(screen.getByTestId("page-hr")).toBeVisible();
    expect(screen.getByPlaceholderText("搜索工号或姓名")).toBeVisible();
    // 但一条数据都没有：不能把"没加载到"当成"正常空表"
    expect(rowsIn("员工目录")).toHaveLength(0);
    expect(rowsIn("考勤与绩效")).toHaveLength(0);
    expect(screen.queryByText("E01")).toBeNull();
    expect(screen.queryByText("2026-02-10 09:00-18:00")).toBeNull();
    expect(screen.queryAllByTestId("data-table")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("page-hr")).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId("error-state")).toBeNull());
    expect(rowsIn("员工目录")).toHaveLength(3);
    expect(panel("考勤与绩效").getByText("2026-02-10 09:00-18:00")).toBeVisible();
    // 重试是整页重新拉取：7 个业务接口各被再请求一次；币种字典与银行账户池是静态主数据，只拉一次
    expect(callsTo(calls, EP.employees)).toHaveLength(2);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(BUSINESS_LISTS.length * 2 + STATIC_MASTER_DATA.length);
    expect(callsTo(calls, EP.currencies)).toHaveLength(1);
    expect(callsTo(calls, EP.banks)).toHaveLength(1);
  });

  it("KNOWN_DEFECT：部门/岗位接口 403（人事账号无 production 模块权限）时整页报错，hr 模块数据一并不可见", async () => {
    // 期望（本仓库已确立的约定，见 apps/web/app/finance/page.tsx:26-28：选项类接口失败时
    //   `.catch(() => ({ data: [], meta: {} }))` 留空即可，页面照常渲染）：
    //   部门/岗位下拉留空，「员工目录」「考勤与绩效」照常渲染 —— HR 页面本身属于 hr 模块，
    //   而这三个接口挂在 production 模块（apps/api/src/modules/production/production-master-data.controller.ts:51
    //   @RequireModules("production")），只有 hr 权限的账号必然拿不到。
    // 实际：apps/web/app/hr/page.tsx:139-147 的 Promise.all 对 7 个请求一视同仁，
    //   任一 reject 就整页 catch，setEmployees/setAttendance/... 一行都不执行 —— 即使 hr 接口
    //   已经成功返回（本次桩里考勤/绩效都回了数据），用户也一条都看不到，只剩错误态 + 两个空态。
    // 责任文件：apps/web/app/hr/page.tsx:139-147。
    const calls = await openHr({ employees, attendance: attendanceRecords, performance: performanceRecords }, (url) =>
      url === EP.departments || url === EP.positions ? apiErr(403, "FORBIDDEN", "无权限访问生产基础资料") : undefined
    );

    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权限访问生产基础资料");
    // hr 模块的接口确实成功了，但数据被整页丢弃
    expect(callsTo(calls, EP.attendance)).toHaveLength(1);
    expect(rowsIn("员工目录")).toHaveLength(0);
    expect(rowsIn("考勤与绩效")).toHaveLength(0);
    expect(screen.queryByText("2026-02-10 09:00-18:00")).toBeNull();
    expect(panel("员工目录").getByTestId("empty-state")).toHaveTextContent("暂无匹配员工");
    expect(panel("考勤与绩效").getByTestId("empty-state")).toHaveTextContent("暂无考勤或绩效记录");

    // 选项池也是空的（没有留下任何可用的下拉项）
    await userEvent.click(filterAt(1));
    expect(screen.queryByRole("option", { name: "生产部" })).toBeNull();
    expect(await screen.findByRole("option", { name: "全部部门" })).toBeVisible();
  });
});

describe("人事页 · 已知缺陷", () => {
  it("KNOWN_DEFECT：薪资台账与工资支付每次加载都请求，但页面上没有任何区块渲染它们", async () => {
    // 期望：页面上有「薪资台账」「工资支付」区块，渲染 payableAmount + currency（hr/page.tsx:802-819 的
    //   ledgerColumns）、paymentNo / 日期截断 / 金额（:860-873 的 paymentColumns），
    //   并给出 jsx 里已经写好的入口（:629 generateLedger「生成薪资台账」、:669 createPayment「登记工资支付」）。
    // 实际：render 只有「员工目录」(:960-1052) 与「考勤与绩效」(:1053-1064) 两个 section 就结束了；
    //   :119-120 的两个 state、:802-873 的两套列定义、:629-700 的两个对话框构造函数全是死代码，
    //   用户永远看不到薪资台账/工资支付数据，也没有任何入口能生成台账或登记工资支付。
    // 责任文件：apps/web/app/hr/page.tsx:802-873（列定义未被任何 DataTable 引用）、:119-120（只被 set 未被读）。
    const calls = await openHr({
      employees,
      ledgers: [{ id: "led-1", employeeId: "emp-1", periodStart: "2026-02-01T00:00:00.000Z", periodEnd: "2026-02-28T00:00:00.000Z", payableAmount: "8800.00", status: "draft", currency: "CNY" }],
      salaryPayments: [{ id: "pay-1", paymentNo: "SP-001", paymentDate: "2026-03-05T00:00:00.000Z", amount: "8800.00", currency: "CNY", status: "draft" }],
    });

    // 请求照发（每次进页面都多两个没人用的请求）
    expect(callsTo(calls, EP.ledgers)).toHaveLength(1);
    expect(callsTo(calls, EP.salaryPayments)).toHaveLength(1);

    // 数据一条都不渲染
    expect(screen.queryByText(/8800\.00/)).toBeNull();
    expect(screen.queryByText("SP-001")).toBeNull();
    expect(screen.queryByRole("heading", { name: /薪资|工资|台账/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "生成薪资台账" })).toBeNull();
    expect(screen.queryByRole("button", { name: "登记工资支付" })).toBeNull();
    // 整页只有两个区块
    expect(screen.getAllByTestId("data-table")).toHaveLength(1);
  });

  it("KNOWN_DEFECT：考勤记录缺上下班时间时，「日期/周期」列渲染成「2026-02-11 ---」", async () => {
    // 期望：没有上下班时间时只显示日期（或单个「-」），例如「2026-02-11」。
    // 实际：apps/web/app/hr/page.tsx:789-792 的模板把两个缺失回退符连在一起：
    //   `${date} ${start ?? "-"}-${end ?? "-"}` → 「2026-02-11 ---」。
    //   请假/缺勤这类没有具体工时的考勤记录（后端 workStartTime/workEndTime 可为空）就会命中。
    // 责任文件：apps/web/app/hr/page.tsx:789-792。
    await openHr({
      employees,
      attendance: [{ id: "att-2", employeeId: "emp-1", attendanceDate: "2026-02-11T00:00:00.000Z", attendanceType: "事假" }],
    });

    const row = rowFor("考勤与绩效", "2026-02-11");
    expect(cellText(row, 2)).toBe("2026-02-11 ---");
    expect(cellText(row, 3)).toBe("事假");
  });
});
