// 修复护栏：告警中心确认「生产日报差异」时，必须同时确认 production_daily_alert。
//
// 缺陷（docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.2）：
//   /alerts/:id/handle 只写 alert_handling；订单侧阻塞只看 production_daily_alert.status === "pending"
//   （production-progress.service.ts:169-170）。因此旧实现里"已确认"的告警仍然阻塞生产单，
//   而 /production/daily-alerts/:id/confirm 没有任何前端调用方。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReportsPage from "../app/reports/page";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

const alert = (overrides: Record<string, unknown> = {}) => ({
  alert_type: "daily_discrepancy",
  order_no: "ORD-1",
  severity: "high",
  source_id: "pd-1",
  source_type: "production_daily_alert",
  status: "pending",
  suggestion: "请核对日报与生产单累计数量。",
  title: "生产日报差异",
  ...overrides,
});

/** 渲染报表页并切到「告警中心」页签。 */
async function openAlertCenter(row: ReturnType<typeof alert>, options: { confirmResponse?: Response } = {}) {
  const calls = stubApi((url) => {
    if (url.includes("/alerts")) return apiOk([row]);
    if (url.includes("/production/daily-alerts/")) return options.confirmResponse ?? apiOk({});
    if (url.includes("/reports/")) return apiOk([]);
    return apiOk({});
  });

  render(<ReportsPage />);
  await userEvent.click(screen.getByRole("button", { name: "告警中心" }));
  await screen.findByText(row.title as string);
  return calls;
}

/** 点击行内「确认」并在处理对话框里提交备注。 */
async function confirmAlert() {
  await userEvent.click(screen.getByRole("button", { name: "确认" }));
  await screen.findByTestId("action-dialog");
  await userEvent.type(screen.getByTestId("action-field-remark"), "已核对");
  await userEvent.click(screen.getByTestId("action-dialog-submit"));
}

describe("告警中心确认与生产日报告警的联动", () => {
  it("确认生产日报告警时会同时调用 /alerts/:id/handle 与 /production/daily-alerts/:id/confirm", async () => {
    const calls = await openAlertCenter(alert());

    await confirmAlert();

    await waitFor(() => expect(callsTo(calls, "/api/v1/alerts/pd-1/handle")).toHaveLength(1));
    const linkage = callsTo(calls, "/api/v1/production/daily-alerts/pd-1/confirm");
    expect(linkage).toHaveLength(1);
    // 备注要一并带上，否则生产日报告警的 confirmRemark 会是空的
    expect(JSON.parse(String(linkage[0].body))).toEqual({ remark: "已核对" });
  });

  it("非生产日报告警（如成品 QC 不合格）不应触发该联动", async () => {
    const calls = await openAlertCenter(alert({ source_id: "qc-1", source_type: "finished_goods_qc", title: "成品 QC 不合格" }));

    await confirmAlert();

    await waitFor(() => expect(callsTo(calls, "/api/v1/alerts/qc-1/handle")).toHaveLength(1));
    expect(callsTo(calls, "/production/daily-alerts/")).toHaveLength(0);
  });

  it("告警已被恢复（RECOVERED_ALERT_CANNOT_CONFIRM）时不阻断用户的确认流程", async () => {
    const calls = await openAlertCenter(alert(), { confirmResponse: apiErr(422, "RECOVERED_ALERT_CANNOT_CONFIRM", "已恢复告警不能再次确认") });

    await confirmAlert();

    // handle 已成功；联动调用被容忍（已恢复的告警本就不再阻塞）
    await waitFor(() => expect(callsTo(calls, "/api/v1/alerts/pd-1/handle")).toHaveLength(1));
    expect(callsTo(calls, "/production/daily-alerts/pd-1/confirm")).toHaveLength(1);
    // 不应把 422 当成错误展示给用户
    expect(screen.queryByText("已恢复告警不能再次确认")).toBeNull();
  });

  it("联动的其它错误仍然要暴露给用户，不被吞掉", async () => {
    stubApi((url) => {
      if (url.includes("/alerts")) return apiOk([alert()]);
      if (url.includes("/production/daily-alerts/")) return apiErr(404, "PRODUCTION_DAILY_ALERT_NOT_FOUND", "生产日报告警不存在");
      return apiOk([]);
    });

    render(<ReportsPage />);
    await userEvent.click(screen.getByRole("button", { name: "告警中心" }));
    await screen.findByText("生产日报差异");
    await confirmAlert();

    expect(await screen.findByText("生产日报告警不存在")).toBeVisible();
  });
});
