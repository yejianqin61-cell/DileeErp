// 销售单编辑器「材料明细 → 其它」的真实行为测试（用户 2026-10-08）。
//
// 用户原话：「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要别的物料。
// 允许用户增删改」。
//
// 本文件钉住五件事：
//   ① 「其它」区块在材料明细**同一块面板里**（用户说的位置就是「材料明细最后」），默认 0 行；
//   ② 增、删、改都会反映到保存载荷里（`material_extras`，整块替换语义）；
//   ③ 引用物料：与 18 格同一套下拉 + 缩略图；内容为空时预填物料摘要，**已有内容不被覆盖**；
//   ④ 类目空/内容与引用都没有 → 当场逐行报错并拦住保存（不发请求）；
//   ⑤ 打开既有单回填（接口给的是列名形状 `materialExtras`），整行空的回填行丢掉。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const customer = { id: "customer-1", customerCode: "C001", name: "家百纳", isActive: true, currency: "USD", contacts: [{ id: "contact-1", name: "田中", phone: "090-1234", isDefault: true }] };
const units = [{ id: "unit-1", name: "支" }, { id: "unit-2", name: "打" }];
const currencyItems = { data: [{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }] };
const material = (extra: Record<string, unknown> = {}) => ({
  id: "m-1", materialCode: "MAT-1", name: "弹簧", specificationModel: "5cm", color: "不锈钢",
  image: { sha256: "sha-1", updatedAt: "2026-10-08T00:00:00.000Z" }, isActive: true, ...extra,
});

type Call = { url: string; method: string; body: Record<string, unknown> };

/** 极简 fetch 桩：按 URL 分派，记录所有调用（与 sales-order-editor.test.tsx 同一套路）。 */
function stubApi(handlers: Array<[string, (init: RequestInit) => unknown]> = []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : {} });
    for (const [fragment, handler] of handlers) if (url.includes(fragment)) return { ok: true, status: 200, json: async () => handler(init) };
    if (url.includes("/customers")) return { ok: true, status: 200, json: async () => ({ data: [customer], meta: {} }) };
    if (url.includes("/units")) return { ok: true, status: 200, json: async () => ({ data: units, meta: {} }) };
    if (url.includes("/dictionaries/currency/items")) return { ok: true, status: 200, json: async () => currencyItems };
    if (url.includes("/materials")) return { ok: true, status: 200, json: async () => ({ data: [material()], meta: {} }) };
    return { ok: true, status: 200, json: async () => ({ data: {}, meta: {} }) };
  });
  return calls;
}

const field = (testid: string) => screen.getByTestId(testid);
const savedCall = (calls: Call[], method: string, fragment: string) => calls.find((call) => call.method === method && call.url.includes(fragment));

/** Radix Select：点开触发器再点选项。 */
async function pickSelect(testid: string, optionText: string) {
  await userEvent.click(field(testid));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(optionText) }));
}

/** 只填必填项（客户/单位/币种是下拉，单独选）。 */
async function fillRequired() {
  await pickSelect("sales-base-customer_id", "C001");
  await pickSelect("sales-base-unit", "支");
  await pickSelect("sales-base-currency", "美元");
  fireEvent.change(field("sales-base-order_no"), { target: { value: "DL260134" } });
  fireEvent.change(field("sales-base-product_name"), { target: { value: "折叠伞" } });
  fireEvent.change(field("sales-base-quantity"), { target: { value: "1960" } });
  fireEvent.change(field("sales-base-order_date"), { target: { value: "2026-10-08" } });
}

/** 「其它」行的引用下拉（`ui/searchable-select`）：点开 → 输入物料编码 → 点第一项。 */
async function pickExtraRef(index: number, query: string) {
  const root = field(`sales-material-extra-ref-${index}`);
  await userEvent.click(within(root).getByRole("combobox"));
  const search = await screen.findByTestId("searchable-select-search");
  await userEvent.type(search, query);
  const option = (await screen.findAllByTestId("searchable-select-option"))[0];
  await userEvent.click(option);
}

