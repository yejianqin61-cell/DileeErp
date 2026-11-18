// 首页任务提醒面板的交互测试：真实渲染 + 真实点击 + fetch 桩。
// 重点不是样式，而是用户提的那条交互契约：
//   默认收起只显示条数；点【展开】才加载列表；到期/紧急可见；能跳单据；能标记完成。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskRemindersPanel } from "../components/dashboard/task-reminders-panel";
import { SessionContext } from "../lib/session-context";
import type { SessionProfile } from "../lib/session";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

type Counts = { total: number; urgent_count: number; normal_count: number; overdue_count: number; due_soon_count: number };
type Task = {
  id: string; source_type: string; source_id: string; task_type: string; title: string;
  module: string; document_no: string; order_no: string | null; detail: string; href: string;
  due_at: string | null; due_status: "overdue" | "due_soon" | "normal" | "none"; due_label: string;
  priority: "urgent" | "normal"; created_at: string;
};

const COUNTS: Counts = { total: 2, urgent_count: 1, normal_count: 1, overdue_count: 1, due_soon_count: 0 };
const TASKS: Task[] = [
  {
    id: "purchase_order:11111111-1111-4111-8111-111111111111:arrival",
    source_type: "purchase_order", source_id: "11111111-1111-4111-8111-111111111111", task_type: "arrival",
    title: "采购到货待登记", module: "procurement", document_no: "PO-20260901-001", order_no: "SO-20260901-001",
    detail: "SO-20260901-001 · 甲供应商", href: "/procurement/orders?order_no=SO-20260901-001",
    due_at: "2026-09-15T00:00:00.000Z", due_status: "overdue", due_label: "已逾期 2 天（09-15 到期）",
    priority: "urgent", created_at: "2026-09-10T00:00:00.000Z",
  },
  {
    id: "raw_material_movement:22222222-2222-4222-8222-222222222222:outbound",
    source_type: "raw_material_movement", source_id: "22222222-2222-4222-8222-222222222222", task_type: "outbound",
    title: "领料单待仓库出库", module: "warehouse", document_no: "MI-20260916-001", order_no: "SO-20260901-001",
    detail: "SO-20260901-001 · MO-20260916-001 · 3 项物料", href: "/production/material-issues?movement_id=22222222-2222-4222-8222-222222222222",
    due_at: "2026-09-20T00:00:00.000Z", due_status: "normal", due_label: "截止 09-20",
    priority: "normal", created_at: "2026-09-16T00:00:00.000Z",
  },
];

function stubSummary(counts: Counts = COUNTS, list: Task[] = TASKS) {
  return stubApi((url, call) => {
    if (url.endsWith("/task-reminders/summary")) return apiOk(counts);
    if (url.endsWith("/task-reminders/complete") && call.method === "POST") return apiOk({ completed: true });
    if (url.endsWith("/task-reminders")) return apiOk(list, counts);
    return apiErr(404, "NOT_FOUND", `未预期的请求：${url}`);
  });
}

