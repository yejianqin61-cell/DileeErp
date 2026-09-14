// BOM 工作区（采购与生产共用组件）的行为测试。
//
// 覆盖本轮整改的关键契约：
//   1. 保存时带上打开时的 `updatedAt`（乐观锁令牌）——没有它，两个模块同时编辑就会互相覆盖；
//   2. 服务端返回 422 BOM_UPDATE_CONFLICT 时：显示冲突提示、本地改动保留、不提示"已保存"；
//   3. 冲突后「重新加载最新版本」会重新 GET，并显示服务端的最新明细；
//   4. 没有创建物料入口（生产模块）时只给提示，不渲染「新建物料」按钮。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BomWorkbench } from "../components/bom/bom-workbench";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const OPENED_AT = "2026-09-14T02:00:00.000Z";
const POLLUTED_AT = "2026-09-14T02:05:00.000Z";

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", materialType: "raw_material", isActive: true },
  { id: "m-2", materialCode: "M-002", name: "面料B", materialType: "raw_material", isActive: true },
];
const units = [{ id: "u-1", name: "米", isActive: true }];

const bomWith = (updatedAt: string, quantity = "2") => ({
  id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "draft", version: 1, updatedAt,
  items: [{ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", requiredQuantity: quantity, unit: "米", unitId: "u-1", materialSnapshot: {} }],
});

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;

function renderWorkbench(options: { onSaved?: () => void; onCreateMaterial?: (apply: (material: (typeof materials)[number]) => void) => void } = {}) {
  return render(<>
    <BomWorkbench bomId="bom-1" title="SO-1" materials={materials} units={units} onClose={() => undefined} onSaved={options.onSaved} onCreateMaterial={options.onCreateMaterial} />
    <Toaster />
  </>);
}

describe("BOM 工作区：乐观锁令牌", () => {
  it("保存时回传打开时的 updatedAt，落到 PUT 请求体里", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    const onSaved = vi.fn();
    renderWorkbench({ onSaved });

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/api/v1/boms/bom-1/items");
    expect(bodyOf(put!).expected_updated_at).toBe(OPENED_AT);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText("BOM表已保存")).toBeVisible();
  });

  it("保存时把人工改过的数量原样发出（不被主数据回填覆盖）", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    renderWorkbench();

    const quantity = await screen.findByDisplayValue("2");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "7.5");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const items = bodyOf(calls.find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items[0].required_quantity).toBe("7.5");
    expect(items[0].material_id).toBe("m-1");
  });
});

describe("BOM 工作区：并发冲突", () => {
  it("服务端返回 BOM_UPDATE_CONFLICT 时给出冲突提示，保留本地改动，且不提示已保存", async () => {
    stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiErr(422, "BOM_UPDATE_CONFLICT", "BOM 已被他人（采购或生产）修改，本次保存没有写入；请重新加载最新版本后再改一次");
      return apiOk({});
    });
    renderWorkbench();

    const quantity = await screen.findByDisplayValue("2");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "9");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const conflict = await screen.findByTestId("bom-conflict");
    expect(conflict).toHaveTextContent("已被他人（采购或生产）修改");
    // 本地改动必须还在屏幕上：用户刚录的内容不能被清掉
    expect(screen.getByDisplayValue("9")).toBeVisible();
    expect(screen.queryByText("BOM表已保存")).toBeNull();
  });

  it("冲突后「重新加载最新版本」会重新拉取，显示服务端的最新明细并清掉提示", async () => {
    let served = bomWith(OPENED_AT);
    stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(served);
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiErr(422, "BOM_UPDATE_CONFLICT", "BOM 已被他人（采购或生产）修改");
      return apiOk({});
    });
    renderWorkbench();

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await screen.findByTestId("bom-conflict");

    // 另一个模块在这期间把数量改成了 4
    served = bomWith(POLLUTED_AT, "4");
    await userEvent.click(screen.getByRole("button", { name: "重新加载最新版本（放弃本次修改）" }));

    await waitFor(() => expect(screen.queryByTestId("bom-conflict")).toBeNull());
    expect(screen.getByDisplayValue("4")).toBeVisible();
  });
});

describe("BOM 工作区：新建物料入口按模块开放", () => {
  it("没有传入 onCreateMaterial 时（生产模块）不渲染「新建物料」，并说明物料池归采购", async () => {
    stubApi((url, call) => (url.endsWith("/boms/bom-1") && call.method === "GET" ? apiOk(bomWith(OPENED_AT)) : apiOk({})));
    renderWorkbench();

    await screen.findByDisplayValue("2");
    expect(screen.queryByRole("button", { name: "新建物料" })).toBeNull();
    expect(screen.getByText(/物料池由【采购 → 物料清单】维护/)).toBeVisible();
  });

  it("传入 onCreateMaterial 时（采购模块）按钮出现，新物料回填到当前行并存进保存请求", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    let apply: ((material: (typeof materials)[number]) => void) | undefined;
    renderWorkbench({ onCreateMaterial: (callback) => { apply = callback; } });

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    expect(apply).toBeTypeOf("function");
    // 采购页此时会弹出「新建物料」对话框并把新物料加进物料池，这里直接模拟创建成功后的回填
    apply?.({ id: "m-9", materialCode: "M-009", name: "伞骨", materialType: "raw_material", isActive: true });

    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    const items = bodyOf(calls.find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].material_id).toBe("m-9");
    expect(items[0].material_name).toBe("伞骨");
  });
});
