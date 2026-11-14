// 销售单列表排序（2026-11-13）。
//
// 用户原话：「针对销售模块，用户需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
//
// 排序**做在服务端**（接口是分页的，前端只有当前一页），所以本文件钉的是**前端有没有把
// 用户选的那一项如实发出去**：默认不带参数（保持老行为）、选了就带 sort/direction、
// 六个选项一个不少。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalesOrdersList from "../components/sales/sales-orders-list";
import { DEFAULT_SALES_ORDER_SORT_VALUE, SALES_ORDER_SORT_OPTIONS } from "../lib/sales-order-sort";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id: "order-1", orderNo: "DL260001-1", itemNo: "27621", productName: "三折伞", quantity: "1960", unit: "支",
  status: "confirmed", customer: { id: "customer-1", name: "FLOWER1" }, boms: [],
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", createdBy: "u-1", updatedBy: "u-1",
  ...overrides,
});

function stubList() {
  return stubApi((url: string) => {
    if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [] });
    if (url.includes("/sales-orders?")) return apiOk([orderRow()]);
    if (url.includes("/customers")) return apiOk([]);
    if (url.includes("/units")) return apiOk([]);
    return apiOk([]);
  });
}

/** 列表请求（`GET /sales-orders?...`），用来断言发出去的参数。 */
const listCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && call.url.includes("/sales-orders?"));

/** Radix Select：点开触发器再点选项（与 sales-item-no.test.tsx 同一套动作）。 */
async function pickSelect(testid: string, optionText: string) {
  await userEvent.click(screen.getByTestId(testid));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(optionText) }));
}

async function openSales() {
  const calls = stubList();
  render(<SalesOrdersList />);
  await screen.findByTestId("page-sales-orders");
  await waitFor(() => expect(screen.getByText("DL260001-1")).toBeTruthy());
  return calls;
}

describe("销售单列表：排序（服务端排序，前端如实传参）", () => {
  it("默认不传 sort/direction（= 服务端的最后修改倒序，老行为一字不改）", async () => {
    const calls = await openSales();

    expect(screen.getByTestId("sales-order-sort").textContent).toContain("最后修改");
    const first = listCalls(calls)[0];
    expect(first.url).not.toContain("sort=");
    expect(first.url).not.toContain("direction=");
  });

  it("选「订单号（字典序 A→Z）」→ 重新拉列表，带上 sort=order_no&direction=asc", async () => {
    const calls = await openSales();
    const before = listCalls(calls).length;

    await pickSelect("sales-order-sort", "订单号（字典序 A→Z）");

    await waitFor(() => expect(listCalls(calls).length).toBeGreaterThan(before));
    const latest = listCalls(calls).at(-1);
    expect(latest?.url).toContain("sort=order_no");
    expect(latest?.url).toContain("direction=asc");
  });

  it("选「创建时间（旧→新）」→ 带上 sort=created_at&direction=asc", async () => {
    const calls = await openSales();

    await pickSelect("sales-order-sort", "创建时间（旧→新）");

    await waitFor(() => expect(listCalls(calls).at(-1)?.url).toContain("sort=created_at"));
    expect(listCalls(calls).at(-1)?.url).toContain("direction=asc");
  });

  it("下拉里有六种排法（两个键 × 两个方向，外加默认键的两个方向）", async () => {
    await openSales();

    await userEvent.click(screen.getByTestId("sales-order-sort"));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent ?? "");

    expect(options).toHaveLength(6);
    expect(options.some((text) => text.includes("订单号（字典序"))).toBe(true);
    expect(options.some((text) => text.includes("创建时间"))).toBe(true);
    expect(new Set(options).size).toBe(6);
  });
});

/**
 * 防漂移守卫：前端这份选项是**照抄**后端口径的（两个独立 workspace，没有共享包），
 * 所以这里直接读后端那个文件逐项比对。
 *
 * 抄一份能让下拉立刻可用；而这条守卫让"两边漂移"变成一条会红的用例，
 * 而不是一个用户报上来的 bug（"下拉里选了订单号排序，服务端说 400"）。
 */
describe("销售单排序：前端选项与后端口径逐项一致（防漂移守卫）", () => {
  it("键、方向、文案三样都与 sales-order-list-sort.ts 相同", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../../api/src/modules/sales/sales-order-list-sort.ts"), "utf8");

    // 后端把六条文案写在一张表里：`"键:方向": "文案"`。
    const pairs = [...source.matchAll(/"([a-z_]+):(asc|desc)":\s*"([^"]+)"/g)].map((match) => ({ value: `${match[1]}:${match[2]}`, label: match[3] }));
    expect(pairs.length).toBe(6);

    const normalize = (rows: Array<{ value: string; label: string }>) => [...rows].sort((left, right) => left.value.localeCompare(right.value));
    expect(normalize(SALES_ORDER_SORT_OPTIONS.map((option) => ({ ...option })))).toEqual(normalize(pairs));
  });

  it("默认值两边一致（前端的默认项 = 后端不传参数时的行为）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../../api/src/modules/sales/sales-order-list-sort.ts"), "utf8");

    const sort = source.match(/DEFAULT_SALES_ORDER_LIST_SORT[^=]*=\s*"([a-z_]+)"/)?.[1];
    const direction = source.match(/DEFAULT_SALES_ORDER_LIST_DIRECTION[^=]*=\s*"([a-z]+)"/)?.[1];
    expect(`${sort}:${direction}`).toBe(DEFAULT_SALES_ORDER_SORT_VALUE);
  });
});
