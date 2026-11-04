// 采购与仓储报表（2026-11-04）的组件测试。
//
// 需求原话：「用户需要一份采购与仓储报表…设计这份报表并支持导出与打印」。
// 本文件钉住七件事：
//   ① 首屏取数只打一次 `GET /api/v1/reports/procurement-warehouse`，查询时带上两个筛选参数；
//   ② 九列都在，数量列右对齐 class 齐全，颜色空值显示 `-`；
//   ③ 负的「采购未入库数 / 库存量」标红（超收 / 负库存），正数不标；
//   ④ 导出打 `export.xlsx` 且带**已应用到屏幕**的筛选参数，成功有 toast；
//   ⑤ 打印弹窗里是纸面（公司名/标题/筛选/行数/打印时间/九列/口径说明/无合计行），点打印调 window.print；
//   ⑥ 屏幕 DataTable 每页 50 行，但纸面渲染全部行（纸上少一行就是漏账）；
//   ⑦ 空数据不打开打印弹窗；接口失败（含 422 行数超限）显示后端原话并可重试。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProcurementWarehouseReportPage from "../app/reports/procurement-warehouse/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const printSpy = vi.fn();
beforeEach(() => {
  printSpy.mockClear();
  Object.defineProperty(window, "print", { value: printSpy, writable: true, configurable: true });
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:xlsx"), writable: true, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true, configurable: true });
});

type Row = Record<string, string>;

/** 契约 §3.1 的一行：数量是去尾零的十进制字符串。 */
const row = (over: Row = {}): Row => ({
  order_no: "260119",
  material_name: "58cm*8k自动直骨伞",
  color: "黑色",
  unit: "打",
  purchase_quantity: "4700",
  inbound_quantity: "4700",
  pending_inbound_quantity: "0",
  production_issue_quantity: "3050",
  stock_quantity: "1650",
  ...over,
});

const rows = () => [
  row(),
  // 第二行专门装"要标红"的两列 + 空颜色：超收（未入库为负）与负库存。
  row({ material_name: "伞布", color: "", pending_inbound_quantity: "-50", stock_quantity: "-10", purchase_quantity: "100" }),
];

const meta = (rowCount = 2) => ({ generated_at: "2026-11-04T14:30:00.000Z", row_count: rowCount, row_limit: 5000, filters: { order_no: null, material: null } });

type Routes = {
  report?: (call: StubbedCall) => Response | Promise<Response>;
  exportXlsx?: (call: StubbedCall) => Response | Promise<Response>;
};

