// 结算方式设置页（/finance/settlements → components/finance/settlement-account-workspace.tsx）行为测试。
//
// 这一页回答的是用户 2026-11-23 的要求：结算方式里要能选「中国银行-人民币账户」和
// 「备用金（招商银行账户）」。测试钉住四件事：
//   1) 列表同时列出启用/停用的字典项（停用项不能消失，历史流水还要显示它）；
//   2) 内置清单缺项时有明确提示与「补齐」按钮，且只 POST 缺失项（已停用的不复活）；
//   3) 新增/编辑/停用走既有字典接口（POST /dictionaries/settlement_account/items、
//      PATCH /dictionaries/items/:id），不另造一套平行接口；
//   4) 搜索是本地过滤，不发新请求。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettlementAccountWorkspace from "../components/finance/settlement-account-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  items: "/api/v1/dictionaries/settlement_account/items",
  item: "/api/v1/dictionaries/items",
} as const;

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

const account = (overrides: Record<string, unknown> = {}) => ({
  id: "acct-1", key: "农业银行5706", label: "农业银行5706", sortOrder: 10, isActive: true, ...overrides,
});

const LEGACY = [
  account(),
  account({ id: "acct-2", key: "中国银行（美元）7624", label: "中国银行（美元）7624", sortOrder: 20 }),
];

function stubPage(items: unknown[] = LEGACY) {
  return stubApi(async (url, call) => {
    if (url.startsWith(EP.items)) {
      if (call.method === "GET") return apiOk(items);
      return apiOk({ id: "acct-new" });
    }
    // PATCH /dictionaries/items/:id（编辑 / 停用）
    if (url.startsWith(EP.item)) return apiOk({});
    return apiOk({});
  });
}

async function openPage(items: unknown[] = LEGACY) {
  const calls = stubPage(items);
  render(<><SettlementAccountWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-settlements");
  return calls;
}

describe("结算方式设置：列表与内置清单", () => {
  it("列出全部结算账户（含停用），并标出内置清单里缺的两项", async () => {
    await openPage([...LEGACY, account({ id: "acct-dead", key: "旧账户", label: "旧账户", sortOrder: 90, isActive: false })]);
    expect(screen.getByText("旧账户")).toBeVisible();
    expect(screen.getByTestId("settlement-account-status-acct-dead")).toHaveTextContent("已停用");
    const builtins = screen.getByTestId("settlement-builtins");
    expect(within(builtins).getByText(/中国银行-人民币账户 · 未添加/)).toBeVisible();
    expect(within(builtins).getByText(/备用金（招商银行账户） · 未添加/)).toBeVisible();
    expect(within(builtins).getByTestId("settlement-builtin-backfill")).toHaveTextContent("补齐缺失的内置账户（2）");
  });

  it("已启用的内置项显示「已启用」；内置齐全时补齐按钮禁用", async () => {
    await openPage([
      ...LEGACY,
      account({ id: "acct-3", key: "中国银行-人民币账户", label: "中国银行-人民币账户", sortOrder: 30 }),
      account({ id: "acct-4", key: "备用金（招商银行账户）", label: "备用金（招商银行账户）", sortOrder: 40 }),
    ]);
    const builtins = screen.getByTestId("settlement-builtins");
    expect(within(builtins).getByText(/中国银行-人民币账户 · 已启用/)).toBeVisible();
    expect(within(builtins).getByTestId("settlement-builtin-backfill")).toBeDisabled();
    expect(within(builtins).getByTestId("settlement-builtin-backfill")).toHaveTextContent("内置账户已齐全");
  });

  it("停用的内置项不算缺失：补齐按钮不会复活它", async () => {
    await openPage([
      ...LEGACY,
      account({ id: "acct-3", key: "中国银行-人民币账户", label: "中国银行-人民币账户", sortOrder: 30, isActive: false }),
    ]);
    const builtins = screen.getByTestId("settlement-builtins");
    expect(within(builtins).getByText(/中国银行-人民币账户 · 已停用/)).toBeVisible();
    expect(within(builtins).getByTestId("settlement-builtin-backfill")).toHaveTextContent("补齐缺失的内置账户（1）");
  });

  it("补齐只 POST 缺失的内置项，key 与 label 都写成账户名", async () => {
    const calls = await openPage();
    await userEvent.click(screen.getByTestId("settlement-builtin-backfill"));
    await waitFor(() => expect(callsTo(calls, EP.items).filter((call) => call.method === "POST")).toHaveLength(2));
    const posts = callsTo(calls, EP.items).filter((call) => call.method === "POST").map(bodyOf);
    expect(posts).toEqual([
      { key: "中国银行-人民币账户", label: "中国银行-人民币账户", sort_order: 30 },
      { key: "备用金（招商银行账户）", label: "备用金（招商银行账户）", sort_order: 40 },
    ]);
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已补齐 2 个内置结算账户"))).toBe(true));
  });

  it("搜索按名称本地过滤，不发新请求", async () => {
    const calls = await openPage([...LEGACY, account({ id: "acct-usd", key: "招商银行美金户", label: "招商银行美金户", sortOrder: 50 })]);
    const before = callsTo(calls, EP.items).filter((call) => call.method === "GET").length;
    setValue("settlement-account-filter", "美金");
    expect(screen.queryByText("农业银行5706")).toBeNull();
    expect(screen.getByText("招商银行美金户")).toBeVisible();
    expect(callsTo(calls, EP.items).filter((call) => call.method === "GET")).toHaveLength(before);
  });
});

describe("结算方式设置：新增 / 编辑 / 停用", () => {
  it("新增：POST 到结算账户字典，key = label，并带上排序", async () => {
    const calls = await openPage();
    await userEvent.click(screen.getByTestId("settlement-account-create"));
    setValue("action-field-label", "中国银行-人民币账户");
    setValue("action-field-sort_order", "30");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, EP.items).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.items).filter((call) => call.method === "POST")[0])).toEqual({
      key: "中国银行-人民币账户",
      label: "中国银行-人民币账户",
      sort_order: 30,
    });
  });

  it("编辑：弹窗预填当前名称，保存 PATCH /dictionaries/items/:id（不改 key）", async () => {
    const calls = await openPage();
    await userEvent.click(screen.getByTestId("settlement-account-edit-acct-1"));
    expect((screen.getByTestId("action-field-label") as HTMLInputElement).value).toBe("农业银行5706");
    setValue("action-field-label", "农业银行5706（基本户）");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.item}/acct-1`)).toHaveLength(1));
    const patch = callsTo(calls, `${EP.item}/acct-1`)[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toEqual({ label: "农业银行5706（基本户）", sort_order: 10 });
  });

  it("停用：PATCH is_active=false，并提示历史流水仍显示该账户", async () => {
    const calls = await openPage();
    await userEvent.click(screen.getByTestId("settlement-account-toggle-acct-1"));
    await waitFor(() => expect(callsTo(calls, `${EP.item}/acct-1`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, `${EP.item}/acct-1`)[0])).toEqual({ is_active: false });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("历史流水仍显示这个账户"))).toBe(true));
  });
});
