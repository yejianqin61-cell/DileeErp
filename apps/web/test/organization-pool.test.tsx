// HR 组织池（components/hr/organization-pool.tsx）真实行为测试：部门池与岗位池的完整 CRUD。
//
// 为什么这个文件必要（docs/test/00-recon-frontend-coverage.md §5 第 5 行、01-test-master-plan.md D4）：
//   该组件只有 32 行，却承载 5 个读操作与 6 个写操作（新建 / 编辑 / 停用 / 启用 / 删除 / 恢复），
//   此前**零组件测试**（recon 第 339 行：32 行、6 个按钮、0 引用）。
//   recon 点名 `request()`（organization-pool.tsx:27）没有 in-flight 标志，
//   `:32` 的「删除」「启用/停用」「恢复」三个行内按钮没有 `disabled`，连点会发出重复写请求；
//   建议的验收手段原文是"组件测试：双击删除断言只调一次 apiRequest"。
//
// 本文件按纪律用**真实渲染 + 真实事件**实测该主张，结论是**连点确实发出重复请求**
//   （见文末「连点重复写请求」describe，带请求次数证据）。
//   按任务纪律：发现真实缺陷不修，写成断言 + KNOWN_DEFECT 注释，并在报告里给出责任 文件:行号。
//
// 纪律：不 readFileSync、不正则匹配源码、不断言 className；
//   只断言 DOM 可见结果（文本 / 可见性 / 行内容 / 行内可用按钮）与 stubApi 记录到的 url/method/body。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";
import { OrganizationPool } from "../components/hr/organization-pool";

// DTO 形状对齐后端 production-master-data.service.ts 的 listDepartments / listPositions：
//   部门：{ id, code, name, remark, isActive, deletedAt, updatedAt, _count: { positions, employees } }
//   岗位：{ id, code, name, departmentId, department { code, name }, remark, isActive, deletedAt, updatedAt, _count: { employees } }
type Department = { id: string; code: string; name: string; remark?: string | null; isActive: boolean; deletedAt?: string | null; updatedAt: string; _count?: { positions: number; employees: number } };
type Position = { id: string; code: string; name: string; departmentId: string; department?: { code: string; name: string }; remark?: string | null; isActive: boolean; deletedAt?: string | null; updatedAt: string; _count?: { employees: number } };

const departments: Department[] = [
  // 启用 + 有统计
  { id: "dept-1", code: "D01", name: "生产部", remark: "一线生产", isActive: true, deletedAt: null, updatedAt: "2026-01-02T00:00:00.000Z", _count: { positions: 2, employees: 5 } },
  // 停用 + 统计为 0 + 备注为空字符串
  { id: "dept-2", code: "D02", name: "质检部", remark: "", isActive: false, deletedAt: null, updatedAt: "2026-01-03T00:00:00.000Z", _count: { positions: 0, employees: 0 } },
  // 已软删除（列表带 include_deleted=true 时才会出现）
  { id: "dept-3", code: "D03", name: "已裁撤部", isActive: true, deletedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", _count: { positions: 1, employees: 0 } },
  // 后端未带 _count 时（关联统计缺失）应回落 0，而不是渲染 undefined
  { id: "dept-4", code: "D04", name: "无统计部", isActive: true, deletedAt: null, updatedAt: "2026-01-04T00:00:00.000Z" },
];

const positions: Position[] = [
  { id: "pos-1", code: "P01", name: "缝纫工", departmentId: "dept-1", department: { code: "D01", name: "生产部" }, remark: "计件", isActive: true, deletedAt: null, updatedAt: "2026-01-02T00:00:00.000Z", _count: { employees: 3 } },
  { id: "pos-2", code: "P02", name: "巡检员", departmentId: "dept-4", department: { code: "D04", name: "无统计部" }, remark: "", isActive: false, deletedAt: null, updatedAt: "2026-01-03T00:00:00.000Z", _count: { employees: 0 } },
  { id: "pos-3", code: "P03", name: "旧岗位", departmentId: "dept-1", department: { code: "D01", name: "生产部" }, isActive: true, deletedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  // department 关联缺失（部门已被物理删除/未 include）→ 所属部门列应回落 "-"
  { id: "pos-4", code: "P04", name: "无部门岗位", departmentId: "dept-9", isActive: true, deletedAt: null, updatedAt: "2026-01-04T00:00:00.000Z" },
];

type Fixture = {
  departments?: Department[];
  positions?: Position[];
  /** 前 N 次列表 GET 返回 500（用于加载失败 + 重试）。 */
  failLoads?: number;
  /** 让所有写请求（非 GET）返回该错误。 */
  mutationError?: { status: number; code: string; message: string };
};

/** 按 URL + method 分派的 mock 后端；返回被记录下来的请求列表。 */
function stubPool(fixture: Fixture = {}) {
  const departmentRows = fixture.departments ?? departments;
  const positionRows = fixture.positions ?? positions;
  let remainingFailures = fixture.failLoads ?? 0;
  return stubApi((url, call) => {
    if (call.method === "GET") {
      if (url.includes("/production/positions") || url.includes("/production/departments")) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          return apiErr(500, "INTERNAL_SERVER_ERROR", "部门池加载失败");
        }
        return apiOk(url.includes("/production/positions") ? positionRows : departmentRows);
      }
      return apiErr(404, "NOT_FOUND", `测试未打桩的 GET：${url}`);
    }
    if (fixture.mutationError) {
      const { status, code, message } = fixture.mutationError;
      return apiErr(status, code, message);
    }
    return apiOk({});
  });
}

