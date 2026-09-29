// BOM 表的「供应商」列 + 下拉里快速新建（2026-09-26）。
//
// 用户原话：「针对 BOM 表，要新增一个 column，供应商。同时允许在下拉列表中快速新建。」
// 已确认的口径：挂在**明细行**（每个部件一个默认供应商）；**不预填到采购单**（备查信息）；
// 新建入口就在下拉里。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BomWorkbench } from "../components/bom/bom-workbench";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const materials = [{ id: "m-1", materialCode: "M-001", name: "面料A", materialType: "raw_material", isActive: true }];
const units = [{ id: "u-1", name: "米", isActive: true }];
const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "宁波辅料厂", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "绍兴纺织", isActive: true },
];

const bomWith = (items: Array<Record<string, unknown>>) => ({ id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: "2026-09-26T02:00:00.000Z", items });
const baseItem = (overrides: Record<string, unknown> = {}) => ({ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", requiredQuantity: "2", unit: "米", unitId: "u-1", materialSnapshot: {}, supplierId: null, supplierSnapshot: null, ...overrides });

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const itemsOf = (call: StubbedCall) => bodyOf(call).items as Array<Record<string, unknown>>;

function renderWorkbench(options: { onSupplierCreated?: (supplier: Record<string, unknown>) => void; items?: Array<Record<string, unknown>>; showSupplier?: boolean } = {}) {
  const calls = stubApi((url, call) => {
    if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(options.items ?? [baseItem()]));
    if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(options.items ?? [baseItem()]));
    if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
    if (url.endsWith("/suppliers") && call.method === "POST") {
      const body = JSON.parse(String(call.body)) as { name: string };
      return apiOk({ id: "s-new", supplierCode: "S-003", name: body.name, isActive: true }, {});
    }
    return apiOk({});
  });
  render(<>
    <BomWorkbench bomId="bom-1" title="SO-1" materials={materials} units={units} showSupplier={options.showSupplier} onSupplierCreated={options.onSupplierCreated} onClose={() => undefined} />
    <Toaster />
  </>);
  return calls;
}

// `SearchableSelect` 收起态的控件显式声明了 `role="combobox"`（覆盖了 button 的隐含角色），
// 所以这里按 combobox 找它，而不是按 button。
const triggerOf = async (index = 0) => {
  const cell = await screen.findByTestId(`bom-supplier-select-${index}`);
  return within(cell).getByRole("combobox");
};

describe("BOM 表：供应商列", () => {
  it("表头多一列「供应商」，每行都有一个选择器", async () => {
    renderWorkbench();
    expect(await screen.findByRole("columnheader", { name: "供应商" })).toBeTruthy();
    expect(screen.getByTestId("bom-supplier-select-0")).toBeTruthy();
  });

  it("选中已有供应商后保存：请求体带 supplier_id", async () => {
    const calls = renderWorkbench();
    await screen.findByTestId("bom-supplier-select-0");
    await userEvent.click(await triggerOf());
    await userEvent.click(await screen.findByText("S-002 / 绍兴纺织"));
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const put = await waitFor(() => {
      const call = calls.find((item) => item.method === "PUT");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(itemsOf(put)[0].supplier_id).toBe("s-2");
  });

  it("当行的供应商已停用（不在池里）时仍然显示，保存时不被抹掉", async () => {
    const calls = renderWorkbench({ items: [baseItem({ supplierId: "s-old", supplierSnapshot: { id: "s-old", supplierCode: "S-000", name: "已停用的老厂家" } })] });
    const trigger = await triggerOf();
    // 不在池里也要显示出来（用快照兜底）：否则用户会以为这一格空了，一保存就把记录抹掉。
    await waitFor(() => expect(trigger).toHaveTextContent("已停用的老厂家"));
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(itemsOf(put)[0].supplier_id).toBe("s-old");
  });
});

describe("BOM 表：下拉里快速新建供应商", () => {
  it("输入一个新名字 → 下拉出现「＋ 新建供应商」→ 建完自动选中并带上新 id", async () => {
    const onSupplierCreated = vi.fn();
    const calls = renderWorkbench({ onSupplierCreated });
    await screen.findByTestId("bom-supplier-select-0");
    await userEvent.click(await triggerOf());
    await userEvent.type(screen.getByTestId("searchable-select-search"), "厦门新伞骨厂");

    await userEvent.click(await screen.findByText("＋ 新建供应商「厦门新伞骨厂」"));
    // 弹窗里的名称用刚输入的词预填（少一次输入）
    expect(await screen.findByDisplayValue("厦门新伞骨厂")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "保存并选用" }));

    // 走的是既有供应商池接口（编码方式 auto/manual 与物料/供应商页同一套）
    const post = await waitFor(() => {
      const call = calls.find((item) => item.method === "POST" && item.url.endsWith("/suppliers"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect(bodyOf(post)).toMatchObject({ name: "厦门新伞骨厂", code_mode: "auto" });
    await waitFor(() => expect(onSupplierCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" })));

    // 建完直接选中：保存时带的是新供应商
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(itemsOf(put)[0].supplier_id).toBe("s-new");
  });

  it("名字与已有供应商相同时不提供「新建」——那会撞 suppliers.name 的唯一约束，正确动作是选那一家", async () => {
    renderWorkbench();
    await screen.findByTestId("bom-supplier-select-0");
    await userEvent.click(await triggerOf());
    await userEvent.type(screen.getByTestId("searchable-select-search"), "宁波辅料厂");

    await screen.findByText("S-001 / 宁波辅料厂");
    expect(screen.queryByText(/＋ 新建供应商/)).toBeNull();
  });

  it("新建失败（名称重复）时弹窗不关、已填内容不丢、原因显示在弹窗里", async () => {
    stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith([baseItem()]));
      if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
      if (url.endsWith("/suppliers") && call.method === "POST") return apiErr(409, "SUPPLIER_CODE_CONFLICT", "供应商编码已存在");
      return apiOk({});
    });
    render(<BomWorkbench bomId="bom-1" title="SO-1" materials={materials} units={units} onClose={() => undefined} />);
    await screen.findByTestId("bom-supplier-select-0");
    await userEvent.click(await triggerOf());
    await userEvent.type(screen.getByTestId("searchable-select-search"), "重复的厂家");
    await userEvent.click(await screen.findByText("＋ 新建供应商「重复的厂家」"));
    await userEvent.click(await screen.findByRole("button", { name: "保存并选用" }));

    // 弹窗还在、名字还在（不用重新填），原因摆在弹窗里
    expect(await screen.findByDisplayValue("重复的厂家")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("供应商编码已存在")).toBeTruthy());
  });

  it("生产侧不显示这一列（showSupplier=false），但保存时行上已有的供应商照旧回传、不会被抹掉", async () => {
    // 用户 2026-09-27：「现在，生产模块里面的 BOM 表里面不用填写供应商。」
    // 这一列是采购的知识（这个部件通常找哪家做）；生产保存 BOM 不该把采购标过的供应商清掉。
    const calls = renderWorkbench({ showSupplier: false, items: [baseItem({ supplierId: "s-1", supplier: { id: "s-1", supplierCode: "S-001", name: "宁波辅料厂", isActive: true } })] });
    await screen.findByRole("button", { name: "保存BOM表" });

    expect(screen.queryByRole("columnheader", { name: "供应商" })).toBeNull();
    expect(screen.queryByTestId("bom-supplier-select-0")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(itemsOf(calls.find((call) => call.method === "PUT")!)[0].supplier_id).toBe("s-1");
  });
});
