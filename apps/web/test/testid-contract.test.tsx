// S6：data-testid 稳定定位钩子的**行为**契约测试（真实渲染 + 真实查询）。
//
// 为什么需要它（见 S6 背景与 docs/announcement/current-development-assessment.md）：
//   E2E 过去用 getByLabel("地点名称") / form 标题文本定位，中文标签或布局一改就超时，
//   production-daily-report.spec.mjs 正是这样卡的。这里渲染共享原语并断言 testid 真的在 DOM 上，
//   任何人删掉/改名 testid 都会立刻变红——这是渲染断言，不是源码文本断言。
//
// 注意：globals: false，测试 API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef } from "@tanstack/react-table";
import { ActionDialog, type ActionField } from "../components/ui/action-dialog";
import { DataTable } from "../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../components/feedback/states";
import { MultiCheckboxSelect } from "../components/ui/multi-checkbox-select";
import { SearchableSelect } from "../components/ui/searchable-select";
import { notify, Toaster } from "../components/ui/toaster";

const fields: ActionField[] = [
  { name: "name", label: "地点名称", required: true },
  { name: "location_type", label: "地点类型", type: "select", options: [{ value: "workshop", label: "厂内车间" }] },
  { name: "order_no", label: "订单号", type: "searchable-select", options: [{ value: "SO-1", label: "SO-1" }] },
  { name: "operation_ids", label: "选择工序（可多选）", type: "multi-checkbox", options: [{ value: "op-1", label: "缝制" }] },
];

type Row = { no: string };

function renderActionDialog(overrides: Partial<Parameters<typeof ActionDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onSubmit = vi.fn();
  render(
    <ActionDialog
      open
      title="新建加工地点"
      fields={fields}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
  return { onOpenChange, onSubmit };
}

describe("data-testid 契约：ActionDialog（全站唯一共享提交弹窗）", () => {
  it("弹窗根、每个字段控件、提交与取消按钮都有稳定 testid", () => {
    renderActionDialog();

    expect(screen.getByTestId("action-dialog")).toBeVisible();
    // 文本类字段：testid 直接挂在 input 上（E2E 可以直接 fill）
    expect(screen.getByTestId("action-field-name")).toHaveAttribute("id", "action-name");
    // select 类字段：挂在 Radix 触发器上
    expect(screen.getByTestId("action-field-location_type")).toHaveAttribute("id", "action-location_type");
    // searchable-select / multi-checkbox 不透传 DOM 属性，testid 落在最近的既有包装元素上
    expect(screen.getByTestId("action-field-order_no")).toContainElement(screen.getByTestId("searchable-select"));
    expect(screen.getByTestId("action-field-operation_ids")).toContainElement(screen.getByTestId("multi-checkbox-select"));
    expect(screen.getByTestId("action-dialog-submit")).toBeVisible();
    expect(screen.getByTestId("action-dialog-cancel")).toBeVisible();
  });

  it("submit/cancel 的 testid 指向真实可点的按钮（不是装饰性属性）", async () => {
    const { onOpenChange, onSubmit } = renderActionDialog();

    await userEvent.click(screen.getByTestId("action-dialog-cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await userEvent.type(screen.getByTestId("action-field-name"), "E2E车间");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "E2E车间" }));
  });

  it("必填校验失败时出现带 action-dialog-error 的错误元素", async () => {
    renderActionDialog();

    expect(screen.queryByTestId("action-dialog-error")).toBeNull();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写地点名称");
  });

  it("服务端拒绝（onSubmit 抛错）时错误元素同样可用", async () => {
    renderActionDialog({ onSubmit: vi.fn(() => Promise.reject(new Error("加工地点已存在"))) });

    await userEvent.type(screen.getByTestId("action-field-name"), "重复地点");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("加工地点已存在");
  });
});

describe("data-testid 契约：DataTable / 反馈状态 / toast", () => {
  it("DataTable：根元素与每一行数据行都有 testid", () => {
    const columns: ColumnDef<Row, string>[] = [{ accessorKey: "no", header: "生产单号" }];
    render(<DataTable columns={columns} data={[{ no: "MO-1" }, { no: "MO-2" }]} />);

    expect(screen.getByTestId("data-table")).toBeVisible();
    const rows = screen.getAllByTestId("data-table-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("MO-1");
  });

  it("DataTable：空数据回落到空态（空态自带 testid，表格根不渲染）", () => {
    const columns: ColumnDef<Row, string>[] = [{ accessorKey: "no", header: "生产单号" }];
    render(<DataTable columns={columns} data={[]} />);

    expect(screen.getByTestId("empty-state")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("LoadingState / EmptyState / ErrorState 各自带 testid", () => {
    const { unmount } = render(<LoadingState />);
    expect(screen.getByTestId("loading-state")).toBeVisible();
    unmount();

    render(<EmptyState />);
    expect(screen.getByTestId("empty-state")).toBeVisible();
  });

  it("ErrorState：重试按钮带 error-state-retry，且点击真的调用 onRetry", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="数据加载失败" onRetry={onRetry} />);

    expect(screen.getByTestId("error-state")).toBeVisible();
    await userEvent.click(screen.getByTestId("error-state-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Toaster：常驻 live region 是 toast-region，每条通知是 toast-item", async () => {
    render(<Toaster />);

    expect(screen.getByTestId("toast-region")).toBeInTheDocument();

    act(() => notify("生产地点已创建"));

    expect(await screen.findByTestId("toast-item")).toHaveTextContent("生产地点已创建");
  });

  it("SearchableSelect / MultiCheckboxSelect：根、搜索框与每个选项都有 testid", async () => {
    render(
      <>
        <SearchableSelect value="" options={[{ value: "SO-1", label: "SO-1" }]} onChange={vi.fn()} label="订单号" />
        <MultiCheckboxSelect selected={[]} options={[{ value: "op-1", label: "缝制" }]} onChange={vi.fn()} label="工序" />
      </>
    );

    expect(screen.getByTestId("searchable-select")).toBeVisible();
    expect(screen.getByTestId("multi-checkbox-select")).toBeVisible();
    expect(screen.getByTestId("multi-checkbox-option-op-1")).toBeVisible();

    // 搜索框与选项只在展开后渲染：展开动作本身也证明 testid 挂在真实交互控件上
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    expect(screen.getByTestId("searchable-select-search")).toBeVisible();
    expect(screen.getByTestId("searchable-select-option")).toHaveTextContent("SO-1");
  });
});
