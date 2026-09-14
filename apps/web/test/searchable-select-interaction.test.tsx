// 两个自研下拉原语的**交互行为**测试：SearchableSelect 与 MultiCheckboxSelect。
//
// 与 searchable-select-placement.test.tsx 的分工：那个文件只管"弹层朝上/朝下、高度是否越界"的几何决策；
// 本文件管交互与状态，不重复验证 placement。
//
// 覆盖的真实行为：
//   SearchableSelect
//     - 收起态受控 value 回显（空值 → 占位文案；命中选项 → 其 label；未命中 → 原值）
//     - 展开：搜索框获得焦点、列出全部选项、当前值 aria-selected/aria-activedescendant 一致
//     - 输入过滤：忽略大小写、忽略两端空格、label 与 value 都能命中
//     - 无匹配项：可读文案（默认 + 自定义），清单不渲染
//     - 键盘：↑/↓ 移动与边界（↑ 在首项回绕末项，↓ 在末项不越界）、Enter 选中并回填并关闭、
//             唯一匹配时 Enter 直选、无匹配时 Enter 不选择
//     - 关闭路径：Escape（焦点归还触发点，且事件不冒泡给宿主对话框）、外部 pointerdown、外部滚动；
//                 弹层内部列表滚动不关闭
//     - 展开期间选项池被异步替换：清单跟随，高亮越界时收敛
//     - 收起态直接键入字符即开搜；Enter / 空格 / ↓ 也能展开；Ctrl/Alt 组合键不展开；disabled 全禁
//     - onSearch 收到每次输入的原始文本（含清空）
//   MultiCheckboxSelect
//     - 勾选 / 取消，输出顺序恒按选项池顺序（与勾选先后无关）
//     - disabledValues 不可勾选、带可见提示；已在选中集合里的 disabledValue 只禁用不提示
//     - 整体 disabled：搜索框与全部复选框禁用
//     - 过滤：大小写 / 两端空格 / label 与 value；过滤态下勾选仍按完整池顺序输出
//     - 计数用的是完整选项池，不受过滤影响
//     - 受控的"全选 / 清空"呈现（组件本身没有全选/清空按钮，见报告）
//     - 点击文字标签也能切换（label 包裹真实 checkbox）
//
// 纪律：只断言 DOM 可见结果 / 可访问性状态 / 回调参数；不 readFileSync、不正则匹配源码、不断言 className。
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableSelect, type SearchableSelectOption } from "../components/ui/searchable-select";
import { MultiCheckboxSelect } from "../components/ui/multi-checkbox-select";

const orders: SearchableSelectOption[] = [
  { value: "SO-2026-001", label: "订单 SO-2026-001 / 100 件" },
  { value: "SO-2026-002", label: "订单 SO-2026-002 / 200 件" },
  { value: "PO-INTERNAL-3", label: "内部补单" },
];

const operations: SearchableSelectOption[] = [
  { value: "op-1", label: "裁剪" },
  { value: "op-2", label: "缝制" },
  { value: "op-3", label: "包装" },
];

/** 展开后弹层里当前可见的选项文本（顺序即渲染顺序）。 */
function visibleOptions() {
  return screen.getAllByTestId("searchable-select-option").map((element) => element.textContent ?? "");
}

function searchInput() {
  return screen.getByTestId("searchable-select-search");
}

/** 受控 value 的宿主：只有 onChange 真的被调用并回填，触发点文案才会变。 */
function ControlledSearchableSelect({
  initialValue = "",
  options = orders,
  onChange,
  ...rest
}: {
  initialValue?: string;
  options?: SearchableSelectOption[];
  onChange?: (value: string) => void;
  onSearch?: (query: string) => void;
  disabled?: boolean;
  noResultsText?: string;
  placeholder?: string;
  searchPlaceholder?: string;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <SearchableSelect
      value={value}
      options={options}
      label="订单号"
      searchPlaceholder="搜索订单"
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      {...rest}
    />
  );
}

/** 受控 selected 的宿主：勾选后的回显、计数都依赖父组件把值传回来。 */
function ControlledMultiCheckboxSelect({
  initialSelected = [],
  options = operations,
  onChange,
  ...rest
}: {
  initialSelected?: string[];
  options?: SearchableSelectOption[];
  onChange?: (selected: string[]) => void;
  disabledValues?: string[];
  disabled?: boolean;
  noResultsText?: string;
  searchPlaceholder?: string;
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <MultiCheckboxSelect
      selected={selected}
      options={options}
      label="工序"
      onChange={(next) => {
        onChange?.(next);
        setSelected(next);
      }}
      {...rest}
    />
  );
}

