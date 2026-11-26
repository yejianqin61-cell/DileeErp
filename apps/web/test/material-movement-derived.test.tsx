// 原料流转页的四个入口：退料、报废、库存影响、详情与审计上下文。
//
// 这四个入口在仓库页拆分（b1798d1）时一起消失过，本文件钉住它们在「领料单 / 补料单」页上的行为。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MaterialIssuesPage from "../app/production/material-issues/page";
import { Toaster } from "../components/ui/toaster";
import { derivedFields, derivedPayload, deriveSourceSelection } from "../lib/material-movement-derived";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

type Row = Record<string, any>;

const movement = (over: Row = {}): Row => ({
  id: "mi-1", movementNo: "MI-001", documentType: "issue", status: "posted", orderNo: "SO-001",
  productionOrderId: "po-1", productionOrder: { productionOrderNo: "MO-001", orderNo: "SO-001" },
  businessDate: "2026-01-02", createdAt: "2026-01-02T03:04:05.000Z", remark: null, reason: null, risks: [],
  lines: [{ id: "line-1", materialId: "m-1", quantity: "3", unit: { name: "米" }, material: { name: "面料A" } }],
  ...over,
});
const order = (over: Row = {}): Row => ({ id: "po-1", productionOrderNo: "MO-001", orderNo: "SO-001", executionMode: "in_house", status: "in_progress", ...over });

