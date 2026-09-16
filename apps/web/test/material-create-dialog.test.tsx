// 共享「新建物料」弹窗（components/bom/material-create-dialog.tsx）的**行为**测试。
//
// 为什么需要它：2026-09-16 用户问「BOM 表的新建物料按钮怎么不见了」—— 查下来按钮在、点了没反应
// （采购两处把它接成了空函数），生产侧干脆不渲染。这个弹窗是三处入口共用的唯一实现，
// 所以「填什么字段、发什么请求、失败后弹窗还开着吗」都在这一层钉住。
//
// 纪律：真实渲染 + 真实输入 + 真实 fetch 桩；断言 DOM 文本与 stubApi 记录的 body。
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaterialCreateDialog, type MaterialRef, type MaterialUnitRef } from "../components/bom/material-create-dialog";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = { materials: "/api/v1/materials", units: "/api/v1/units" } as const;
const units = [{ id: "u-1", name: "米", isActive: true }];

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const dialog = () => within(screen.getByTestId("action-dialog"));

/** 用真实的父子接线渲染：单位池是受控的（新建单位要能立刻出现在下拉里）。 */
function renderDialog(options: { onCreated?: (material: MaterialRef) => void; onOpenChange?: (open: boolean) => void } = {}) {
  function Harness() {
    const [unitPool, setUnitPool] = useState<MaterialUnitRef[]>(units);
    return <>
      <MaterialCreateDialog
        open
        units={unitPool}
        onOpenChange={options.onOpenChange ?? (() => undefined)}
        onUnitCreated={(unit) => setUnitPool((items) => [...items, unit])}
        onCreated={options.onCreated ?? (() => undefined)}
      />
      <Toaster />
    </>;
  }
  return render(<Harness />);
}

/** 选默认单位：按字段 testid 点那个下拉（弹窗里第一个 combobox 是「编码方式」，别按下标猜）。 */
async function pickUnit(name: string) {
  await userEvent.click(dialog().getByTestId("action-field-default_unit_id"));
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** 选下拉（按字段 testid 点触发器）。 */
async function pickField(field: string, optionName: string) {
  await userEvent.click(dialog().getByTestId(`action-field-${field}`));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("新建物料弹窗：字段与请求", () => {
  it("自动编码 + 必填项齐全时，POST /materials 只发该发的字段，并把新物料交回调用方", async () => {
    const calls = stubApi((url, call) => (url.endsWith("/materials") && call.method === "POST"
      ? apiOk({ id: "m-9", materialCode: "M-009", name: "伞骨", materialType: "raw_material", defaultUnitId: "u-1", isActive: true })
      : apiOk([])));
    const onCreated = vi.fn();
    renderDialog({ onCreated });

    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await pickUnit("米");
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/materials")).toHaveLength(1));
    // 精确 body：空串字段必须**消失**（后端把空串当脏值），不能发 "material_code": ""
    expect(bodyOf(callsTo(calls, "/materials")[0])).toEqual({
      code_mode: "auto",
      name: "伞骨",
      default_unit_id: "u-1",
      material_type: "raw_material",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "m-9", name: "伞骨" })));
  });

  it("手动编码时把物料编码一起发出去（自动编码则不发）", async () => {
    const calls = stubApi((url, call) => (url.endsWith("/materials") && call.method === "POST" ? apiOk({ id: "m-9", name: "伞骨" }) : apiOk([])));
    renderDialog();

    await pickField("code_mode", "手动填写");
    await userEvent.type(screen.getByLabelText(/物料编码/), "M-009");
    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await pickUnit("米");
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/materials")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/materials")[0])).toMatchObject({ code_mode: "manual", material_code: "M-009" });
  });

  it("默认单位是必填：不选就提交会被本地拦下，不发请求", async () => {
    const calls = stubApi(() => apiOk([]));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("请填写默认单位");
    expect(callsTo(calls, "/materials")).toEqual([]);
  });

  it("创建失败时弹窗保持打开、显示后端原因、按钮回到可提交（用户的输入不丢）", async () => {
    stubApi((url, call) => (url.endsWith("/materials") && call.method === "POST" ? apiErr(409, "MATERIAL_DUPLICATE", "同名同规格同颜色的物料已存在") : apiOk([])));
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog({ onCreated, onOpenChange });

    await userEvent.type(screen.getByLabelText(/物料名称/), "涤纶布");
    await pickUnit("米");
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("同名同规格同颜色的物料已存在");
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByDisplayValue("涤纶布")).toBeVisible();
    expect(dialog().getByTestId("action-dialog-submit")).toBeEnabled();
  });
});

describe("新建物料弹窗：单位池里没有这个单位时就地新建", () => {
  it("「新增类目」切到新建单位 → 建完回到物料表单，单位已预选且已填字段不丢", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/units") && call.method === "POST") return apiOk({ id: "u-9", name: "打", isActive: true });
      if (url.endsWith("/materials") && call.method === "POST") return apiOk({ id: "m-9", materialCode: "M-009", name: "伞骨", defaultUnitId: "u-9", isActive: true });
      return apiOk([]);
    });
    const onCreated = vi.fn();
    renderDialog({ onCreated });

    // 先填一部分物料字段，再去建单位 —— 这些字段必须原样回来
    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await userEvent.type(screen.getByLabelText(/规格型号/), "60cm");
    await userEvent.click(dialog().getByRole("button", { name: "新增类目" }));

    // 换页到「新建单位」：请求体只带单位自己的字段
    expect(await screen.findByText("新建单位")).toBeVisible();
    await userEvent.type(screen.getByLabelText(/单位名称/), "打");
    await userEvent.click(within(screen.getByTestId("action-dialog")).getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/units")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/units")[0])).toEqual({ name: "打" });

    // 回到物料表单：名称与规格型号还在，默认单位已经是刚建的单位
    expect(await screen.findByDisplayValue("伞骨")).toBeVisible();
    expect(screen.getByDisplayValue("60cm")).toBeVisible();
    expect(dialog().getByTestId("action-field-default_unit_id")).toHaveTextContent("打");

    await userEvent.click(dialog().getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, "/materials")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/materials")[0])).toMatchObject({ name: "伞骨", specification_model: "60cm", default_unit_id: "u-9" });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("新建单位失败时停在单位表单并显示原因（不回退成半张物料表单）", async () => {
    stubApi((url, call) => (url.endsWith("/units") && call.method === "POST" ? apiErr(409, "UNIT_DUPLICATE", "单位已存在") : apiOk([])));
    renderDialog();

    await userEvent.type(screen.getByLabelText(/物料名称/), "伞骨");
    await userEvent.click(dialog().getByRole("button", { name: "新增类目" }));
    await userEvent.type(screen.getByLabelText(/单位名称/), "打");
    await userEvent.click(within(screen.getByTestId("action-dialog")).getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("单位已存在");
    expect(screen.getByText("新建单位")).toBeVisible();
  });
});
