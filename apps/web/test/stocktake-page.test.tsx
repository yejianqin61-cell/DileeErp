// 仓库 → 库存盘点页（app/warehouse/stocktakes/page.tsx）的行为测试。
//
// 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，调整库存物料数量。
// 物料的产品代码作为唯一性，在新建物料时自动生成一个物料代码。物料导入模板，需要有这些 column：
// 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」。
//
// 这里覆盖的是**用户能看见的行为**：
//   1. 导入盘点表（multipart：file + period_month）→ 逐行结果 → 自动打开新建的盘点单；
//   2. 明细表把三个账面口径都摊开（导入时账面 / 实盘 / 导入时差异，确认后还有确认时账面与已应用调整）；
//   3. 确认按确认当时的账面数重算，回报「导入后有变动」的行数；
//   4. 只有草稿能改能删；已确认只能冲销，且冲销原因必填；
//   5. 搜索只过滤展示，不额外打接口。
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StocktakesPage from "../app/warehouse/stocktakes/page";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 下载三件套（与 payable-page.test.tsx 同一套）：只关心 URL 与文件名。 */
let anchorClicks: Array<{ download: string; href: string }> = [];
function captureDownloads() {
  anchorClicks = [];
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:http://localhost/${anchorClicks.length + 1}`),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}
afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const EP = { list: "/api/v1/stocktakes", template: "/api/v1/stocktakes/import-template.xlsx", imp: "/api/v1/stocktakes/import" } as const;

const draftRow = {
  id: "st-1", stocktake_no: "PD-20260916-0001", period_month: "2026-09", status: "draft", status_label: "草稿",
  source_file_name: "9月盘点.xlsx", imported_at: "2026-09-16T02:00:00.000Z", confirmed_at: null, reversed_at: null,
  reversal_reason: null, remark: null, created_at: "2026-09-16T02:00:00.000Z", line_count: 2, differing_line_count: 1,
};
const confirmedRow = {
  ...draftRow, id: "st-2", stocktake_no: "PD-20260901-0002", status: "confirmed", status_label: "已确认",
  confirmed_at: "2026-09-02T02:00:00.000Z", line_count: 1, differing_line_count: 0,
};

const lineOne = {
  id: "line-1", line_no: 1, material_id: "m-1", material_code: "MAT-1", material_name: "涤纶布",
  product_code: "MAT-1", product_name: "涤纶布", specification: "150D", warehouse_zone: "A区", bin_location: "A-01",
  unit_id: "u-1", unit_name: "米", actual_quantity: "90", book_quantity_snapshot: "100", difference_snapshot: "-10",
  book_quantity_at_confirm: null, applied_quantity: null, difference_reason: "受潮报废",
};
const lineTwo = {
  ...lineOne, id: "line-2", line_no: 2, material_id: "m-2", material_code: "MAT-2", material_name: "松紧带",
  product_code: "MAT-2", product_name: "松紧带", specification: "5mm", warehouse_zone: "B区", bin_location: "B-01",
  unit_id: "u-2", unit_name: "条", actual_quantity: "80", book_quantity_snapshot: "80", difference_snapshot: "0",
  difference_reason: null,
};
const summary = {
  line_count: 2, differing_line_count: 1, increased_line_count: 0, decreased_line_count: 1, applied_line_count: 0,
  changed_after_import_count: 0, differing_without_reason_count: 0,
  units: [{ unit_id: "u-1", unit_name: "米", increase_quantity: "0", decrease_quantity: "10" }],
};
const draftDetail = { ...draftRow, lines: [lineOne, lineTwo], summary };
const confirmedDetail = {
  ...confirmedRow,
  lines: [{ ...lineOne, book_quantity_at_confirm: "85", applied_quantity: "-5" }],
  summary: { ...summary, line_count: 1, applied_line_count: 1, changed_after_import_count: 1, units: [{ unit_id: "u-1", unit_name: "米", increase_quantity: "0", decrease_quantity: "10" }] },
};

const importResult = {
  status: "partial", total: 3, imported: 2, errorCount: 1, headerRow: 1,
  errors: [{ row: 4, field: "产品代码", reason: "产品代码 MAT-404 在物料清单里找不到：请先到【采购 → 物料清单】新建这个物料（物料编码默认自动生成），再重新导入" }],
  missingColumns: [], ignoredColumns: ["盘点人"], ignoredTrailingRows: 0,
  hints: ["2026-09 已有 1 张盘点单（PD-20260916-0001 草稿）：差异都按各自确认当时的账面数计算", "导入只生成盘点草稿：数量与差异原因都可以再改，确认后才写库存调整"],
  stocktakeId: "st-1", stocktakeNo: "PD-20260916-0001",
};

const confirmResult = {
  adjusted: 1, unchanged: 1,
  changedAfterImport: [{ line_no: 1, product_code: "MAT-1", book_quantity_snapshot: "100", book_quantity_at_confirm: "85" }],
  differingWithoutReason: [],
};

function stub(data: { rows?: unknown; detail?: unknown; importResult?: unknown; confirm?: unknown } = {}, extra?: (url: string, call: StubbedCall) => Response | undefined) {
  return stubApi((url, call) => {
    const fromExtra = extra?.(url, call);
    if (fromExtra) return fromExtra;
    if (url.endsWith(EP.template)) {
      return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    }
    if (call.method === "POST" && url.endsWith(EP.imp)) return apiOk(data.importResult ?? importResult);
    if (call.method === "POST" && /\/stocktakes\/[^/]+\/confirm$/.test(url)) return apiOk(data.confirm ?? confirmResult);
    if (call.method === "POST" && /\/stocktakes\/[^/]+\/reverse$/.test(url)) return apiOk({ id: "st-2", reverted: 1, reason: "点错了" });
    if (call.method === "PATCH" && url.includes("/stocktakes/lines/")) return apiOk({ id: "line-1", actual_quantity: "105", difference_snapshot: "5", difference_reason: "" });
    if (call.method === "DELETE" && url.includes("/stocktakes/lines/")) return apiOk({ id: "line-1" });
    if (call.method === "DELETE" && /\/stocktakes\/[^/]+$/.test(url)) return apiOk({ id: "st-1" });
    if (call.method === "GET" && /\/stocktakes\/[^/]+$/.test(url)) {
      if (data.detail === null) return apiErr(404, "STOCKTAKE_NOT_FOUND", "盘点单不存在");
      return apiOk(data.detail ?? (url.endsWith("/st-2") ? confirmedDetail : draftDetail));
    }
    if (call.method === "GET" && url.endsWith(EP.list)) return apiOk(data.rows ?? [draftRow, confirmedRow]);
    return apiOk([]);
  });
}

async function open() {
  render(<StocktakesPage />);
  await screen.findByTestId("page-warehouse-stocktakes");
}

const panel = (title: string) => {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
};

describe("库存盘点：列表", () => {
  it("列出盘点单（单号 / 月份 / 状态 / 明细数 / 差异行数 / 来源文件）", async () => {
    stub();
    await open();

    const table = panel("盘点单");
    const rows = table.getAllByTestId("data-table-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("PD-20260916-0001")).toBeVisible();
    expect(within(rows[0]).getByText("2026-09")).toBeVisible();
    expect(within(rows[0]).getByText("草稿")).toBeVisible();
    expect(within(rows[0]).getByText("9月盘点.xlsx")).toBeVisible();
    // 差异行数只在 nonzero 时高亮显示，0 就显示 0（不要用「-」让人以为是没数据）
    expect(within(rows[0]).getByText("1")).toBeVisible();
    expect(within(rows[1]).getByText("已确认")).toBeVisible();
  });

  it("没有盘点单时给出空态与去处", async () => {
    stub({ rows: [] });
    await open();

    expect(panel("盘点单").getByText("暂无盘点单")).toBeVisible();
  });

  it("加载失败：错误态可重试，重试会再打一次列表接口", async () => {
    let attempt = 0;
    const calls = stub({}, (url, call) => {
      if (call.method === "GET" && url.endsWith(EP.list)) {
        attempt += 1;
        return attempt === 1 ? apiErr(500, "INTERNAL_ERROR", "盘点单加载失败") : apiOk([draftRow]);
      }
      return undefined;
    });
    await open();

    const errorState = await screen.findByTestId("error-state");
    expect(errorState).toHaveTextContent("盘点单加载失败");

    await userEvent.click(screen.getByTestId("error-state-retry"));

    await waitFor(() => expect(panel("盘点单").getByText("PD-20260916-0001")).toBeVisible());
    expect(callsTo(calls, EP.list).filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("搜索只过滤展示（列表与明细都过滤），不额外打接口", async () => {
    const calls = stub();
    await open();
    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[0]);
    await screen.findByTestId("stocktake-detail");
    const before = calls.length;

    fireEvent.change(screen.getByTestId("stocktake-search"), { target: { value: "松紧带" } });

    expect(panel("盘点单").queryAllByTestId("data-table-row")).toHaveLength(0);
    const lineRows = within(screen.getByTestId("stocktake-detail")).getAllByTestId("data-table-row");
    expect(lineRows).toHaveLength(1);
    expect(within(lineRows[0]).getByText("MAT-2")).toBeVisible();
    expect(calls).toHaveLength(before);
  });
});

describe("库存盘点：明细与口径", () => {
  it("明细把三个账面口径摊开：导入时账面 / 实盘 / 导入时差异，并给出按单位的调增调减", async () => {
    stub();
    await open();

    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[0]);

    const detail = await screen.findByTestId("stocktake-detail");
    const rows = within(detail).getAllByTestId("data-table-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("MAT-1")).toBeVisible();
    expect(within(rows[0]).getByText("150D")).toBeVisible();
    expect(within(rows[0]).getByText("A区")).toBeVisible();
    expect(within(rows[0]).getByText("A-01")).toBeVisible();
    expect(within(rows[0]).getByText("100")).toBeVisible();
    expect(within(rows[0]).getByText("-10")).toBeVisible();
    expect(within(rows[0]).getByText("受潮报废")).toBeVisible();
    // 未确认的行没有「确认时账面」「已应用调整」
    expect(within(rows[0]).getAllByText("-").length).toBeGreaterThanOrEqual(2);

    expect(screen.getByTestId("stocktake-summary")).toHaveTextContent("明细 2 行：差异 1 行（盘盈 0 / 盘亏 1），已应用调整 0 行");
    expect(screen.getByTestId("stocktake-unit-summary")).toHaveTextContent("米 +0 / -10");
  });

  it("已确认的明细不给「改实盘数 / 删行」，显示确认时账面与已应用调整", async () => {
    stub();
    await open();

    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[1]);

    const detail = await screen.findByTestId("stocktake-detail");
    expect(within(detail).queryByRole("button", { name: "改实盘数" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "删行" })).toBeNull();
    const row = within(detail).getAllByTestId("data-table-row")[0];
    expect(within(row).getByText("85")).toBeVisible();
    expect(within(row).getByText("-5")).toBeVisible();
    expect(within(row).getByText("已确认")).toBeVisible();
    expect(screen.getByTestId("stocktake-summary")).toHaveTextContent("已应用调整 1 行");
  });
});

describe("库存盘点：导入", () => {
  it("下载模板：拉 import-template.xlsx 并按后端文件名落盘", async () => {
    captureDownloads();
    const calls = stub();
    await open();

    await userEvent.click(screen.getByTestId("stocktake-import-template"));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith(EP.template))).toBe(true));
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("迪礼ERP-库存盘点导入模板.xlsx");
  });

  it("上传盘点表：multipart 带 file 与盘点月份，逐行结果显示出来，并自动打开新建的盘点单", async () => {
    const calls = stub();
    await open();
    fireEvent.change(screen.getByTestId("stocktake-month"), { target: { value: "2026-09" } });

    const file = new File(["xlsx-bytes"], "9月盘点.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await userEvent.upload(screen.getByTestId("stocktake-import-file"), file);

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith(EP.imp))).toHaveLength(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith(EP.imp))!;
    expect(posted.body).toBeInstanceOf(FormData);
    const form = posted.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("period_month")).toBe("2026-09");

    const result = await screen.findByTestId("stocktake-import-result");
    expect(screen.getByTestId("stocktake-import-count")).toHaveTextContent("共 3 行：入库 2 行 / 错误 1 行（盘点单 PD-20260916-0001）");
    expect(within(result).getByText(/MAT-404 在物料清单里找不到/)).toBeVisible();
    expect(within(result).getByText(/已忽略：盘点人/)).toBeVisible();
    expect(within(result).getByText(/2026-09 已有 1 张盘点单/)).toBeVisible();
    // 导入成功后自动打开这张草稿单（省一次「明细」点击）
    await waitFor(() => expect(screen.getByTestId("stocktake-detail")).toBeVisible());
  });

  it("一行都没进来时明确说「没有可导入的行」，不假装成功", async () => {
    stub({ importResult: { ...importResult, status: "failed", imported: 0, errorCount: 3, stocktakeId: null, stocktakeNo: null } });
    await open();

    await userEvent.upload(screen.getByTestId("stocktake-import-file"), new File(["x"], "坏表.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    const result = await screen.findByTestId("stocktake-import-result");
    expect(screen.getByTestId("stocktake-import-count")).toHaveTextContent("共 3 行：入库 0 行 / 错误 3 行");
    expect(result).toBeVisible();
    expect(screen.queryByTestId("stocktake-detail")).toBeNull();
  });
});

