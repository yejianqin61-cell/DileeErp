// 领料单 / 补料单「打印」（用户 2026-11-02：「系统中的出库单要支持导出 excel，支持打印」）。
//
// 原料侧的出库单据是领料单/补料单：导出早就有，这一轮补**打印**。本文件钉住三件事：
//   ① 行内「打印」打开的是**纸面版式**（标题含状态、三行表头、明细四列数量、小计），数据来自 slip-document；
//   ② 领料单与补料单是两套版式（补料单只有「补领数量」+ 图片列，没有四个数量）；
//   ③ 「打印 / 另存 PDF」走浏览器打印（window.print），与记账凭证纸/跨行转账单同一做法。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MaterialIssuesPage from "../app/production/material-issues/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const printSpy = vi.fn();
beforeEach(() => {
  printSpy.mockClear();
  Object.defineProperty(window, "print", { value: printSpy, writable: true, configurable: true });
});

type Issue = Record<string, any>;

const issue = (over: Issue = {}): Issue => ({
  id: "mi-1",
  movementNo: "MI-001",
  documentType: "issue",
  status: "draft",
  orderNo: "SO-001",
  productionOrderId: "po-1",
  productionOrder: { productionOrderNo: "MO-001", orderNo: "SO-001" },
  businessDate: "2026-01-02",
  createdAt: "2026-01-02T03:04:05.000Z",
  remark: null,
  reason: null,
  lines: [{ id: "l-1", materialId: "m-1", quantity: "1", remark: null, unit: { name: "米" }, material: { materialCode: "RM-1", name: "面料A", specificationModel: "150D" } }],
  ...over,
});

/** slip-document：与后端 `buildSlipDocument` 同形（表头字段 + 明细四个数量）。 */
const slipDocument = (kind: "issue" | "replenishment" = "issue") => ({
  document_type: kind,
  document: {
    movementNo: kind === "issue" ? "MI-001" : "MC-001",
    status: "draft",
    productionOrderNo: "MO-001",
    orderNo: "SO-001",
    productName: "连衣裙",
    productCode: "",
    productSpecification: "M",
    productColor: "",
    operationName: "裁剪",
    issueUnit: "一车间",
    plannedQuantity: 500,
    unitName: "件",
    operatorName: "张三",
    operatedAt: "2026/1/2 10:00:00",
    remark: "第一批领料",
    reason: kind === "replenishment" ? "伞布坏片" : "",
    lines: kind === "issue"
      ? [{ sequence: 1, materialName: "面料A", materialCode: "RM-1", specificationModel: "150D", color: "黑", unit: "米", bomQuantity: 5, issuedQuantity: 2, currentQuantity: 1, remainingQuantity: 2 }]
      : [{ sequence: 1, materialName: "面料A", materialCode: "RM-1", specificationModel: "150D", color: "黑", unit: "米", replenishQuantity: 1 }],
  },
});

type Routes = {
  movements?: (call: StubbedCall) => Response | Promise<Response>;
  slipDocument?: (call: StubbedCall) => Response | Promise<Response>;
};

function stubPageApi(routes: Routes = {}) {
  return stubApi((url, call) => {
    if (url.endsWith("/production/orders")) return apiOk([]);
    if (/\/production\/material-movements\/[^/?]+\/slip-document$/.test(url)) return routes.slipDocument?.(call) ?? apiErr(404, "NOT_FOUND", "未打桩的 slip-document");
    if (call.method === "GET" && /\/production\/material-movements\/[^/?]+$/.test(url)) return apiErr(404, "NOT_FOUND", "未打桩的详情");
    if (url.includes("/production/material-movements")) return routes.movements?.(call) ?? apiOk([]);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

async function renderPage(routes: Routes = {}) {
  const calls = stubPageApi(routes);
  render(<><Toaster /><MaterialIssuesPage /></>);
  await screen.findByTestId("page-production-material-issues");
  return calls;
}

function rowOf(text: string) {
  const row = screen.getByText(text).closest('[data-testid="data-table-row"]');
  if (!row) throw new Error(`没有找到单据行：${text}`);
  return within(row as HTMLElement);
}

describe("领料单 / 补料单打印", () => {
  it("领料单「打印」：打开纸面版式（标题带状态、四个数量列、小计），点「打印 / 另存 PDF」调 window.print", async () => {
    await renderPage({ movements: () => apiOk([issue()]), slipDocument: () => apiOk(slipDocument("issue")) });
    await screen.findByText("MI-001");

    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "打印" }));
    const dialog = await screen.findByTestId("material-slip-print-dialog");
    const sheet = await within(dialog).findByTestId("material-slip-sheet");
    expect(within(sheet).getByTestId("material-slip-print-title")).toHaveTextContent("【领料单】（草稿）");
    expect(sheet).toHaveTextContent("MI-001");
    expect(sheet).toHaveTextContent("一车间");
    // 四个数量列与打印件同名（已领不含本次、余下已减本次）
    for (const label of ["配料数量", "已领数量", "本次领料量", "余下数量"]) expect(within(sheet).getByRole("columnheader", { name: label })).toBeVisible();
    expect(sheet).toHaveTextContent("小计");

    await userEvent.click(within(dialog).getByTestId("material-slip-print-confirm"));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("补料单「打印」：纸面版式只有「补领数量」+ 图片列，没有四个数量", async () => {
    await renderPage({
      movements: () => apiOk([issue({ id: "mc-1", movementNo: "MC-001", documentType: "replenishment" })]),
      slipDocument: () => apiOk(slipDocument("replenishment")),
    });
    await screen.findByText("MC-001");

    await userEvent.click(rowOf("MC-001").getByRole("button", { name: "打印" }));
    const dialog = await screen.findByTestId("material-slip-print-dialog");
    const sheet = await within(dialog).findByTestId("material-slip-sheet");
    expect(within(sheet).getByTestId("material-slip-print-title")).toHaveTextContent("【补料单】（草稿）");
    expect(within(sheet).getByRole("columnheader", { name: "补领数量" })).toBeVisible();
    expect(within(sheet).getByRole("columnheader", { name: "图片" })).toBeVisible();
    expect(within(sheet).queryByRole("columnheader", { name: "配料数量" })).toBeNull();
    expect(sheet).toHaveTextContent("伞布坏片"); // 补料原因要印在表头（纸样第 3 行）
  });

  it("打印数据取不到：错误留在页面上，弹窗不渲染空纸", async () => {
    await renderPage({ movements: () => apiOk([issue()]), slipDocument: () => apiErr(404, "MATERIAL_SLIP_NOT_FOUND", "该单据类型没有领料单/补料单版式") });
    await screen.findByText("MI-001");
    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "打印" }));
    expect(await screen.findByText("该单据类型没有领料单/补料单版式")).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId("material-slip-sheet")).toBeNull());
  });
});