function multiCheckboxFor(value: string) {
  return within(screen.getByTestId(`multi-checkbox-option-${value}`)).getByRole("checkbox");
}

/** 当前可见的多选选项（按选项池顺序），用于过滤断言 —— 0 行时不能抛错。 */
function visibleMultiOptions() {
  return operations.filter((option) => screen.queryByTestId(`multi-checkbox-option-${option.value}`) !== null).map((option) => option.value);
}

describe("SearchableSelect · 收起态的受控 value 回显", () => {
  it("空值显示占位文案，命中选项显示其 label，未命中回显原值", () => {
    const { rerender } = render(<SearchableSelect value="" options={orders} onChange={vi.fn()} label="订单号" placeholder="请选择订单" />);

    const trigger = screen.getByRole("combobox", { name: "订单号" });
    expect(trigger).toHaveTextContent("请选择订单");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    rerender(<SearchableSelect value="SO-2026-002" options={orders} onChange={vi.fn()} label="订单号" placeholder="请选择订单" />);
    expect(screen.getByRole("combobox", { name: "订单号" })).toHaveTextContent("订单 SO-2026-002 / 200 件");

    // 值不在当前选项池里（例如服务端搜索把 options 换掉了）：必须回显原值而不是退回占位文案，
    // 否则用户会以为自己没选过东西。
    rerender(<SearchableSelect value="SO-2026-999" options={orders} onChange={vi.fn()} label="订单号" placeholder="请选择订单" />);
    const stale = screen.getByRole("combobox", { name: "订单号" });
    expect(stale).toHaveTextContent("SO-2026-999");
    expect(stale).not.toHaveTextContent("请选择订单");
  });
});

describe("SearchableSelect · 展开与输入过滤", () => {
  it("点击触发点展开：搜索框自动聚焦、列出全部选项、当前值被标记为已选中且高亮落在它上面", async () => {
    render(<SearchableSelect value="SO-2026-002" options={orders} onChange={vi.fn()} label="订单号" />);

    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    const input = searchInput();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(visibleOptions()).toEqual(["订单 SO-2026-001 / 100 件", "订单 SO-2026-002 / 200 件", "内部补单"]);

    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    // 打开时高亮预置在当前值上，键盘 Enter 才能"原样确认"
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
  });

  it("输入过滤：忽略大小写与两端空格，label 与 value 都能命中", async () => {
    render(<ControlledSearchableSelect />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    const input = searchInput();

    // 小写查询命中 value 里的大写编码
    await userEvent.type(input, "so-2026-002");
    expect(visibleOptions()).toEqual(["订单 SO-2026-002 / 200 件"]);

    await userEvent.clear(input);
    await userEvent.type(input, "  内部  ");
    expect(visibleOptions()).toEqual(["内部补单"]);

    await userEvent.clear(input);
    await userEvent.type(input, "订单");
    expect(visibleOptions()).toEqual(["订单 SO-2026-001 / 100 件", "订单 SO-2026-002 / 200 件"]);
  });

  it("无匹配项：显示 noResultsText（默认与自定义），选项清单整体不渲染", async () => {
    const { rerender } = render(<ControlledSearchableSelect />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    await userEvent.type(searchInput(), "不存在的订单");

    expect(screen.getByRole("status")).toHaveTextContent("无匹配项");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryAllByTestId("searchable-select-option")).toHaveLength(0);

    rerender(<ControlledSearchableSelect noResultsText="没有找到订单" />);
    expect(screen.getByRole("status")).toHaveTextContent("没有找到订单");
  });

  it("展开期间选项池被异步替换：清单跟随更新，高亮越界时收敛到末项", async () => {
    const { rerender } = render(<SearchableSelect value="" options={orders} onChange={vi.fn()} label="订单号" />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    const input = searchInput();
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);

    // 服务端搜索返回了更短的候选池（父组件把 options 换掉）
    rerender(<SearchableSelect value="" options={[orders[0]]} onChange={vi.fn()} label="订单号" />);

    expect(visibleOptions()).toEqual(["订单 SO-2026-001 / 100 件"]);
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);
  });
});

