import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductionPage from "../app/production/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/production",
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const EP = {
  sales: "/api/v1/sales-orders?status=confirmed&page=1&page_size=200",
  locations: "/api/v1/production/locations",
  operations: "/api/v1/production/operations",
  orders: "/api/v1/production/orders",
  units: "/api/v1/units",
};

const order = { orderNo: "SO-1", quantity: "120", unit: "打", status: "confirmed", boms: [{ id: "bom-1", version: 1, status: "active" }, { id: "bom-2", version: 2, status: "active" }] };

function stub() {
  return stubApi((url) => {
    if (url.endsWith(EP.sales)) return apiOk([order]);
    if (url.endsWith(EP.locations)) return apiOk([{ id: "loc-1", name: "一号车间", locationType: "workshop", isActive: true }]);
    if (url.endsWith(EP.operations)) return apiOk([{ id: "op-1", operationName: "裁剪", isActive: true }]);
    if (url.endsWith(EP.orders)) return apiOk([{ id: "po-1", productionOrderNo: "MO-001", orderNo: "SO-1", executionMode: "in_house", status: "draft", plannedQuantity: "120", executionLocation: { name: "一号车间" }, operations: [{ id: "opr-1", operationNameSnapshot: "裁剪", targetQuantity: "120", status: "active" }] }]);
    if (url.endsWith(EP.units)) return apiOk([{ id: "u-1", name: "打", isActive: true }]);
    return apiErr(404, "NOT_FOUND", `unexpected ${url}`);
  });
}

describe("probe", () => {
  it("renders and opens dialog / submits", async () => {
    const calls = stub();
    render(<><ProductionPage /><Toaster /></>);
    expect(await screen.findByTestId("page-production")).toBeVisible();

    await userEvent.click(screen.getByTestId("production-create-order"));
    await screen.findByTestId("action-dialog");
    console.log("FIELDS:", screen.getByTestId("action-dialog").textContent);

    await userEvent.click(screen.getByTestId("action-field-order_no").querySelector("button")!);
    console.log("OPTIONS:", screen.getAllByTestId("searchable-select-option").map((o) => o.textContent));
    await userEvent.click(screen.getAllByTestId("searchable-select-option")[0]);

    await userEvent.click(screen.getByTestId("action-field-execution_location_id"));
    await screen.findByRole("option", { name: "一号车间 / 厂内" });
    await userEvent.click(screen.getByRole("option", { name: "一号车间 / 厂内" }));
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, EP.orders).filter((c) => c.method === "POST")).toHaveLength(1));
    console.log("POST:", JSON.stringify(callsTo(calls, EP.orders).filter((c) => c.method === "POST")[0]));
    console.log("TOAST:", await screen.findByText("生产单草稿已创建").then(() => "ok"));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("row link pushes router", async () => {
    stub();
    render(<><ProductionPage /><Toaster /></>);
    await screen.findByTestId("page-production");
    await userEvent.click(await screen.findByRole("button", { name: "MO-001" }));
    expect(routerPush).toHaveBeenCalledWith("/production/orders/po-1");
  });

  it("double click transition -> how many POSTs", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith(EP.sales)) return apiOk([order]);
      if (url.endsWith(EP.operations)) return apiOk([]);
      if (url.endsWith(EP.locations)) return apiOk([]);
      if (url.endsWith(EP.units)) return apiOk([]);
      if (url.endsWith(EP.orders) && call.method === "POST") return apiOk({});
      if (url.endsWith(EP.orders)) return apiOk([{ id: "po-1", productionOrderNo: "MO-001", orderNo: "SO-1", executionMode: "in_house", status: "draft", plannedQuantity: "120", executionLocation: null, operations: [] }]);
      return apiErr(404, "NOT_FOUND", "x");
    });
    render(<><ProductionPage /><Toaster /></>);
    await screen.findByTestId("page-production");
    const btn = screen.getByRole("button", { name: "启动" });
    await userEvent.click(btn);
    await userEvent.click(btn);
    await waitFor(() => expect(callsTo(calls, "/transition").length).toBeGreaterThan(0));
    console.log("TRANSITIONS:", callsTo(calls, "/transition").length, JSON.stringify(callsTo(calls, "/transition")));
  });

  it("search by chinese status", async () => {
    stub();
    render(<><ProductionPage /><Toaster /></>);
    await screen.findByTestId("page-production");
    const input = screen.getByPlaceholderText("输入关键词");
    await userEvent.type(input, "草稿");
    console.log("ROWS after searching 草稿:", screen.queryAllByTestId("data-table-row").length, "EMPTY:", !!screen.queryByText("暂无生产单"));
    await userEvent.clear(input);
    await userEvent.type(input, "draft");
    console.log("ROWS after searching draft:", screen.queryAllByTestId("data-table-row").length);
  });

  it("searchable select onSearch debounce", async () => {
    const calls = stubApi((url) => {
      if (url.includes("search=")) return apiOk([{ orderNo: "SO-9", quantity: "5", status: "confirmed", boms: [{ id: "bom-9", version: 1 }] }]);
      if (url.endsWith(EP.sales)) return apiOk([order]);
      if (url.endsWith(EP.locations)) return apiOk([]);
      if (url.endsWith(EP.operations)) return apiOk([]);
      if (url.endsWith(EP.orders)) return apiOk([]);
      if (url.endsWith(EP.units)) return apiOk([]);
      return apiErr(404, "NOT_FOUND", "x");
    });
    render(<><ProductionPage /><Toaster /></>);
    await screen.findByTestId("page-production");
    await userEvent.click(screen.getByTestId("production-create-order"));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-field-order_no").querySelector("button")!);
    await userEvent.type(screen.getByTestId("searchable-select-search"), "SO-9");
    await waitFor(() => expect(calls.filter((c) => c.url.includes("search=")).length).toBeGreaterThan(0));
    await screen.findByText("SO-9 / 5");
    console.log("SEARCH CALLS:", JSON.stringify(calls.filter((c) => c.url.includes("search="))));
  });
});
