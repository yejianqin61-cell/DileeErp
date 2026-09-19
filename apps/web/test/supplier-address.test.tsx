// 供应商「地址」字段的行为测试（用户 2026-09-16：「供应商，需要多一个字段，地址」）。
//
// 覆盖三件事（都是用户能看见的）：
//   1. 供应商池列表有「地址」列；
//   2. 新建 / 编辑弹窗里能填地址，请求体带上 address（清空时按 null 提交 = 清除）；
//   3. 搜索能按地址命中（与其它池子共用 fuzzyMatch 的多词 AND 语义）。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SuppliersPage from "../app/procurement/suppliers/page";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = { suppliers: "/api/v1/suppliers" } as const;

const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "香港迪礼贸易", contactName: "陈小姐", phone: "13800000001", address: "香港九龙旺角弥敦道 1 号", remark: "面料主供", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "宁波辅料厂", contactName: "王先生", phone: "13900000002", address: "浙江省宁波市北仑区港城大道 88 号", remark: null, isActive: true },
  { id: "s-3", supplierCode: "S-003", name: "无地址供应商", contactName: null, phone: null, address: null, remark: null, isActive: true },
];

function stub(rows: unknown = suppliers) {
  return stubApi((url) => (url === EP.suppliers ? apiOk(rows) : apiOk([])));
}

async function open() {
  render(<SuppliersPage />);
  await screen.findByTestId("page-procurement-suppliers");
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;

describe("供应商地址：列表", () => {
  it("有「地址」列并显示地址；没有地址时显示占位符而不是空白", async () => {
    stub();
    await open();

    expect(screen.getByRole("columnheader", { name: "地址" })).toBeVisible();
    expect(screen.getByText("香港九龙旺角弥敦道 1 号")).toBeVisible();
    expect(screen.getByText("浙江省宁波市北仑区港城大道 88 号")).toBeVisible();
    // 第三家没有地址：一格「-」比空着好，空着看不出是没填还是渲染漏了
    // 列序：0 编码 / 1 名称 / 2 联系人 / 3 联系电话 / 4 地址 / 5 备注 / 6 状态 / 7 操作
    const row = screen.getByText("无地址供应商").closest("tr") as HTMLTableRowElement;
    expect(within(row).getAllByRole("cell")[4]).toHaveTextContent("-");
  });

  it("搜索能按地址命中（多词 AND，大小写与空白不敏感）", async () => {
    stub();
    await open();
    const box = screen.getByTestId("supplier-search");

    fireEvent.change(box, { target: { value: "宁波" } });
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(1);

    fireEvent.change(box, { target: { value: "九龙 弥敦道" } });
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(1);
    expect(screen.getByText("香港迪礼贸易")).toBeVisible();

    fireEvent.change(box, { target: { value: "弥敦道 北仑" } });
    expect(screen.getByText(/没有匹配/)).toBeVisible();
  });
});

describe("供应商地址：新建与编辑", () => {
  it("新建供应商：弹窗里有地址字段，提交时带上 address", async () => {
    const calls = stub();
    await open();

    await userEvent.click(screen.getByRole("button", { name: "新建供应商" }));
    await screen.findByTestId("action-dialog");

    expect(screen.getByText("地址")).toBeVisible();
    await userEvent.type(screen.getByTestId("action-field-name"), "新面料厂");
    await userEvent.type(screen.getByTestId("action-field-address"), "福建省晋江市陈埭镇");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url === EP.suppliers)).toBe(true));
    const posted = calls.find((call) => call.method === "POST" && call.url === EP.suppliers)!;
    expect(bodyOf(posted)).toMatchObject({ name: "新面料厂", address: "福建省晋江市陈埭镇", code_mode: "auto" });
  });

  it("新建时地址留空：不发 address 键（不是空串，避免把空串当成要存的地址）", async () => {
    const calls = stub();
    await open();

    await userEvent.click(screen.getByRole("button", { name: "新建供应商" }));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-name"), "没填地址的厂");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url === EP.suppliers)).toBe(true));
    expect(bodyOf(calls.find((call) => call.method === "POST" && call.url === EP.suppliers)!)).not.toHaveProperty("address");
  });

  it("编辑供应商：带出现有地址，清空后按 null 提交（清除）", async () => {
    const calls = stub();
    await open();

    const row = screen.getByText("香港迪礼贸易").closest("tr") as HTMLTableRowElement;
    await userEvent.click(within(row).getByRole("button", { name: "编辑" }));

    const address = await screen.findByTestId("action-field-address");
    expect(address).toHaveValue("香港九龙旺角弥敦道 1 号");

    await userEvent.clear(address);
    await userEvent.type(address, "香港九龙旺角弥敦道 2 号");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/suppliers/s-1"))).toBe(true));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/suppliers/s-1"))!;
    expect(bodyOf(patched)).toMatchObject({ address: "香港九龙旺角弥敦道 2 号" });

    // 再清空一次：空串要变成 null（服务端的「清除这一格」）
    const rowAgain = screen.getByText("香港迪礼贸易").closest("tr") as HTMLTableRowElement;
    await userEvent.click(within(rowAgain).getByRole("button", { name: "编辑" }));
    await userEvent.clear(await screen.findByTestId("action-field-address"));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/suppliers/s-1")).length).toBe(2));
    expect(bodyOf(calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/suppliers/s-1")).at(-1)!)).toMatchObject({ address: null });
  });
});
