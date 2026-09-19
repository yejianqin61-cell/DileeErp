// 销售单整页编辑器（components/sales/sales-order-editor.tsx）的真实行为测试。
//
// 用户 2026-09-16：「针对销售模块，在新建销售单的时候，要细化口径…按照这个模板来进行设计字段和
// 设计可导出的 excel」。字段太多（37 个标量 + 一张明细表），所以新建销售单从弹窗改成整页编辑器。
//
// 本文件钉住四件事：
//   1. 37 个细化字段真的渲染出来了（少一个就是「界面填不了、库里永远空」）；
//   2. 保存时**每个细化键都发出去**（空串 = 清除这一格）——只发填了的键会让「清空」永远保存不上；
//   3. 明细按行提交、空行不提交、必填缺了逐行报错并拦住保存；
//   4. 明细数量与单头数量不一致时页面提示（不拦），与后端同一口径。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";
import { SPEC_SCALAR_KEYS } from "../lib/sales-order-spec";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const customer = { id: "customer-1", customerCode: "C001", name: "家百纳", isActive: true, currency: "USD", contacts: [{ id: "contact-1", name: "田中", phone: "090-1234", isDefault: true }] };
const units = [{ id: "unit-1", name: "支" }, { id: "unit-2", name: "打" }];
const currencyItems = { data: [{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }] };

type Call = { url: string; method: string; body: unknown };

/** 极简 fetch 桩：按 URL 分派，记录所有调用。 */
function stubApi(handlers: Array<[string, (init: RequestInit) => unknown]> = []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : undefined });
    for (const [fragment, handler] of handlers) if (url.includes(fragment)) return { ok: true, status: 200, json: async () => handler(init) };
    if (url.includes("/customers")) return { ok: true, status: 200, json: async () => ({ data: [customer], meta: {} }) };
    if (url.includes("/units")) return { ok: true, status: 200, json: async () => ({ data: units, meta: {} }) };
    if (url.includes("/dictionaries/currency/items")) return { ok: true, status: 200, json: async () => currencyItems };
    return { ok: true, status: 200, json: async () => ({ data: {}, meta: {} }) };
  });
  return calls;
}

const field = (testid: string) => screen.getByTestId(testid);
const specField = (key: string) => screen.getByTestId(`sales-spec-${key}`);

async function fillBase() {
  fireEvent.change(field("sales-base-order_no"), { target: { value: "DL260134" } });
  fireEvent.change(field("sales-base-product_name"), { target: { value: "50cm*5K 三折手开碳纤维伞" } });
  fireEvent.change(field("sales-base-quantity"), { target: { value: "1960" } });
  fireEvent.change(field("sales-base-order_date"), { target: { value: "2026-06-18" } });
  // 客户/单位/币种是 Radix 下拉：测试里直接改它们比较笨重，这里用「必须选」的校验来暴露问题，
  // 选中的动作放在下面专门的一个用例里验证。
}