/** 渲染组织池并等待表格出现（首次 load 完成）。 */
async function renderPool(kind: "departments" | "positions", fixture: Fixture = {}) {
  const calls = stubPool(fixture);
  render(<OrganizationPool kind={kind} />);
  await screen.findByTestId("data-table");
  return calls;
}

function rows() {
  return within(screen.getByTestId("data-table")).queryAllByTestId("data-table-row");
}

function rowFor(text: string) {
  const row = rows().find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`未找到包含「${text}」的行`);
  return row;
}

/** 单元格按列序取值：部门 [编码, 名称, 岗位数, 员工数, 状态, 备注, 操作]。 */
function cellText(row: HTMLElement, index: number) {
  return within(row).getAllByRole("cell")[index]?.textContent?.trim() ?? "";
}

function jsonBody(call: StubbedCall | undefined) {
  if (!call) throw new Error("没有记录到该请求");
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 点开某个筛选下拉并选中一项（Radix Select）。 */
async function pickOption(trigger: HTMLElement, optionName: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("组织池 · 加载态与错误态", () => {
  it("列表返回前显示整页加载态，且此时没有任何入口按钮（不会把空部门快照进对话框）", async () => {
    const gate = deferred<Response>();
    stubApi((url) => (url.includes("include_deleted=true") ? gate.promise : apiErr(404, "NOT_FOUND", url)));

    render(<OrganizationPool kind="departments" />);

    expect(screen.getByTestId("loading-state")).toBeVisible();
    expect(screen.getByText("正在加载...")).toBeVisible();
    expect(screen.getByRole("heading", { name: "部门池" })).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();
    // loading 时提前 return，只有页头 + 加载态：新建入口不存在，因此不存在"加载中开对话框拿到空选项"的窗口
    expect(screen.queryByRole("button", { name: "新建部门" })).toBeNull();

    gate.resolve(apiOk(departments));

    expect(await screen.findByTestId("data-table")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();
    expect(screen.getByRole("button", { name: "新建部门" })).toBeVisible();
  });

  it("加载失败显示服务端原因，「重新加载」重新请求并恢复渲染", async () => {
    const calls = stubPool({ failLoads: 1 });
    render(<OrganizationPool kind="departments" />);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("部门池加载失败");
    expect(screen.queryByTestId("data-table")).toBeNull();

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("data-table")).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(callsTo(calls, "include_deleted=true")).toHaveLength(2);
  });

  it("空数据渲染空态，空态里的「新建部门」能打开新建对话框", async () => {
    await stubPool({ departments: [] });
    render(<OrganizationPool kind="departments" />);

    const empty = await screen.findByTestId("empty-state");
    expect(empty).toHaveTextContent("暂无部门");
    expect(screen.queryByTestId("data-table")).toBeNull();

    await userEvent.click(within(empty).getByRole("button", { name: "新建部门" }));

    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    expect(screen.getByTestId("action-field-code")).toBeVisible();
    expect(screen.getByTestId("action-field-name")).toBeVisible();
  });
});

describe("部门池 · 列表渲染与行内可用操作", () => {
  it("按列渲染编码/名称/岗位数/员工数/状态/备注，缺失 _count 回落 0", async () => {
    await renderPool("departments");

    expect(rows()).toHaveLength(4);

    const production = rowFor("D01");
    expect(cellText(production, 0)).toBe("D01");
    expect(cellText(production, 1)).toBe("生产部");
    expect(cellText(production, 2)).toBe("2");
    expect(cellText(production, 3)).toBe("5");
    expect(cellText(production, 4)).toBe("启用");
    expect(cellText(production, 5)).toBe("一线生产");

    // 停用行
    expect(cellText(rowFor("D02"), 4)).toBe("停用");
    // 软删除行
    expect(cellText(rowFor("D03"), 4)).toBe("已删除");
    // 后端未返回 _count：必须回落 0，不能渲染 "undefined"
    const noCount = rowFor("D04");
    expect(cellText(noCount, 2)).toBe("0");
    expect(cellText(noCount, 3)).toBe("0");
    expect(noCount).not.toHaveTextContent("undefined");
  });

  it("活跃行给出编辑/停用/删除，已删除行只给出恢复", async () => {
    await renderPool("departments");

    const active = rowFor("D01");
    expect(within(active).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "停用" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "删除" })).toBeVisible();
    expect(within(active).queryByRole("button", { name: "恢复" })).toBeNull();

    // isActive=false 的行文案是「启用」
    expect(within(rowFor("D02")).getByRole("button", { name: "启用" })).toBeVisible();

    const deleted = rowFor("D03");
    expect(within(deleted).getByRole("button", { name: "恢复" })).toBeVisible();
    expect(within(deleted).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(deleted).queryByRole("button", { name: "删除" })).toBeNull();
    expect(within(deleted).queryByRole("button", { name: "启用" })).toBeNull();
    expect(within(deleted).queryByRole("button", { name: "停用" })).toBeNull();
  });

  it("部门池没有「部门筛选器」（岗位池才有）：整页只有一个下拉框", async () => {
    await renderPool("departments");

    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });
});