describe("库存盘点：确认与冲销", () => {
  it("确认要两步（先展开确认条），确认后回报调整行数与「导入后有变动」的行数，并刷新列表", async () => {
    const calls = stub();
    await open();

    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "确认" })[0]);

    const bar = await screen.findByTestId("stocktake-confirm-bar");
    expect(bar).toHaveTextContent("确认后按确认当时的账面数写库存调整（差异 1 行）");
    expect(calls.filter((call) => call.url.endsWith("/confirm"))).toHaveLength(0);

    const listLoadsBefore = callsTo(calls, EP.list).filter((call) => call.method === "GET").length;
    await userEvent.click(within(bar).getByRole("button", { name: "确认" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/stocktakes/st-1/confirm"))).toBe(true));
    const message = await screen.findByTestId("stocktake-message");
    expect(message).toHaveTextContent("盘点 PD-20260916-0001 已确认：写库存调整 1 行，无差异 1 行");
    expect(message).toHaveTextContent("1 行在导入之后账面有变动，已按确认当时的账面数调整");
    await waitFor(() => expect(callsTo(calls, EP.list).filter((call) => call.method === "GET").length).toBeGreaterThan(listLoadsBefore));
  });

  it("冲销原因必填：不填时按钮禁用，填了才提交，并把原因发给后端", async () => {
    const calls = stub();
    await open();

    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "冲销" })[0]);

    const bar = await screen.findByTestId("stocktake-reverse-bar");
    const submit = within(bar).getByRole("button", { name: "冲销" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByTestId("stocktake-reverse-reason"), "盘错了一行");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/stocktakes/st-2/reverse"))).toBe(true));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith("/stocktakes/st-2/reverse"))!;
    expect(JSON.parse(String(posted.body))).toEqual({ reason: "盘错了一行" });
    expect(await screen.findByTestId("stocktake-message")).toHaveTextContent("盘点 PD-20260901-0002 已冲销");
  });
});