async function renderPage({ movements = [movement()], actions }: { movements?: Row[]; actions?: (url: string, call: StubbedCall) => Response | undefined } = {}) {
  const calls = stubApi((url, call) => {
    const intercepted = actions?.(url, call);
    if (intercepted) return intercepted;
    if (url.endsWith("/production/orders")) return apiOk([order()]);
    if (url.endsWith("/production/material-movements") && call.method === "GET") return apiOk(movements);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
  render(<><Toaster /><MaterialIssuesPage /></>);
  await screen.findByTestId("page-production-material-issues");
  return calls;
}

function rowOf(text: string) {
  const row = screen.getByText(text).closest('[data-testid="data-table-row"]');
  if (!row) throw new Error(`没有找到包含「${text}」的单据行`);
  return within(row as HTMLElement);
}
const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Row;

async function fillDerived() {
  await userEvent.click(screen.getByTestId("action-field-source_issue_line_id"));
  await userEvent.click(await screen.findByRole("option", { name: /MI-001/ }));
  await userEvent.type(screen.getByTestId("action-field-quantity"), "1");
  await userEvent.type(screen.getByTestId("action-field-reason"), "裁多了");
  await userEvent.click(screen.getByTestId("action-dialog-submit"));
}

describe("退料 / 报废的来源口径", () => {
  const movements = [movement(), movement({ id: "mi-2", movementNo: "MI-002", status: "draft", lines: [{ id: "line-2", materialId: "m-1", quantity: "1" }] }), movement({ id: "mc-1", movementNo: "MC-001", documentType: "replenishment", lines: [{ id: "line-3", materialId: "m-1", quantity: "1" }] })] as any[];
  const orders = [order(), order({ id: "po-2", productionOrderNo: "MO-002" })] as any[];

  it("来源只列已过账领料单的明细，生产单只列有来源可处理的那些", () => {
    const fields = derivedFields(movements, orders);
    expect(fields.find((field) => field.name === "source_issue_line_id")?.options?.map((option) => option.value)).toEqual(["line-1"]);
    expect(fields.find((field) => field.name === "production_order_id")?.options?.map((option) => option.value)).toEqual(["po-1"]);
    expect(fields.some((field) => field.type === "info")).toBe(false);
  });

  it("生产单不在生产中时没有来源，并说明原因", () => {
    const fields = derivedFields(movements, [order({ status: "completed" })] as any[]);
    expect(fields.find((field) => field.name === "source_issue_line_id")?.options).toEqual([]);
    expect(fields[0].type).toBe("info");
  });

  it("选来源行带出生产单；换成别的生产单会清掉来源行", () => {
    expect(deriveSourceSelection(movements, "source_issue_line_id", { source_issue_line_id: "line-1", production_order_id: "" })).toEqual({ production_order_id: "po-1" });
    expect(deriveSourceSelection(movements, "production_order_id", { source_issue_line_id: "line-1", production_order_id: "po-2" })).toEqual({ source_issue_line_id: "" });
    expect(deriveSourceSelection(movements, "quantity", { source_issue_line_id: "line-1", production_order_id: "po-1" })).toEqual({});
  });

  it("空备注不下发", () => {
    expect(derivedPayload({ production_order_id: "po-1", source_issue_line_id: "line-1", quantity: "1", reason: "r", remark: " " })).toEqual({ production_order_id: "po-1", reason: "r", remark: undefined, lines: [{ source_issue_line_id: "line-1", quantity: "1", remark: undefined }] });
  });
});

describe("原料流转页：退料与报废", () => {
  it.each([
    ["退料", "/production/material-movements/returns", "post-return", "退料已过账"],
    ["报废", "/production/material-movements/scraps", "post-scrap", "报废已过账"],
  ])("「%s」建单后立即过账，带幂等键", async (button, createPath, postAction, success) => {
    const calls = await renderPage({ actions: (url, call) => {
      if (call.method === "POST" && url.endsWith(createPath)) return apiOk({ id: "d-1" });
      if (url.endsWith(`/d-1/${postAction}`)) return apiOk({});
      return undefined;
    } });
    await userEvent.click(screen.getByRole("button", { name: button }));
    await fillDerived();

    await waitFor(() => expect(callsTo(calls, `/d-1/${postAction}`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, createPath)[0])).toEqual({ production_order_id: "po-1", reason: "裁多了", lines: [{ source_issue_line_id: "line-1", quantity: "1" }] });
    expect(bodyOf(callsTo(calls, `/d-1/${postAction}`)[0]).idempotency_key).toMatch(/^web-movement-/);
    expect(await screen.findByText(success)).toBeVisible();
  });

  it("过账失败：删掉刚建的草稿，原因留在弹窗里", async () => {
    const calls = await renderPage({ actions: (url, call) => {
      if (call.method === "POST" && url.endsWith("/returns")) return apiOk({ id: "d-9" });
      if (url.endsWith("/d-9/post-return")) return apiErr(422, "DERIVED_QUANTITY_EXCEEDED", "退料或报废数量超过来源领料可处分数量");
      if (call.method === "DELETE" && url.endsWith("/material-movements/d-9")) return apiOk({});
      return undefined;
    } });
    await userEvent.click(screen.getByRole("button", { name: "退料" }));
    await fillDerived();

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("超过来源领料可处分数量");
    expect(calls.filter((call) => call.method === "DELETE" && call.url.endsWith("/material-movements/d-9"))).toHaveLength(1);
  });

  it("退料单、报废单、冲销单列在第二张表里；冲销单没有「冲销」按钮", async () => {
    await renderPage({ movements: [movement(), movement({ id: "mr-1", movementNo: "MR-001", documentType: "return", reason: "裁多了" }), movement({ id: "rv-1", movementNo: "RV-001", documentType: "reversal" })] });
    const panel = within(screen.getByTestId("material-derived-panel"));
    expect(panel.getByText("MR-001")).toBeVisible();
    expect(panel.queryByText("MI-001")).toBeNull();
    expect(rowOf("MR-001").getByRole("button", { name: "冲销" })).toBeVisible();
    expect(rowOf("RV-001").queryByRole("button", { name: "冲销" })).toBeNull();
    expect(rowOf("RV-001").getByRole("button", { name: "审计" })).toBeVisible();
  });
});

describe("原料流转页：库存影响与审计", () => {
  it("「影响」只出现在已过账行；显示本单数量与当前库存，不把本单再扣一遍", async () => {
    await renderPage({
      movements: [movement({ risks: [{ riskType: "OVER_ISSUE_WARNING" }] }), movement({ id: "mi-2", movementNo: "MI-002", status: "draft" })],
      actions: (url) => (url.endsWith("/mi-1/impact-preview") ? apiOk({ lines: [{ material_id: "m-1", material_name: "面料A", material_code: "RM-1", unit: "米", quantity: "3", available_before: "7", available_after: "4", bom_reference_quantity: "5" }] }) : undefined),
    });
    expect(rowOf("MI-002").queryByRole("button", { name: "影响" })).toBeNull();

    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "影响" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("impact-stock")).toHaveTextContent("7");
    expect(within(dialog).getByTestId("impact-quantity")).toHaveTextContent("3米");
    expect(dialog).toHaveTextContent("超出实际入库数量");
    expect(dialog).not.toHaveTextContent("4");
  });

  it("「审计」显示单据上下文与审计记录（操作人是姓名）", async () => {
    await renderPage({ actions: (url) => (url.endsWith("/mi-1/audit-events") ? apiOk([{ id: "a-1", action: "raw_material_movement.post", actor_name: "张三", createdAt: "2026-01-02T04:00:00.000Z", details: {} }]) : undefined) });
    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "审计" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("库存单详情与审计上下文：MI-001");
    expect(await within(dialog).findByText("张三")).toBeVisible();
    expect(dialog).toHaveTextContent("过账");
    expect(dialog).toHaveTextContent("SO-001");
  });

  it("接口失败时在弹窗里说明原因", async () => {
    await renderPage({ actions: (url) => (url.endsWith("/audit-events") ? apiErr(403, "FORBIDDEN", "没有权限") : undefined) });
    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "审计" }));
    expect(await screen.findByText("没有权限")).toBeVisible();
  });
});