describe("首页任务提醒", () => {
  it("默认收起：只显示待办条数，不加载完整列表", async () => {
    const calls = stubSummary();
    render(<TaskRemindersPanel />);

    await waitFor(() => expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("task-reminder-summary")).toHaveTextContent("2 条待办，其中 1 条紧急");
    expect(screen.queryByTestId("task-reminders-body")).toBeNull();
    expect(screen.getByTestId("task-reminder-toggle")).toHaveTextContent("展开");
    // summary 可以拉，完整列表不能拉。
    expect(callsTo(calls, "/task-reminders/summary")).toHaveLength(1);
    expect(callsTo(calls, "/task-reminders")).toHaveLength(0);
  });

  it("点【展开】才加载完整列表，并显示到期标色、紧急/普通和单据链接", async () => {
    const calls = stubSummary();
    render(<TaskRemindersPanel />);
    await waitFor(() => expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("2"));

    await userEvent.click(screen.getByTestId("task-reminder-toggle"));
    await waitFor(() => expect(screen.getByTestId("task-reminders-body")).toBeInTheDocument());

    const urgent = screen.getByTestId("task-reminder-purchase_order:11111111-1111-4111-8111-111111111111:arrival");
    expect(within(urgent).getByText("紧急")).toBeInTheDocument();
    expect(within(urgent).getByTestId("task-reminder-due-purchase_order:11111111-1111-4111-8111-111111111111:arrival")).toHaveTextContent("已逾期 2 天");
    expect(within(urgent).getByTestId("task-reminder-link-purchase_order:11111111-1111-4111-8111-111111111111:arrival")).toHaveAttribute("href", "/procurement/orders?order_no=SO-20260901-001");

    const normal = screen.getByTestId("task-reminder-raw_material_movement:22222222-2222-4222-8222-222222222222:outbound");
    expect(within(normal).getByText("普通")).toBeInTheDocument();
    expect(within(normal).getByTestId("task-reminder-due-raw_material_movement:22222222-2222-4222-8222-222222222222:outbound")).toHaveTextContent("截止 09-20");
    expect(within(normal).getByRole("link", { name: "打开单据" })).toHaveAttribute("href", "/production/material-issues?movement_id=22222222-2222-4222-8222-222222222222");

    expect(callsTo(calls, "/task-reminders")).toHaveLength(1);
    expect(screen.getByTestId("task-reminder-toggle")).toHaveTextContent("收起");
  });

  it("标记完成会提交来源三段键、把该任务从列表移除并同步计数", async () => {
    const calls = stubSummary();
    render(<TaskRemindersPanel />);
    await waitFor(() => expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("2"));
    await userEvent.click(screen.getByTestId("task-reminder-toggle"));
    await waitFor(() => expect(screen.getByTestId("task-reminders-body")).toBeInTheDocument());

    const firstId = "purchase_order:11111111-1111-4111-8111-111111111111:arrival";
    await userEvent.click(screen.getByTestId(`task-reminder-complete-${firstId}`));

    await waitFor(() => expect(screen.queryByTestId(`task-reminder-${firstId}`)).toBeNull());
    expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("1");
    expect(screen.getByTestId("task-reminder-summary")).toHaveTextContent("1 条待办");
    expect(screen.getByTestId("task-reminder-raw_material_movement:22222222-2222-4222-8222-222222222222:outbound")).toBeInTheDocument();

    const post = calls.find((call) => call.url.endsWith("/task-reminders/complete"));
    expect(post?.method).toBe("POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      source_type: "purchase_order",
      source_id: "11111111-1111-4111-8111-111111111111",
      task_type: "arrival",
    });
  });

  it("按表面权限裁剪：只有采购栏目时不显示仓库任务，收起计数也不含仓库", async () => {
    const profile: SessionProfile = {
      id: "u1", username: "user", display_name: "测试用户",
      role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "custom",
      surface_sections: ["dashboard", "procurement"], module_keys: ["procurement"],
    };
    stubApi((url) => {
      if (url.endsWith("/task-reminders/summary")) {
        return apiOk({
          ...COUNTS,
          total: 4,
          normal_count: 3,
          by_module: {
            procurement: { total: 1, urgent_count: 1, normal_count: 0, overdue_count: 1, due_soon_count: 0 },
            warehouse: { total: 3, urgent_count: 0, normal_count: 3, overdue_count: 0, due_soon_count: 0 },
          },
        });
      }
      if (url.endsWith("/task-reminders")) return apiOk(TASKS, COUNTS);
      return apiErr(404, "NOT_FOUND");
    });

    render(<SessionContext.Provider value={profile}><TaskRemindersPanel /></SessionContext.Provider>);
    await waitFor(() => expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("1"));
    expect(screen.getByTestId("task-reminder-summary")).toHaveTextContent("1 条待办，其中 1 条紧急");

    await userEvent.click(screen.getByTestId("task-reminder-toggle"));
    await waitFor(() => expect(screen.getByTestId("task-reminders-body")).toBeInTheDocument());
    expect(screen.getByTestId("task-reminder-purchase_order:11111111-1111-4111-8111-111111111111:arrival")).toBeInTheDocument();
    expect(screen.queryByTestId("task-reminder-raw_material_movement:22222222-2222-4222-8222-222222222222:outbound")).toBeNull();
  });

  it("列表加载失败时给出明确失败态和重试按钮，而不是假装没有任务", async () => {
    stubApi((url) => {
      if (url.endsWith("/task-reminders/summary")) return apiOk(COUNTS);
      if (url.endsWith("/task-reminders")) return apiErr(500, "TASK_REMINDERS_FAILED", "待办任务加载失败");
      return apiErr(404, "NOT_FOUND");
    });
    render(<TaskRemindersPanel />);
    await waitFor(() => expect(screen.getByTestId("task-reminder-count")).toHaveTextContent("2"));
    await userEvent.click(screen.getByTestId("task-reminder-toggle"));
    await waitFor(() => expect(screen.getByText("待办任务加载失败")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