describe("库存盘点：草稿行的修改与删除", () => {
  it("改实盘数：弹窗带出当前值与账面数，提交后 PATCH 只发需要的字段", async () => {
    const calls = stub();
    await open();
    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[0]);
    await screen.findByTestId("stocktake-detail");

    await userEvent.click(within(screen.getByTestId("stocktake-detail")).getAllByRole("button", { name: "改实盘数" })[0]);

    const input = await screen.findByTestId("action-field-actual_quantity");
    // type=number 的表单控件值在 DOM 里是数字
    expect(input).toHaveValue(90);
    // 账面数写在标签里：操作员填的时候必须能一眼看到在跟什么比
    expect(screen.getByText(/实盘数（米，账面 100）/)).toBeVisible();
    expect(screen.getByTestId("action-field-difference_reason")).toHaveValue("受潮报废");

    await userEvent.clear(input);
    await userEvent.type(input, "105");
    await userEvent.clear(screen.getByTestId("action-field-difference_reason"));
    await userEvent.type(screen.getByTestId("action-field-difference_reason"), "上次盘错");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/stocktakes/lines/line-1"))).toBe(true));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/stocktakes/lines/line-1"))!;
    expect(JSON.parse(String(patched.body))).toEqual({ actual_quantity: "105", difference_reason: "上次盘错" });
    // 成功后才关弹窗（失败要留在弹窗里，用户填的不丢）
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
  });

  it("改实盘数失败：弹窗保持打开并显示后端原因", async () => {
    stub({}, (url, call) => (call.method === "PATCH" && url.endsWith("/stocktakes/lines/line-1")
      ? apiErr(422, "INVALID_STOCKTAKE_ACTUAL_QUANTITY", "实际数量必须是不小于 0 的十进制数（最多 4 位小数）")
      : undefined));
    await open();
    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[0]);
    await screen.findByTestId("stocktake-detail");

    await userEvent.click(within(screen.getByTestId("stocktake-detail")).getAllByRole("button", { name: "改实盘数" })[0]);
    await userEvent.click(await screen.findByRole("button", { name: "保存" }));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("实际数量必须是不小于 0 的十进制数");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("删行：DELETE 打到明细行接口，并刷新这张单子", async () => {
    const calls = stub();
    await open();
    await userEvent.click(panel("盘点单").getAllByRole("button", { name: "明细" })[0]);
    await screen.findByTestId("stocktake-detail");
    const detailLoadsBefore = calls.filter((call) => call.method === "GET" && call.url.endsWith("/stocktakes/st-1")).length;

    await userEvent.click(within(screen.getByTestId("stocktake-detail")).getAllByRole("button", { name: "删行" })[0]);

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/stocktakes/lines/line-1"))).toBe(true));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.url.endsWith("/stocktakes/st-1")).length).toBeGreaterThan(detailLoadsBefore));
  });
});