describe("部门池 · 新建与编辑", () => {
  it("新建：POST /production/departments 带编码/名称/备注，成功后提示并重新拉取列表", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(screen.getByRole("button", { name: "新建部门" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText("新建部门")).toBeVisible();

    await userEvent.type(screen.getByTestId("action-field-code"), "D05");
    await userEvent.type(screen.getByTestId("action-field-name"), "仓储部");
    await userEvent.type(screen.getByTestId("action-field-remark"), "新建备注");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/departments").filter((call) => call.method === "POST")).toHaveLength(1));
    const create = callsTo(calls, "/production/departments").find((call) => call.method === "POST");
    expect(jsonBody(create)).toEqual({ code: "D05", name: "仓储部", remark: "新建备注" });

    expect(await screen.findByText("部门已创建")).toBeVisible();
    // 成功后必须全量重拉（本组件没有乐观更新）
    expect(callsTo(calls, "include_deleted=true").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("新建：必填项为空时给出可读提示且不发写请求", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(screen.getByRole("button", { name: "新建部门" }));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写部门编码");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    // 校验失败不能关弹窗，否则用户已填内容会丢
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("编辑：对话框带出当前值，提交 PATCH /production/departments/:id（备注原样回传）", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D01")).getByRole("button", { name: "编辑" }));

    expect(await screen.findByText("编辑部门")).toBeVisible();
    expect(screen.getByTestId("action-field-code")).toHaveValue("D01");
    expect(screen.getByTestId("action-field-name")).toHaveValue("生产部");
    expect(screen.getByTestId("action-field-remark")).toHaveValue("一线生产");

    await userEvent.clear(screen.getByTestId("action-field-name"));
    await userEvent.type(screen.getByTestId("action-field-name"), "生产一部");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-1")).toHaveLength(1));
    const patch = callsTo(calls, "/production/departments/dept-1")[0];
    expect(patch.method).toBe("PATCH");
    expect(jsonBody(patch)).toEqual({ code: "D01", name: "生产一部", remark: "一线生产" });
    expect(await screen.findByText("部门已更新")).toBeVisible();
  });

  it("编辑：备注留空时不把 remark 提交上去（清空不会被写成空串覆盖历史备注）", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D02")).getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑部门");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-2")).toHaveLength(1));
    expect(jsonBody(callsTo(calls, "/production/departments/dept-2")[0])).toEqual({ code: "D02", name: "质检部" });
  });
});

describe("部门池 · 停用/启用/删除/恢复", () => {
  it("停用：PATCH /:id/active 带 is_active=false，提示与状态文案一致", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D01")).getByRole("button", { name: "停用" }));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-1/active")).toHaveLength(1));
    const toggle = callsTo(calls, "/production/departments/dept-1/active")[0];
    expect(toggle.method).toBe("PATCH");
    expect(jsonBody(toggle)).toEqual({ is_active: false });
    expect(await screen.findByText("部门已停用")).toBeVisible();
  });

  it("启用：停用行给出「启用」，PATCH 带 is_active=true", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D02")).getByRole("button", { name: "启用" }));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-2/active")).toHaveLength(1));
    expect(jsonBody(callsTo(calls, "/production/departments/dept-2/active")[0])).toEqual({ is_active: true });
    expect(await screen.findByText("部门已启用")).toBeVisible();
  });

  it("删除：DELETE /production/departments/:id 并提示", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D01")).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-1").filter((call) => call.method === "DELETE")).toHaveLength(1));
    expect(await screen.findByText("部门已删除")).toBeVisible();
  });

  it("恢复：POST /production/departments/:id/restore 并提示", async () => {
    const calls = await renderPool("departments");

    await userEvent.click(within(rowFor("D03")).getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(callsTo(calls, "/production/departments/dept-3/restore")).toHaveLength(1));
    expect(callsTo(calls, "/production/departments/dept-3/restore")[0].method).toBe("POST");
    expect(await screen.findByText("部门已恢复")).toBeVisible();
  });

  it("写操作被服务端拒绝：显示服务端原因、不显示成功提示、不重拉列表", async () => {
    const calls = await renderPool("departments", { mutationError: { status: 422, code: "DEPARTMENT_HAS_EMPLOYEES", message: "该部门下仍有员工，无法删除" } });

    await userEvent.click(within(rowFor("D01")).getByRole("button", { name: "删除" }));

    expect(await screen.findByTestId("error-state")).toHaveTextContent("该部门下仍有员工，无法删除");
    expect(screen.queryByText("部门已删除")).toBeNull();
    expect(callsTo(calls, "/production/departments/dept-1").filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(callsTo(calls, "include_deleted=true")).toHaveLength(1);
  });
});

