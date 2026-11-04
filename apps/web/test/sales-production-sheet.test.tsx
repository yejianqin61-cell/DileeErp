// 销售页「工艺单导出 + 图片勾选」的行为测试（用户 2026-09-24，2026-11-04 扩到行级图片）。
//
// 用户原话：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
// 2026-11-04（docs/design/sales-order-row-images-2026-11-04.md §4.3）：候选里还有材料行自己的图、
// 「再加一款 / 其它」行的图与细分明细行的图，缩略图与取图都改走候选给的 `image_url`。
//
// 这里覆盖用户能看见的六件事：
//   1. 这一单**没有**可导出的图片 → 点「工艺单」直接出文件（与改造前一样，不多一次点击）；
//   2. 有图 → 打开勾选弹窗，**默认全勾**，每行带缩略图与物料编码/名称；
//   3. 勾选状态决定发出去的文件：勾两张就只发两个文件，字段名是**候选键**（后端按 fieldname 认行）；
//   4. 材料行图与明细行图同时在场：缩略图各走自己的 image_url、字段名原样（含 `detail:<行 id>` /
//      `extra:<行 id>`）、成功提示张数正确；
//   5. 「不带图片导出」走 GET（普通工艺单）；
//   6. 取图失败时把原因写在弹窗里（toast 会消失，这句话不能只飘一下）。
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
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const order = { id: "order-1", orderNo: "DL260134", status: "draft", productName: "雨伞", quantity: "10", unit: "支", customer: { id: "c-1", name: "家百纳", isActive: true, contacts: [] }, boms: [] };

// 2026-11-04 的候选契约（§2.4）：spec_key / label / kind / material_* / has_image /
// image_version / image_source / image_id / image_url。行图（明细行 / 其它行）没有物料。
const withImage = { spec_key: "rib_spec", label: "伞骨（孔对孔）", kind: "material", material_id: "m-1", material_code: "MAT-1", material_name: "伞骨 50cm 黑", has_image: true, image_version: "sha-1", image_source: "material", image_id: null, image_url: "/api/v1/materials/m-1/image?v=sha-1" };
const alsoWithImage = { spec_key: "canopy_spec", label: "伞布规格", kind: "material", material_id: "m-2", material_code: "MAT-2", material_name: "伞布 190T", has_image: true, image_version: "sha-2", image_source: "material", image_id: null, image_url: "/api/v1/materials/m-2/image?v=sha-2" };
const noImage = { spec_key: "handle_spec", label: "伞头", kind: "material", material_id: "m-3", material_code: "MAT-3", material_name: "伞头", has_image: false, image_version: null, image_source: null, image_id: null, image_url: "" };
// 细分明细行自己的图（键是 `detail:<行 id>`，图走销售单图片接口）。
const detailKey = "detail:11111111-1111-1111-1111-111111111111";
const detailWithImage = { spec_key: detailKey, label: "伞头配色 / Hawái", kind: "detail", material_id: null, material_code: null, material_name: null, has_image: true, image_version: "sha-detail", image_source: "row", image_id: "img-detail", image_url: "/api/v1/sales-orders/order-1/images/img-detail?v=sha-detail" };
// 「再加一款 / 其它」行自己的图（键是 `extra:<行 id>`）。
const extraKey = "extra:22222222-2222-2222-2222-222222222222";
const extraWithImage = { spec_key: extraKey, label: "弹簧", kind: "extra", material_id: null, material_code: null, material_name: null, has_image: true, image_version: "sha-extra", image_source: "row", image_id: "img-extra", image_url: "/api/v1/sales-orders/order-1/images/img-extra?v=sha-extra" };

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
  // 一并挂 Toaster：成功提示（张数）也是用户可见行为的一部分。
  render(<><SalesOrdersList /><Toaster /></>);
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

