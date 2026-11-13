// 表单下拉「什么时候带搜索框」的行为测试（2026-11-13）。
//
// 用户原话：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上
// 搜索功能。因为现在单子多了，查找比较麻烦。」
//
// 口径（`components/ui/action-dialog.tsx` 的 `usesSearchableField`）：
//   · 字段显式写 `type: "searchable-select"` → 一定带搜索；
//   · 写 `type: "select"` 但选项 > 8 项 → 自动升级成带搜索的下拉（8 项正好铺满 288px 弹层）；
//   · 2–8 项的固定枚举（性别 / 是否 / 方向）保持紧凑，不塞一个没人用的搜索框。
//
// 为什么必须有这条测试：现网 67 个表单下拉字段里只有 6 个显式写了 searchable-select，
// 其余全部靠「选项多了自动升级」这条规则兜底 —— 规则坏了不会有任何报错，只会静默退回「不能搜」。
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ActionDialog, SEARCHABLE_FIELD_MIN_OPTIONS, usesSearchableField, type ActionField } from "../components/ui/action-dialog";

const manyOptions = Array.from({ length: 12 }, (_, index) => ({ value: `c-${index}`, label: `客户${index}` }));
const fewOptions = [
  { value: "male", label: "男" },
  { value: "female", label: "女" },
];

function renderDialog(fields: ActionField[]) {
  return render(<ActionDialog open title="测试表单" fields={fields} onOpenChange={() => {}} onSubmit={() => {}} />);
}

describe("usesSearchableField：纯判定", () => {
  it("显式 searchable-select 一定带搜索（哪怕只有 2 个选项）", () => {
    expect(usesSearchableField({ name: "x", label: "X", type: "searchable-select", options: fewOptions })).toBe(true);
  });

  it("阈值是 9：8 项不升级、9 项升级", () => {
    expect(SEARCHABLE_FIELD_MIN_OPTIONS).toBe(9);
    expect(usesSearchableField({ name: "x", label: "X", type: "select", options: fewOptions })).toBe(false);
    expect(usesSearchableField({ name: "x", label: "X", type: "select", options: manyOptions.slice(0, 8) })).toBe(false);
    expect(usesSearchableField({ name: "x", label: "X", type: "select", options: manyOptions.slice(0, 9) })).toBe(true);
  });

  it("没有选项 / 不是下拉字段时不升级", () => {
    expect(usesSearchableField({ name: "x", label: "X", type: "select" })).toBe(false);
    expect(usesSearchableField({ name: "x", label: "X" })).toBe(false);
    expect(usesSearchableField({ name: "x", label: "X", type: "text", options: manyOptions })).toBe(false);
  });
});

describe("ActionDialog：长清单真的能搜", () => {
  it("12 个选项的下拉展开后有搜索框，且能按关键词收窄", () => {
    renderDialog([{ name: "customer_id", label: "客户", type: "select", options: manyOptions }]);
    // 触发器上的 testid 仍然叫 action-field-customer_id（原来那个名字不能变）。
    // 与显式 `searchable-select` 字段同一形状：testid 落在根 div 上，要展开得点它里面的按钮。
    const root = screen.getByTestId("action-field-customer_id");
    fireEvent.click(within(root).getByRole("combobox"));
    const search = screen.getByTestId("searchable-select-search");
    expect(search).toBeTruthy();
    fireEvent.change(search, { target: { value: "客户7" } });
    expect(screen.getByText("客户7")).toBeTruthy();
    expect(screen.queryByText("客户3")).toBeNull();
  });

  it("2 项的固定枚举保持原样（不出现搜索框，界面不啰嗦）", () => {
    renderDialog([{ name: "gender", label: "性别", type: "select", options: fewOptions }]);
    fireEvent.click(screen.getByTestId("action-field-gender"));
    expect(screen.queryByTestId("searchable-select-search")).toBeNull();
    expect(screen.getByText("男")).toBeTruthy();
  });
});