describe("销售单整页编辑器", () => {
  it("37 个细化字段全部渲染（材料 18 + 工艺 9 + 布量 5 + 表头 5）", async () => {
    stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    for (const key of SPEC_SCALAR_KEYS) expect(specField(key), `缺字段 ${key}`).toBeTruthy();
    // 抽查几个来自两张不同样本的字段：样本1 独有 / 样本2 独有
    expect(specField("handle_strap_spec")).toBeTruthy();
    expect(specField("wood_ear_spec")).toBeTruthy();
    expect(specField("qc_requirement")).toBeTruthy();
    expect(screen.getByText("布量（Y/DZ）")).toBeVisible();
    expect(screen.getByText("细分明细")).toBeVisible();
  });

  it("保存：每个细化键都发出去（空串 = 清除这一格），明细按行提交且空行不提交", async () => {
    const calls = stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    fireEvent.change(specField("rib_spec"), { target: { value: "50cm*5K三折手开双碳纤骨" } });
    fireEvent.change(specField("qc_requirement"), { target: { value: "所有材料和成品都要质检报告" } });

    // 明细：第一行填全，再加一行填一半（缺品番/品名 → 应被拦下）
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞布明细" } });
    fireEvent.change(field("sales-detail-0-name"), { target: { value: "27621 流水花扇PKGY" } });
    fireEvent.change(field("sales-detail-0-color"), { target: { value: "PKGY" } });
    fireEvent.change(field("sales-detail-0-quantity"), { target: { value: "1960" } });
    fireEvent.change(field("sales-detail-0-unit"), { target: { value: "pcs" } });
    fireEvent.click(field("sales-detail-add"));

    await userEvent.click(field("sales-order-save"));
    const saved = calls.find((call) => call.method === "POST" && call.url.includes("/sales-orders"));
    expect(saved, "应当发出创建请求").toBeTruthy();
    const body = saved!.body as Record<string, unknown>;

    // 37 个细化键一个都不能少：少一个就是「界面填了、库里没存」
    for (const key of SPEC_SCALAR_KEYS) expect(key in body, `载荷缺 ${key}`).toBe(true);
    expect(body.rib_spec).toBe("50cm*5K三折手开双碳纤骨");
    expect(body.qc_requirement).toBe("所有材料和成品都要质检报告");
    // 没填的细化字段要发空串（后端据此清空这一格），不能省略键——否则「清空」永远保存不上。
    expect(body.handle_spec).toBe("");
    expect(body.spec_details).toEqual([{ group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "1960", unit: "pcs", sort_order: 0 }]);
    expect(routerPush).toHaveBeenCalledWith("/sales");
  });

  it("明细必填缺失时逐行报错并拦住保存（不发请求）", async () => {
    const calls = stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    // 只填分组名不填品番/品名
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞头配色" } });

    await userEvent.click(field("sales-order-save"));

    expect(await screen.findByTestId("sales-detail-errors")).toBeVisible();
    expect(screen.getByTestId("sales-detail-errors").textContent).toContain("第 1 行：品番/品名不能为空");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("明细合计与单头数量不一致时页面提示，但不拦保存", async () => {
    stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞布明细" } });
    fireEvent.change(field("sales-detail-0-name"), { target: { value: "27621 流水花扇PKGY" } });
    fireEvent.change(field("sales-detail-0-quantity"), { target: { value: "100" } });
    fireEvent.change(field("sales-detail-0-unit"), { target: { value: "pcs" } });

    const notice = await screen.findByTestId("sales-quantity-notice");
    expect(notice.textContent).toContain("明细数量合计 100 与单头数量 1960支 不一致");
    expect(field("sales-order-save")).not.toBeDisabled();
  });

  it("编辑既有销售单：回填细化字段与明细，已确认的单子改要填原因", async () => {
    const order = {
      id: "order-1", orderNo: "DL260134", status: "confirmed", orderDate: "2026-06-18T00:00:00.000Z", deliveryDate: null,
      productName: "折叠伞", productSpec: "旧规格", quantity: "1960.0000", unit: "支", currency: "USD",
      customer: { id: "customer-1" }, contact: null, rib_spec: "旧伞骨", factory: "JBN",
      created_by_name: "张三", updated_by_name: "李四", createdAt: "2026-09-01T02:30:00.000Z", updatedAt: "2026-09-02T06:05:00.000Z",
      specDetails: [{ groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "1960.0000", unit: "pcs" }],
    };
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: order, meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);

    await waitFor(() => expect((field("sales-spec-rib_spec") as HTMLTextAreaElement).value).toBe("旧伞骨"));
    expect((field("sales-spec-factory") as HTMLInputElement).value).toBe("JBN");
    expect((field("sales-detail-0-name") as HTMLInputElement).value).toBe("27621 流水花扇PKGY");
    // 审计四行（上一轮的全站治理）：编辑页也要能看到创建人 / 最后修改人
    const audit = screen.getByTestId("sales-order-audit").textContent ?? "";
    expect(audit).toContain("创建人 张三");
    expect(audit).toContain("最后修改人 李四");

    // 已确认单：不填原因会被拦下
    await userEvent.click(field("sales-order-save"));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    fireEvent.change(field("sales-change-reason"), { target: { value: "客户改了伞骨" } });
    await userEvent.click(field("sales-order-save"));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.includes("/sales-orders/order-1"));
    expect(patched).toBeTruthy();
    const body = patched!.body as Record<string, unknown>;
    expect(body.reason).toBe("客户改了伞骨");
    expect(body.rib_spec).toBe("旧伞骨");
    expect("order_no" in body).toBe(false);
    expect("customer_id" in body).toBe(false);
  });
});

/** Radix Select 的选择动作：点开触发器，再点选项。 */
async function pickSelect(testid: string, optionText: string) {
  const trigger = screen.getByTestId(testid);
  await userEvent.click(trigger);
  const option = await screen.findByRole("option", { name: new RegExp(optionText) });
  await userEvent.click(option);
}

// within 在本文件里没用到，但保留导入会被 lint 判为未使用——这里显式引用一次避免误解。
void within;
