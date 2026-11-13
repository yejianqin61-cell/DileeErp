// 报表中心（/reports）两张表的表内搜索（2026-11-13）。
//
// 用户原话：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
// 因为现在单子多了，查找比较麻烦。」
//
// 这一页有**两套**筛选，本文件把它们的边界一起钉住（改坏了很容易互相污染）：
//   · 上方「订单号 + 筛选」是**服务端**条件：点了才带 `?order_no=` 重新取数，导出用同一个条件；
//   · 两张表各自的关键字框是**客户端**过滤：只在已取回的这一批里找，不发请求、不影响导出。
// 所以断言里有两件看起来相反的事：表内搜索**不许**打接口；点「筛选」**必须**打接口。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReportsPage from "../app/reports/page";
import { apiOk, stubApi } from "./helpers/api-stub";

/** 「订单推进」页签的两行（列按接口键动态生成，所以这里就是接口原样返回的样子）。 */
const orderRows = () => [
  { order_no: "DL260001-1", customer_name: "宁波客户", status: "confirmed", amount: "100.00" },
  { order_no: "DL260002-1", customer_name: "绍兴客户", status: "pending", amount: "200.00" },
];

const alertRow = (overrides: Record<string, unknown> = {}) => ({
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
const alertRows = () => [
  alertRow(),
  alertRow({ alert_type: "finished_goods_qc", source_id: "qc-1", order_no: "ORD-2", title: "成品 QC 不合格", suggestion: "请隔离该批成品并复检。" }),
];

function stubPage(options: { rows?: Array<Record<string, unknown>>; alerts?: Array<Record<string, unknown>> } = {}) {
  return stubApi((url) => {
    if (url.includes("/alerts")) return apiOk(options.alerts ?? alertRows());
    if (url.includes("/reports/")) return apiOk(options.rows ?? orderRows());
    return apiOk({});
  });
}

async function renderPage(options: { rows?: Array<Record<string, unknown>>; alerts?: Array<Record<string, unknown>> } = {}) {
  const calls = stubPage(options);
  render(<ReportsPage />);
  await screen.findByTestId("page-reports");
  return calls;
}

/** 切到告警中心（它自己一份取数：`GET /alerts`）。 */
const openAlerts = async () => {
  await userEvent.click(screen.getByRole("button", { name: "告警中心" }));
  return waitFor(() => expect(screen.getByTestId("reports-alert-search")).toBeTruthy());
};

describe("报表中心：报表页签的表内搜索（2026-11-13）", () => {
  it("按格子里的文字收窄，给「筛选后 N / M 行」计数，且**不发请求**", async () => {
    const calls = await renderPage();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));
    const before = calls.length;

    await userEvent.type(screen.getByTestId("reports-search"), "宁波");

    const rows = screen.getAllByTestId("data-table-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("宁波客户");
    expect(screen.getByTestId("reports-search-count")).toHaveTextContent("筛选后 1 / 2 行");
    // 客户端过滤：不得因此再打接口（否则「搜索」会变成一次看不见的重新取数）
    expect(calls.length).toBe(before);
  });

  /** 报表的列随接口键变，所以过滤只能按**显示出来的文字**匹配：枚举要先翻成中文（`pending` → 待处理）。 */
  it("中文枚举也参与匹配：搜「待处理」命中 status=pending 的那一行", async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByTestId("reports-search"), "待处理");

    const rows = screen.getAllByTestId("data-table-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("绍兴客户");
  });

  it("不匹配时说「没有匹配」而不是「暂无报表数据」；「清除搜索」恢复全部", async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByTestId("reports-search"), "查无此单");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("没有匹配“查无此单”的行");

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(2);
    expect(screen.queryByTestId("reports-search-count")).toBeNull();
  });

  it("本来就一条数据都没有时说「暂无报表数据」（与搜空分开）", async () => {
    await renderPage({ rows: [] });

    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无报表数据");
    // 没数据也仍然留着搜索框：不然用户不知道这一页是"能搜的、只是这次空"
    expect(screen.getByTestId("reports-search")).toBeTruthy();
  });

  /**
   * 边界守卫：表内搜索**不能**顶替上面那条服务端筛选。
   * 点了「筛选」就必须带着订单号重新取数（导出的也正是这个条件）。
   */
  it("服务端订单号筛选照旧：点「筛选」带 ?order_no= 重新取数（表内搜索不替代它）", async () => {
    const calls = await renderPage();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByLabelText("订单号"), "DL260001");
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() => expect(calls.some((call) => call.url.includes("order_no=DL260001"))).toBe(true));
  });

  it("换页签把关键词清掉：否则新页签看起来像「没有数据」", async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByTestId("reports-search"), "宁波");
    await userEvent.click(screen.getByRole("button", { name: "库存" }));
    await waitFor(() => expect(screen.queryByTestId("reports-search")).toBeTruthy());

    expect((screen.getByTestId("reports-search") as HTMLInputElement).value).toBe("");
  });
});

describe("报表中心：告警中心的表内搜索（2026-11-13）", () => {
  it("按标题收窄并计数", async () => {
    const calls = await renderPage();
    await openAlerts();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));
    const before = calls.length;

    await userEvent.type(screen.getByTestId("reports-alert-search"), "QC");

    const rows = screen.getAllByTestId("data-table-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("成品 QC 不合格");
    expect(screen.getByTestId("reports-alert-count")).toHaveTextContent("筛选后 1 / 2 行");
    expect(calls.length).toBe(before);
  });

  it("不匹配时说「没有匹配」；清除搜索恢复两条", async () => {
    await renderPage();
    await openAlerts();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByTestId("reports-alert-search"), "查无此警");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("没有匹配“查无此警”的告警");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("共 2 条待处理告警");

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(2);
  });

  /**
   * 只匹配表里**看得见**的五列。`alert_type` / `source_type` / `source_id` 是内部字段：
   * 让它们参与匹配，用户搜 `production_daily_alert` 会命中一堆，而屏幕上一个字都对不上 ——
   * 那会被当成"搜索坏了"。
   */
  it("只匹配看得见的列：内部字段（alert_type / source_type）不参与", async () => {
    await renderPage();
    await openAlerts();
    await waitFor(() => expect(screen.getAllByTestId("data-table-row")).toHaveLength(2));

    await userEvent.type(screen.getByTestId("reports-alert-search"), "production_daily_alert");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("没有匹配“production_daily_alert”的告警");

    // 但表里真的显示着的东西都能搜到（级别、状态、建议）
    const search = screen.getByTestId("reports-alert-search");
    await userEvent.clear(search);
    await userEvent.type(search, "请隔离");
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(1);
    expect(within(screen.getByTestId("daily-alert-table")).getByText("成品 QC 不合格")).toBeTruthy();
  });
});