function stubPageApi(routes: Routes = {}) {
  return stubApi((url, call) => {
    // 导出路径也包含 `/reports/procurement-warehouse`，必须先判断 export.xlsx。
    if (url.includes("/reports/procurement-warehouse/export.xlsx")) {
      return routes.exportXlsx?.(call) ?? new Response("xlsx-bytes", {
        status: 200,
        headers: { "content-disposition": "attachment; filename*=UTF-8''procurement-warehouse.xlsx" },
      });
    }
    if (url.includes("/reports/procurement-warehouse")) return routes.report?.(call) ?? apiOk(rows(), meta());
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

async function renderPage(routes: Routes = {}) {
  const calls = stubPageApi(routes);
  render(<><Toaster /><ProcurementWarehouseReportPage /></>);
  await screen.findByTestId("page-reports-procurement-warehouse");
  return calls;
}

/** 取出某个路径前缀、且查询参数满足给定条件的调用（不手写 URL 编码，避免与 URLSearchParams 的口径打架）。 */
function reportCall(calls: StubbedCall[], params: Record<string, string> = {}) {
  return calls.filter((call) => {
    const [path, query = ""] = call.url.split("?");
    if (path !== "/api/v1/reports/procurement-warehouse") return false;
    const search = new URLSearchParams(query);
    return Object.entries(params).every(([key, value]) => search.get(key) === value);
  });
}

function rowElement(text: string) {
  const element = screen.getByText(text).closest('[data-testid="data-table-row"]');
  if (!element) throw new Error(`没有找到数据行：${text}`);
  return element as HTMLElement;
}

const numericTexts = (element: HTMLElement) => [...element.querySelectorAll(".procurement-warehouse-num")].map((node) => node.textContent);

describe("采购与仓储报表：取数与表格", () => {
  it("首屏只打一次取数接口（无查询串）；点「查询」带上订单号与物料两个参数", async () => {
    const calls = await renderPage();
    await screen.findByText("58cm*8k自动直骨伞");

    expect(reportCall(calls)).toHaveLength(1);
    expect(reportCall(calls)[0].method).toBe("GET");
    expect(reportCall(calls)[0].url).toBe("/api/v1/reports/procurement-warehouse");
    expect(screen.getByTestId("report-row-count")).toHaveTextContent("共 2 行");

    await userEvent.type(screen.getByTestId("filter-order-no"), "260119");
    await userEvent.type(screen.getByTestId("filter-material"), "伞布");
    await userEvent.click(screen.getByTestId("report-search"));

    await waitFor(() => expect(reportCall(calls, { order_no: "260119", material: "伞布" })).toHaveLength(1));
    expect(reportCall(calls)).toHaveLength(2);
  });

  it("九列与设计文档同名同序；五个数量列右对齐；空颜色显示 `-`", async () => {
    await renderPage();
    await screen.findByText("58cm*8k自动直骨伞");

    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"]);

    expect(numericTexts(rowElement("58cm*8k自动直骨伞"))).toEqual(["4700", "4700", "0", "3050", "1650"]);
    // 数量格是 span.procurement-warehouse-num（globals.css 里才右对齐 + tabular-nums）；
    // 空颜色走 `-`，不留一格让人以为被裁掉了。
    const second = rowElement("伞布");
    expect(numericTexts(second)).toEqual(["100", "4700", "-50", "3050", "-10"]);
    expect(within(second).getAllByRole("cell")[2]).toHaveTextContent("-");
  });

  it("负的「采购未入库数」「库存量」标红（复用 .status-error），正数不标", async () => {
    await renderPage();
    await screen.findByText("58cm*8k自动直骨伞");

    const alertSpans = rowElement("伞布").querySelectorAll(".procurement-warehouse-num.status-error");
    expect([...alertSpans].map((node) => node.textContent)).toEqual(["-50", "-10"]);
    expect(rowElement("58cm*8k自动直骨伞").querySelectorAll(".procurement-warehouse-num.status-error")).toHaveLength(0);
  });
});

describe("采购与仓储报表：导出", () => {
  it("导出打 export.xlsx 并带上已应用的筛选参数，成功提示已导出", async () => {
    const calls = await renderPage();
    await screen.findByText("58cm*8k自动直骨伞");

    await userEvent.type(screen.getByTestId("filter-order-no"), "260119");
    await userEvent.click(screen.getByTestId("report-search"));
    await waitFor(() => expect(reportCall(calls, { order_no: "260119" })).toHaveLength(1));

    await userEvent.click(screen.getByTestId("report-export"));

    await waitFor(() => {
      const exportCalls = calls.filter((call) => call.url.includes("/reports/procurement-warehouse/export.xlsx"));
      expect(exportCalls).toHaveLength(1);
      expect(exportCalls[0].method).toBe("GET");
      expect(new URLSearchParams(exportCalls[0].url.split("?")[1] ?? "").get("order_no")).toBe("260119");
    });
    expect(await screen.findByText("已导出 2 行采购与仓储报表")).toBeVisible();
  });

  it("空数据时导出给出提示、不发请求", async () => {
    const calls = await renderPage({ report: () => apiOk([], meta(0)) });
    await screen.findByTestId("empty-state");

    await userEvent.click(screen.getByTestId("report-export"));

    expect(await screen.findByText("当前筛选条件下没有可导出的数据")).toBeVisible();
    expect(callsTo(calls, "/reports/procurement-warehouse/export.xlsx")).toHaveLength(0);
  });
});

describe("采购与仓储报表：打印", () => {
  it("「打印」打开纸面：公司名/标题/筛选+行数+打印时间/九列/口径说明；点打印调 window.print", async () => {
    await renderPage();
    await screen.findByText("58cm*8k自动直骨伞");

    await userEvent.click(screen.getByTestId("report-print"));
    const dialog = await screen.findByTestId("report-print-dialog");
    const sheet = await within(dialog).findByTestId("procurement-warehouse-sheet");

    expect(sheet).toHaveTextContent("厦门迪礼伞业有限公司");
    expect(within(sheet).getByRole("heading", { name: "采购与仓储报表" })).toBeVisible();
    const subtitle = within(sheet).getByTestId("procurement-warehouse-print-subtitle");
    expect(subtitle).toHaveTextContent("筛选条件：订单号：全部；物料：全部");
    expect(subtitle).toHaveTextContent("行数：2 行");
    expect(subtitle).toHaveTextContent("（北京时间）");
    // 九列表头在纸上也必须是同一组（表头每页重复靠 <thead>）。
    expect(within(sheet).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(
      ["订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"],
    );
    // 口径说明三条 + 五个数量列的来源说明都在纸上。
    expect(sheet).toHaveTextContent("不跨单位相加");
    expect(sheet).toHaveTextContent("库存量不按订单拆账");
    expect(sheet).toHaveTextContent("本表不设合计行");
    expect(sheet).toHaveTextContent("采购入库量：");
    // 不设合计行：纸上没有任何一格只写「合计」。
    expect(within(sheet).queryByText("合计")).toBeNull();

    // 数字格的结构必须是 `<td><span class="procurement-warehouse-num">数字</span></td>`：
    // 那个 class 带 `display: block`（屏幕表格里用来做右对齐），一旦挂到 `<td>` 上，
    // 单元格会从表格布局里被摘出来 —— 实测是每个数字竖着叠成一片、后面几列直接挤出纸外
    // （2026-11-04 视觉验证先在真实 Chromium 的打印媒体里发现，见
    //  docs/test/results/procurement-warehouse-report/print-media-before-fix.png）。
    const paperRows = sheet.querySelectorAll('[data-testid="procurement-warehouse-sheet-row"]');
    expect(paperRows).toHaveLength(2);
    for (const paperRow of paperRows) {
      expect(paperRow.querySelectorAll("td.procurement-warehouse-num")).toHaveLength(0);
      const quantityCells = [...paperRow.querySelectorAll("td")].slice(4);
      expect(quantityCells).toHaveLength(5);
      for (const cell of quantityCells) {
        expect(cell.children).toHaveLength(1);
        expect(cell.firstElementChild).toHaveProperty("tagName", "SPAN");
        expect(cell.firstElementChild).toHaveClass(/procurement-warehouse-num/);
      }
    }

    await userEvent.click(within(dialog).getByTestId("report-print-confirm"));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("屏幕每页 50 行，但纸面渲染全部行并把行数印在副标题上", async () => {
    const many = Array.from({ length: 51 }, (_, index) => row({ material_name: `物料-${index + 1}` }));
    await renderPage({ report: () => apiOk(many, meta(51)) });
    await screen.findByText("物料-1");

    // 屏幕上第一页只显示 50 行（DataTable 的客户端分页）；「共 51 行」由 panel-note 说明。
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(50);
    expect(screen.getByTestId("report-row-count")).toHaveTextContent("共 51 行");

    await userEvent.click(screen.getByTestId("report-print"));
    const sheet = await screen.findByTestId("procurement-warehouse-sheet");
    expect(sheet.querySelectorAll('[data-testid="procurement-warehouse-sheet-row"]')).toHaveLength(51);
    expect(within(sheet).getByTestId("procurement-warehouse-print-subtitle")).toHaveTextContent("行数：51 行");
  });

  it("没有数据时不打开打印弹窗，提示「当前筛选条件下没有可打印的数据」", async () => {
    await renderPage({ report: () => apiOk([], meta(0)) });
    await screen.findByTestId("empty-state");

    await userEvent.click(screen.getByTestId("report-print"));

    expect(await screen.findByText("当前筛选条件下没有可打印的数据")).toBeVisible();
    expect(screen.queryByTestId("report-print-dialog")).toBeNull();
    expect(printSpy).not.toHaveBeenCalled();
  });
});

describe("采购与仓储报表：错误态", () => {
  it("接口失败显示后端原话（422 行数超限不吞掉），可重试", async () => {
    let attempt = 0;
    const calls = await renderPage({
      report: (call) => {
        attempt += 1;
        if (attempt === 1) return apiErr(422, "REPORT_ROW_LIMIT_EXCEEDED", "结果过多（超过 5000 行），请按订单号或物料缩小范围");
        return apiOk(rows(), meta());
      },
    });

    // 后端 message 原样展示：前端不包一层「数据加载失败」。
    expect(await screen.findByText("结果过多（超过 5000 行），请按订单号或物料缩小范围")).toBeVisible();
    expect(screen.queryByText("数据加载失败")).toBeNull();
    expect(reportCall(calls)).toHaveLength(1);

    await userEvent.click(screen.getByTestId("error-state-retry"));
    await screen.findByText("58cm*8k自动直骨伞");
    expect(reportCall(calls)).toHaveLength(2);
    expect(screen.queryByTestId("error-state")).toBeNull();
  });
});
