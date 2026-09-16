// 采购 → BOM表 页面（app/procurement/boms/page.tsx）的**行为**测试：BOM 表里的「新建物料」。
//
// 背景（用户 2026-09-16：「BOM表的新建物料按钮怎么不见了」）：拆成枢纽页时，这一页把
// BomWorkbench 的 onCreateMaterial 接成了空函数 —— 按钮在、点了没反应；生产侧干脆不传。
// 现在三处入口都挂共享的 MaterialCreateDialog，本文件覆盖「采购 → BOM表」这条：
//   点「新建物料」→ 弹窗填表 → POST /materials → 新物料进物料池并回填当前行 → 保存BOM表带上它。
//
// 纪律：真实渲染 + 真实点击 + 真实 fetch 桩；不 mock 模块。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BomsPage from "../app/procurement/boms/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  salesOrders: "/api/v1/sales-orders",
  boms: "/api/v1/boms",
  materials: "/api/v1/materials",
  units: "/api/v1/units",
} as const;

const bomWithOneItem = {
  id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "draft", version: 1, updatedAt: "2026-09-16T02:00:00.000Z",
  items: [{ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", specificationModel: "150D", color: "本白", requiredQuantity: "3", unit: "米", unitId: "u-1", materialSnapshot: {} }],
};

function stubBomsPage() {
  return stubApi((url, call) => {
    if (url === EP.salesOrders) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
    if (url === EP.boms) return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
    if (url === EP.materials && call.method === "POST") return apiOk({ id: "m-9", materialCode: "M-009", name: "伞骨", specificationModel: "60cm", color: "银色", defaultUnitId: "u-1", materialType: "raw_material", isActive: true });
    if (url === EP.materials) return apiOk([{ id: "m-1", materialCode: "M-001", name: "面料A", defaultUnitId: "u-1", materialType: "raw_material", isActive: true }]);
    if (url === EP.units) return apiOk([{ id: "u-1", name: "米", isActive: true }]);
    if (url === `${EP.boms}/bom-1` && call.method === "GET") return apiOk(bomWithOneItem);
    if (url === `${EP.boms}/bom-1/items` && call.method === "PUT") return apiOk(bomWithOneItem);
    return apiOk([]);
  });
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const dialog = () => within(screen.getByTestId("action-dialog"));

async function openBom() {
  render(<><BomsPage /><Toaster /></>);
  await screen.findByTestId("page-procurement-boms");
  await userEvent.click(await screen.findByRole("button", { name: "编辑BOM表" }));
  await screen.findByDisplayValue("3");
}

describe("采购 → BOM表：新建物料按钮真的能用", () => {
  it("点「新建物料」打开共享弹窗，建完回填当前行并随保存发出 material_id", async () => {
    const calls = stubBomsPage();
    await openBom();

    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    expect(await screen.findByTestId("action-dialog")).toBeVisible();

    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await userEvent.click(dialog().getByTestId("action-field-default_unit_id"));
    await userEvent.click(await screen.findByRole("option", { name: "米" }));
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    // 1) 新物料先落进物料池（BOM 行的物料下拉靠 options 渲染名字）
    await waitFor(() => expect(callsTo(calls, "/materials").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/materials").find((call) => call.method === "POST")!)).toMatchObject({ name: "伞骨", default_unit_id: "u-1" });
    // 弹窗关闭，且那一行显示的是新物料（而不是空白下拉）
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
    expect(await screen.findByText("M-009 / 伞骨")).toBeVisible();
    // 物料的规格型号/颜色按主数据带进行里
    expect(screen.getByDisplayValue("60cm")).toBeVisible();
    expect(screen.getByDisplayValue("银色")).toBeVisible();

    // 2) 保存 BOM：发出去的明细里是新物料
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await waitFor(() => expect(callsTo(calls, "/boms/bom-1/items").filter((call) => call.method === "PUT")).toHaveLength(1));
    const items = bodyOf(callsTo(calls, "/boms/bom-1/items").find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ material_id: "m-9", material_name: "伞骨", specification_model: "60cm", color: "银色" });
  });

  it("物料建失败时弹窗保持打开、不动 BOM 行、也不发出保存请求", async () => {
    const calls = stubApi((url, call) => {
      if (url === EP.salesOrders) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
      if (url === EP.boms) return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
      if (url === EP.materials && call.method === "POST") return apiErr(409, "MATERIAL_DUPLICATE", "同名同规格同颜色的物料已存在");
      if (url === EP.materials) return apiOk([{ id: "m-1", materialCode: "M-001", name: "面料A", defaultUnitId: "u-1", materialType: "raw_material", isActive: true }]);
      if (url === EP.units) return apiOk([{ id: "u-1", name: "米", isActive: true }]);
      if (url === `${EP.boms}/bom-1` && call.method === "GET") return apiOk(bomWithOneItem);
      return apiOk([]);
    });
    await openBom();

    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByLabelText(/物料名称/), "面料A");
    await userEvent.click(dialog().getByTestId("action-field-default_unit_id"));
    await userEvent.click(await screen.findByRole("option", { name: "米" }));
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    // 失败原因留在弹窗里，用户不用重填
    expect(await screen.findByRole("alert")).toHaveTextContent("同名同规格同颜色的物料已存在");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(screen.getByDisplayValue("面料A")).toBeVisible();
    // BOM 行没被改动，也没有任何 BOM 写请求
    expect(callsTo(calls, "/boms/bom-1/items")).toEqual([]);
  });
});
