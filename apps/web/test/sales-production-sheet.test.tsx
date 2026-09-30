// 销售页「工艺单导出 + 图片勾选」的行为测试（用户 2026-09-24）。
//
// 用户原话：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
//
// 这里覆盖用户能看见的五件事：
//   1. 这一单**没有**引用任何有图的物料 → 点「工艺单」直接出文件（与改造前一样，不多一次点击）；
//   2. 有图的物料 → 打开勾选弹窗，**默认全勾**，每行带缩略图与物料编码/名称；
//   3. 勾选状态决定发出去的文件：勾两张就只发两个文件，字段名是**栏位键**（后端按 fieldname 认栏位）；
//   4. 「不带图片导出」走 GET（普通工艺单）；
//   5. 导出失败时把原因写在弹窗里（toast 会消失，这句话不能只飘一下）。
//
// 图片转码（canvas / createImageBitmap）在 jsdom 里不存在，所以**只**替换
// `browserSheetImageDeps` 这一个工厂，其余（selectableImages / candidateLabel /
// buildProductionSheetForm / 路径拼接）一律用真实实现 —— 替掉整个模块等于把这些逻辑也一起测掉了。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const imageDeps = { fetchImage: vi.fn(), measure: vi.fn(), encodeJpeg: vi.fn() };
vi.mock("../lib/production-sheet-image", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, browserSheetImageDeps: () => imageDeps };
});

import SalesOrdersList from "../components/sales/sales-orders-list";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const order = { id: "order-1", orderNo: "DL260134", status: "draft", productName: "雨伞", quantity: "10", unit: "支", customer: { id: "c-1", name: "家百纳", isActive: true, contacts: [] }, boms: [] };

const withImage = { spec_key: "rib_spec", label: "伞骨（孔对孔）", material_id: "m-1", material_code: "MAT-1", material_name: "伞骨 50cm 黑", has_image: true, image_version: "sha-1" };
const alsoWithImage = { spec_key: "canopy_spec", label: "伞布规格", material_id: "m-2", material_code: "MAT-2", material_name: "伞布 190T", has_image: true, image_version: "sha-2" };
const noImage = { spec_key: "handle_spec", label: "伞头", material_id: "m-3", material_code: "MAT-3", material_name: "伞头", has_image: false, image_version: null };

const EP = { export: "/api/v1/sales-orders/order-1/production-sheet.xlsx", candidates: "/sales-orders/order-1/export-images" } as const;

/** 下载三件套：只关心 URL、方法与文件名（与 payable-page.test.tsx 同一套）。 */
let anchors: Array<{ download: string; href: string }> = [];
function captureDownloads() {
  anchors = [];
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:http://localhost/${anchors.length + 1}`), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchors.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}
afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

function stub(images: unknown[]) {
  return stubApi((url: string, call: StubbedCall) => {
    if (url.endsWith(EP.export)) return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename*=UTF-8''%E5%B7%A5%E8%89%BA%E5%8D%95.xlsx" } });
    if (url.endsWith(EP.candidates)) return apiOk({ images });
    if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [] });
    if (call.method === "GET" && url.includes("/sales-orders")) return apiOk([order]);
    return apiOk([]);
  });
}

async function open() {
  render(<SalesOrdersList />);
  await screen.findByTestId("page-sales-orders");
  await screen.findByTestId("order-production-sheet-DL260134");
}