describe("SearchableSelect · 键盘操作", () => {
  it("↓/↑ 移动高亮（↓ 在末项不越界），Enter 选中、回填受控值并关闭", async () => {
    const onChange = vi.fn();
    render(<ControlledSearchableSelect onChange={onChange} />);

    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    const input = searchInput();
    // 未选中任何值 → 打开时没有高亮项
    expect(input).not.toHaveAttribute("aria-activedescendant");

    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);

    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1].id);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);

    await userEvent.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("PO-INTERNAL-3");
    // 选中即关闭，受控 value 回填到触发点
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "订单号" })).toHaveTextContent("内部补单");
  });

  it("↑ 在首项回绕到末项", async () => {
    render(<SearchableSelect value="" options={orders} onChange={vi.fn()} label="订单号" />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    await userEvent.keyboard("{ArrowUp}");

    const options = screen.getAllByRole("option");
    expect(searchInput()).toHaveAttribute("aria-activedescendant", options[options.length - 1].id);
  });

  it("输入后只剩唯一匹配时，Enter 直接选中它（无需先按 ↓）", async () => {
    const onChange = vi.fn();
    render(<ControlledSearchableSelect onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    await userEvent.type(searchInput(), "内部");
    await userEvent.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("PO-INTERNAL-3");
    expect(screen.getByRole("combobox", { name: "订单号" })).toHaveTextContent("内部补单");
  });

  it("无匹配项时按 Enter 不触发选择，弹层保持打开", async () => {
    const onChange = vi.fn();
    render(<ControlledSearchableSelect onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    await userEvent.type(searchInput(), "zzz");
    await userEvent.keyboard("{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    expect(searchInput()).toBeVisible();
  });

  it("收起态直接键入字符即展开并按其搜索；Enter / 空格 / ↓ 也能展开，且重开不残留上次查询", async () => {
    render(<ControlledSearchableSelect />);
    const trigger = screen.getByRole("combobox", { name: "订单号" });

    // 注意：userEvent.type(trigger, "内") 会先 click，click 本身就把下拉点开了，走不到"在收起态键入"的分支。
    // 这里显式只给焦点、不点击，才是真正的"在收起态直接敲字符"。
    trigger.focus();
    await userEvent.keyboard("内");
    expect(searchInput()).toHaveValue("内");
    expect(visibleOptions()).toEqual(["内部补单"]);

    // Escape 关闭后回到触发点，再分别用 Enter / 空格 / ↓ 展开
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "订单号" })).toHaveFocus());

    await userEvent.keyboard("{Enter}");
    expect(searchInput()).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "订单号" })).toHaveFocus());

    await userEvent.keyboard(" ");
    expect(searchInput()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "订单号" })).toHaveFocus());

    await userEvent.keyboard("{ArrowDown}");
    expect(searchInput()).toBeVisible();
  });

  it("Ctrl / Alt 组合键不展开（避免吞掉浏览器快捷键）", async () => {
    render(<ControlledSearchableSelect />);
    screen.getByRole("combobox", { name: "订单号" }).focus();

    await userEvent.keyboard("{Control>}a{/Control}");
    expect(screen.queryByTestId("searchable-select-search")).toBeNull();

    await userEvent.keyboard("{Alt>}a{/Alt}");
    expect(screen.queryByTestId("searchable-select-search")).toBeNull();
  });

  it("disabled：触发点禁用，点击与键盘都不能展开", async () => {
    const onChange = vi.fn();
    render(<SearchableSelect value="SO-2026-001" options={orders} onChange={onChange} disabled label="订单号" />);

    const trigger = screen.getByRole("combobox", { name: "订单号" });
    expect(trigger).toBeDisabled();

    await userEvent.click(trigger);
    expect(screen.queryByTestId("searchable-select-search")).toBeNull();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.queryByTestId("searchable-select-search")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SearchableSelect · 点击选项与关闭路径", () => {
  it("点击选项：回调传出该值、受控 value 回填、弹层关闭", async () => {
    const onChange = vi.fn();
    render(<ControlledSearchableSelect onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    await userEvent.click(screen.getByRole("option", { name: "订单 SO-2026-002 / 200 件" }));

    expect(onChange).toHaveBeenCalledWith("SO-2026-002");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "订单号" })).toHaveTextContent("订单 SO-2026-002 / 200 件");
  });

  it("点击组件外部关闭弹层，且不改变选择", async () => {
    const onChange = vi.fn();
    render(
      <div>
        <SearchableSelect value="" options={orders} onChange={onChange} label="订单号" />
        <button type="button">外部按钮</button>
      </div>
    );
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    expect(screen.getByRole("listbox")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "外部按钮" }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape 关闭并把焦点还给触发点，且该按键不再冒泡给宿主对话框", async () => {
    const hostKeyDown = vi.fn();
    render(
      <div onKeyDown={hostKeyDown}>
        <SearchableSelect value="" options={orders} onChange={vi.fn()} label="订单号" />
      </div>
    );
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    // 对照组：普通字符正常冒泡到宿主，证明探针有效
    await userEvent.keyboard("a");
    expect(hostKeyDown).toHaveBeenCalled();

    const beforeEscape = hostKeyDown.mock.calls.length;
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    // 组件在 document 捕获阶段 stopPropagation：宿主对话框的 Escape 处理不应被触发，
    // 否则第一次 Escape 会连对话框一起关掉（组件注释里声明的契约）。
    expect(hostKeyDown.mock.calls.length).toBe(beforeEscape);
    expect(hostKeyDown.mock.calls.filter(([event]) => (event as KeyboardEvent).key === "Escape")).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "订单号" })).toHaveFocus());
  });

  it("视口滚动关闭弹层；弹层内部列表滚动时保持打开", async () => {
    render(<SearchableSelect value="" options={orders} onChange={vi.fn()} label="订单号" />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));

    // 内部列表滚动（滚选项）不能把弹层关掉，否则鼠标滚轮一滚就没了
    act(() => {
      screen.getByRole("listbox").dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("listbox")).toBeVisible();

    // 真实浏览器的视口滚动把 scroll 事件派发在 document 上（target 是 Node）
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("SearchableSelect · onSearch 回调", () => {
  it("每次输入都把原始文本交给 onSearch（含清空为空串）", async () => {
    const onSearch = vi.fn();
    render(<ControlledSearchableSelect onSearch={onSearch} />);
    await userEvent.click(screen.getByRole("combobox", { name: "订单号" }));
    const input = searchInput();

    await userEvent.type(input, "SO-2");
    expect(onSearch.mock.calls.map(([value]) => value)).toEqual(["S", "SO", "SO-", "SO-2"]);

    await userEvent.clear(input);
    expect(onSearch).toHaveBeenLastCalledWith("");
  });

  it("KNOWN_DEFECT：在收起态直接键入的首字符不会触发 onSearch（搜索框却已显示它）", async () => {
    // 期望：与"展开后在搜索框里输入"一致 —— 首字符也要交给 onSearch。
    //   生产页（app/production/page.tsx:71 searchSalesOrders）用 onSearch 做服务端搜索并回填 options，
    //   首字符不发出请求时，用户看到的是"用新查询过滤旧候选池"的结果；只输一个字就停手则永远搜不到。
    // 实际：handleTriggerKeyDown 里走 openWith(event.key)，只设内部 query，没有调用 onSearch。
    // 责任文件：components/ui/searchable-select.tsx:210（openWith(event.key)）。
    const onSearch = vi.fn();
    render(<ControlledSearchableSelect onSearch={onSearch} />);

    // 只聚焦不点击，确保真正走进 handleTriggerKeyDown 的"单字符开启搜索"分支
    screen.getByRole("combobox", { name: "订单号" }).focus();
    await userEvent.keyboard("内");

    expect(searchInput()).toHaveValue("内");
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe("MultiCheckboxSelect · 勾选、取消与输出顺序", () => {
  it("勾选与取消：回调收到选中值数组，勾选态与计数随受控值更新", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect onChange={onChange} />);

    expect(screen.getByText("已选 0 / 3 项")).toBeVisible();

    await userEvent.click(multiCheckboxFor("op-2"));

    expect(onChange).toHaveBeenLastCalledWith(["op-2"]);
    expect(multiCheckboxFor("op-2")).toBeChecked();
    expect(screen.getByText("已选 1 / 3 项")).toBeVisible();

    await userEvent.click(multiCheckboxFor("op-2"));

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(multiCheckboxFor("op-2")).not.toBeChecked();
    expect(screen.getByText("已选 0 / 3 项")).toBeVisible();
  });

  it("输出顺序始终按选项池顺序，与勾选先后无关", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect initialSelected={["op-3"]} onChange={onChange} />);

    // 先勾了 op-3，再勾 op-1：结果必须是 [op-1, op-3]（池顺序），提交体才可预期
    await userEvent.click(multiCheckboxFor("op-1"));

    expect(onChange).toHaveBeenLastCalledWith(["op-1", "op-3"]);
    expect(screen.getByText("已选 2 / 3 项")).toBeVisible();
  });

  it("点击选项文字标签也能切换（label 包裹真实勾选框）", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect onChange={onChange} />);

    await userEvent.click(within(screen.getByTestId("multi-checkbox-option-op-3")).getByText("包装"));

    expect(onChange).toHaveBeenLastCalledWith(["op-3"]);
    expect(multiCheckboxFor("op-3")).toBeChecked();
  });

  it("受控全选 / 清空：全部选中时每项都勾选，清空后全部取消（组件本身没有全选/清空按钮）", () => {
    const { rerender } = render(<MultiCheckboxSelect selected={operations.map((option) => option.value)} options={operations} onChange={vi.fn()} label="工序" />);

    for (const option of operations) expect(multiCheckboxFor(option.value)).toBeChecked();
    expect(screen.getByText("已选 3 / 3 项")).toBeVisible();

    rerender(<MultiCheckboxSelect selected={[]} options={operations} onChange={vi.fn()} label="工序" />);

    for (const option of operations) expect(multiCheckboxFor(option.value)).not.toBeChecked();
    expect(screen.getByText("已选 0 / 3 项")).toBeVisible();
  });

  it("逐个取消到空数组即为清空：最后一次取消回调传出 []", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect initialSelected={["op-1"]} onChange={onChange} />);

    await userEvent.click(multiCheckboxFor("op-1"));

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByText("已选 0 / 3 项")).toBeVisible();
  });
});