describe("销售单编辑器：材料明细「其它」", () => {
  it("「其它」区块在材料明细面板里，默认 0 行；点「加一行」才有行", async () => {
    stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    expect(screen.getByText("其它")).toBeVisible();
    expect(field("sales-material-extra-empty")).toHaveTextContent("还没有自定义类目");
    expect(screen.queryByTestId("sales-material-extra-row-0")).toBeNull();

    await userEvent.click(field("sales-material-extra-add"));
    expect(field("sales-material-extra-row-0")).toBeTruthy();
    expect(field("sales-material-extra-label-0")).toBeTruthy();
    expect(field("sales-material-extra-content-0")).toBeTruthy();
    expect(field("sales-material-extra-ref-0")).toBeTruthy();
  });

  it("增删改：删除只影响那一行，且保存载荷按剩余顺序重排 sort_order", async () => {
    const calls = stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await fillRequired();

    await userEvent.click(field("sales-material-extra-add"));
    fireEvent.change(field("sales-material-extra-label-0"), { target: { value: "弹簧" } });
    fireEvent.change(field("sales-material-extra-content-0"), { target: { value: "5cm 不锈钢" } });
    await userEvent.click(field("sales-material-extra-add"));
    fireEvent.change(field("sales-material-extra-label-1"), { target: { value: "胶袋" } });
    fireEvent.change(field("sales-material-extra-content-1"), { target: { value: "200x300" } });

    // 删掉第一行：剩下那一行要顶上来（载荷里的 sort_order 也随之重排）
    await userEvent.click(field("sales-material-extra-remove-0"));
    expect(screen.queryByTestId("sales-material-extra-row-1")).toBeNull();
    expect((field("sales-material-extra-label-0") as HTMLInputElement).value).toBe("胶袋");

    await userEvent.click(field("sales-order-save"));
    const saved = savedCall(calls, "POST", "/sales-orders");
    expect(saved!.body.material_extras).toEqual([{ label: "胶袋", content: "200x300", sort_order: 0 }]);
  });

  it("引用物料：内容为空时预填物料摘要并显示缩略图；已有内容**不被覆盖**（那一行是人写的规格说明）", async () => {
    const calls = stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await fillRequired();

    await userEvent.click(field("sales-material-extra-add"));
    fireEvent.change(field("sales-material-extra-label-0"), { target: { value: "弹簧" } });
    await pickExtraRef(0, "MAT-1");
    expect((field("sales-material-extra-content-0") as HTMLTextAreaElement).value).toBe("弹簧 5cm 不锈钢");
    expect((field("material-image-thumb-m-1") as HTMLImageElement).getAttribute("src")).toBe("/api/v1/materials/m-1/image?v=sha-1");

    // 用户改过内容之后再换/再选引用：内容保持不动（18 格是无条件覆盖，这里故意不同 —— 注释在组件里）
    fireEvent.change(field("sales-material-extra-content-0"), { target: { value: "弹簧 5cm 不锈钢（按上次那批）" } });
    await pickExtraRef(0, "MAT-1");
    expect((field("sales-material-extra-content-0") as HTMLTextAreaElement).value).toBe("弹簧 5cm 不锈钢（按上次那批）");

    await userEvent.click(field("sales-order-save"));
    expect(savedCall(calls, "POST", "/sales-orders")!.body.material_extras).toEqual([
      { label: "弹簧", content: "弹簧 5cm 不锈钢（按上次那批）", material_id: "m-1", sort_order: 0 },
    ]);
  });

  it("取消引用：只摘掉引用（缩略图消失、载荷里不再带 material_id），内容留着", async () => {
    const calls = stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await fillRequired();

    await userEvent.click(field("sales-material-extra-add"));
    fireEvent.change(field("sales-material-extra-label-0"), { target: { value: "弹簧" } });
    await pickExtraRef(0, "MAT-1");
    await userEvent.click(field("sales-material-extra-ref-clear-0"));

    expect(screen.queryByTestId("material-image-thumb-m-1")).toBeNull();
    expect((field("sales-material-extra-content-0") as HTMLTextAreaElement).value).toBe("弹簧 5cm 不锈钢");
    await userEvent.click(field("sales-order-save"));
    expect(savedCall(calls, "POST", "/sales-orders")!.body.material_extras).toEqual([{ label: "弹簧", content: "弹簧 5cm 不锈钢", sort_order: 0 }]);
  });

  it("类目为空、或内容与引用都没有：逐行报错并拦住保存（不发请求）", async () => {
    const calls = stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await fillRequired();

    await userEvent.click(field("sales-material-extra-add"));
    fireEvent.change(field("sales-material-extra-content-0"), { target: { value: "有内容但没类目" } });
    await userEvent.click(field("sales-order-save"));

    expect(field("sales-material-extra-errors")).toHaveTextContent("第 1 行：类目不能为空");
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    // 类目补上、内容删空（也没有引用）→ 换成另一条错误
    fireEvent.change(field("sales-material-extra-label-0"), { target: { value: "弹簧" } });
    fireEvent.change(field("sales-material-extra-content-0"), { target: { value: "   " } });
    await userEvent.click(field("sales-order-save"));
    expect(field("sales-material-extra-errors")).toHaveTextContent("第 1 行：内容与引用的物料至少要有一个");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("打开既有单：回填「其它」行（接口的列名形状），整行空的丢掉；保存时原样再发出去", async () => {
    const order = {
      id: "order-1", orderNo: "DL260134", status: "draft", orderDate: "2026-10-08T00:00:00.000Z", deliveryDate: null,
      productName: "折叠伞", quantity: "1960", unit: "支", currency: "USD", customer: { id: "customer-1" }, contact: null,
      ribSpec: "50cm 碳纤骨", specDetails: [],
      materialExtras: [
        { id: "e-1", label: "弹簧", content: "5cm 不锈钢", sortOrder: 0, material: { id: "m-1", materialCode: "MAT-1", name: "弹簧", specificationModel: "5cm", color: "不锈钢", image: { sha256: "sha-1" } } },
        { id: "e-2", label: "", content: "", sortOrder: 1, material: null },
      ],
    };
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: order, meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);

    await waitFor(() => expect((field("sales-material-extra-label-0") as HTMLInputElement).value).toBe("弹簧"));
    expect((field("sales-material-extra-content-0") as HTMLTextAreaElement).value).toBe("5cm 不锈钢");
    expect(screen.queryByTestId("sales-material-extra-row-1")).toBeNull();
    expect(field("sales-material-extra-ref-clear-0")).toBeTruthy();

    await userEvent.click(field("sales-order-save"));
    const patched = savedCall(calls, "PATCH", "/sales-orders/order-1");
    expect(patched!.body.material_extras).toEqual([{ label: "弹簧", content: "5cm 不锈钢", material_id: "m-1", sort_order: 0 }]);
  });
});
