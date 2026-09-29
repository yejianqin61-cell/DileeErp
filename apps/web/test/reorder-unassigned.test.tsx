// 历史单未填货号补录（T12）。
//
// 老板要求每个销售单都有货号，历史单是空的 —— 这张待办表是补录入口。
// 口径：**绝不从品名猜货号**（猜错会把两批不同的货并成一个货号，比空着糟糕得多），
// 逐条走既有的 PATCH /sales-orders/:id（不新增批量接口——批量接口会绕开
// 「已确认单改货号必须填原因」那道守卫与它的审计）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnassignedPanel } from "../components/reorder/unassigned-panel";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const orders = [
  { sales_order_id: "so-1", order_no: "DL260001-1", customer_name: "FLOWER1", product_name: "三折伞", quantity: "1960", unit: "支", order_date: "2026-06-18T00:00:00.000Z", status: "closed" },
  { sales_order_id: "so-2", order_no: "DL260002-1", customer_name: "家百纳", product_name: "直骨伞", quantity: "500", unit: "打", order_date: "2026-07-01T00:00:00.000Z", status: "confirmed" },
];
const suggestions = [{ item_no: "27621 流水花扇", item_no_key: "27621流水花扇", order_count: 3 }];

function stub(handlers: Record<string, () => Response> = {}): StubbedCall[] {
  return stubApi((url) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (url.includes(fragment)) return handler();
    if (url.includes("/reorder/unassigned-orders")) return apiOk(orders, { total: orders.length });
    if (url.includes("/sales-orders/item-nos")) return apiOk(suggestions);
    return apiOk({});
  });
}

describe("未填货号补录", () => {
  it("列出待补录的销售单（订单号/客户/产品/数量/日期/状态）", async () => {
    stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    expect(screen.getByTestId("unassigned-row-DL260001-1")).toHaveTextContent("1960 支");
    expect(screen.getByTestId("unassigned-row-DL260002-1")).toHaveTextContent("已确认");
  });

  it("单行指派：成功后该行消失，其余行与勾选状态保留", async () => {
    const calls = stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    // 先勾上另一张单（验证它不会被清掉）
    fireEvent.click(screen.getByTestId("unassigned-select-DL260002-1"));

    fireEvent.click(screen.getByTestId("unassigned-assign-DL260001-1"));
    fireEvent.change(await screen.findByTestId("unassigned-item-no"), { target: { value: "27621 流水花扇" } });
    fireEvent.click(screen.getByTestId("unassigned-submit"));

    await waitFor(() => expect(screen.queryByTestId("unassigned-row-DL260001-1")).toBeNull());
    expect(screen.getByTestId("unassigned-row-DL260002-1")).toBeTruthy();
    expect(screen.getByTestId("unassigned-select-DL260002-1")).toBeChecked();
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toContain("/sales-orders/so-1");
    expect(JSON.parse(String(patch?.body))).toEqual({ item_no: "27621 流水花扇" });
  });

  it("已确认单必填原因：没填就不发请求，并说明原因", async () => {
    const calls = stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    fireEvent.click(screen.getByTestId("unassigned-assign-DL260002-1"));
    fireEvent.change(await screen.findByTestId("unassigned-item-no"), { target: { value: "88001" } });
    fireEvent.click(screen.getByTestId("unassigned-submit"));

    await screen.findByTestId("unassigned-failure");
    expect(screen.getByTestId("unassigned-failure")).toHaveTextContent("必须填写原因");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("已确认单填了原因才发请求，原因进载荷", async () => {
    const calls = stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    fireEvent.click(screen.getByTestId("unassigned-assign-DL260002-1"));
    fireEvent.change(await screen.findByTestId("unassigned-item-no"), { target: { value: "88001" } });
    fireEvent.change(screen.getByTestId("unassigned-reason"), { target: { value: "历史单补货号" } });
    fireEvent.click(screen.getByTestId("unassigned-submit"));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body))).toEqual({ item_no: "88001", reason: "历史单补货号" });
  });

  it("批量指派：逐条发请求；部分失败时列出失败单号与原因", async () => {
    const calls = stub({ "/sales-orders/so-2": () => apiErr(422, "CORRECTION_REASON_REQUIRED", "已确认销售单修改必须填写原因") });
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    fireEvent.click(screen.getByTestId("unassigned-select-all"));
    fireEvent.click(screen.getByTestId("unassigned-assign-selected"));
    expect(await screen.findByText(/指派货号（2 张单）/)).toBeTruthy();
    fireEvent.change(screen.getByTestId("unassigned-item-no"), { target: { value: "27621" } });
    fireEvent.change(screen.getByTestId("unassigned-reason"), { target: { value: "批量补录" } });
    fireEvent.click(screen.getByTestId("unassigned-submit"));

    await screen.findByTestId("unassigned-failure");
    expect(screen.getByTestId("unassigned-failure")).toHaveTextContent("有 1 张单没补上");
    expect(screen.getByTestId("unassigned-failure")).toHaveTextContent("DL260002-1");
    expect(screen.getByTestId("unassigned-failure")).toHaveTextContent("必须填写原因");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
    // 成功的那张已从待办里移除，失败的那张留着继续补。
    expect(screen.queryByTestId("unassigned-row-DL260001-1")).toBeNull();
    expect(screen.getByTestId("unassigned-row-DL260002-1")).toBeTruthy();
  });

  it("指派发的是**原样**输入（归一在服务端，前端不自己转一遍）", async () => {
    const calls = stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    fireEvent.click(screen.getByTestId("unassigned-assign-DL260001-1"));
    // 全角空格 + 小写：前端不该把它改成 "27621 流水花扇"
    fireEvent.change(await screen.findByTestId("unassigned-item-no"), { target: { value: "dl27621\u3000流水" } });
    fireEvent.click(screen.getByTestId("unassigned-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)).item_no).toBe("dl27621\u3000流水");
  });

  it("可以直接输一个系统里还没有的新货号（候选列表是建议，不是白名单）", async () => {
    const calls = stub();
    render(<UnassignedPanel />);
    await screen.findByTestId("unassigned-table");
    fireEvent.click(screen.getByTestId("unassigned-assign-DL260001-1"));
    const input = await screen.findByTestId("unassigned-item-no");
    await userEvent.clear(input);
    await userEvent.type(input, "NEW-9527");
    fireEvent.click(screen.getByTestId("unassigned-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)).item_no).toBe("NEW-9527");
  });

  it("待补录清单加载失败 → 错误态", async () => {
    stub({ "/reorder/unassigned-orders": () => apiErr(500, "INTERNAL", "服务器错误") });
    render(<UnassignedPanel />);
    await screen.findByText("服务器错误");
  });
});

// 用不到 vi 的话 lint 会判未使用，这里显式引用一次避免误解。
void vi;