describe("MultiCheckboxSelect · disabledValues、整体禁用与过滤", () => {
  it("disabledValues：该项不可勾选并给出可见提示，点击不触发回调，其余选项不受影响", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect onChange={onChange} disabledValues={["op-1"]} />);

    expect(multiCheckboxFor("op-1")).toBeDisabled();
    expect(screen.getByTestId("multi-checkbox-option-op-1")).toHaveTextContent("已在当前生产单");

    await userEvent.click(multiCheckboxFor("op-1"));
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(multiCheckboxFor("op-2"));
    expect(onChange).toHaveBeenLastCalledWith(["op-2"]);
  });

  it("已在选中集合里的 disabledValue：保持勾选且不再显示提示", () => {
    render(<ControlledMultiCheckboxSelect initialSelected={["op-1"]} disabledValues={["op-1"]} onChange={vi.fn()} />);

    expect(multiCheckboxFor("op-1")).toBeChecked();
    expect(multiCheckboxFor("op-1")).toBeDisabled();
    expect(screen.getByTestId("multi-checkbox-option-op-1")).not.toHaveTextContent("已在当前生产单");
  });

  it("整体 disabled：搜索框与所有复选框禁用，点击不触发回调", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect onChange={onChange} disabled />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    for (const option of operations) expect(multiCheckboxFor(option.value)).toBeDisabled();

    await userEvent.click(multiCheckboxFor("op-2"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("搜索过滤：忽略大小写与两端空格，label 与 value 都能命中；计数始终用完整选项池", async () => {
    render(<ControlledMultiCheckboxSelect />);
    const search = screen.getByRole("textbox");

    await userEvent.type(search, "op-3");
    expect(visibleMultiOptions()).toEqual(["op-3"]);
    expect(screen.getByText("已选 0 / 3 项")).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, "  缝制  ");
    expect(visibleMultiOptions()).toEqual(["op-2"]);

    await userEvent.clear(search);
    await userEvent.type(search, "包装");
    expect(visibleMultiOptions()).toEqual(["op-3"]);
  });

  it("过滤状态下勾选：输出仍按完整选项池顺序", async () => {
    const onChange = vi.fn();
    render(<ControlledMultiCheckboxSelect initialSelected={["op-3"]} onChange={onChange} />);

    await userEvent.type(screen.getByRole("textbox"), "缝制");
    await userEvent.click(multiCheckboxFor("op-2"));

    expect(onChange).toHaveBeenLastCalledWith(["op-2", "op-3"]);
    expect(screen.getByText("已选 2 / 3 项")).toBeVisible();
  });

  it("无匹配项：显示可读文案（默认与自定义）且没有任何选项行", async () => {
    const { rerender } = render(<ControlledMultiCheckboxSelect />);
    await userEvent.type(screen.getByRole("textbox"), "不存在的工序");

    expect(screen.getByRole("status")).toHaveTextContent("无匹配项");
    expect(visibleMultiOptions()).toEqual([]);

    rerender(<ControlledMultiCheckboxSelect noResultsText="没有匹配的工序" />);
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配的工序");
  });

  it("搜索框的可访问名与占位文案来自 searchPlaceholder", () => {
    render(<MultiCheckboxSelect selected={[]} options={operations} onChange={vi.fn()} label="工序" searchPlaceholder="搜索工序" />);

    const search = screen.getByRole("textbox", { name: "搜索工序" });
    expect(search).toHaveAttribute("placeholder", "搜索工序");
  });
});