describe("部门池 · 搜索与状态筛选", () => {
  it("搜索框按编码或名称过滤（大小写不敏感）", async () => {
    await renderPool("departments");
    const search = screen.getByPlaceholderText("搜索部门编码或名称");

    await userEvent.type(search, "d01");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("D01")).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, "质检");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("D02")).toBeVisible();

    await userEvent.clear(search);
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it("状态筛选选「已删除」时只剩软删除行", async () => {
    await renderPool("departments");

    await pickOption(screen.getByRole("combobox"), "已删除");

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("D03")).toBeVisible();
    expect(cellText(rowFor("D03"), 4)).toBe("已删除");
  });

  it("状态筛选选「停用」时只剩 isActive=false 的行（已删除行不算停用）", async () => {
    await renderPool("departments");

    await pickOption(screen.getByRole("combobox"), "停用");

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("D02")).toBeVisible();
  });
});

describe("岗位池 · 列表、部门筛选与新建/编辑", () => {
  it("请求岗位列表（带 include_deleted）并额外拉取部门列表供筛选与下拉使用", async () => {
    const calls = await renderPool("positions");

    // KNOWN_DEFECT（契约错位）：前端为岗位请求软删除数据，但后端 GET /production/positions 只接
    //   department_id，include_deleted 被静默忽略，且 service 恒过滤 deletedAt: null
    //   （apps/api/src/modules/production/production-master-data.controller.ts:60、
    //    production-master-data.service.ts:58）。
    //   期望：岗位池能看到并「恢复」已删除岗位；实际：后端永不返回已删除岗位，
    //   该行只在本次测试的桩数据下存在。责任文件：apps/api/.../production-master-data.controller.ts:60
    //   （未声明 include_deleted 查询参数）+ production-master-data.service.ts:58（硬编码 deletedAt: null）。
    //   本用例只钉住前端确实发起了该请求这一现状。
    expect(callsTo(calls, "/production/positions?include_deleted=true")).toHaveLength(1);
    expect(callsTo(calls, "/production/departments")).toHaveLength(1);

    expect(rows()).toHaveLength(4);
    expect(cellText(rowFor("P01"), 0)).toBe("P01");
    expect(cellText(rowFor("P01"), 2)).toBe("D01 / 生产部");
    expect(cellText(rowFor("P01"), 3)).toBe("3");
    expect(cellText(rowFor("P01"), 4)).toBe("启用");
    // department 关联缺失回落 "-"
    expect(cellText(rowFor("P04"), 2)).toBe("-");
    // 未带 _count 回落 0
    expect(cellText(rowFor("P03"), 3)).toBe("0");
    // 软删除岗位状态
    expect(cellText(rowFor("P03"), 4)).toBe("已删除");
  });

  it("岗位池有两个下拉（状态 + 部门）；筛选下拉列出部门接口返回的全部部门（含停用）", async () => {
    await renderPool("positions");

    // 部门池只有 1 个下拉（状态），岗位池多一个部门筛选器
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);
    const departmentTrigger = comboboxes[1];

    await userEvent.click(departmentTrigger);
    // 筛选器直接映射 /production/departments 的返回，不做启用过滤：
    // 停用部门下也可能还有历史岗位，仍需要能筛出来。
    expect(await screen.findByRole("option", { name: "生产部" })).toBeVisible();
    expect(await screen.findByRole("option", { name: "质检部" })).toBeVisible();
    expect(await screen.findByRole("option", { name: "无统计部" })).toBeVisible();
  });

  it("新建岗位对话框的部门选项池只含启用部门（停用部门不能挂新岗位）", async () => {
    await renderPool("positions");

    await userEvent.click(screen.getByRole("button", { name: "新建岗位" }));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-field-department_id"));

    expect(await screen.findByRole("option", { name: "D01 / 生产部" })).toBeVisible();
    expect(await screen.findByRole("option", { name: "D04 / 无统计部" })).toBeVisible();
    // 已停用部门（D02 质检部）不进入对话框选项池
    expect(screen.queryByRole("option", { name: "D02 / 质检部" })).toBeNull();
    // 岗位对话框的部门下拉与筛选框是两个独立的选项池
    expect(screen.queryByRole("option", { name: "质检部" })).toBeNull();
  });

  it("按部门筛岗：选中某部门后只显示该部门岗位", async () => {
    await renderPool("positions");

    const [, departmentTrigger] = screen.getAllByRole("combobox");
    await pickOption(departmentTrigger, "无统计部");

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("P02")).toBeVisible();
    expect(screen.queryByText("缝纫工")).toBeNull();
  });

  it("新建岗位：部门必填、选项来自启用部门，提交 POST /production/positions", async () => {
    const calls = await renderPool("positions");

    await userEvent.click(screen.getByRole("button", { name: "新建岗位" }));
    await screen.findByTestId("action-dialog");

    // KNOWN_DEFECT（文案）：department_id 是 select 类型，校验文案却是「请填写」。
    //   期望「请选择所属部门」（与 multi-checkbox 分支一致的可读语义）。
    //   实际：action-dialog.tsx:28 只对 multi-checkbox 用「请选择」，select 落到「请填写」。
    //   责任文件：apps/web/components/ui/action-dialog.tsx:28。
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写所属部门");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("action-field-department_id"));
    await userEvent.click(await screen.findByRole("option", { name: "D01 / 生产部" }));
    await userEvent.type(screen.getByTestId("action-field-code"), "P05");
    await userEvent.type(screen.getByTestId("action-field-name"), "包装工");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/positions").filter((call) => call.method === "POST")).toHaveLength(1));
    const create = callsTo(calls, "/production/positions").find((call) => call.method === "POST");
    expect(jsonBody(create)).toEqual({ department_id: "dept-1", code: "P05", name: "包装工" });
    expect(await screen.findByText("岗位已创建")).toBeVisible();
  });

  it("编辑岗位：带出原编码/名称与所属部门，PATCH 对应岗位 id", async () => {
    const calls = await renderPool("positions");

    await userEvent.click(within(rowFor("P01")).getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑岗位");
    expect(screen.getByTestId("action-field-code")).toHaveValue("P01");

    await userEvent.clear(screen.getByTestId("action-field-name"));
    await userEvent.type(screen.getByTestId("action-field-name"), "缝纫技工");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/positions/pos-1")).toHaveLength(1));
    const patch = callsTo(calls, "/production/positions/pos-1")[0];
    expect(patch.method).toBe("PATCH");
    // department_id 必须由行数据带出（对话框未触碰该下拉），否则会把岗位改挂到别处/丢失部门
    expect(jsonBody(patch)).toEqual({ department_id: "dept-1", code: "P01", name: "缝纫技工", remark: "计件" });
    expect(await screen.findByText("岗位已更新")).toBeVisible();
  });
});

