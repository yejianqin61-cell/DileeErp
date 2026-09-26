// 物料清单页（app/procurement/materials/page.tsx）的「物料图片」行为测试。
//
// 用户 2026-09-24：「物料清单，要给物料配上图片。图片上传之后要压缩成 webp 再存进数据库里。
// 所以要允许用户对对应的物料进行图片的上传」。
//
// 这里覆盖用户能看见的五件事：
//   1. 没有图的物料显示「上传图片」，有图的显示缩略图 + 「换图」+「删除图片」；
//   2. 缩略图地址带 `?v=<sha256>` 破缓存（换图之后必须看到新图，不是浏览器缓存里的旧图）；
//   3. **不是图片的文件连请求都不发**（先拦再干活），原因写在行内而不只是飘一个 toast；
//   4. 上传成功后重新取列表（图片有无是列表行上的字段）；
//   5. 后端拒绝时把后端那句话原样显示出来。
//
// 压缩管线（canvas / createImageBitmap）在 jsdom 里不存在，所以**只**替换上传与删除这两个
// 网络函数，其余（materialImageUrl / materialImageProblem 等纯函数）一律用真实实现 ——
// 替掉整个模块就等于把这些逻辑也一起测掉了，那样测的是桩不是代码。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const upload = vi.fn();
const remove = vi.fn();
vi.mock("../lib/material-image", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, uploadMaterialImage: (...args: unknown[]) => upload(...args), deleteMaterialImage: (...args: unknown[]) => remove(...args) };
});

import MaterialsPage from "../app/procurement/materials/page";

const EP = { materials: "/api/v1/materials", units: "/api/v1/units" } as const;
const IMAGE = { id: "img-1", width: 1600, height: 1200, byteSize: 2048, sha256: "sha-abc", updatedAt: "2026-09-24T02:00:00.000Z" };

/** 两个物料：一个已经配了图，一个还没有（两条分支都要看得见）。 */
const withImage = { id: "m-1", materialCode: "MAT-1", name: "涤纶布", specificationModel: "150D", color: "米白", defaultUnitId: "u-1", materialType: "raw_material", isActive: true, image: IMAGE };
const withoutImage = { id: "m-2", materialCode: "MAT-2", name: "松紧带", specificationModel: "5mm", color: "黑", defaultUnitId: "u-1", materialType: "raw_material", isActive: true, image: null };

function stub(materials: unknown[] = [withImage, withoutImage]) {
  return stubApi((url: string, call: StubbedCall) => {
    if (call.method === "GET" && url.endsWith(EP.materials)) return apiOk(materials);
    if (call.method === "GET" && url.endsWith(EP.units)) return apiOk([{ id: "u-1", name: "米", isActive: true }]);
    return apiOk([]);
  });
}

async function open() {
  render(<MaterialsPage />);
  await screen.findByTestId("page-procurement-materials");
  await screen.findByTestId("material-image-pick-m-1");
}

const image = (name = "伞布.png", type = "image/png") => new File(["fake-image-bytes"], name, { type });

beforeEach(() => { upload.mockReset(); remove.mockReset(); upload.mockResolvedValue(IMAGE); remove.mockResolvedValue(undefined); });
afterEach(() => { vi.clearAllMocks(); });

