// 销售单 Excel 补录的前端行为测试（用户 2026-11-02）。
//
// 用户原话：「用户上传销售单 excel，系统进行字段读取与匹配，展示一份系统表单，让用户进行修改与确认。
// 用户通过之后，再确认建立销售单。」
//
// 这里钉住四件事：
//   ① 解析结果**灌进的是正式的新建销售单表单**（客户/订单号/数量/日期/材料/工艺/明细都填好），不是另做一张表；
//   ② 核对横幅把「读出多少 / 必须改什么 / 没认出什么」摆在表单上方，且**主按钮叫「确认建立销售单」**；
//   ③ 点确认走的仍是 `POST /sales-orders`（同一套载荷：`spec_details` / `material_extras` 都带上）；
//   ④ 「换一个文件重新读取」不会留下半张单（只回调，不发请求）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";
import type { SalesOrderImportResult } from "../lib/sales-order-import";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const customer = { id: "customer-1", customerCode: "JBN", name: "家百纳", isActive: true, currency: "USD", contacts: [] };
const units = [{ id: "unit-1", name: "支" }, { id: "unit-2", name: "打" }];
const currencyItems = { data: [{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }] };

type Call = { url: string; method: string; body: Record<string, unknown> };

function stubApi() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : {} });
    if (url.includes("/customers")) return { ok: true, status: 200, json: async () => ({ data: [customer], meta: {} }) };
    if (url.includes("/units")) return { ok: true, status: 200, json: async () => ({ data: units, meta: {} }) };
    if (url.includes("/dictionaries/currency/items")) return { ok: true, status: 200, json: async () => currencyItems };
    if (url.includes("/materials")) return { ok: true, status: 200, json: async () => ({ data: [], meta: {} }) };
    if (url.includes("/sales-orders") && (init.method ?? "GET").toUpperCase() === "POST") return { ok: true, status: 201, json: async () => ({ data: { id: "new-order", orderNo: "DL260134" }, meta: {} }) };
    return { ok: true, status: 200, json: async () => ({ data: {}, meta: {} }) };
  });
  return calls;
}

/** 服务端补录解析的返回（形状与 `SalesOrderImportService.preview` 一致）。 */
const imported: SalesOrderImportResult = {
  file_name: "DL260134 JBN生产单.xls",
  sheet_name: "DL250199",
  status: "partial",
  customer_id: "customer-1",
  customer: { id: "customer-1", name: "家百纳", customer_code: "JBN", currency: "USD", matched_by: "客户名称「家百纳」" },
  customer_raw: "家百纳",
  copy: {
    order_no: "DL260134",
    order_date: "2026-06-18",
    delivery_date: "2026-07-30",
    completion_remark: "进仓",
    quantity: "1960",
    unit: "支",
    currency: "USD",
    product_name: "50cm*5K 三折手开碳纤维伞",
    item_no: "HC-01",
    attention_note: "1、此订单共12款图案",
    rib_spec: "50cm 双碳纤骨",
    handle_spec: "宇豪兴配套伞头",
    sample_requirement: "每个设计各1支",
    spec_details: [
      { group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "100", unit: "pcs", sort_order: 0 },
      { group_name: "伞布明细", name: "27621 花屋辻NV", color: "NV", barcode: "", quantity: "200", unit: "pcs", sort_order: 1 },
    ],
    material_extras: [
      { label: "伞头", content: "弯柄黑色", spec_key: "handle_spec", sort_order: 0 },
      { label: "伞头", content: "三折伞头（银）", spec_key: "handle_spec", sort_order: 1 },
    ],
  },
  must_fill: [],
  issues: [
    { level: "error", field: "order_no", message: "订单号 DL260134 在系统里已经有一张单了（状态：已确认），请改号" },
    { level: "warning", field: "unit", message: "单位「支」不在单位清单里，请确认" },
  ],
  warnings: ["读到细分明细 2 行（分组「伞布明细」），请核对品名与数量"],
  recognized: [
    { field: "order_no", label: "订单号", value: "DL260134", from: "C2" },
    { field: "rib_spec", label: "伞骨（孔对孔）", value: "50cm 双碳纤骨", from: "B7" },
  ],
  unrecognized: [{ where: "A4", text: "加大货样各1支" }],
  summary: { recognized: 31, detail_rows: 2, extra_rows: 2, fills: 20, missing: [] },
};

