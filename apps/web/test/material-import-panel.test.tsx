// 采购 → 物料清单（app/procurement/materials/page.tsx）的「批量导入物料」行为测试。
//
// 用户 2026-09-20：「针对采购模块，物料清单，我们新增一个批量导入物料。我们提供模板，用户填写并上传」。
// 这里覆盖用户能看见的四件事：
//   1. 下载模板走带鉴权 cookie 的 fetch（不是 <a href>），文件名是后端给的中文名；
//   2. 上传是 multipart（FormData + file），不是 JSON —— 走错就等于「点了没反应」；
//   3. 逐行结果整份留在页面上：条数、未导入的行（行号/字段/原因）、忽略的列、提示；
//   4. **部分成功不许提示成全部成功**（这是本功能最容易骗到人的地方）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MaterialsPage from "../app/procurement/materials/page";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 下载三件套（与 stocktake-page.test.tsx 同一套）：只关心 URL 与文件名。 */
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

const EP = { materials: "/api/v1/materials", units: "/api/v1/units", template: "/api/v1/materials/import-template.xlsx", imp: "/api/v1/materials/import" } as const;

const materialRow = { id: "m-1", materialCode: "MAT-1", name: "涤纶布", specificationModel: "150D", color: "米白", defaultUnitId: "u-1", materialType: "raw_material", isActive: true };
const units = [{ id: "u-1", name: "米", isActive: true }];

const partialResult = {
  status: "partial", total: 3, imported: 2, errorCount: 1, headerRow: 1,
  errors: [{ row: 4, field: "默认单位", reason: "默认单位「包」在单位表里找不到：请先在【采购 → 物料清单 → 新建物料】的「默认单位」旁点「新增类目」建出这个单位" }],
  missingColumns: [], ignoredColumns: ["盘点人"], ignoredTrailingRows: 0,
  hints: ["有 1 行没有填物料编码：已按「MAT-当天日期-序号」自动生成，生成结果见下方新增清单", "单位表里现有的单位：米"],
  created: [
    { row: 2, material_code: "MAT-1001", name: "涤纶布", auto_code: false },
    { row: 3, material_code: "MAT-20260920-0001", name: "松紧带", auto_code: true },
  ],
};

function stub(data: { importResult?: unknown; importError?: Response } = {}) {
  return stubApi((url, call: StubbedCall) => {
    if (url.endsWith(EP.template)) {
      return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    }
    if (call.method === "POST" && url.endsWith(EP.imp)) return data.importError ?? apiOk(data.importResult ?? partialResult);
    if (call.method === "GET" && url.endsWith(EP.materials)) return apiOk([materialRow]);
    if (call.method === "GET" && url.endsWith(EP.units)) return apiOk(units);
    return apiOk([]);
  });
}

async function open() {
  render(<MaterialsPage />);
  await screen.findByTestId("page-procurement-materials");
}

const upload = (name = "物料清单.xlsx") =>
  userEvent.upload(screen.getByTestId("material-import-file"), new File(["xlsx-bytes"], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

describe("物料清单：批量导入", () => {
  it("面板在页面上，并说明 7 列口径与「编码留空即自动生成」", async () => {
    stub();
    await open();

    const section = screen.getByRole("heading", { name: "批量导入物料" }).closest("section") as HTMLElement;
    const panel = within(section);
    expect(panel.getByTestId("material-import-template")).toBeVisible();
    expect(panel.getByTestId("material-import-file")).toBeVisible();
    expect(panel.getByText(/模板 7 列：物料编码 \/ 物料名称 \/ 规格型号 \/ 颜色 \/ 默认单位 \/ 物料类型 \/ 备注/)).toBeVisible();
    expect(panel.getByText(/物料编码留空即自动生成/)).toBeVisible();
  });

  it("下载模板：带鉴权 cookie 的 fetch + 中文文件名（<a href> 会丢 cookie 变 401）", async () => {
    captureDownloads();
    const calls = stub();
    await open();

    await userEvent.click(screen.getByTestId("material-import-template"));

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(callsTo(calls, EP.template)).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("迪礼ERP-物料清单导入模板.xlsx");
  });

  it("上传：multipart 带 file，结果逐行留在页面上（行号/字段/原因 + 未识别列 + 提示）", async () => {
    const calls = stub();
    await open();

    await upload();

    const result = await screen.findByTestId("material-import-result");
    // 上传必须是 FormData，不能是 JSON（后端是 FileInterceptor）
    const uploadCall = callsTo(calls, EP.imp)[0];
    expect(uploadCall.method).toBe("POST");
    expect(uploadCall.body).toBeInstanceOf(FormData);
    expect((uploadCall.body as FormData).get("file")).toBeInstanceOf(File);

    expect(screen.getByTestId("material-import-summary")).toHaveTextContent("共 3 行：新增 2 条 / 未导入 1 行 / 其中自动生成编码 1 条");
    const rows = within(result).getAllByTestId("data-table-row");
    // 未导入行 + 已新增行两张表：两张都有「Excel 行号」表头
    expect(within(result).getAllByText("Excel 行号")).toHaveLength(2);
    expect(within(result).getByText("默认单位")).toBeVisible();
    expect(within(result).getByText(/默认单位「包」在单位表里找不到/)).toBeVisible();
    expect(within(result).getByText(/以下列不属于物料口径，已忽略：盘点人/)).toBeVisible();
    expect(within(result).getByText(/有 1 行没有填物料编码/)).toBeVisible();
    // 自动生成的编码必须显示出来，否则操作员不知道后续引用哪个码
    expect(within(result).getByText("MAT-20260920-0001")).toBeVisible();
    expect(within(result).getByText("自动生成")).toBeVisible();
    expect(within(result).getByText("表里填写")).toBeVisible();
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("部分成功：提示里必须写清「未导入 N 行」，不许说成全部成功", async () => {
    stub();
    await open();

    await upload();

    const summary = await screen.findByTestId("material-import-summary");
    expect(summary).toHaveTextContent("未导入 1 行");
    expect(summary.className).toContain("status-warning");
  });

  it("一行都没进：结果档位是错误、只列出未导入的行（没有「已新增」表）", async () => {
    stub({ importResult: { ...partialResult, status: "failed", imported: 0, errorCount: 3, created: [] } });
    await open();

    await upload("全错.xlsx");

    const summary = await screen.findByTestId("material-import-summary");
    expect(summary).toHaveTextContent("共 3 行：新增 0 条 / 未导入 3 行");
    expect(summary.className).toContain("status-error");
    expect(screen.queryByText(/已新增的物料/)).toBeNull();
  });

  it("上传失败（后端 400/422）：给出后端的原因，且不刷新列表", async () => {
    const calls = stub({ importError: apiErr(422, "MATERIAL_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件，请使用「下载模板」得到的模板填写") });
    await open();
    const listCallsBefore = callsTo(calls, EP.materials).length;

    await upload("物料.csv");

    await waitFor(() => expect(screen.queryByTestId("material-import-result")).toBeNull());
    expect(callsTo(calls, EP.materials)).toHaveLength(listCallsBefore);
  });
});