describe("物料清单：物料图片", () => {
  it("有图的显示缩略图 + 换图 + 删除，没图的显示上传图片", async () => {
    stub();
    await open();

    expect(screen.getByTestId("material-image-thumb-m-1")).toBeVisible();
    expect(screen.getByTestId("material-image-pick-m-1")).toHaveTextContent("换图");
    expect(screen.getByTestId("material-image-delete-m-1")).toBeVisible();

    expect(screen.queryByTestId("material-image-thumb-m-2")).toBeNull();
    expect(screen.getByTestId("material-image-pick-m-2")).toHaveTextContent("上传图片");
    expect(screen.queryByTestId("material-image-delete-m-2")).toBeNull();
  });

  it("缩略图地址带 /api/v1 前缀与 ?v=sha256（否则换图后看到的还是缓存里的旧图）", async () => {
    stub();
    await open();

    const thumb = screen.getByTestId("material-image-thumb-m-1") as HTMLImageElement;
    expect(thumb.getAttribute("src")).toBe("/api/v1/materials/m-1/image?v=sha-abc");
  });

  it("选中的不是图片：不发请求、原因写在行内（toast 会消失，这句话不能只飘一下）", async () => {
    const calls = stub();
    await open();
    const listCallsBefore = callsTo(calls, EP.materials).length;

    // 用 fireEvent 而不是 userEvent.upload：后者会替我们按 `accept` 过滤掉 PDF，
    // 于是这条用例根本走不到组件里。但真实用户可以切到「所有文件」把它选进来，
    // 所以「选到非图片」这条路必须测 —— 它正是 `materialImageProblem` 存在的理由。
    fireEvent.change(screen.getByTestId("material-image-input-m-2"), { target: { files: [new File(["%PDF-1.4"], "报价单.pdf", { type: "application/pdf" })] } });

    const error = await screen.findByTestId("material-image-error-m-2");
    expect(error).toHaveTextContent("只能上传图片");
    expect(upload).not.toHaveBeenCalled();
    expect(callsTo(calls, EP.materials)).toHaveLength(listCallsBefore);
  });

  it("选中的是图片：调上传（物料 id + 文件）并重新取列表", async () => {
    const calls = stub();
    await open();
    const listCallsBefore = callsTo(calls, EP.materials).length;

    await userEvent.upload(screen.getByTestId("material-image-input-m-2"), image());

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0]).toBe("m-2");
    expect((upload.mock.calls[0][1] as File).name).toBe("伞布.png");
    await waitFor(() => expect(callsTo(calls, EP.materials).length).toBe(listCallsBefore + 1));
  });

  it("删除图片：调删除接口并重新取列表；成功后行内不留错误", async () => {
    const calls = stub();
    await open();
    const listCallsBefore = callsTo(calls, EP.materials).length;

    await userEvent.click(screen.getByTestId("material-image-delete-m-1"));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("m-1"));
    await waitFor(() => expect(callsTo(calls, EP.materials).length).toBe(listCallsBefore + 1));
    expect(screen.queryByTestId("material-image-error-m-1")).toBeNull();
  });

  it("上传被后端拒绝：把后端那句话原样显示出来，并且不刷新列表", async () => {
    const calls = stub();
    upload.mockRejectedValue(Object.assign(new Error("只支持 WebP 图片（浏览器上传前会自动把 JPG/PNG 压成 WebP）：这个文件的内容不是 WebP"), { code: "MATERIAL_IMAGE_NOT_WEBP" }));
    await open();
    const listCallsBefore = callsTo(calls, EP.materials).length;

    await userEvent.upload(screen.getByTestId("material-image-input-m-2"), image());

    const error = await screen.findByTestId("material-image-error-m-2");
    expect(error).toHaveTextContent("这个文件的内容不是 WebP");
    expect(callsTo(calls, EP.materials)).toHaveLength(listCallsBefore);
  });

  it("上传中按钮变成「处理中…」且禁用（连点两次不该传两张）", async () => {
    let release: (value: unknown) => void = () => {};
    upload.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    stub();
    await open();

    await userEvent.upload(screen.getByTestId("material-image-input-m-2"), image());

    const button = await screen.findByTestId("material-image-pick-m-2");
    expect(button).toHaveTextContent("处理中…");
    expect(button).toBeDisabled();
    release(IMAGE);
    await waitFor(() => expect(screen.getByTestId("material-image-pick-m-2")).toHaveTextContent("上传图片"));
  });

  it("图片加载失败时显示占位符，而不是一个破图图标", async () => {
    stub();
    await open();

    const thumb = screen.getByTestId("material-image-thumb-m-1") as HTMLImageElement;
    thumb.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByTestId("material-image-thumb-m-1")).toHaveTextContent("—"));
    // 面板本身还在（占位符不是把整行干掉）
    expect(within(screen.getByTestId("page-procurement-materials")).getByTestId("material-image-pick-m-1")).toBeVisible();
  });
});