// recon D4（00-recon-frontend-coverage.md §7 第 5 行）要求："双击删除断言只调一次 apiRequest"。
// 实测结论：**该主张不成立** —— request()（organization-pool.tsx:27）没有 in-flight 标志，
// 行内按钮也没有 disabled/submitting 门禁，因此请求悬挂期间再点一次会再发一次写请求。
// 下面三个用例把这一现状钉死（首次请求用 deferred 挂住，确保两次点击**确实重叠**，
// 而不是"两次串行点击各发一次"的弱证据）。修法应落在生产代码，不在测试里。
describe("组织池 · 连点重复写请求（KNOWN_DEFECT）", () => {
  /** 把指定写请求挂起：第一次点击后请求永不返回，用来验证"请求在途时按钮是否仍可点"。 */
  function stubPoolWithHeldMutation(hold: (call: StubbedCall) => boolean) {
    const gate = deferred<Response>();
    const calls = stubApi((url, call) => {
      if (call.method === "GET") return apiOk(url.includes("/production/positions") ? positions : departments);
      if (hold(call)) return gate.promise;
      return apiOk({});
    });
    return { calls, release: () => gate.resolve(apiOk({})) };
  }

  it("KNOWN_DEFECT：删除在途时按钮仍可点，连点发出 2 次 DELETE", async () => {
    const { calls, release } = stubPoolWithHeldMutation((call) => call.method === "DELETE");
    render(<OrganizationPool kind="departments" />);
    await screen.findByTestId("data-table");

    const remove = within(rowFor("D01")).getByRole("button", { name: "删除" });
    await userEvent.click(remove);

    // 期望：请求在途时按钮禁用（或整行忙碌），第二次点击无处可发。
    // 实际：按钮依然 enabled —— 这正是重复 DELETE 的入口。
    expect(within(rowFor("D01")).getByRole("button", { name: "删除" })).toBeEnabled();

    await userEvent.click(remove);

    expect(callsTo(calls, "/production/departments/dept-1").filter((call) => call.method === "DELETE")).toHaveLength(2);

    release();
    expect(await screen.findByText("部门已删除")).toBeVisible();
  });

  it("KNOWN_DEFECT：停用在途时连点发出 2 次 PATCH /active（重复写请求）", async () => {
    const { calls, release } = stubPoolWithHeldMutation((call) => call.method === "PATCH");
    render(<OrganizationPool kind="departments" />);
    await screen.findByTestId("data-table");

    const toggle = within(rowFor("D01")).getByRole("button", { name: "停用" });
    await userEvent.click(toggle);
    expect(within(rowFor("D01")).getByRole("button", { name: "停用" })).toBeEnabled();

    await userEvent.click(toggle);

    expect(callsTo(calls, "/production/departments/dept-1/active")).toHaveLength(2);
    expect(callsTo(calls, "/production/departments/dept-1/active").every((call) => JSON.parse(String(call.body)).is_active === false)).toBe(true);

    release();
    expect(await screen.findByText("部门已停用")).toBeVisible();
  });

  it("KNOWN_DEFECT：恢复在途时连点发出 2 次 POST /restore", async () => {
    const { calls, release } = stubPoolWithHeldMutation((call) => call.method === "POST");
    render(<OrganizationPool kind="departments" />);
    await screen.findByTestId("data-table");

    const restore = within(rowFor("D03")).getByRole("button", { name: "恢复" });
    await userEvent.click(restore);
    expect(within(rowFor("D03")).getByRole("button", { name: "恢复" })).toBeEnabled();

    await userEvent.click(restore);

    expect(callsTo(calls, "/production/departments/dept-3/restore")).toHaveLength(2);

    release();
    expect(await screen.findByText("部门已恢复")).toBeVisible();
  });
});