describe("销售页：工艺单导出（含行级图片勾选）", () => {
  it("这一单没有可导出的图片：点「工艺单」直接出文件，不弹窗", async () => {
    const calls = stub([noImage]);
    await open();

    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(screen.queryByTestId("production-sheet-image-dialog")).toBeNull();
    expect(callsTo(calls, EP.export)[0].method).toBe("GET");
    expect(anchors[0].download).toBe("工艺单.xlsx");
  });

  it("有图的候选：打开勾选弹窗、默认全勾、每行带物料编码与名称", async () => {
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
    // 缩略图走候选给的 image_url（物料图 = 物料图片接口，带版本号破缓存）
    expect(within(dialog).getByTestId("production-sheet-image-thumb-rib_spec")).toHaveAttribute("src", "/api/v1/materials/m-1/image?v=sha-1");
    expect(within(dialog).getByTestId("production-sheet-image-thumb-canopy_spec")).toHaveAttribute("src", "/api/v1/materials/m-2/image?v=sha-2");
  });

  it("材料行图 + 明细行图 + 其它行图同时在场：缩略图各走 image_url、字段名原样、成功提示张数正确", async () => {
    const calls = stub([withImage, detailWithImage, extraWithImage]);
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    // 缩略图：物料图走物料接口，行图（明细行 / 其它行）走销售单图片接口 —— 都由 image_url 决定。
    expect(within(dialog).getByTestId("production-sheet-image-thumb-rib_spec")).toHaveAttribute("src", "/api/v1/materials/m-1/image?v=sha-1");
    expect(within(dialog).getByTestId(`production-sheet-image-thumb-${detailKey}`)).toHaveAttribute("src", detailWithImage.image_url);
    expect(within(dialog).getByTestId(`production-sheet-image-thumb-${extraKey}`)).toHaveAttribute("src", extraWithImage.image_url);
    // 明细行的 label 已带分组，直接显示（没有物料编码就不拼破折号）。
    expect(within(dialog).getByText("伞头配色 / Hawái")).toBeVisible();
    expect(within(dialog).getByTestId("production-sheet-image-export")).toHaveTextContent("导出（含 3 张图片）");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-export"));

    await waitFor(() => expect(callsTo(calls, EP.export)).toHaveLength(1));
    const body = callsTo(calls, EP.export)[0].body as FormData;
    // 字段名就是候选键：栏位键 / detail:<行 id> / extra:<行 id> 前端一律原样用。
    expect([...body.keys()]).toEqual(["rib_spec", detailKey, extraKey]);
    for (const key of ["rib_spec", detailKey, extraKey]) expect((body.get(key) as File).type).toBe("image/jpeg");
    // 取图按候选的 image_url（行图候选连 material_id 都是 null，不再拼物料 id）。
    expect(imageDeps.fetchImage.mock.calls.map(([item]) => item.image_url)).toEqual([
      "/api/v1/materials/m-1/image?v=sha-1",
      detailWithImage.image_url,
      extraWithImage.image_url,
    ]);
    // 成功提示里的张数 = 真发出去的文件数。
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已导出 DL260134 的工艺单（含 3 张图片）"))).toBe(true));
    // 弹窗导出成功后自己关掉
    await waitFor(() => expect(screen.queryByTestId("production-sheet-image-dialog")).toBeNull());
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

  it("明细行图取不到：把原因写在弹窗里、不出文件（行图不是物料图，提示也照着说）", async () => {
    stub([withImage, detailWithImage]);
    imageDeps.fetchImage.mockRejectedValue(new Error("取图片失败（HTTP 404）：请刷新页面后重试"));
    await open();
    await userEvent.click(screen.getByTestId("order-production-sheet-DL260134"));
    const dialog = await screen.findByTestId("production-sheet-image-dialog");

    await userEvent.click(within(dialog).getByTestId("production-sheet-image-export"));

    expect(await within(dialog).findByTestId("production-sheet-image-error")).toHaveTextContent("取图片失败（HTTP 404）");
    expect(anchors).toHaveLength(0);
    // 失败后按钮恢复可点（用户能重试或取消图片），弹窗不关。
    expect(within(dialog).getByTestId("production-sheet-image-export")).toBeEnabled();
  });

  it("取图失败：把原因写在弹窗里，并且不出文件", async () => {
    stub([withImage]);
    imageDeps.fetchImage.mockRejectedValue(new Error("取图片失败（HTTP 500）：请刷新页面后重试"));
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