const field = (testid: string) => screen.getByTestId(testid);
const valueOf = (testid: string) => (field(testid) as HTMLInputElement).value;

describe("销售单 Excel 补录：核对表单", () => {
  it("解析结果灌进正式的表单：客户/订单号/数量/日期/材料/明细都填好，主按钮叫「确认建立销售单」", async () => {
    stubApi();
    render(<SalesOrderEditor imported={imported} />);

    expect(await screen.findByText("新建销售单（Excel 补录核对）")).toBeTruthy();
    await waitFor(() => expect(valueOf("sales-base-order_no")).toBe("DL260134"));
    expect(valueOf("sales-base-quantity")).toBe("1960");
    expect(valueOf("sales-base-product_name")).toBe("50cm*5K 三折手开碳纤维伞");
    expect(valueOf("sales-base-order_date")).toBe("2026-06-18");
    expect(valueOf("sales-base-delivery_date")).toBe("2026-07-30");
    expect(valueOf("sales-base-item_no")).toBe("HC-01");
    expect(valueOf("sales-spec-rib_spec")).toBe("50cm 双碳纤骨");
    expect(valueOf("sales-spec-sample_requirement")).toBe("每个设计各1支");
    // 明细两行与「伞头」的追加款都跟着表过来了（3 款伞头的第 2、3 款在对应类目里）。
    expect(screen.getAllByDisplayValue("27621 流水花扇PKGY").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("弯柄黑色").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("三折伞头（银）").length).toBeGreaterThan(0);
    // 四个"必须重填"的格子这一路是**按表填好**的，提示语也要跟着变。
    expect(screen.getByTestId("import-must-fill-order_no").textContent).toContain("按表填好");
    expect(field("sales-order-save").textContent).toBe("确认建立销售单");
  });

  it("核对横幅：一句话汇总 + 必须改的项（红）+ 提醒（黄）+ 折叠的逐格清单", async () => {
    stubApi();
    render(<SalesOrderEditor imported={imported} />);
    await screen.findByTestId("sales-order-import-banner");
    const summary = field("sales-order-import-summary").textContent ?? "";
    expect(summary).toContain("读出 31 处字段");
    expect(summary).toContain("细分明细 2 行");
    expect(summary).toContain("1 处没认出");
    expect(summary).toContain("待修正 1 项");
    expect(field("sales-order-import-errors").textContent).toContain("订单号 DL260134 在系统里已经有一张单了");
    expect(field("sales-order-import-warnings").textContent).toContain("单位「支」不在单位清单里");
    // 折叠区默认收起，但内容已经在 DOM 里（点开即见；逐格清单是"怀疑时才展开"的东西）。
    expect(field("sales-order-import-recognized").textContent).toContain("C2");
    expect(field("sales-order-import-unrecognized").textContent).toContain("加大货样各1支");
    expect(field("sales-order-import-customer").textContent).toContain("家百纳");
  });

  it("点「确认建立销售单」走的是 POST /sales-orders，明细与追加款一起提交", async () => {
    const calls = stubApi();
    const onReimport = vi.fn();
    render(<SalesOrderEditor imported={imported} onReimport={onReimport} />);
    await waitFor(() => expect(valueOf("sales-base-order_no")).toBe("DL260134"));
    fireEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.includes("/sales-orders"))).toBe(true));
    const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/sales-orders"))!;
    expect(post.body.order_no).toBe("DL260134");
    expect(post.body.customer_id).toBe("customer-1");
    expect(post.body.quantity).toBe("1960");
    expect((post.body.spec_details as unknown[]).length).toBe(2);
    expect((post.body.material_extras as Array<Record<string, unknown>>)[0].spec_key).toBe("handle_spec");
    expect(onReimport).not.toHaveBeenCalled();
  });

  it("「换一个文件重新读取」只回调、不发请求（不会留下半张单）", async () => {
    const calls = stubApi();
    const onReimport = vi.fn();
    render(<SalesOrderEditor imported={imported} onReimport={onReimport} />);
    await screen.findByTestId("sales-order-import-banner");
    const before = calls.filter((call) => call.method !== "GET").length;
    fireEvent.click(field("sales-order-import-reupload"));
    expect(onReimport).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method !== "GET").length).toBe(before);
  });
});
