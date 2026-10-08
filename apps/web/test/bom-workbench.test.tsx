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

// 2026-10-08（用户）：「1.BOM表页面，物料名称一长，后面的column就被压缩很窄。这很不好。我要求，
// 扩大BOM表悬浮居中页面的占页面大小，并且固定物料名称这一列的宽度。一旦字数超出，就省略显示，
// 鼠标hover时显示全部文字。」
//
// "列不再被压缩"靠的是 `table-layout: fixed` + 每列显式宽度，"省略"靠的是三家 CSS 属性 ——
// 那部分没有 jsdom 能测的东西，守卫在 `lib/bom-table.test.mjs`（钉 CSS 规则）与真实 Chromium 实测里。
// 这里钉的是它们依赖的两样**代码里的**契约：列的类名（CSS 规则挂在这些类上）、
// 以及触发器的 title（被省略掉的字要有地方看，且必须是屏幕上正在显示的那串字）。
describe("BOM 表：物料名称列（固定列宽 / 省略 / hover 全文）", () => {
  const LONG_NAME = "超细纤维防风防水涂层复合单面摇粒绒面料（加厚款 320g）";
  const longMaterial = { id: "m-long", materialCode: "M-20261008", name: LONG_NAME, materialType: "raw_material", isActive: true };
  const otherMaterial = { id: "m-2", materialCode: "M-002", name: "面料B", materialType: "raw_material", isActive: true };
  const item = (overrides: Record<string, unknown> = {}) => ({ id: "bi-1", materialId: "m-long", materialName: LONG_NAME, model: "", requiredQuantity: "2", unit: "米", unitId: "u-1", materialSnapshot: {}, ...overrides });

  function renderWith(rows: Array<Record<string, unknown>>, materialPool = [longMaterial, otherMaterial]) {
    stubApi((url, call) => (url.endsWith("/boms/bom-1") && call.method === "GET"
      ? apiOk({ id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: OPENED_AT, items: rows })
      : apiOk({})));
    return render(<BomWorkbench bomId="bom-1" title="SO-1" materials={materialPool} units={units} onClose={() => undefined} />);
  }

  it("表头每一列都挂着与 CSS 列宽规则一一对应的类（类名一改，CSS 静默失效）", async () => {
    renderWith([item()]);
    const pairs: Array<[string, string]> = [
      ["序号", "bom-col-index"], ["物料名称", "bom-col-material"], ["型号", "bom-col-model"],
      ["规格型号", "bom-col-spec"], ["颜色", "bom-col-color"], ["数量", "bom-col-quantity"],
      ["单位", "bom-col-unit"], ["供应商", "bom-col-supplier"], ["操作", "bom-col-action"],
    ];
    for (const [header, className] of pairs) {
      expect((await screen.findByRole("columnheader", { name: header })).className).toContain(className);
    }
    expect(screen.getByTestId("bom-material-0").closest("td")?.className).toContain("bom-col-material");
  });

  it("title 是完整物料名（省略号只发生在屏幕上，不会进 title）", async () => {
    renderWith([item()]);
    const trigger = await screen.findByTestId("bom-material-0");
    expect(trigger).toHaveAttribute("title", `M-20261008 / ${LONG_NAME}`);
    // hover 出来的必须与眼睛看到的是同一份字符串：触发器里显示的正是下拉选项的 label
    expect(trigger.textContent).toContain(`M-20261008 / ${LONG_NAME}`);
  });

  it("换了物料，title 跟着换（不是只在首次渲染时算一次）", async () => {
    renderWith([item()]);
    await userEvent.click(await screen.findByTestId("bom-material-0"));
    await userEvent.click(await screen.findByText("M-002 / 面料B"));
    await waitFor(() => expect(screen.getByTestId("bom-material-0")).toHaveAttribute("title", "M-002 / 面料B"));
  });

  it("行里还没选物料时不给 title（空提示比没有提示更糟）", async () => {
    renderWith([item({ materialId: "", materialName: "" })]);
    expect(await screen.findByTestId("bom-material-0")).not.toHaveAttribute("title");
  });
});