beforeEach(() => {
  captureDownloads();
  imageDeps.fetchImage.mockReset().mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/webp" }));
  imageDeps.measure.mockReset().mockResolvedValue({ width: 1280, height: 960 });
  imageDeps.encodeJpeg.mockReset().mockResolvedValue(new Blob([new Uint8Array(4)], { type: "image/jpeg" }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("销售页：工艺单导出（含物料图片勾选）", () => {
  it("这一单没有可导出的图片：点「工艺单」直接出文件，不弹窗", async () => {
    const calls = stub([noImage]);
    await open();

    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(screen.queryByTestId("production-sheet-image-dialog")).toBeNull();
    expect(callsTo(calls, EP.export)[0].method).toBe("GET");
    expect(anchors[0].download).toBe("工艺单.xlsx");
  });

  it("有图的物料：打开勾选弹窗、默认全勾、每行带物料编码与名称", async () => {
    stub([withImage, alsoWithImage, noImage]);
    await open();

    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));

    const dialog = await screen.findByTestId("production-sheet-image-dialog");
    // 没有图的「伞头」不该出现在可勾选列表里（勾了也没有图，只会让人以为导出坏了）。
    expect(within(dialog).queryByTestId("production-sheet-image-row-handle_spec")).toBeNull();
    expect(within(dialog).getByTestId("production-sheet-image-check-rib_spec")).toBeChecked();
    expect(within(dialog).getByTestId("production-sheet-image-check-canopy_spec")).toBeChecked();
    expect(within(dialog).getByText("伞骨（孔对孔） — MAT-1 伞骨 50cm 黑")).toBeVisible();
    expect(within(dialog).getByTestId("production-sheet-image-export")).toHaveTextContent("导出（含 2 张图片）");
    // 缩略图走物料图片接口（带版本号破缓存）
    expect((within(dialog).getByTestId("material-image-thumb-m-1") as HTMLImageElement).getAttribute("src")).toBe("/api/v1/materials/m-1/image?v=sha-1");
  });

  it("取消勾选一张：按钮数字跟着变，且只发没被取消的那些（字段名 = 栏位键）", async () => {
    const calls = stub([withImage, alsoWithImage]);
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-check-rib_spec"));
    expect(within(dialog).getByTestId("production-sheet-image-export")).toHaveTextContent("导出（含 1 张图片）");
    await userEvent.click(within(dialog).getByTestId("production-sheet-image-export"));

    await waitFor(() => expect(callsTo(calls, EP.export)).toHaveLength(1));
    const exportCall = callsTo(calls, EP.export)[0];
    expect(exportCall.method).toBe("POST");
    expect(exportCall.body).toBeInstanceOf(FormData);
    const body = exportCall.body as FormData;
    // 字段名就是栏位键（后端 AnyFilesInterceptor 按它认栏位）
    expect([...body.keys()]).toEqual(["canopy_spec"]);
    expect((body.get("canopy_spec") as File).type).toBe("image/jpeg");
    expect(imageDeps.fetchImage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(anchors).toHaveLength(1));
    // 弹窗导出成功后自己关掉
    await waitFor(() => expect(screen.queryByTestId("production-sheet-image-dialog")).toBeNull());
  });

  it("「不带图片导出」走 GET（普通工艺单）", async () => {
    const calls = stub([withImage]);
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-without"));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(callsTo(calls, EP.export)[0].method).toBe("GET");
    expect(imageDeps.fetchImage).not.toHaveBeenCalled();
  });

  it("取图失败：把原因写在弹窗里，并且不出文件", async () => {
    stub([withImage]);
    imageDeps.fetchImage.mockRejectedValue(new Error("取物料图片失败（HTTP 500）：请刷新页面后重试"));
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-export"));

    expect(await within(dialog).findByTestId("production-sheet-image-error")).toHaveTextContent("HTTP 500");
    expect(anchors).toHaveLength(0);
  });

  it("后端拒绝导出：把后端那句话显示出来（不是光秃秃的「导出失败」）", async () => {
    stub([withImage]);
    stubApi((url: string, call: StubbedCall) => {
      if (url.endsWith(EP.export) && call.method === "POST") return apiErr(422, "PRODUCTION_SHEET_IMAGE_INVALID", "图片不是 JPEG（Excel 需要 JPEG/PNG 才能显示）");
      if (url.endsWith(EP.candidates)) return apiOk({ images: [withImage] });
      if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [] });
      if (url.includes("/customers")) return apiOk([]);
      if (url.includes("/units")) return apiOk([]);
      return apiOk([order]);
    });
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-export"));

    expect(await within(dialog).findByTestId("production-sheet-image-error")).toHaveTextContent("图片不是 JPEG");
  });
});
